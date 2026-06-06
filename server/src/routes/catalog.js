const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /api/catalog/search?q=
router.get('/search', async (req, res) => {
  const q = (req.query.q ?? '').trim();
  if (!q) return res.json([]);

  try {
    const { rows } = await pool.query(`
      SELECT id, item_type, name, year, brand_publisher, set_name,
             card_number, variation, sport_game, rarity
      FROM master_catalog
      WHERE name           ILIKE $1
         OR set_name        ILIKE $1
         OR brand_publisher ILIKE $1
         OR sport_game      ILIKE $1
      ORDER BY name
      LIMIT 10
    `, [`%${q}%`]);
    res.json(rows);
  } catch (err) {
    console.error('[catalog search]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
