// Real Windcave integration, replacing Stripe for customer-facing payments (booking deposits,
// gift cards, packages). Blooma's own Solo/Team subscription billing stays on Stripe — that's
// a different capability (recurring billing, proration, self-serve portal) that Windcave's
// side hasn't been tested for.
//
// Everything lives in one file, dispatched by ?action=, rather than one file per endpoint —
// Vercel's Hobby plan caps a deployment at 12 serverless functions.
//
// Windcave's merchantReference field is capped at 64 characters (confirmed empirically against
// the live API, not documented) — nowhere near enough to carry full purchase details (a salon
// slug plus a customer UUID alone can exceed that). So the two purchase types need different
// fulfillment strategies:
//   - Booking deposits: merchantReference is just `dep:<booking_id>` (fits easily), so the FPRN
//     notification alone can fully fulfil it, exactly like Stripe's webhook does today.
//   - Gift cards / packages: full purchase details ride in OUR OWN callbackUrls query string
//     (unconstrained, since we build that URL ourselves) and get finalised by the browser
//     calling back in after the redirect. FPRN still fires for these, but since it only carries
//     a throwaway reference, it can only detect "this got paid but never got fulfilled" and log
//     it for manual follow-up — it can't safely reconstruct which salon/customer to credit.
//     That's a real (small) reliability gap versus Stripe's metadata dict, worth knowing about.
const { serviceClient, requireCustomerAuth, requireVenueAuth } = require('./_lib/auth');

const WINDCAVE_BASE_URL = process.env.WINDCAVE_BASE_URL || 'https://uat.windcave.com/api/v1';
const GIFT_CARD_MIN = 10;
const GIFT_CARD_MAX = 500;

function authHeader() {
  const username = process.env.WINDCAVE_USERNAME;
  const key = process.env.WINDCAVE_API_KEY;
  if (!username || !key) {
    const err = new Error('Windcave credentials are not configured on the server.');
    err.statusCode = 500;
    throw err;
  }
  return 'Basic ' + Buffer.from(`${username}:${key}`).toString('base64');
}

async function windcaveFetch(pathOrUrl, opts = {}) {
  // Accepts either a path relative to WINDCAVE_BASE_URL or a full URL — Windcave hands back
  // absolute links (hpp, refund, ...) on session/transaction responses, and those must be
  // followed as-is rather than re-based, per their own HATEOAS-style API design.
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${WINDCAVE_BASE_URL}${pathOrUrl}`;
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(), ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error(data?.message || data?.errors?.[0]?.message || `Windcave returned HTTP ${res.status}`);
    e.statusCode = 502;
    e.details = data;
    throw e;
  }
  return data;
}

function hppRedirectUrl(sessionData) {
  const link = (sessionData.links || []).find(l => l.rel === 'hpp' && l.method === 'REDIRECT');
  if (!link) {
    const e = new Error('Windcave session created but no hosted payment page link was returned.');
    e.statusCode = 502;
    e.details = sessionData;
    throw e;
  }
  return link.href;
}

function originOf(req) {
  return req.headers['origin'] || `https://${req.headers['host']}`;
}

// Issues a refund against a previously completed purchase transaction. Windcave returns a
// "refund" link directly on the transaction resource (self-discovered, same pattern as
// hppRedirectUrl above) — confirmed live against a real UAT transaction that this points at the
// general /transactions endpoint, and the original transaction is referenced via a
// `transactionId` field in the POST body (not the URL), with `type: "refund"` alongside it. A
// successful refund comes back as its own transaction resource with `authorised`/`responseText`,
// same shape as a purchase — checked explicitly here since a declined refund can still come back
// as a 2xx with authorised:false rather than an HTTP error.
async function refundWindcaveTransaction(transactionId, amount) {
  const txn = await windcaveFetch(`/transactions/${encodeURIComponent(transactionId)}`, { method: 'GET' });
  const refundLink = (txn.links || []).find(l => l.rel === 'refund' && String(l.method || '').toUpperCase() === 'POST');
  if (!refundLink) {
    const e = new Error('This payment cannot be refunded automatically — refund it directly in Payline instead.');
    e.statusCode = 400;
    e.details = txn;
    throw e;
  }
  const refundResult = await windcaveFetch(refundLink.href, {
    method: 'POST',
    body: JSON.stringify({ type: 'refund', transactionId, amount: amount.toFixed(2), currency: 'NZD' }),
  });
  console.log('[windcave refund] transaction', transactionId, 'amount', amount, 'result', JSON.stringify(refundResult));
  if (refundResult.authorised !== true) {
    const e = new Error(refundResult.responseText || 'Refund was declined by Windcave.');
    e.statusCode = 502;
    e.details = refundResult;
    throw e;
  }
  return refundResult;
}

