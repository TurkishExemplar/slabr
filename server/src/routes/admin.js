const express = require('express');
const pool    = require('../db');
const { runEbayJob, priceSingleItem, fetchCardImage, fetchPriceCharting } = require('../jobs/ebay');

const router = express.Router();

// ── Full eBay price refresh ───────────────────────────────────────────────────
// POST /api/admin/ebay-job  — triggers price fetch for every item in the DB.
// GET  /api/admin/ebay-job  — kept for backward compat (curl usage).

async function handleFullJob(req, res) {
  try {
    const result = await runEbayJob();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[admin ebay-job]', err.message);
    res.status(500).json({ error: err.message });
  }
}

router.post('/ebay-job', handleFullJob);
router.get('/ebay-job',  handleFullJob);

// ── Single-item price refresh ─────────────────────────────────────────────────
// POST /api/admin/ebay-job/:catalog_id
// Prices all (condition, grade) combos for one catalog entry.

router.post('/ebay-job/:catalog_id', async (req, res) => {
  const catalogId = parseInt(req.params.catalog_id);
  if (isNaN(catalogId)) {
    return res.status(400).json({ error: 'Invalid catalog_id' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT DISTINCT condition, grade FROM portfolio_items WHERE catalog_id = $1',
      [catalogId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'No portfolio items found for this catalog entry' });
    }

    const results = [];
    for (const { condition, grade } of rows) {
      const r = await priceSingleItem(catalogId, condition, grade);
      results.push({ condition, grade, ...(r ?? {}) });
    }

    res.json({ ok: true, catalog_id: catalogId, results });
  } catch (err) {
    console.error('[admin ebay-job/:catalog_id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Manual image refresh ──────────────────────────────────────────────────────
// POST /api/admin/refresh-image/:catalog_id
// Runs fetchCardImage for a specific catalog entry and unconditionally updates
// master_catalog.image_url.  Useful when an old wrong image is already saved
// and priceSingleItem's auto-refresh hasn't run yet.

router.post('/refresh-image/:catalog_id', async (req, res) => {
  const catalogId = parseInt(req.params.catalog_id);
  if (isNaN(catalogId)) {
    return res.status(400).json({ error: 'Invalid catalog_id' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, name, year, set_name, card_number FROM master_catalog WHERE id = $1',
      [catalogId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Catalog entry not found' });
    }

    const imageUrl = await fetchCardImage(rows[0]);
    if (!imageUrl) {
      return res.json({ ok: false, message: 'No clean image found — image_url unchanged' });
    }

    await pool.query('UPDATE master_catalog SET image_url = $1 WHERE id = $2', [imageUrl, catalogId]);
    console.log(`[admin] refresh-image: catalog_id=${catalogId} → ${imageUrl}`);
    res.json({ ok: true, catalog_id: catalogId, image_url: imageUrl });
  } catch (err) {
    console.error('[admin refresh-image]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PriceCharting connectivity test ──────────────────────────────────────────
// GET /api/admin/test-pricecharting
//   ?name=LeBron+James&year=2003&set_name=Topps+Chrome&condition=raw
//
// Runs all three query variations in order and returns per-variation results
// so you can see which format PriceCharting responds to.  Read-only, no DB writes.
//
// Shortcut: pass ?name=LeBron+James+2003+Topps+Chrome with no year/set_name
// to treat the whole string as the name (mirrors how a scan card would look).

router.get('/test-pricecharting', async (req, res) => {
  const token = (process.env.PRICE_CHARTING_TOKEN ?? '').trim();
  if (!token) {
    return res.status(503).json({ error: 'PRICE_CHARTING_TOKEN is not set in the environment' });
  }

  const name      = (req.query.name  ?? 'LeBron James').trim();
  const year      = req.query.year   ? parseInt(req.query.year,  10) : null;
  const set_name  = (req.query.set_name  ?? '').trim() || null;
  const condition = req.query.condition === 'graded' ? 'graded' : 'raw';

  const brandShort = set_name ? set_name.split(/\s+/)[0] : null;

  const queries = [...new Set([
    [name, year, brandShort].filter(Boolean).join(' '),
    [name, set_name        ].filter(Boolean).join(' '),
    [name, year            ].filter(Boolean).join(' '),
  ].map(q => q.trim()).filter(Boolean))];

  const tried = [];

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      const url  = `https://www.pricecharting.com/api/product?t=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const data = await resp.json();

      if (data.status !== 'success' || !data.products?.length) {
        tried.push({ try: i + 1, query: q, result: 'no_results' });
        continue;
      }

      const product = data.products[0];
      const cents   = condition === 'graded'
        ? ((product['graded-price'] > 0 ? product['graded-price'] : null) ?? (product['cib-price'] > 0 ? product['cib-price'] : null))
        : ((product['loose-price']  > 0 ? product['loose-price']  : null) ?? (product['cib-price'] > 0 ? product['cib-price'] : null));

      const entry = {
        try:           i + 1,
        query:         q,
        result:        cents != null ? 'matched' : 'no_price',
        product_name:  product['product-name'],
        loose_price:   (product['loose-price']  ?? 0) / 100,
        cib_price:     (product['cib-price']    ?? 0) / 100,
        graded_price:  (product['graded-price'] ?? 0) / 100,
        selected_dollars: cents != null ? parseFloat((cents / 100).toFixed(2)) : null,
        total_results: data.products.length,
      };
      tried.push(entry);

      if (cents != null) {
        // First variation with a real price — this is what fetchPriceCharting returns
        return res.json({
          ok:           true,
          winning_try:  i + 1,
          winning_query: q,
          slabr_price:  entry.selected_dollars,
          condition,
          variations:   tried,
        });
      }
    } catch (err) {
      tried.push({ try: i + 1, query: q, result: 'error', error: err.message });
    }
  }

  // No variation yielded a usable price
  res.json({ ok: false, slabr_price: null, condition, variations: tried });
});

module.exports = router;
