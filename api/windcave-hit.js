// The real, per-venue physical-terminal charge path for checkout.html's "Card" option —
// replaces the "standing in" Windcave hosted-payment-page flow (api/windcave.js's
// createCheckoutChargeSession) for any venue that has a Windcave HIT terminal configured.
// Separate file from the throwaway api/windcave-hit-test.js on purpose: that one uses global
// env-var credentials for raw hardware smoke-testing with no booking involved; this one reads
// per-venue credentials from the salons table and writes real booking completions.
//
// HIT is asynchronous: `start` POSTs a Purchase and kicks the transaction off on the physical
// terminal (customer taps/inserts + enters PIN), then the browser polls `status` (same TxnRef)
// until Windcave reports Complete=1. Every windcave_hit_transactions row this creates is the
// single source of truth for "is this booking's card charge still in flight" — checkout.html
// uses it to resume polling if staff closes/reloads the tab mid-charge.
const { serviceClient, requireVenueAuth } = require('./_lib/auth');

const WINDCAVE_HIT_PROD_BASE_URL = 'https://sec.windcave.com/hit/pos.aspx';
// How long a `pending` transaction blocks a fresh `start` call for the same booking before a
// retry is allowed to fire a brand-new terminal transaction instead of reusing the stale one.
const PENDING_REUSE_WINDOW_MS = 3 * 60 * 1000;

function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function assertReadOk(error, what) {
  if (error) {
    const e = new Error(`We couldn't confirm ${what} right now. Please try again in a moment.`);
    e.statusCode = 503;
    throw e;
  }
}

function xmlValue(xml, tag) {
  const m = String(xml || '').match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return m ? m[1] : null;
}

async function postHitXml(baseUrl, xml) {
  const response = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml });
  return response.text();
}

/* ---------------------------------------------------
   START — fires a Purchase on the venue's physical terminal for a booking's remaining balance.
--------------------------------------------------- */
async function start(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { svc, salonId } = await requireVenueAuth(req);
  const { booking_id, tip_pct } = req.body || {};
  if (!booking_id) { const e = new Error('booking_id is required'); e.statusCode = 400; throw e; }

  const { data: booking, error: bookingErr } = await svc.from('bookings').select('*').eq('id', booking_id).eq('salon_id', salonId).maybeSingle();
  assertReadOk(bookingErr, 'this booking');
  if (!booking) { const e = new Error('Booking not found'); e.statusCode = 404; throw e; }
  if (booking.status !== 'upcoming') { const e = new Error('This appointment is not awaiting checkout.'); e.statusCode = 400; throw e; }

  // Same formula as api/windcave.js's createCheckoutChargeSession — kept identical on purpose
  // so the hosted-page and physical-terminal charge paths can never disagree on amount.
  const total = Number(booking.total || 0);
  const depositPaid = booking.deposit_status === 'paid' ? Number(booking.deposit_amount || 0) : 0;
  const pct = Math.max(0, Math.min(Number(tip_pct) || 0, 1));
  const tipAmount = Math.round(total * pct * 100) / 100;
  const amount = Math.round((total - depositPaid + tipAmount) * 100) / 100;
  if (!(amount > 0)) { const e = new Error('Nothing to charge for this appointment.'); e.statusCode = 400; throw e; }

  const { data: salon, error: salonErr } = await svc.from('salons')
    .select('windcave_hit_enabled,windcave_hit_user,windcave_hit_key,windcave_hit_station,windcave_hit_base_url')
    .eq('id', salonId).maybeSingle();
  assertReadOk(salonErr, 'this venue\'s terminal settings');
  if (!salon?.windcave_hit_enabled || !salon.windcave_hit_user || !salon.windcave_hit_key || !salon.windcave_hit_station) {
    const e = new Error('Physical terminal is not configured for this venue.');
    e.statusCode = 400;
    throw e;
  }

  // Reuse a still-fresh pending transaction for this booking instead of firing a second
  // terminal transaction (double-click, duplicate tab, or a resume-on-load re-check).
  const reuseSince = new Date(Date.now() - PENDING_REUSE_WINDOW_MS).toISOString();
  const { data: existing } = await svc.from('windcave_hit_transactions')
    .select('txn_ref,amount').eq('booking_id', booking.id).eq('status', 'pending')
    .gte('created_at', reuseSince).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existing) { res.status(200).json({ txn_ref: existing.txn_ref, amount: Number(existing.amount) }); return; }

  // An older attempt may have been completed on the terminal after staff left the page. Settle
  // it before firing a new charge, so a card that was actually billed is never billed twice.
  const { data: stale } = await svc.from('windcave_hit_transactions')
    .select('*').eq('booking_id', booking.id).eq('status', 'pending').is('resolved_at', null);
  for (const old of stale || []) {
    const out = await resolveTransaction(svc, salonId, salon, old).catch(() => null);
    if (out && out.complete && out.approved) {
      const e = new Error('This appointment was already paid by card on the terminal.');
      e.statusCode = 409;
      throw e;
    }
  }

  // Windcave's HIT TxnRef field is capped at 40 characters — it doesn't need to be
  // human-decodable, the booking_id is already stored alongside it in this table, which is
  // how status()/resume() look transactions back up.
  const txnRef = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const { error: insertErr } = await svc.from('windcave_hit_transactions').insert({
    salon_id: salonId, booking_id: booking.id, txn_ref: txnRef, amount, tip_amount: tipAmount, status: 'pending',
  });
  if (insertErr) { const e = new Error('Could not start the terminal transaction. Please try again.'); e.statusCode = 500; throw e; }

  const xml = `<Scr action="doScrHIT" user="${escapeXml(salon.windcave_hit_user)}" key="${escapeXml(salon.windcave_hit_key)}">
  <Amount>${amount.toFixed(2)}</Amount>
  <Cur>NZD</Cur>
  <TxnType>Purchase</TxnType>
  <Station>${escapeXml(salon.windcave_hit_station)}</Station>
  <TxnRef>${escapeXml(txnRef)}</TxnRef>
  <DeviceId>Blooma</DeviceId>
  <PosName>Blooma</PosName>
  <PosVersion>1.0</PosVersion>
  <VendorId>Blooma</VendorId>
  <MRef>Booking ${booking.id}</MRef>
</Scr>`;
  await postHitXml(salon.windcave_hit_base_url || WINDCAVE_HIT_PROD_BASE_URL, xml);

  res.status(200).json({ txn_ref: txnRef, amount });
}

