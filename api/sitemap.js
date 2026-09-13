const SUPABASE_URL = "https://jzyvnipzdgfjportrbpo.supabase.co";
const SUPABASE_KEY = "sb_publishable_1EOYX0bR8WLF9f4Wf-5NqA_73ixmjUx";
const SITE_URL = "https://blooma.co.nz";

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = async (req, res) => {
  // /privacy and /terms are noindexed (legal boilerplate, no ranking value, and their plain
  // definitional prose was getting picked up by Google's AI Overview for "what is Blooma" type
  // queries instead of the actual marketing pages) - keep them out of the sitemap accordingly.
  const staticPaths = ['/', '/explore', '/alternative-to-fresha', '/alternative-to-timely', '/salon-software-auckland', '/salon-software-hamilton'];
  let venueSlugs = [];

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_marketplace_venues`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows)) {
        venueSlugs = rows.map(v => String(v.public_slug || '').trim()).filter(Boolean);
      }
    }
  } catch (err) {
    console.error('Blooma sitemap: could not load venues', err);
  }

  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    ...staticPaths.map(p => ({ loc: `${SITE_URL}${p}`, priority: p === '/' ? '1.0' : (p === '/explore' ? '0.9' : ((p.startsWith('/alternative-to-') || p.startsWith('/salon-software-')) ? '0.7' : '0.3')) })),
    ...venueSlugs.map(slug => ({ loc: `${SITE_URL}/${slug}`, priority: '0.8' })),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>\n    <loc>${escapeXml(u.loc)}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n')}
</urlset>
`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(xml);
};
