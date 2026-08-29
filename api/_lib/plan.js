// Solo: flat $29/mo (1 stylist). Team: $19/mo per stylist once there are 2+.
// Team member count comes from app_config.config.stylists — the same array
// team.html reads/writes — so seat count always reflects the real roster.
async function stylistCount(svc, salonId) {
  const { data, error } = await svc
    .from('app_config')
    .select('config')
    .eq('salon_id', salonId)
    .maybeSingle();
  if (error) throw error;
  const stylists = data?.config?.stylists;
  return Array.isArray(stylists) ? Math.max(1, stylists.length) : 1;
}

function planForSeatCount(seatCount) {
  if (seatCount >= 2) {
    return { planId: 'team', priceId: process.env.STRIPE_PRICE_TEAM_SEAT, quantity: seatCount };
  }
  return { planId: 'solo', priceId: process.env.STRIPE_PRICE_SOLO, quantity: 1 };
}

function monthlyCost(planId, quantity) {
  return planId === 'team' ? 19 * quantity : 29;
}

module.exports = { stylistCount, planForSeatCount, monthlyCost };