/* ---------------------------------------------------
   STATUS — polls the terminal for the outcome of a transaction started via start(); marks the
   booking completed the moment Windcave reports an approved result.
--------------------------------------------------- */
const SALON_HIT_COLUMNS = 'windcave_hit_user,windcave_hit_key,windcave_hit_station,windcave_hit_base_url';
// A pending row this old is given up on (the terminal long since timed out or lost it).
const PENDING_EXPIRY_MS = 24 * 60 * 60 * 1000;

async function loadSalonHit(svc, salonId) {
  const { data: salon, error } = await svc.from('salons').select(SALON_HIT_COLUMNS).eq('id', salonId).maybeSingle();
  assertReadOk(error, "this venue's terminal settings");
  return salon;
}

// Single place that asks Windcave for a transaction's outcome and, if it's final, records it and
// completes the booking. Used by the browser's live poll (status), by the background reconcile
// that makes sure a charge is never lost when the checkout tab is closed mid-payment, and by
// start/resume to avoid double-charging a booking whose earlier attempt actually went through.
async function resolveTransaction(svc, salonId, salon, txn) {
  if (txn.resolved_at) {
    return { complete: true, approved: txn.status === 'approved', responseText: txn.response_text, authCode: txn.auth_code, dpsTxnRef: txn.dps_txn_ref, fresh: false };
  }

  const xml = `<Scr action="doScrHIT" user="${escapeXml(salon.windcave_hit_user)}" key="${escapeXml(salon.windcave_hit_key)}">
  <Station>${escapeXml(salon.windcave_hit_station)}</Station>
  <TxnType>Status</TxnType>
  <TxnRef>${escapeXml(txn.txn_ref)}</TxnRef>
</Scr>`;
  const raw = await postHitXml(salon.windcave_hit_base_url || WINDCAVE_HIT_PROD_BASE_URL, xml);

  if (xmlValue(raw, 'Complete') !== '1') return { complete: false };

  const approved = xmlValue(raw, 'AP') === '1';
  const responseText = xmlValue(raw, 'RT');
  const responseCode = xmlValue(raw, 'RC');
  const authCode = xmlValue(raw, 'AC');
  const dpsTxnRef = xmlValue(raw, 'TR');

  // Only the caller that flips resolved_at from null gets to report this as freshly resolved.
  const { data: won } = await svc.from('windcave_hit_transactions').update({
    status: approved ? 'approved' : 'declined',
    dps_txn_ref: dpsTxnRef, response_code: responseCode, response_text: responseText, auth_code: authCode,
    resolved_at: new Date().toISOString(),
  }).eq('id', txn.id).is('resolved_at', null).select('id');

  if (approved) {
    // Atomic guarded update, not read-then-write — if some other path already completed this
    // booking (e.g. staff also hit Accept on the cash flow), this just no-ops harmlessly.
    await svc.from('bookings').update({
      status: 'completed', payment_method: 'card', tip_amount: Number(txn.tip_amount || 0), windcave_transaction_id: dpsTxnRef,
      completed_at: new Date().toISOString(),
    }).eq('id', txn.booking_id).eq('salon_id', salonId).eq('status', 'upcoming');
  }

  return { complete: true, approved, responseText, authCode, dpsTxnRef, fresh: !!(won && won.length) };
}

