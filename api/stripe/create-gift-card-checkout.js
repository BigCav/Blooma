const Stripe = require('stripe');
const { requireCustomerAuth } = require('../_lib/auth');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const MIN_AMOUNT = 10;
const MAX_AMOUNT = 500;

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { svc, userId, email } = await requireCustomerAuth(req);
    const { salon_id, amount, recipient_name, recipient_email, purchaser_name } = req.body || {};

    if (!salon_id) { const e = new Error('salon_id is required'); e.statusCode = 400; throw e; }
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount < MIN_AMOUNT || numAmount > MAX_AMOUNT) {
      const e = new Error(`Gift card amount must be between $${MIN_AMOUNT} and $${MAX_AMOUNT}`);
      e.statusCode = 400;
      throw e;
    }

    const { data: salonRow } = await svc.from('salons').select('id,name,public_slug').eq('id', salon_id).maybeSingle();
    if (!salonRow) { const e = new Error('Venue not found'); e.statusCode = 404; throw e; }

    const origin = req.headers['origin'] || `https://${req.headers['host']}`;
    const venuePath = `/venue/${encodeURIComponent(salonRow.public_slug || salon_id)}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: 'nzd',
          unit_amount: Math.round(numAmount * 100),
          product_data: { name: `${salonRow.name} gift card` },
        },
        quantity: 1,
      }],
      success_url: `${origin}${venuePath}?purchase=giftcard-success`,
      cancel_url: `${origin}${venuePath}?purchase=cancelled`,
      metadata: {
        blooma_purchase_type: 'gift_card',
        salon_id,
        purchaser_user_id: userId,
        purchaser_name: purchaser_name || '',
        recipient_name: recipient_name || '',
        recipient_email: recipient_email || '',
        amount: String(numAmount),
      },
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Could not start checkout' });
  }
};