/* ---------------------------------------------------
   BOOKING DEPOSIT — mirrors api/stripe/create-booking-deposit-checkout.js
--------------------------------------------------- */
async function createDepositSession(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { booking_id } = req.body || {};
  if (!booking_id) { const e = new Error('booking_id is required'); e.statusCode = 400; throw e; }

  const svc = serviceClient();
  const { data: booking } = await svc.from('bookings').select('*').eq('id', booking_id).maybeSingle();
  if (!booking) { const e = new Error('Booking not found'); e.statusCode = 404; throw e; }
  if (booking.status !== 'upcoming') { const e = new Error('This booking is no longer available.'); e.statusCode = 400; throw e; }
  if (booking.deposit_status !== 'pending') {
    const e = new Error(booking.deposit_status === 'paid' ? 'This deposit has already been paid.' : 'No deposit is required for this booking.');
    e.statusCode = 400;
    throw e;
  }
  const depositAmount = Number(booking.deposit_amount || 0);
  if (!(depositAmount > 0)) { const e = new Error('Invalid deposit amount'); e.statusCode = 400; throw e; }

  const { data: salonRow } = await svc.from('salons').select('id,name,public_slug').eq('id', booking.salon_id).maybeSingle();
  if (!salonRow) { const e = new Error('Venue not found'); e.statusCode = 404; throw e; }

  const origin = originOf(req);
  const returnUrl = `${origin}/customer-checkout.html?depositReturn={STATUS}&token=${booking.public_token}`;

  const session = await windcaveFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      type: 'purchase',
      amount: depositAmount.toFixed(2),
      currency: 'NZD',
      merchantReference: `dep:${booking.id}`,
      callbackUrls: {
        approved: returnUrl.replace('{STATUS}', 'success'),
        declined: returnUrl.replace('{STATUS}', 'declined'),
        cancelled: returnUrl.replace('{STATUS}', 'cancelled'),
      },
      notificationUrl: `${origin}/api/windcave?action=notification`,
      threeds: booking.customer_email ? { email: booking.customer_email, cardHolderName: booking.customer_name || undefined } : undefined,
    }),
  });

  res.status(200).json({ url: hppRedirectUrl(session) });
}

/* ---------------------------------------------------
   IN-VENUE CHECKOUT CHARGE — the "Card" option on checkout.html, standing in for the
   physical Windcave HIT terminal until it arrives. merchantReference carries both the
   booking id and the tip (in cents) so, exactly like booking deposits, the FPRN
   notification alone can fully complete the booking with no separate finalize call.
--------------------------------------------------- */
async function createCheckoutChargeSession(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { salonId } = await requireVenueAuth(req);
  const { booking_id, tip_pct } = req.body || {};
  if (!booking_id) { const e = new Error('booking_id is required'); e.statusCode = 400; throw e; }

  const svc = serviceClient();
  const { data: booking } = await svc.from('bookings').select('*').eq('id', booking_id).eq('salon_id', salonId).maybeSingle();
  if (!booking) { const e = new Error('Booking not found'); e.statusCode = 404; throw e; }
  if (booking.status !== 'upcoming') { const e = new Error('This appointment is not awaiting checkout.'); e.statusCode = 400; throw e; }

  const total = Number(booking.total || 0);
  const depositPaid = booking.deposit_status === 'paid' ? Number(booking.deposit_amount || 0) : 0;
  const pct = Math.max(0, Math.min(Number(tip_pct) || 0, 1));
  const tipAmount = Math.round(total * pct * 100) / 100;
  const amount = Math.round((total - depositPaid + tipAmount) * 100) / 100;
  if (!(amount > 0)) { const e = new Error('Nothing to charge for this appointment.'); e.statusCode = 400; throw e; }
  const tipCents = Math.round(tipAmount * 100);

  const origin = originOf(req);
  const returnUrl = `${origin}/venue/admin/checkout?id=${booking.id}&chargeReturn={STATUS}`;

  const session = await windcaveFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      type: 'purchase',
      amount: amount.toFixed(2),
      currency: 'NZD',
      merchantReference: `chk:${booking.id}:${tipCents}`,
      callbackUrls: {
        approved: returnUrl.replace('{STATUS}', 'success'),
        declined: returnUrl.replace('{STATUS}', 'declined'),
        cancelled: returnUrl.replace('{STATUS}', 'cancelled'),
      },
      notificationUrl: `${origin}/api/windcave?action=notification`,
      threeds: booking.customer_email ? { email: booking.customer_email, cardHolderName: booking.customer_name || undefined } : undefined,
    }),
  });

  res.status(200).json({ url: hppRedirectUrl(session) });
}