async function status(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { svc, salonId } = await requireVenueAuth(req);
  const { txn_ref } = req.body || {};
  if (!txn_ref) { const e = new Error('txn_ref is required'); e.statusCode = 400; throw e; }

  const { data: txn, error: txnErr } = await svc.from('windcave_hit_transactions').select('*').eq('txn_ref', txn_ref).eq('salon_id', salonId).maybeSingle();
  assertReadOk(txnErr, 'this transaction');
  if (!txn) { const e = new Error('Transaction not found'); e.statusCode = 404; throw e; }

  const salon = txn.resolved_at ? null : await loadSalonHit(svc, salonId);
  const out = await resolveTransaction(svc, salonId, salon, txn);
  if (!out.complete) { res.status(200).json({ complete: false }); return; }
  res.status(200).json({ complete: true, approved: out.approved, responseText: out.responseText, authCode: out.authCode, dpsTxnRef: out.dpsTxnRef });
}

/* ---------------------------------------------------
   RECONCILE — settles every still-unresolved terminal charge for the caller's venue,
   independent of whether anyone still has that checkout tab open. HIT has no webhook, so
   without this a card charged after staff navigated away would never mark the booking paid.
   Called by sidebar-badges.js on every venue-admin page load and on a short interval.
--------------------------------------------------- */
async function reconcile(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { svc, salonId } = await requireVenueAuth(req);

  const expiredBefore = new Date(Date.now() - PENDING_EXPIRY_MS).toISOString();
  await svc.from('windcave_hit_transactions')
    .update({ status: 'timeout', resolved_at: new Date().toISOString() })
    .eq('salon_id', salonId).eq('status', 'pending').is('resolved_at', null).lt('created_at', expiredBefore);

  const { data: pending, error } = await svc.from('windcave_hit_transactions')
    .select('*').eq('salon_id', salonId).eq('status', 'pending').is('resolved_at', null)
    .order('created_at', { ascending: true }).limit(20);
  assertReadOk(error, 'pending terminal payments');
  if (!pending || !pending.length) { res.status(200).json({ completed: [], pending: 0 }); return; }

  const salon = await loadSalonHit(svc, salonId);
  const completed = [];
  let stillPending = 0;
  for (const txn of pending) {
    try {
      const out = await resolveTransaction(svc, salonId, salon, txn);
      if (!out.complete) stillPending++;
      else if (out.approved && out.fresh) completed.push(txn.booking_id);
    } catch (err) {
      console.error('windcave-hit [reconcile] txn', txn.txn_ref, err.message);
      stillPending++;
    }
  }
  res.status(200).json({ completed, pending: stillPending });
}

/* ---------------------------------------------------
   RESUME — used on checkout page load to detect an in-flight terminal charge for a booking
   (e.g. staff closed/reloaded the tab mid-charge) so the UI can jump straight back into polling
   instead of showing a fresh summary and risking a second transaction on the same booking.
--------------------------------------------------- */
async function resume(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { svc, salonId } = await requireVenueAuth(req);
  const { booking_id } = req.body || {};
  if (!booking_id) { const e = new Error('booking_id is required'); e.statusCode = 400; throw e; }

  const { data: pending, error } = await svc.from('windcave_hit_transactions')
    .select('*').eq('booking_id', booking_id).eq('salon_id', salonId).eq('status', 'pending').is('resolved_at', null)
    .order('created_at', { ascending: false });
  assertReadOk(error, 'this booking\'s payment status');
  if (!pending || !pending.length) { res.status(200).json({ txn_ref: null, amount: null, paid: false }); return; }

  // Settle anything left over from a tab that was closed mid-charge; if it turns out the card
  // was billed, the booking is now completed and the page should say so, not offer a new charge.
  const salon = await loadSalonHit(svc, salonId);
  const reuseSince = Date.now() - PENDING_REUSE_WINDOW_MS;
  let inFlight = null;
  for (const txn of pending) {
    const out = await resolveTransaction(svc, salonId, salon, txn).catch(() => null);
    if (out && out.complete && out.approved) { res.status(200).json({ txn_ref: null, amount: null, paid: true }); return; }
    if (out && !out.complete && !inFlight && new Date(txn.created_at).getTime() >= reuseSince) inFlight = txn;
  }
  res.status(200).json({ txn_ref: inFlight?.txn_ref || null, amount: inFlight ? Number(inFlight.amount) : null, paid: false });
}

module.exports = async (req, res) => {
  const action = req.query?.action;
  try {
    if (action === 'start') return await start(req, res);
    if (action === 'status') return await status(req, res);
    if (action === 'resume') return await resume(req, res);
    if (action === 'reconcile') return await reconcile(req, res);
    res.status(400).json({ error: 'Unknown or missing ?action=' });
  } catch (err) {
    console.error(`windcave-hit [${action}] error:`, err.message);
    res.status(err.statusCode || 500).json({ error: err.message || 'Request failed' });
  }
};
