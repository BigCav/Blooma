const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = "https://jzyvnipzdgfjportrbpo.supabase.co";

function serviceClient() {
  return createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Verifies the caller's Supabase access token and returns the salon they own/staff,
// mirroring the owner_profiles membership check every SECURITY DEFINER RPC in this
// project already does — just done here in Node since these are server-side endpoints
// the client can't reach a Postgres RPC to authenticate itself against.
async function requireVenueAuth(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    const err = new Error('Not authorised');
    err.statusCode = 401;
    throw err;
  }
  const svc = serviceClient();
  const { data: userData, error: userErr } = await svc.auth.getUser(token);
  if (userErr || !userData?.user) {
    const err = new Error('Not authorised');
    err.statusCode = 401;
    throw err;
  }
  const { data: owner, error: ownerErr } = await svc
    .from('owner_profiles')
    .select('salon_id,role')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (ownerErr || !owner?.salon_id) {
    const err = new Error('No venue is connected to this account.');
    err.statusCode = 403;
    throw err;
  }
  return { svc, userId: userData.user.id, salonId: owner.salon_id, role: owner.role };
}

// Same token check as requireVenueAuth but for customer-facing purchases (gift cards,
// packages) — these don't require an owner_profiles row, just a logged-in user.
async function requireCustomerAuth(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    const err = new Error('Not authorised');
    err.statusCode = 401;
    throw err;
  }
  const svc = serviceClient();
  const { data: userData, error: userErr } = await svc.auth.getUser(token);
  if (userErr || !userData?.user) {
    const err = new Error('Not authorised');
    err.statusCode = 401;
    throw err;
  }
  return { svc, userId: userData.user.id, email: userData.user.email };
}

module.exports = { serviceClient, requireVenueAuth, requireCustomerAuth, SUPABASE_URL };