/* ---------------------------------------------------
   GIFT CARD — mirrors api/stripe/create-gift-card-checkout.js
--------------------------------------------------- */
async function createGiftCardSession(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { svc, userId, email } = await requireCustomerAuth(req);
  const { salon_id, amount, recipient_name, recipient_email, purchaser_name } = req.body || {};

  if (!salon_id) { const e = new Error('salon_id is required'); e.statusCode = 400; throw e; }
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount < GIFT_CARD_MIN || numAmount > GIFT_CARD_MAX) {
    const e = new Error(`Gift card amount must be between $${GIFT_CARD_MIN} and $${GIFT_CARD_MAX}`);
    e.statusCode = 400;
    throw e;
  }

  const { data: salonRow } = await svc.from('salons').select('id,name,public_slug').eq('id', salon_id).maybeSingle();
  if (!salonRow) { const e = new Error('Venue not found'); e.statusCode = 404; throw e; }

  const origin = originOf(req);
  const venuePath = `/${encodeURIComponent(salonRow.public_slug || salon_id)}`;
  // Everything the finalize step needs to fulfil the purchase rides in the callback URL's own
  // query string (unlike merchantReference, this has no meaningful length limit since we
  // control and parse it ourselves) — see the file-level comment on why.
  const finalizeParams = new URLSearchParams({
    purchase: 'giftcard-success',
    salon_id: String(salon_id),
    purchaser_name: purchaser_name || '',
    recipient_name: recipient_name || '',
    recipient_email: recipient_email || '',
  });

  const session = await windcaveFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      type: 'purchase',
      amount: numAmount.toFixed(2),
      currency: 'NZD',
      merchantReference: `gc:${Date.now()}`,
      callbackUrls: {
        approved: `${origin}${venuePath}?${finalizeParams.toString()}`,
        declined: `${origin}${venuePath}?purchase=cancelled`,
        cancelled: `${origin}${venuePath}?purchase=cancelled`,
      },
      notificationUrl: `${origin}/api/windcave?action=notification`,
      threeds: email ? { email, cardHolderName: purchaser_name || undefined } : undefined,
    }),
  });

  // Bind this Windcave session to the salon that was actually validated above, server-side —
  // finalizeGiftCard looks this up by sessionId instead of trusting whatever salon_id the
  // browser resubmits, so a paid session can never be redirected to credit a different venue.
  // If this write fails, refuse to hand back a payable URL at all — a session no one can trace
  // back to a venue must never be payable in the first place.
  const { error: trackErr } = await svc.from('windcave_purchase_sessions').insert({ session_id: session.id, kind: 'gift_card', salon_id });
  if (trackErr) { const e = new Error('Could not start checkout. Please try again.'); e.statusCode = 500; throw e; }

  res.status(200).json({ url: hppRedirectUrl(session) });
}

function generateGiftCardCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid misreads
  let code = '';
  for (let i = 0; i < 10; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

// Called by the browser once it lands back on the venue page after Windcave redirects to our
// own callback URL (which carries the purchase details we embedded, plus Windcave's own
// appended sessionId). We never trust the client for the amount — that always comes from
// Windcave's own authoritative session data.
async function finalizeGiftCard(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { svc, userId } = await requireCustomerAuth(req);
  const { sessionId, purchaser_name, recipient_name, recipient_email } = req.body || {};
  if (!sessionId) { const e = new Error('sessionId is required'); e.statusCode = 400; throw e; }

  // Redelivery/double-call guard — the browser callback can fire more than once (e.g. a refresh).
  const { data: already } = await svc.from('gift_cards').select('id').eq('windcave_session_id', sessionId).maybeSingle();
  if (already) { res.status(200).json({ ok: true, alreadyFulfilled: true }); return; }

  // Which venue this credits comes from OUR OWN record of what was validated when the session
  // was created — never from the client-resubmitted salon_id. Without this, a customer could pay
  // for a gift card on Venue A's page and resubmit the finalize call with Venue B's salon_id,
  // minting a real paid gift card credited to a venue that never made the sale.
  const { data: tracked } = await svc.from('windcave_purchase_sessions').select('salon_id,kind').eq('session_id', sessionId).maybeSingle();
  if (!tracked || tracked.kind !== 'gift_card') {
    const e = new Error('This payment session is not a gift card purchase.');
    e.statusCode = 400;
    throw e;
  }
  const salon_id = tracked.salon_id;

  const session = await windcaveFetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' });
  const txn = (session.transactions || [])[0];
  if (session.state !== 'complete' || !txn?.authorised) {
    const e = new Error('This payment was not approved.');
    e.statusCode = 400;
    throw e;
  }
  // A Windcave session that paid for something else entirely (a deposit or an in-venue charge)
  // must never be replayable here — the tracking-table check above already scopes this to a
  // real gift-card session, this is a defense-in-depth check against the raw merchantReference too.
  if (!String(session.merchantReference || '').startsWith('gc:')) {
    const e = new Error('This payment session is not a gift card purchase.');
    e.statusCode = 400;
    throw e;
  }
  const amount = Number(session.amount);
  if (!(amount > 0)) { const e = new Error('Invalid session amount'); e.statusCode = 502; throw e; }

  let code, existing;
  do {
    code = generateGiftCardCode();
    ({ data: existing } = await svc.from('gift_cards').select('id').eq('code', code).maybeSingle());
  } while (existing);

  const { error: insertErr } = await svc.from('gift_cards').insert({
    salon_id,
    code,
    purchaser_user_id: userId,
    purchaser_name: purchaser_name || null,
    purchaser_email: null,
    recipient_name: recipient_name || null,
    recipient_email: recipient_email || null,
    initial_value: amount,
    remaining_balance: amount,
    currency: 'nzd',
    status: 'active',
    windcave_session_id: sessionId,
    windcave_transaction_id: txn?.id || null,
    expires_at: new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (insertErr) {
    // Unique violation on windcave_session_id means a concurrent request already
    // fulfilled this same payment — treat as success rather than minting a duplicate card.
    if (insertErr.code === '23505') { res.status(200).json({ ok: true, alreadyFulfilled: true }); return; }
    throw insertErr;
  }

  res.status(200).json({ ok: true, code });
}

/* ---------------------------------------------------
   PACKAGE — mirrors api/stripe/create-package-checkout.js
--------------------------------------------------- */
async function createPackageSession(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { svc, userId, email } = await requireCustomerAuth(req);
  const { salon_id, package_offer_id } = req.body || {};
  if (!salon_id || !package_offer_id) { const e = new Error('salon_id and package_offer_id are required'); e.statusCode = 400; throw e; }

  const { data: salonRow } = await svc.from('salons').select('id,name,public_slug').eq('id', salon_id).maybeSingle();
  if (!salonRow) { const e = new Error('Venue not found'); e.statusCode = 404; throw e; }

  const { data: configRow } = await svc.from('app_config').select('config').eq('salon_id', salon_id).maybeSingle();
  const packages = configRow?.config?.packages || [];
  // Price and session count come from the venue's own saved catalog, never from the client.
  const offer = packages.find((p) => String(p.id) === String(package_offer_id));
  if (!offer || offer.active === false) { const e = new Error('This package is no longer available'); e.statusCode = 404; throw e; }

  const services = configRow?.config?.services || [];
  const service = services.find((s) => String(s.id) === String(offer.service_id));
  const serviceName = service?.name || offer.name;

  const origin = originOf(req);
  const venuePath = `/${encodeURIComponent(salonRow.public_slug || salon_id)}`;
  const finalizeParams = new URLSearchParams({
    purchase: 'package-success',
    salon_id: String(salon_id),
    package_offer_id: String(offer.id),
    service_id: offer.service_id ? String(offer.service_id) : '',
    service_name_snapshot: serviceName,
    sessions_total: String(offer.sessions),
  });

  const session = await windcaveFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      type: 'purchase',
      amount: Number(offer.price).toFixed(2),
      currency: 'NZD',
      merchantReference: `pkg:${Date.now()}`,
      callbackUrls: {
        approved: `${origin}${venuePath}?${finalizeParams.toString()}`,
        declined: `${origin}${venuePath}?purchase=cancelled`,
        cancelled: `${origin}${venuePath}?purchase=cancelled`,
      },
      notificationUrl: `${origin}/api/windcave?action=notification`,
      threeds: email ? { email } : undefined,
    }),
  });

  // Bind this session to the salon+offer validated above, server-side — finalizePackage looks
  // this up by sessionId instead of trusting a resubmitted salon_id/package_offer_id, so a paid
  // session can never be redirected to credit a different venue's catalog. If this write fails,
  // refuse to hand back a payable URL — an untraceable session must never be payable.
  const { error: trackErr } = await svc.from('windcave_purchase_sessions').insert({ session_id: session.id, kind: 'package', salon_id, package_offer_id: offer.id });
  if (trackErr) { const e = new Error('Could not start checkout. Please try again.'); e.statusCode = 500; throw e; }

  res.status(200).json({ url: hppRedirectUrl(session) });
}

