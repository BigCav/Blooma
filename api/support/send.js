const { SUPABASE_URL } = require('../_lib/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public, unauthenticated endpoint (the for-business support form has no login) — validates
// and caps the input server-side, then relays it to the send-email edge function using this
// project's service-role key so hello@blooma.co.nz gets it, with reply-to set to the sender.
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { name, email, message } = req.body || {};
    const cleanName = String(name || '').trim().slice(0, 120);
    const cleanEmail = String(email || '').trim().slice(0, 200);
    const cleanMessage = String(message || '').trim().slice(0, 4000);
    if (!cleanName || !cleanEmail || !cleanMessage) {
      const e = new Error('Name, email and message are all required.');
      e.statusCode = 400;
      throw e;
    }
    if (!EMAIL_RE.test(cleanEmail)) {
      const e = new Error('Please enter a valid email address.');
      e.statusCode = 400;
      throw e;
    }

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        type: 'support_request',
        to: 'hello@blooma.co.nz',
        data: { name: cleanName, email: cleanEmail, message: cleanMessage, replyTo: cleanEmail },
      }),
    });
    const out = await resp.json().catch(() => null);
    if (!resp.ok || !out?.sent) {
      const e = new Error((out && out.error) || 'Could not send your message. Please try again.');
      e.statusCode = 502;
      throw e;
    }

    res.status(200).json({ sent: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ sent: false, error: err.message || 'Something went wrong.' });
  }
};
