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
// GET /api/admin/test-pricecharting?q=LeBron+James+2003+Topps&condition=raw
// Returns the raw PC response + the price Slabr would actually use.
// Safe to call repeatedly — read-only, no DB writes.

router.get('/test-pricecharting', async (req, res) => {
  const token = (process.env.PRICE_CHARTING_TOKEN ?? '').trim();
  if (!token) {
    return res.status(503).json({ error: 'PRICE_CHARTING_TOKEN is not set in the environment' });
  }

  const q         = (req.query.q ?? 'LeBron James 2003 Topps Chrome').trim();
  const condition = req.query.condition === 'graded' ? 'graded' : 'raw';

  try {
    const url  = `https://www.pricecharting.com/api/product?t=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data = await resp.json();

    if (data.status !== 'success' || !data.products?.length) {
      return res.json({ ok: false, query: q, status: data.status, products: [] });
    }

    const product = data.products[0];
    const cents   = condition === 'graded'
      ? ((product['graded-price'] > 0 ? product['graded-price'] : null) ?? (product['cib-price'] > 0 ? product['cib-price'] : null))
      : ((product['loose-price']  > 0 ? product['loose-price']  : null) ?? (product['cib-price'] > 0 ? product['cib-price'] : null));

    const selectedPrice = cents != null ? parseFloat((cents / 100).toFixed(2)) : null;

    // Also show fetchPriceCharting's actual return value for full e2e confirmation
    const slabr_price = await fetchPriceCharting({ name: q, condition });

    res.json({
      ok: true,
      query: q,
      condition,
      top_match: {
        'product-name':  product['product-name'],
        'loose-price':   (product['loose-price']  ?? 0) / 100,
        'cib-price':     (product['cib-price']    ?? 0) / 100,
        'graded-price':  (product['graded-price'] ?? 0) / 100,
      },
      selected_field:    condition === 'graded' ? 'graded-price (cib fallback)' : 'loose-price (cib fallback)',
      selected_cents:    cents,
      selected_dollars:  selectedPrice,
      slabr_price,        // what priceSingleItem would actually record
      total_results:     data.products.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
