// One-off manual test endpoint for the Windcave HIT (Host Initiated Transaction) API, which
// controls the physical in-person terminal directly over HTTPS — a completely separate
// integration from the REST/HPP API in api/windcave.js used for online deposits/gift cards.
// Superseded by api/windcave-hit.js for real checkout — that one reads per-venue credentials
// from the salons table and writes real booking completions. This file stays around purely as
// a raw hardware smoke test (global env-var credentials, no booking/venue auth needed) for
// verifying a brand-new terminal's connectivity before it's ever configured for a venue. HIT is
// asynchronous: a Purchase POST kicks the transaction off on the terminal, then the caller
// polls with Status requests (matching TxnRef) until the response's <Complete> is "1".
//
// user/key are never sent to the browser — this file builds and sends the XML server-side only.
const WINDCAVE_HIT_BASE_URL = process.env.WINDCAVE_HIT_BASE_URL || 'https://uat.windcave.com/hit/pos.aspx';

function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function credentials() {
  const user = process.env.WINDCAVE_HIT_USER;
  const key = process.env.WINDCAVE_HIT_KEY;
  const station = process.env.WINDCAVE_HIT_STATION;
  if (!user || !key || !station) {
    const err = new Error('Windcave HIT credentials are not configured on the server.');
    err.statusCode = 500;
    throw err;
  }
  return { user, key, station };
}

async function postXml(xml) {
  const response = await fetch(WINDCAVE_HIT_BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: xml,
  });
  const text = await response.text();
  return { httpStatus: response.status, raw: text };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const action = req.query.action;

  try {
    const { user, key, station } = credentials();

    if (action === 'start') {
      const amount = Number(req.body?.amount) > 0 ? Number(req.body.amount).toFixed(2) : '1.00';
      const txnRef = `bloomahit${Date.now()}`;
      const xml = `<Scr action="doScrHIT" user="${escapeXml(user)}" key="${escapeXml(key)}">
  <Amount>${amount}</Amount>
  <Cur>NZD</Cur>
  <TxnType>Purchase</TxnType>
  <Station>${escapeXml(station)}</Station>
  <TxnRef>${escapeXml(txnRef)}</TxnRef>
  <DeviceId>BloomaTest</DeviceId>
  <PosName>Blooma</PosName>
  <PosVersion>1.0</PosVersion>
  <VendorId>Blooma</VendorId>
  <MRef>Blooma HIT test</MRef>
</Scr>`;
      const result = await postXml(xml);
      res.status(200).json({ txnRef, ...result });
      return;
    }

    if (action === 'status') {
      const txnRef = req.body?.txnRef;
      if (!txnRef) { res.status(400).json({ error: 'Missing txnRef' }); return; }
      const xml = `<Scr action="doScrHIT" user="${escapeXml(user)}" key="${escapeXml(key)}">
  <Station>${escapeXml(station)}</Station>
  <TxnType>Status</TxnType>
  <TxnRef>${escapeXml(txnRef)}</TxnRef>
</Scr>`;
      const result = await postXml(xml);
      res.status(200).json(result);
      return;
    }

    res.status(400).json({ error: 'Unknown action. Use ?action=start or ?action=status.' });
  } catch (e) {
    res.status(e.statusCode || 502).json({ error: e.message || 'Windcave HIT request failed' });
  }
};