async function finalizePackage(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { svc, userId } = await requireCustomerAuth(req);
  const { sessionId } = req.body || {};
  if (!sessionId) { const e = new Error('sessionId is required'); e.statusCode = 400; throw e; }

  const { data: already } = await svc.from('customer_packages').select('id').eq('windcave_session_id', sessionId).maybeSingle();
  if (already) { res.status(200).json({ ok: true, alreadyFulfilled: true }); return; }

  // Which venue/offer this credits comes from OUR OWN record of what was validated when the
  // session was created — never from client-resubmitted salon_id/package_offer_id. See the
  // matching comment in finalizeGiftCard for why.
  const { data: tracked } = await svc.from('windcave_purchase_sessions').select('salon_id,package_offer_id,kind').eq('session_id', sessionId).maybeSingle();
  if (!tracked || tracked.kind !== 'package') {
    const e = new Error('This payment session is not a package purchase.');
    e.statusCode = 400;
    throw e;
  }
  const salon_id = tracked.salon_id;
  const package_offer_id = tracked.package_offer_id;

  const session = await windcaveFetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' });
  const txn = (session.transactions || [])[0];
  if (session.state !== 'complete' || !txn?.authorised) {
    const e = new Error('This payment was not approved.');
    e.statusCode = 400;
    throw e;
  }
  // Defense-in-depth — the tracking-table check above already scopes this to a real package
  // session, this additionally guards against the raw merchantReference itself.
  if (!String(session.merchantReference || '').startsWith('pkg:')) {
    const e = new Error('This payment session is not a package purchase.');
    e.statusCode = 400;
    throw e;
  }
  const amount = Number(session.amount);

  // Re-derive session count, service, and price from the venue's own saved catalog — never
  // trust sessions_total/service_id/service_name_snapshot from the client. The paid amount must
  // match the offer's current price exactly, otherwise a client could pay for a cheap package
  // and finalize against a different, more valuable one.
  const { data: configRow } = await svc.from('app_config').select('config').eq('salon_id', salon_id).maybeSingle();
  const packages = configRow?.config?.packages || [];
  const offer = packages.find((p) => String(p.id) === String(package_offer_id));
  if (!offer || offer.active === false) { const e = new Error('This package is no longer available'); e.statusCode = 404; throw e; }
  if (Math.abs(amount - Number(offer.price)) > 0.01) {
    const e = new Error('Paid amount does not match this package.');
    e.statusCode = 400;
    throw e;
  }
  const services = configRow?.config?.services || [];
  const service = services.find((s) => String(s.id) === String(offer.service_id));
  const serviceName = service?.name || offer.name;

  const { error: insertErr } = await svc.from('customer_packages').insert({
    salon_id,
    package_offer_id: offer.id,
    service_id: offer.service_id || null,
    service_name_snapshot: serviceName,
    customer_user_id: userId,
    customer_name: null,
    customer_email: null,
    sessions_total: offer.sessions,
    sessions_remaining: offer.sessions,
    price_paid: amount,
    status: 'active',
    windcave_session_id: sessionId,
    windcave_transaction_id: txn?.id || null,
  });
  if (insertErr) {
    if (insertErr.code === '23505') { res.status(200).json({ ok: true, alreadyFulfilled: true }); return; }
    throw insertErr;
  }

  res.status(200).json({ ok: true });
}

