const express        = require('express');
const pool           = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// ── GET /api/catalog/search?q= ────────────────────────────────────────────────
// SportsCardsPro database search (requires PRICE_CHARTING_TOKEN), merged with
// the local catalog.  Falls back to local-only ILIKE search when the token is
// missing or SportsCardsPro returns nothing.

router.get('/search', async (req, res) => {
  const q = (req.query.q ?? '').trim();
  if (!q) return res.json([]);

  const hasScp = !!(process.env.PRICE_CHARTING_TOKEN ?? '').trim();

  if (hasScp) {
    try {
      const { scpSearch } = require('../jobs/ebay');

      // Run SCP search and local catalog lookup in parallel.
      // Local results take priority — if a card already exists in master_catalog
      // we show that version so the user adds to the existing catalog entry
      // rather than creating a duplicate.
      const [scpItems, localRes] = await Promise.all([
        scpSearch(q, 12),
        pool.query(`
          SELECT id, item_type, name, year, brand_publisher, set_name,
                 card_number, variation, sport_game, rarity, image_url
          FROM master_catalog
          WHERE name           ILIKE $1
             OR set_name        ILIKE $1
             OR brand_publisher ILIKE $1
          ORDER BY name
          LIMIT 10
        `, [`%${q}%`]),
      ]);

      const local = localRes.rows.map(r => ({ ...r, source: 'local' }));

      // Suppress SCP results whose 40-char name prefix matches a local entry —
      // the user sees the saved version instead of creating a duplicate.
      const localKeys = new Set(
        local.map(r => (r.name ?? '').toLowerCase().slice(0, 40))
      );
      const freshScp = scpItems.filter(s =>
        !localKeys.has((s.name ?? '').toLowerCase().slice(0, 40))
      );

      // Local entries first so the user sees familiar/saved cards at the top.
      const merged = [...local, ...freshScp].slice(0, 25);
      if (merged.length) return res.json(merged);
      // Nothing from SCP or the targeted local query — fall through to the
      // broader local search below.
    } catch (err) {
      console.error('[catalog search] SportsCardsPro error, falling back to local:', err.message);
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

// ── POST /api/catalog/from-scp ────────────────────────────────────────────────
// Upsert a SportsCardsPro result into master_catalog.  Returns the catalog row
// with a real `id` so the frontend can immediately POST to /api/portfolio.
// The SCP product id is stored in the ebay_item_id column (reused) so future
// price lookups can reference the exact product.
// '/from-ebay' is kept as an alias for clients deployed before the rename.

async function handleFromScp(req, res) {
  const { ebay_item_id, name, item_type, year, set_name, card_number, sport_game, image_url } = req.body ?? {};

  if (!ebay_item_id || !name) {
    return res.status(400).json({ error: 'ebay_item_id and name are required' });
  }

  try {
    // Atomic upsert — two concurrent adds of the same product race on the
    // partial unique index; ON CONFLICT makes the loser return the existing
    // row (back-filling image_url if it was missing) instead of a 500.
    const { rows } = await pool.query(`
      INSERT INTO master_catalog
        (item_type, name, year, set_name, card_number, sport_game, image_url, ebay_item_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (ebay_item_id) WHERE ebay_item_id IS NOT NULL
      DO UPDATE SET image_url = COALESCE(master_catalog.image_url, EXCLUDED.image_url)
      RETURNING *
    `, [
      item_type   ?? 'sports_card',
      name,
      year        ?? null,
      set_name    ?? null,
      card_number ?? null,
      sport_game  ?? null,
      image_url   ?? null,
      ebay_item_id,
    ]);

    res.json({ ...rows[0], source: 'scp' });
  } catch (err) {
    console.error('[catalog from-scp]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
}

router.post('/from-scp',  authMiddleware, handleFromScp);
router.post('/from-ebay', authMiddleware, handleFromScp); // legacy alias

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
