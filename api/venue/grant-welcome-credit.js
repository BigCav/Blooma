const { requireVenueAuth } = require('../_lib/auth');

const WELCOME_CREDIT_CENTS = 6000; // $60 — matches the signup-offer copy on the marketing pages.

// Called (fire-and-forget) right after a new venue finishes onboarding, so every new
// account gets its welcome credit without anyone having to remember to add it.
// Lands in venue_wallet_ledger exactly like a referral bonus — it's not cash and can't be
// withdrawn, it just reduces what the venue owes on its next manual subscription payment
// (api/windcave.js's createSubscriptionSession applies whatever wallet balance exists against
// the price at the moment the venue pays).
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { svc, salonId } = await requireVenueAuth(req);

    const { data: existing } = await svc
      .from('venue_wallet_ledger')
      .select('id')
      .eq('salon_id', salonId)
      .eq('type', 'welcome_credit')
      .maybeSingle();
    if (existing) { res.status(200).json({ granted: false, reason: 'already_granted' }); return; }

    const { error: insertErr } = await svc.from('venue_wallet_ledger').insert([{
      salon_id: salonId,
      amount_cents: WELCOME_CREDIT_CENTS,
      type: 'welcome_credit',
      description: 'Welcome credit — new venue signup bonus',
    }]);
    if (insertErr) throw insertErr;

    res.status(200).json({ granted: true, amountCents: WELCOME_CREDIT_CENTS });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Could not grant welcome credit' });
  }
};
