const express = require('express');
const { runEbayJob } = require('../jobs/ebay');

const router = express.Router();

// GET /api/admin/ebay-job — manually trigger the eBay price fetch job
router.get('/ebay-job', async (req, res) => {
  try {
    const result = await runEbayJob();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[admin ebay-job]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