/* ---------------------------------------------------
   REFUNDS — venue-initiated. Each of these looks up the real Windcave transaction id captured
   at payment time (never a client-supplied one) and refunds through refundWindcaveTransaction,
   only updating our own records once Windcave has actually accepted the refund.
--------------------------------------------------- */
async function refundDeposit(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { salonId } = await requireVenueAuth(req);
  const { booking_id } = req.body || {};
  if (!booking_id) { const e = new Error('booking_id is required'); e.statusCode = 400; throw e; }

  const svc = serviceClient();
  const { data: booking } = await svc.from('bookings').select('*').eq('id', booking_id).eq('salon_id', salonId).maybeSingle();
  if (!booking) { const e = new Error('Booking not found'); e.statusCode = 404; throw e; }
  if (booking.deposit_status !== 'paid') { const e = new Error('This deposit is not marked as paid.'); e.statusCode = 400; throw e; }
  if (!booking.windcave_transaction_id) { const e = new Error('No payment record found for this deposit — it may predate online payments. Refund it directly in Payline.'); e.statusCode = 400; throw e; }
  const amount = Number(booking.deposit_amount || 0);
  if (!(amount > 0)) { const e = new Error('Invalid deposit amount'); e.statusCode = 400; throw e; }

  await refundWindcaveTransaction(booking.windcave_transaction_id, amount);

  await svc.from('bookings').update({
    deposit_status: 'refunded',
    deposit_refunded_at: new Date().toISOString(),
    deposit_refund_amount: amount,
  }).eq('id', booking_id);

  res.status(200).json({ ok: true });
}

async function voidGiftCard(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { salonId } = await requireVenueAuth(req);
  const { gift_card_id } = req.body || {};
  if (!gift_card_id) { const e = new Error('gift_card_id is required'); e.statusCode = 400; throw e; }

  const svc = serviceClient();
  const { data: card } = await svc.from('gift_cards').select('*').eq('id', gift_card_id).eq('salon_id', salonId).maybeSingle();
  if (!card) { const e = new Error('Gift card not found'); e.statusCode = 404; throw e; }
  if (card.status !== 'active') { const e = new Error('This gift card is not active.'); e.statusCode = 400; throw e; }
  const amount = Number(card.remaining_balance || 0);
  if (!(amount > 0)) { const e = new Error('Nothing left to refund on this gift card.'); e.statusCode = 400; throw e; }
  if (!card.windcave_transaction_id) { const e = new Error('No payment record found for this gift card — it may predate online payments. Refund it directly in Payline.'); e.statusCode = 400; throw e; }

  await refundWindcaveTransaction(card.windcave_transaction_id, amount);

  await svc.from('gift_cards').update({
    status: 'cancelled',
    remaining_balance: 0,
    refunded_amount: amount,
    refunded_at: new Date().toISOString(),
  }).eq('id', gift_card_id);

  res.status(200).json({ ok: true });
}

