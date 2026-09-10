const { serviceClient } = require('../_lib/auth');

const HOLD_MINUTES = 15;

// A booking made through the public checkout flow that needs a deposit reserves its slot
// (it shows up in get_marketplace_venues' booked_slots) from the moment it's created — even
// if the customer never finishes paying the deposit. Nothing was actually flipping these back
// open again: there's no scheduled job anywhere in this project enforcing a time limit, so an
// abandoned Stripe checkout left the slot reserved indefinitely.
//
// Vercel's Hobby plan only allows daily cron schedules, which is useless for a 15-minute
// window, so instead this runs opportunistically — called (fire-and-forget or awaited) from
// every place that's about to read a venue's availability: the customer checkout boot, the
// venue profile page, and the admin bookings pages. Whichever of those loads first after the
// window elapses sweeps it, which in practice is within moments given normal traffic.
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const svc = serviceClient();
    const cutoff = new Date(Date.now() - HOLD_MINUTES * 60000).toISOString();
    const { data: stale, error } = await svc
      .from('bookings')
      .select('id,notes')
      .eq('status', 'upcoming')
      .eq('deposit_status', 'pending')
      .lt('created_at', cutoff);
    if (error) throw error;

    if (stale && stale.length) {
      await Promise.all(stale.map(b => svc.from('bookings').update({
        status: 'cancelled',
        notes: [b.notes, `[Auto-cancelled — deposit hold expired after ${HOLD_MINUTES} minutes]`].filter(Boolean).join(' ').trim(),
      }).eq('id', b.id)));
    }

    res.status(200).json({ expired: stale ? stale.length : 0 });
  } catch (err) {
    // Never block a page load or booking attempt over this — it's a best-effort sweep.
    res.status(200).json({ expired: 0, error: err.message || 'sweep failed' });
  }
};
