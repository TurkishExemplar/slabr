const express        = require('express');
const pool           = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// ── GET /api/catalog/search?q= ────────────────────────────────────────────────
// If EBAY_APP_ID + EBAY_CERT_ID are set → hit eBay Browse API (returns real
// cards with images and prices).  Falls back to local ILIKE search otherwise.

router.get('/search', async (req, res) => {
  const q = (req.query.q ?? '').trim();
  if (!q) return res.json([]);

  const hasEbay = !!(
    (process.env.EBAY_APP_ID  ?? '').trim() &&
    (process.env.EBAY_CERT_ID ?? '').trim()
  );

  if (hasEbay) {
    try {
      const { ebaySearch } = require('../jobs/ebay');
      const items = await ebaySearch(q, 25);
      return res.json(items);
    } catch (err) {
      console.error('[catalog search] eBay error, falling back to local:', err.message);
      // fall through to local search
    }
  }

  // ── Local ILIKE fallback ──────────────────────────────────────────────────
  try {
    const { rows } = await pool.query(`
      SELECT id, item_type, name, year, brand_publisher, set_name,
             card_number, variation, sport_game, rarity, image_url
      FROM master_catalog
      WHERE name           ILIKE $1
         OR set_name        ILIKE $1
         OR brand_publisher ILIKE $1
         OR sport_game      ILIKE $1
      ORDER BY name
      LIMIT 25
    `, [`%${q}%`]);
    res.json(rows.map(r => ({ ...r, source: 'local' })));
  } catch (err) {
    console.error('[catalog search]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/catalog/from-ebay ───────────────────────────────────────────────
// Upsert an eBay result into master_catalog.  Returns the catalog row with a
// real `id` so the frontend can immediately POST to /api/portfolio.

router.post('/from-ebay', authMiddleware, async (req, res) => {
  const { ebay_item_id, name, item_type, year, set_name, image_url } = req.body ?? {};

  if (!ebay_item_id || !name) {
    return res.status(400).json({ error: 'ebay_item_id and name are required' });
  }

  try {
    // Return existing row if this eBay item was already imported
    const existing = await pool.query(
      'SELECT * FROM master_catalog WHERE ebay_item_id = $1 LIMIT 1',
      [ebay_item_id]
    );

    if (existing.rows.length) {
      const row = existing.rows[0];
      // Back-fill image_url if we now have it
      if (image_url && !row.image_url) {
        await pool.query('UPDATE master_catalog SET image_url = $1 WHERE id = $2', [image_url, row.id]);
        row.image_url = image_url;
      }
      return res.json({ ...row, source: 'ebay' });
    }

    // First time — insert a new catalog entry
    const { rows } = await pool.query(`
      INSERT INTO master_catalog (item_type, name, year, set_name, image_url, ebay_item_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      item_type ?? 'sports_card',
      name,
      year      ?? null,
      set_name  ?? null,
      image_url ?? null,
      ebay_item_id,
    ]);

    res.status(201).json({ ...rows[0], source: 'ebay' });
  } catch (err) {
    console.error('[catalog from-ebay]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/catalog ─────────────────────────────────────────────────────────
// Create a manual catalog entry when search returns no results and the user
// fills in the details themselves.

router.post('/', authMiddleware, async (req, res) => {
  const { item_type, name, year, set_name, card_number } = req.body ?? {};

  if (!name?.trim() || !item_type) {
    return res.status(400).json({ error: 'name and item_type are required' });
  }

  try {
    const { rows } = await pool.query(`
      INSERT INTO master_catalog (item_type, name, year, set_name, card_number)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [
      item_type,
      name.trim(),
      year        ? parseInt(year) : null,
      set_name?.trim()    || null,
      card_number?.trim() || null,
    ]);

    res.status(201).json({ ...rows[0], source: 'manual' });
  } catch (err) {
    console.error('[catalog POST]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
