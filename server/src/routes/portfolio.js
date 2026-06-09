const express = require('express');
const pool = require('../db');

const router = express.Router();

// Shared SELECT fragment for portfolio items
const ITEM_SELECT = `
  pi.id, pi.catalog_id, pi.condition, pi.grading_company, pi.grade,
  pi.cert_number, pi.quantity, pi.purchase_price, pi.purchase_date,
  pi.current_value, pi.active_low, pi.forecast_30d,
  pi.scan_identified, pi.scan_source, pi.added_at,
  pi.is_one_of_one, pi.manual_value, pi.manual_value_set_at,
  mc.item_type, mc.name, mc.year, mc.brand_publisher, mc.set_name,
  mc.card_number, mc.variation, mc.sport_game, mc.rarity, mc.image_url,
  ph.sold_median  AS ph_value,
  ph.source       AS price_source,
  ph.recorded_at  AS price_updated_at
`;

const PRICE_JOIN = `
  LEFT JOIN LATERAL (
    SELECT sold_median, source, recorded_at
    FROM price_history
    WHERE catalog_id = pi.catalog_id
    ORDER BY
      CASE source WHEN 'ebay' THEN 1 WHEN 'ximilar' THEN 2 ELSE 3 END,
      recorded_at DESC
    LIMIT 1
  ) ph ON true
`;

