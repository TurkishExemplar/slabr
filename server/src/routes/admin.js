const express = require('express');
const pool    = require('../db');
const { runEbayJob, priceSingleItem } = require('../jobs/ebay');

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

module.exports = router;
