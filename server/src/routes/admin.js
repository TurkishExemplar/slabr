const express = require('express');
const pool    = require('../db');
const { runEbayJob, priceSingleItem, fetchCardImage } = require('../jobs/ebay');

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

module.exports = router;