async function voidPackage(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { salonId } = await requireVenueAuth(req);
  const { package_id } = req.body || {};
  if (!package_id) { const e = new Error('package_id is required'); e.statusCode = 400; throw e; }

  const svc = serviceClient();
  const { data: pkg } = await svc.from('customer_packages').select('*').eq('id', package_id).eq('salon_id', salonId).maybeSingle();
  if (!pkg) { const e = new Error('Package not found'); e.statusCode = 404; throw e; }
  if (pkg.status !== 'active') { const e = new Error('This package is not active.'); e.statusCode = 400; throw e; }
  // Kept deliberately conservative: a partially-used package's fair refund value is a business
  // decision, not something to compute automatically. Only a fully-unused package can be voided
  // here; anything else needs a manual call on the remaining value.
  if (Number(pkg.sessions_remaining) !== Number(pkg.sessions_total)) {
    const e = new Error('This package has sessions already used — partial refunds aren’t supported here. Refund the remaining value directly in Payline.');
    e.statusCode = 400;
    throw e;
  }
  const amount = Number(pkg.price_paid || 0);
  if (!(amount > 0)) { const e = new Error('Invalid package amount'); e.statusCode = 400; throw e; }
  if (!pkg.windcave_transaction_id) { const e = new Error('No payment record found for this package — it may predate online payments. Refund it directly in Payline.'); e.statusCode = 400; throw e; }

  await refundWindcaveTransaction(pkg.windcave_transaction_id, amount);

  await svc.from('customer_packages').update({
    status: 'cancelled',
    sessions_remaining: 0,
    refunded_amount: amount,
    refunded_at: new Date().toISOString(),
  }).eq('id', package_id);

  res.status(200).json({ ok: true });
}

// The 15-minute stale-hold sweep (api/bookings/expire-stale-holds.js) can cancel a booking
// while the customer is still completing 3DS on Windcave's hosted page. If the payment then
// comes through authorised, it's genuine — so before giving up on it, check whether the slot
// is still actually free (nobody else booked over it in the meantime) so the booking can be
// safely restored rather than the payment being silently orphaned.
async function hasSlotConflict(svc, booking) {
  if (!booking.stylist_id || !booking.starts_at) return false;
  const start = new Date(booking.starts_at).getTime();
  const end = start + (Number(booking.duration_minutes) || 0) * 60000;
  const windowStart = new Date(start - 6 * 60 * 60000).toISOString();
  const windowEnd = new Date(start + 6 * 60 * 60000).toISOString();
  const { data: candidates } = await svc
    .from('bookings')
    .select('id,starts_at,duration_minutes')
    .eq('salon_id', booking.salon_id)
    .eq('stylist_id', booking.stylist_id)
    .neq('id', booking.id)
    .in('status', ['upcoming', 'completed'])
    .gte('starts_at', windowStart)
    .lte('starts_at', windowEnd);
  return (candidates || []).some((c) => {
    const cStart = new Date(c.starts_at).getTime();
    const cEnd = cStart + (Number(c.duration_minutes) || 0) * 60000;
    return start < cEnd && cStart < end;
  });
}

