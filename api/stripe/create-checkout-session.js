const Stripe = require('stripe');
const { requireVenueAuth } = require('../_lib/auth');
const { stylistCount, planForSeatCount } = require('../_lib/plan');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { svc, salonId } = await requireVenueAuth(req);

    const { data: salonRow } = await svc.from('salons').select('name').eq('id', salonId).maybeSingle();
    const { data: billingRow } = await svc.from('venue_billing').select('stripe_customer_id').eq('salon_id', salonId).maybeSingle();

    let customerId = billingRow?.stripe_customer_id || null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: salonRow?.name || salonId,
        metadata: { salon_id: salonId },
      });
      customerId = customer.id;
      await svc.from('venue_billing').upsert({ salon_id: salonId, stripe_customer_id: customerId }, { onConflict: 'salon_id' });
    }

    const seatCount = await stylistCount(svc, salonId);
    const { priceId, quantity } = planForSeatCount(seatCount);

    const origin = req.headers['origin'] || `https://${req.headers['host']}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity }],
      success_url: `${origin}/venue/admin/settings?billing=success`,
      cancel_url: `${origin}/venue/admin/settings?billing=cancelled`,
      subscription_data: { metadata: { salon_id: salonId } },
      allow_promotion_codes: true,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Could not start checkout' });
  }
};
