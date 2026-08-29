const Stripe = require('stripe');
const { requireVenueAuth } = require('../_lib/auth');
const { stylistCount, planForSeatCount, monthlyCost } = require('../_lib/plan');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Called (fire-and-forget) whenever team.html adds or removes a stylist, so an
// existing Stripe subscription's price/quantity always matches the real roster.
//
// Upgrades (adding a stylist, or Solo -> Team) apply immediately with proration —
// the venue gets the extra seat right away and pays the prorated difference on
// their next invoice. Downgrades (removing a stylist) are deferred to the start
// of the next billing period via a Stripe Subscription Schedule — no mid-cycle
// credits/charges, the venue simply keeps what they already paid for until it
// renews, then drops to the cheaper plan. This mirrors how most SaaS billing
// (and most people's expectations) handles seat changes.
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { svc, salonId } = await requireVenueAuth(req);
    const { data: billingRow } = await svc
      .from('venue_billing')
      .select('stripe_subscription_id,stripe_subscription_item_id,stripe_schedule_id,plan_id,seat_count,pending_plan_id,pending_seat_count')
      .eq('salon_id', salonId)
      .maybeSingle();

    if (!billingRow?.stripe_subscription_id) {
      res.status(200).json({ synced: false, reason: 'no_subscription' });
      return;
    }

    const seatCount = await stylistCount(svc, salonId);
    const desired = planForSeatCount(seatCount);
    const currentCost = monthlyCost(billingRow.plan_id, billingRow.seat_count);
    const desiredCost = monthlyCost(desired.planId, desired.quantity);

    const liveMatches = desired.planId === billingRow.plan_id && desired.quantity === billingRow.seat_count;
    const pendingMatches = billingRow.pending_plan_id === desired.planId && billingRow.pending_seat_count === desired.quantity;

    if (liveMatches && (!billingRow.pending_plan_id || pendingMatches)) {
      // Live plan already matches, and there's no stale scheduled change to worry about either.
      res.status(200).json({ synced: false, reason: 'unchanged' });
      return;
    }

    // A schedule from a previous pending downgrade may still be attached — release it whenever
    // the roster no longer wants that change (whether we're about to set a new one below, or the
    // live plan already matches desired and there's simply nothing left to schedule).
    if (billingRow.stripe_schedule_id) {
      try { await stripe.subscriptionSchedules.release(billingRow.stripe_schedule_id); } catch (e) { /* already released/finished */ }
    }

    if (liveMatches) {
      // Roster changed back to what's already live (e.g. a stylist was re-added before a
      // scheduled downgrade took effect) — just drop the now-stale pending change.
      await svc.from('venue_billing').update({
        stripe_schedule_id: null, pending_plan_id: null, pending_seat_count: null, pending_effective_at: null,
      }).eq('salon_id', salonId);
      res.status(200).json({ synced: true, effective: 'cancelled_pending', planId: desired.planId, quantity: desired.quantity });
      return;
    }

    if (desiredCost >= currentCost) {
      // Upgrade (or lateral move) — apply now, prorate the difference onto the next invoice.
      await stripe.subscriptions.update(billingRow.stripe_subscription_id, {
        items: [{ id: billingRow.stripe_subscription_item_id, price: desired.priceId, quantity: desired.quantity }],
        proration_behavior: 'create_prorations',
      });
      await svc.from('venue_billing').update({
        plan_id: desired.planId,
        seat_count: desired.quantity,
        stripe_schedule_id: null,
        pending_plan_id: null,
        pending_seat_count: null,
        pending_effective_at: null,
      }).eq('salon_id', salonId);
      res.status(200).json({ synced: true, effective: 'immediate', planId: desired.planId, quantity: desired.quantity });
      return;
    }

    // Downgrade — defer to the next renewal via a Subscription Schedule so this
    // period's already-paid-for Team time isn't touched.
    const subscription = await stripe.subscriptions.retrieve(billingRow.stripe_subscription_id);
    const currentItem = subscription.items.data[0];
    const periodEnd = currentItem.current_period_end ?? subscription.current_period_end;

    const schedule = await stripe.subscriptionSchedules.create({ from_subscription: billingRow.stripe_subscription_id });
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: 'release',
      phases: [
        {
          items: [{ price: currentItem.price.id, quantity: currentItem.quantity }],
          start_date: schedule.phases[0].start_date,
          end_date: periodEnd,
        },
        {
          items: [{ price: desired.priceId, quantity: desired.quantity }],
          iterations: 1,
        },
      ],
    });

    await svc.from('venue_billing').update({
      stripe_schedule_id: schedule.id,
      pending_plan_id: desired.planId,
      pending_seat_count: desired.quantity,
      pending_effective_at: new Date(periodEnd * 1000).toISOString(),
    }).eq('salon_id', salonId);

    res.status(200).json({ synced: true, effective: 'next_renewal', planId: desired.planId, quantity: desired.quantity, effectiveAt: periodEnd });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Could not sync seats' });
  }
};
