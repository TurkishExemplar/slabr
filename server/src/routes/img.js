const express = require('express');

const router = express.Router();

// ── Same-origin image proxy ───────────────────────────────────────────────────
//
// The PriceCharting image CDN serves no Access-Control-Allow-Origin header, so
// the client's canvas-based white-background detection can never read pixels
// from those images directly.  This proxy streams a WHITELISTED image with
// permissive CORS so the probe works.
//
// Strict prefix whitelist — this must never become an open proxy (SSRF).
const ALLOWED_PREFIXES = [
  'https://storage.googleapis.com/images.pricecharting.com/',
  'https://i.ebayimg.com/',
];

router.get('/', async (req, res) => {
  const url = String(req.query.url ?? '');
  if (!ALLOWED_PREFIXES.some(p => url.startsWith(p))) {
    return res.status(400).json({ error: 'URL not allowed' });
  }

  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok) {
      return res.status(upstream.status).end();
    }
    const type = upstream.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) {
      return res.status(415).json({ error: 'Not an image' });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    // 8 MB ceiling — card images are far smaller
    if (buf.length > 8 * 1024 * 1024) {
      return res.status(413).json({ error: 'Image too large' });
    }

    res.set({
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400, immutable',
    });
    res.send(buf);
  } catch (err) {
    console.warn(`[img-proxy] ${url} failed: ${err.message}`);
    res.status(502).end();
  }
});

module.exports = router;