// GET /api/portfolio
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ${ITEM_SELECT}
      FROM portfolio_items pi
      JOIN master_catalog mc ON pi.catalog_id = mc.id
      ${PRICE_JOIN}
      WHERE pi.user_id = $1
      ORDER BY pi.added_at DESC
    `, [req.user.userId]);
    res.json(rows);
  } catch (err) {
    console.error('[portfolio GET]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/portfolio/history  — must be before /:id
router.get('/history', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        date_trunc('day', ph.recorded_at)::date::text AS date,
        -- Use active_low as fallback when sold_median is null (e.g. Marketplace
        -- Insights scope not approved — priceSingleItem still inserts a row but
        -- only active_low is populated).
        ROUND(SUM(COALESCE(ph.sold_median, ph.active_low) * pi.quantity)::numeric, 2) AS total_value
      FROM price_history ph
      JOIN portfolio_items pi
        ON ph.catalog_id = pi.catalog_id AND pi.user_id = $1
      WHERE COALESCE(ph.sold_median, ph.active_low) IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `, [req.user.userId]);
    res.json(rows);
  } catch (err) {
    console.error('[portfolio history]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/portfolio
router.post('/', async (req, res) => {
  const {
    catalog_id, condition, grading_company, grade, cert_number,
    quantity, purchase_price, purchase_date,
    scan_identified, scan_source, scan_value, forecast_30d,
    is_one_of_one, manual_value,
  } = req.body ?? {};

  if (!catalog_id) {
    return res.status(400).json({ error: 'catalog_id is required' });
  }

  try {
    let current_value;

    if (scan_identified && scan_value != null) {
      current_value = scan_value;
    } else {
      const priceRes = await pool.query(`
        SELECT sold_median FROM price_history
        WHERE catalog_id = $1
        ORDER BY CASE source WHEN 'ebay' THEN 1 WHEN 'ximilar' THEN 2 ELSE 3 END,
                 recorded_at DESC
        LIMIT 1
      `, [catalog_id]);
      current_value = priceRes.rows[0]?.sold_median ?? null;
    }

    const { rows } = await pool.query(`
      INSERT INTO portfolio_items
        (user_id, catalog_id, condition, grading_company, grade, cert_number,
         quantity, purchase_price, purchase_date, current_value, forecast_30d,
         scan_identified, scan_source, is_one_of_one, manual_value,
         manual_value_set_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *
    `, [
      req.user.userId, catalog_id,
      condition ?? null, grading_company ?? null, grade ?? null,
      cert_number ?? null, quantity ?? 1,
      purchase_price ?? null, purchase_date ?? null,
      current_value,
      forecast_30d ?? null,
      scan_identified === true,
      scan_source ?? null,
      is_one_of_one === true,
      manual_value ?? null,
      manual_value != null ? new Date() : null,
    ]);

    res.status(201).json(rows[0]);

    // ── Background instant pricing ────────────────────────────────────────
    // Run after the response is sent so the user isn't blocked.
    // Only fires when eBay credentials are configured.
    if ((process.env.EBAY_APP_ID ?? '').trim() && (process.env.EBAY_CERT_ID ?? '').trim()) {
      setImmediate(async () => {
        try {
          const { priceSingleItem } = require('../jobs/ebay');
          await priceSingleItem(catalog_id, condition ?? null, grade ?? null);
        } catch (err) {
          console.error(`[pricing] Auto-price failed for catalog ${catalog_id}:`, err.message);
        }
      });
    }
  } catch (err) {
    console.error('[portfolio POST]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/portfolio/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ${ITEM_SELECT}
      FROM portfolio_items pi
      JOIN master_catalog mc ON pi.catalog_id = mc.id
      ${PRICE_JOIN}
      WHERE pi.id = $1 AND pi.user_id = $2
    `, [req.params.id, req.user.userId]);

    if (!rows.length) return res.status(404).json({ error: 'Item not found' });

    const item = rows[0];

    const { rows: historyRows } = await pool.query(`
      SELECT
        date_trunc('day', recorded_at)::date::text AS date,
        -- Fall back to active_low when sold_median is null (Browse API fallback path)
        ROUND(COALESCE(sold_median, active_low)::numeric, 2) AS value,
        source
      FROM price_history
      WHERE catalog_id = $1
        AND COALESCE(sold_median, active_low) IS NOT NULL
      ORDER BY recorded_at ASC
    `, [item.catalog_id]);

    // For 1/1 items, include comparable sales
    let comparableSales = [];
    if (item.is_one_of_one) {
      const { rows: compRows } = await pool.query(`
        SELECT parallel_label, sold_price, sold_date, ebay_listing_url, source
        FROM comparable_sales
        WHERE portfolio_item_id = $1
        ORDER BY sold_date DESC NULLS LAST, recorded_at DESC
      `, [item.id]);
      comparableSales = compRows;
    }

    res.json({ ...item, price_history: historyRows, comparable_sales: comparableSales });
  } catch (err) {
    console.error('[portfolio GET /:id]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/portfolio/:id
router.put('/:id', async (req, res) => {
  const {
    condition, grading_company, grade, cert_number,
    quantity, purchase_price, purchase_date, current_value,
    manual_value,
  } = req.body ?? {};

  try {
    const { rows } = await pool.query(`
      UPDATE portfolio_items SET
        condition            = COALESCE($1,  condition),
        grading_company      = COALESCE($2,  grading_company),
        grade                = COALESCE($3,  grade),
        cert_number          = COALESCE($4,  cert_number),
        quantity             = COALESCE($5,  quantity),
        purchase_price       = COALESCE($6,  purchase_price),
        purchase_date        = COALESCE($7,  purchase_date),
        current_value        = COALESCE($8,  current_value),
        manual_value         = CASE WHEN $9::numeric IS NOT NULL
                                 THEN $9::numeric ELSE manual_value END,
        manual_value_set_at  = CASE WHEN $9::numeric IS NOT NULL
                                 THEN NOW() ELSE manual_value_set_at END
      WHERE id = $10 AND user_id = $11
      RETURNING *
    `, [
      condition, grading_company, grade, cert_number,
      quantity, purchase_price, purchase_date, current_value,
      manual_value ?? null,
      req.params.id, req.user.userId,
    ]);

    if (!rows.length) return res.status(404).json({ error: 'Item not found' });

    // If manual_value was updated, insert a price_history row for the chart
    if (manual_value != null) {
      await pool.query(`
        INSERT INTO price_history (catalog_id, condition, grade, sold_median, source)
        VALUES ($1, $2, $3, $4, 'manual')
      `, [rows[0].catalog_id, rows[0].condition, rows[0].grade, manual_value]);
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[portfolio PUT]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Image-type helper ─────────────────────────────────────────────────────────
// Checks actual file-header magic bytes — not the client-supplied MIME string.
function detectImageType(base64) {
  try {
    const h = Buffer.from(base64.slice(0, 24), 'base64');
    if (h[0] === 0xFF && h[1] === 0xD8 && h[2] === 0xFF) return 'image/jpeg';
    if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47) return 'image/png';
    if (h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46) return 'image/gif';
    if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 &&
        h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50) return 'image/webp';
    return null;
  } catch { return null; }
}

// POST /api/portfolio/:id/image — replace the catalog image with a user upload
router.post('/:id/image', async (req, res) => {
  const { image_base64 } = req.body ?? {};
  if (!image_base64) return res.status(400).json({ error: 'image_base64 is required' });

  // Verify ownership and retrieve catalog_id
  const ownerRes = await pool.query(
    'SELECT catalog_id FROM portfolio_items WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.userId]
  );
  if (!ownerRes.rows.length) return res.status(404).json({ error: 'Item not found' });
  const { catalog_id } = ownerRes.rows[0];

  const base64 = image_base64.replace(/^data:[^;]+;base64,/, '');

  // Basic well-formedness check
  if (base64.length < 8 || !/^[A-Za-z0-9+/]/.test(base64)) {
    return res.status(400).json({ error: 'Only image files are accepted' });
  }

  // 5 MB decoded-size limit
  if (Math.floor((base64.length * 3) / 4) > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image too large — maximum 5MB' });
  }

  // Magic-byte file-type check
  if (!detectImageType(base64)) {
    return res.status(400).json({ error: 'Only image files are accepted' });
  }

  try {
    await pool.query(
      'UPDATE master_catalog SET image_url = $1 WHERE id = $2',
      [image_base64, catalog_id]
    );
    res.json({ ok: true, image_url: image_base64 });
  } catch (err) {
    console.error('[portfolio image upload]', err.message);
    res.status(500).json({ error: 'Image update failed — please try again' });
  }
});

// PATCH /api/portfolio/:id/name — rename the catalog entry
router.patch('/:id/name', async (req, res) => {
  let { name } = req.body ?? {};

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }

  // Strip HTML tags then trim
  name = name.replace(/<[^>]*>/g, '').trim();

  if (name.length < 3 || name.length > 200) {
    return res.status(400).json({ error: 'Name must be between 3 and 200 characters' });
  }

  // Verify ownership and retrieve catalog_id
  const ownerRes = await pool.query(
    'SELECT catalog_id FROM portfolio_items WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.userId]
  );
  if (!ownerRes.rows.length) return res.status(404).json({ error: 'Item not found' });
  const { catalog_id } = ownerRes.rows[0];

  try {
    await pool.query('UPDATE master_catalog SET name = $1 WHERE id = $2', [name, catalog_id]);
    res.json({ ok: true, name });
  } catch (err) {
    console.error('[portfolio name update]', err.message);
    res.status(500).json({ error: 'Name update failed — please try again' });
  }
});

// DELETE /api/portfolio/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM portfolio_items WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json({ deleted: rows[0].id });
  } catch (err) {
    console.error('[portfolio DELETE]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
