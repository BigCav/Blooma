const Stripe = require('stripe');
const { serviceClient } = require('../_lib/auth');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Signature verification needs the exact raw request body, so we opt out of
// Vercel's default JSON body parsing for this one route.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function generateGiftCardCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid misreads
  let code = '';
  for (let i = 0; i < 10; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

async function fulfillGiftCardPurchase(svc, session) {
  // Stripe can redeliver checkout.session.completed, so guard against double-issuing.
  const { data: already } = await svc.from('gift_cards').select('id').eq('stripe_checkout_session_id', session.id).maybeSingle();
  if (already) return;

  const meta = session.metadata || {};
  const amount = Number(meta.amount);
  let code, existing;
  // Extremely unlikely, but guard against a code collision anyway.
  do {
    code = generateGiftCardCode();
    ({ data: existing } = await svc.from('gift_cards').select('id').eq('code', code).maybeSingle());
  } while (existing);

  await svc.from('gift_cards').insert({
    salon_id: meta.salon_id,
    code,
    purchaser_user_id: meta.purchaser_user_id || null,
    purchaser_name: meta.purchaser_name || null,
    purchaser_email: session.customer_details?.email || null,
    recipient_name: meta.recipient_name || null,
    recipient_email: meta.recipient_email || null,
    initial_value: amount,
    remaining_balance: amount,
    currency: 'nzd',
    status: 'active',
    stripe_checkout_session_id: session.id,
    expires_at: new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

async function fulfillPackagePurchase(svc, session) {
  const { data: already } = await svc.from('customer_packages').select('id').eq('stripe_checkout_session_id', session.id).maybeSingle();
  if (already) return;

  const meta = session.metadata || {};
  const sessionsTotal = parseInt(meta.sessions_total, 10) || 1;

  await svc.from('customer_packages').insert({
    salon_id: meta.salon_id,
    package_offer_id: meta.package_offer_id || null,
    service_id: meta.service_id || null,
    service_name_snapshot: meta.service_name_snapshot || null,
    customer_user_id: meta.customer_user_id,
    customer_name: session.customer_details?.name || null,
    customer_email: session.customer_details?.email || null,
    sessions_total: sessionsTotal,
    sessions_remaining: sessionsTotal,
    price_paid: Number(meta.price) || 0,
    status: 'active',
    stripe_checkout_session_id: session.id,
  });
}

const REFERRAL_PAYOUT_CENTS = 12000;

// Pushes any not-yet-applied wallet ledger credits (or debits) for a venue onto its Stripe
// customer balance, so they land as an automatic reduction on that venue's next invoice.
// A ledger row can only be applied once a venue actually has a Stripe customer — a venue that
// hasn't subscribed yet earns the credit but it stays unapplied until they do, at which point
// this same function (called from syncSubscriptionToDb on every billing sync) sweeps it in.
async function applyUnappliedWalletCredits(svc, salonId) {
  const { data: billing } = await svc.from('venue_billing').select('stripe_customer_id').eq('salon_id', salonId).maybeSingle();
  const customerId = billing?.stripe_customer_id;
  if (!customerId) return;

  const { data: unapplied } = await svc
    .from('venue_wallet_ledger')
    .select('id, amount_cents, description')
    .eq('salon_id', salonId)
    .eq('stripe_applied', false);
  if (!unapplied || !unapplied.length) return;

  for (const row of unapplied) {
    try {
      const balanceTx = await stripe.customers.createBalanceTransaction(customerId, {
        amount: -row.amount_cents, // Stripe convention: negative = credit (reduces what's owed).
        currency: 'nzd',
        description: row.description || 'Blooma wallet credit',
      });
      await svc
        .from('venue_wallet_ledger')
        .update({ stripe_applied: true, stripe_balance_transaction_id: balanceTx.id })
        .eq('id', row.id);
    } catch (err) {
      console.error('Blooma: failed to apply wallet credit to Stripe balance', salonId, row.id, err);
      // Leave it unapplied — the next billing sync for this venue will retry.
    }
  }
}

async function processReferralConversion(svc, salonId) {
  // Only ever pays out once: the moment we flip a referral's status to 'paid_out' below, this
  // query stops matching, so Stripe redelivering 'active' status updates is naturally a no-op.
  const { data: referral } = await svc
    .from('venue_referrals')
    .select('id, referrer_salon_id, referred_salon_id')
    .eq('referred_salon_id', salonId)
    .eq('status', 'pending')
    .maybeSingle();
  if (!referral) return;

  await svc.from('venue_wallet_ledger').insert([
    {
      salon_id: referral.referrer_salon_id,
      amount_cents: REFERRAL_PAYOUT_CENTS,
      type: 'referral_bonus_referrer',
      description: 'Referral bonus — a venue you referred went live on a paid plan',
      related_referral_id: referral.id,
    },
    {
      salon_id: referral.referred_salon_id,
      amount_cents: REFERRAL_PAYOUT_CENTS,
      type: 'referral_bonus_referred',
      description: 'Welcome bonus — you signed up via a referral',
      related_referral_id: referral.id,
    },
  ]);

  await svc
    .from('venue_referrals')
    .update({ status: 'paid_out', converted_at: new Date().toISOString() })
    .eq('id', referral.id);

  await applyUnappliedWalletCredits(svc, referral.referrer_salon_id);
  await applyUnappliedWalletCredits(svc, referral.referred_salon_id);
}

function planIdForPrice(priceId) {
  if (priceId === process.env.STRIPE_PRICE_TEAM_SEAT) return 'team';
  if (priceId === process.env.STRIPE_PRICE_SOLO) return 'solo';
  return null;
}

async function syncSubscriptionToDb(svc, subscription) {
  const salonId = subscription.metadata?.salon_id;
  if (!salonId) return;
  const item = subscription.items?.data?.[0];
  const priceId = item?.price?.id || null;
  const planId = planIdForPrice(priceId);
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  // Recent Stripe API versions moved current_period_end from the subscription to each item.
  const periodEnd = item?.current_period_end ?? subscription.current_period_end ?? null;

  let cardBrand = null, cardLast4 = null, cardExp = null;
  try {
    const pm = subscription.default_payment_method
      ? await stripe.paymentMethods.retrieve(subscription.default_payment_method)
      : null;
    if (pm?.card) {
      cardBrand = pm.card.brand;
      cardLast4 = pm.card.last4;
      cardExp = `${String(pm.card.exp_month).padStart(2, '0')}/${pm.card.exp_year}`;
    }
  } catch (e) { /* card display is a nice-to-have, don't fail the sync over it */ }

  // subscription.schedule is the attached Subscription Schedule's id (or null once a
  // deferred-downgrade schedule has run its course and released control back to the
  // subscription) — used to clear the "pending downgrade" banner once it actually lands.
  const scheduleId = typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule?.id || null;

  const row = {
    salon_id: salonId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    stripe_subscription_item_id: item?.id || null,
    plan_id: planId,
    seat_count: item?.quantity || 1,
    status: subscription.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    card_brand: cardBrand,
    card_last4: cardLast4,
    card_exp: cardExp,
    subscribed_at: new Date(subscription.start_date * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (!scheduleId) {
    // No schedule attached (or it just finished) — any pending downgrade has either
    // landed or was never scheduled, so there's nothing left to show as "pending".
    row.stripe_schedule_id = null;
    row.pending_plan_id = null;
    row.pending_seat_count = null;
    row.pending_effective_at = null;
  }

  await svc.from('venue_billing').upsert(row, { onConflict: 'salon_id' });

  if (subscription.status === 'active') await processReferralConversion(svc, salonId);
  // Catches up any wallet credit this venue earned before it had a Stripe customer to apply
  // it to (e.g. it referred someone while still on trial, or was itself referred and only just
  // subscribed) — runs on every billing sync, not just the moment a referral converts.
  await applyUnappliedWalletCredits(svc, salonId);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    return;
  }

  const svc = serviceClient();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          await syncSubscriptionToDb(svc, subscription);
        } else if (session.mode === 'payment') {
          const purchaseType = session.metadata?.blooma_purchase_type;
          if (purchaseType === 'gift_card') await fulfillGiftCardPurchase(svc, session);
          else if (purchaseType === 'package') await fulfillPackagePurchase(svc, session);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await syncSubscriptionToDb(svc, event.data.object);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          await syncSubscriptionToDb(svc, subscription);
        }
        break;
      }
      default:
        break;
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Blooma Stripe webhook handling error', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
};
