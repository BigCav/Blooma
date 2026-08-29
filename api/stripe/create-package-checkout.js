const Stripe = require('stripe');
const { requireCustomerAuth } = require('../_lib/auth');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { svc, userId, email } = await requireCustomerAuth(req);
    const { salon_id, package_offer_id } = req.body || {};

    if (!salon_id || !package_offer_id) {
      const e = new Error('salon_id and package_offer_id are required');
      e.statusCode = 400;
      throw e;
    }

    const { data: salonRow } = await svc.from('salons').select('id,name,public_slug').eq('id', salon_id).maybeSingle();
    if (!salonRow) { const e = new Error('Venue not found'); e.statusCode = 404; throw e; }

    const { data: configRow } = await svc.from('app_config').select('config').eq('salon_id', salon_id).maybeSingle();
    const packages = configRow?.config?.packages || [];
    // Price and session count come from the venue's own saved catalog, never from the
    // client, so a tampered request can't buy a package for less than it costs.
    const offer = packages.find((p) => String(p.id) === String(package_offer_id));
    if (!offer || offer.active === false) {
      const e = new Error('This package is no longer available');
      e.statusCode = 404;
      throw e;
    }

    const services = configRow?.config?.services || [];
    const service = services.find((s) => String(s.id) === String(offer.service_id));

    const origin = req.headers['origin'] || `https://${req.headers['host']}`;
    const venuePath = `/venue/${encodeURIComponent(salonRow.public_slug || salon_id)}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: 'nzd',
          unit_amount: Math.round(Number(offer.price) * 100),
          product_data: { name: `${salonRow.name} — ${offer.name}` },
        },
        quantity: 1,
      }],
      success_url: `${origin}${venuePath}?purchase=package-success`,
      cancel_url: `${origin}${venuePath}?purchase=cancelled`,
      metadata: {
        blooma_purchase_type: 'package',
        salon_id,
        customer_user_id: userId,
        package_offer_id: String(offer.id),
        service_id: offer.service_id ? String(offer.service_id) : '',
        service_name_snapshot: service?.name || offer.name,
        sessions_total: String(offer.sessions),
        price: String(offer.price),
      },
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Could not start checkout' });
  }
};