/* ---------------------------------------------------
   FPRN NOTIFICATION — Windcave's own server calls this directly, independent of whether the
   customer's browser makes it back. This is the sole, fully-reliable fulfillment path for
   booking deposits (merchantReference carries the booking id). For gift cards/packages it's a
   best-effort safety net only — see the file-level comment.
--------------------------------------------------- */
async function notification(req, res) {
  const sessionId = req.query?.sessionId || req.body?.sessionId || req.body?.id;
  if (!sessionId) { res.status(200).json({ received: true }); return; }

  try {
    const session = await windcaveFetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' });
    const txn = (session.transactions || [])[0];
    const authorised = session.state === 'complete' && !!txn?.authorised;
    const ref = String(session.merchantReference || '');

    if (ref.startsWith('dep:')) {
      const bookingId = ref.slice(4);
      if (authorised) {
        const svc = serviceClient();
        const { data: booking } = await svc.from('bookings').select('*').eq('id', bookingId).maybeSingle();
        if (booking && booking.deposit_status !== 'paid') {
          const update = {
            deposit_status: 'paid',
            deposit_paid_at: new Date().toISOString(),
            windcave_transaction_id: txn?.id || null,
          };
          let shouldNotify = true;
          if (booking.status !== 'upcoming') {
            // Booking was auto-cancelled (stale-hold sweep) while this payment was in flight.
            // Restore it if the slot is still free; otherwise the payment is real but the slot
            // is gone — record the paid deposit but flag loudly for a manual refund rather than
            // silently reviving over someone else's booking.
            const conflict = await hasSlotConflict(svc, booking);
            if (!conflict) {
              update.status = 'upcoming';
              update.notes = [booking.notes, '[Deposit paid after hold expiry — booking restored]'].filter(Boolean).join(' ').trim();
            } else {
              shouldNotify = false;
              console.error('[windcave notification] DEPOSIT PAID ON CANCELLED BOOKING, SLOT NO LONGER AVAILABLE — needs manual refund:', { bookingId, sessionId });
            }
          }
          await svc.from('bookings').update(update).eq('id', bookingId);
          // Booking creation withholds the confirmation email/SMS while a deposit is pending;
          // fire it now that the deposit is genuinely paid (and the booking is actually active).
          if (shouldNotify) {
            try {
              await svc.rpc('notify_booking_deposit_paid', { p_booking_id: bookingId });
            } catch (notifyErr) {
              console.error('notify_booking_deposit_paid failed', notifyErr);
            }
          }
        }
      }
    } else if (ref.startsWith('chk:')) {
      const [, bookingId, tipCentsStr] = ref.split(':');
      if (authorised) {
        const svc = serviceClient();
        const { data: booking } = await svc.from('bookings').select('id,status').eq('id', bookingId).maybeSingle();
        if (booking && booking.status === 'upcoming') {
          const tipAmount = Math.max(0, Number(tipCentsStr || 0)) / 100;
          await svc.from('bookings').update({
            status: 'completed',
            payment_method: 'card',
            tip_amount: tipAmount,
          }).eq('id', bookingId);
        }
      }
    } else if (ref.startsWith('gc:') || ref.startsWith('pkg:')) {
      if (authorised) {
        const svc = serviceClient();
        const table = ref.startsWith('gc:') ? 'gift_cards' : 'customer_packages';
        const { data: existing } = await svc.from(table).select('id').eq('windcave_session_id', sessionId).maybeSingle();
        if (!existing) {
          // The browser never came back to finalize this one — we don't have enough
          // information here (no salon/customer) to safely auto-create the row, so this is
          // flagged loudly for manual reconciliation rather than silently dropped.
          console.error('[windcave notification] PAID BUT UNFULFILLED — needs manual reconciliation:', {
            sessionId, ref, amount: session.amount, merchantReference: session.merchantReference,
          });
        }
      }
    }
  } catch (err) {
    console.error('[windcave notification] error handling notification:', err.message);
  }

  res.status(200).json({ received: true });
}

module.exports = async (req, res) => {
  const action = req.query?.action;
  try {
    if (action === 'create-deposit-session') return await createDepositSession(req, res);
    if (action === 'create-checkout-charge-session') return await createCheckoutChargeSession(req, res);
    if (action === 'create-gift-card-session') return await createGiftCardSession(req, res);
    if (action === 'finalize-gift-card') return await finalizeGiftCard(req, res);
    if (action === 'create-package-session') return await createPackageSession(req, res);
    if (action === 'finalize-package') return await finalizePackage(req, res);
    if (action === 'notification') return await notification(req, res);
    if (action === 'refund-deposit') return await refundDeposit(req, res);
    if (action === 'void-gift-card') return await voidGiftCard(req, res);
    if (action === 'void-package') return await voidPackage(req, res);
    res.status(400).json({ error: 'Unknown or missing ?action=' });
  } catch (err) {
    console.error(`windcave [${action}] error:`, err.message, err.details || '');
    if (action === 'notification') { res.status(200).json({ received: true }); return; }
    res.status(err.statusCode || 500).json({ error: err.message || 'Request failed', details: err.details });
  }
};
