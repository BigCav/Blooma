const Stripe = require('stripe');
const { requireVenueAuth } = require('../_lib/auth');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { svc, salonId } = await requireVenueAuth(req);
    const { data: billingRow } = await svc.from('venue_billing').select('stripe_customer_id').eq('salon_id', salonId).maybeSingle();
    if (!billingRow?.stripe_customer_id) {
      res.status(400).json({ error: 'No billing account yet — subscribe first.' });
      return;
    }

    const origin = req.headers['origin'] || `https://${req.headers['host']}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: billingRow.stripe_customer_id,
      return_url: `${origin}/venue/admin/settings`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Could not open billing portal' });
  }
};
