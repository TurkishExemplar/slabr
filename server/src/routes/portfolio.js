const express = require('express');
const pool = require('../db');
const { fetchActiveListings, buildQuery } = require('../jobs/ebay');

const router = express.Router();

// Map an item's (condition, grading_company, grade) to its PriceCharting tier
// label.  Half grades have no tier of their own — they bucket to the floor
// grade for sold-listing lookups (a BGS 8.5 shops in the Grade 8 bucket,
// title-filtered to actual 8.5 slabs).
function pcTierLabelFor(item) {
  if (item.condition !== 'graded') return { label: 'Ungraded', halfGrade: false };
  const g = parseFloat(item.grade);
  if (isNaN(g))  return { label: 'Grade 9', halfGrade: false };
  if (g >= 10)   return { label: 'PSA 10', halfGrade: false };
  if (g === 9.5) return { label: 'Grade 9.5', halfGrade: false };
  if (g % 1 !== 0) return { label: `Grade ${Math.floor(g)}`, halfGrade: true };
  return { label: `Grade ${g}`, halfGrade: false };
}

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

// Latest market-value row.  Market value (sold_median) comes from
// PriceCharting; 'manual' covers 1/1 owner estimates and 'mock' is seeded
// placeholder data.  eBay rows are excluded — eBay is an active-listing
// source (active_low), never a market-value source.
//
// Real-source rows must match the item's (condition, grade) combo so a PSA 9
// item is never valued from the raw or PSA 10 price.  Mock rows are exempt:
// they are seeded as ('raw', NULL) placeholders meant to apply to any combo
// until a real price lands.
const PRICE_JOIN = `
  LEFT JOIN LATERAL (
    SELECT sold_median, source, recorded_at
    FROM price_history
    WHERE catalog_id = pi.catalog_id
      AND sold_median IS NOT NULL
      AND source <> 'ebay'
      AND (source = 'mock'
           OR (condition IS NOT DISTINCT FROM pi.condition
               AND grade IS NOT DISTINCT FROM pi.grade))
    ORDER BY
      CASE source WHEN 'pricecharting' THEN 1 WHEN 'manual' THEN 2 ELSE 3 END,
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
    // One row per (portfolio item, day): when a day has rows from multiple
    // sources (e.g. a seeded mock row plus a real pricecharting row), only the
    // highest-ranked source counts — pricecharting > manual > ebay > mock —
    // so the daily total never double-counts an item.  Real-source rows must
    // match the item's (condition, grade) combo; mock placeholder rows
    // ('raw', NULL) are exempt so unpriced items still chart something.
    const { rows } = await pool.query(`
      SELECT date, ROUND(SUM(value * quantity)::numeric, 2) AS total_value
      FROM (
        SELECT DISTINCT ON (pi.id, date_trunc('day', ph.recorded_at))
          pi.id,
          pi.quantity,
          date_trunc('day', ph.recorded_at)::date::text AS date,
          -- ebay rows carry active_low only; all other sources carry sold_median
          COALESCE(ph.sold_median, ph.active_low) AS value
        FROM price_history ph
        JOIN portfolio_items pi
          ON ph.catalog_id = pi.catalog_id AND pi.user_id = $1
        WHERE COALESCE(ph.sold_median, ph.active_low) IS NOT NULL
          AND (ph.source = 'mock'
               OR (ph.condition IS NOT DISTINCT FROM pi.condition
                   AND ph.grade IS NOT DISTINCT FROM pi.grade))
        ORDER BY
          pi.id,
          date_trunc('day', ph.recorded_at),
          CASE ph.source WHEN 'pricecharting' THEN 1 WHEN 'manual' THEN 2 WHEN 'ebay' THEN 3 ELSE 4 END,
          ph.recorded_at DESC
      ) best
      GROUP BY date
      ORDER BY date
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
          AND sold_median IS NOT NULL
          AND source <> 'ebay'
          AND (source = 'mock'
               OR (condition IS NOT DISTINCT FROM $2 AND grade IS NOT DISTINCT FROM $3))
        ORDER BY CASE source WHEN 'pricecharting' THEN 1 WHEN 'manual' THEN 2 ELSE 3 END,
                 recorded_at DESC
        LIMIT 1
      `, [catalog_id, condition ?? null, grade ?? null]);
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
    // Fires when at least one pricing source (PriceCharting or eBay) is configured.
    const _hasPc   = !!(process.env.PRICE_CHARTING_TOKEN ?? '').trim();
    const _hasEbay = !!(process.env.EBAY_APP_ID ?? '').trim() && !!(process.env.EBAY_CERT_ID ?? '').trim();
    if (_hasPc || _hasEbay) {
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

    // Chart = market value over time, using the exact row-selection semantics
    // of PRICE_JOIN (sold_median only, no ebay rows, combo-matched with the
    // mock exemption) so the line's last point always equals the Market Value
    // shown on the page.  One point per day: highest-ranked source wins
    // (pricecharting > manual > mock).
    const { rows: historyRows } = await pool.query(`
      SELECT date, value, source FROM (
        SELECT DISTINCT ON (date_trunc('day', recorded_at))
          date_trunc('day', recorded_at)::date::text AS date,
          ROUND(sold_median::numeric, 2) AS value,
          source
        FROM price_history
        WHERE catalog_id = $1
          AND sold_median IS NOT NULL
          AND source <> 'ebay'
          AND (source = 'mock'
               OR (condition IS NOT DISTINCT FROM $2 AND grade IS NOT DISTINCT FROM $3))
        ORDER BY
          date_trunc('day', recorded_at),
          CASE source WHEN 'pricecharting' THEN 1 WHEN 'manual' THEN 2 ELSE 3 END,
          recorded_at DESC
      ) best
      ORDER BY date ASC
    `, [item.catalog_id, item.condition, item.grade]);

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

// GET /api/portfolio/:id/market
// Multi-grade market view for the item detail page:
//   history_by_grade — one series per PriceCharting tier (and the user's own
//     grade when it differs), from pricecharting price_history rows
//   grade_prices     — per-tier current price, change vs ~30 days ago, and
//     90-day sales volume
//   sales            — recent sold listings for the user's grade bucket
//     (half grades title-filter the floor bucket, e.g. BGS 8.5 in Grade 8)
//   user_tier        — which series/bucket is the user's, for highlighting
router.get('/:id/market', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT pi.catalog_id, pi.condition, pi.grade, pi.grading_company
      FROM portfolio_items pi
      WHERE pi.id = $1 AND pi.user_id = $2
    `, [req.params.id, req.user.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });

    const item = rows[0];
    const { label: userLabel, halfGrade } = pcTierLabelFor(item);

    // Series labels normalize through parseFloat so free-text grades ('9.0',
    // '09') merge with the canonical tier series ('9') instead of rendering
    // as a separate sparse line.
    const tierLabel = (condition, grade) => {
      if (condition !== 'graded') return 'Ungraded';
      const n = parseFloat(grade);
      if (isNaN(n)) return 'Graded';
      return n >= 10 ? 'PSA 10' : `Grade ${n}`;
    };
    const userSeries = tierLabel(item.condition, item.grade);

    // ── Per-tier history series ───────────────────────────────────────────
    const { rows: hist } = await pool.query(`
      SELECT date, value, condition, grade FROM (
        SELECT DISTINCT ON (condition, grade, date_trunc('day', recorded_at))
          date_trunc('day', recorded_at)::date::text AS date,
          ROUND(sold_median::numeric, 2) AS value,
          condition, grade
        FROM price_history
        WHERE catalog_id = $1
          AND source = 'pricecharting'
          AND sold_median IS NOT NULL
        ORDER BY condition, grade, date_trunc('day', recorded_at), recorded_at DESC
      ) t
      ORDER BY date ASC
    `, [item.catalog_id]);

    const historyByGrade = {};
    for (const r of hist) {
      const label = tierLabel(r.condition, r.grade);
      (historyByGrade[label] ??= []).push({ date: r.date, value: parseFloat(r.value) });
    }

    // Lower grades (1–6) have no chart series on PriceCharting, but their
    // sold listings exist — derive monthly sale-medians so they chart too.
    // Only fills labels that don't already have a real tier series.
    const tierSeriesLabels = new Set(Object.keys(historyByGrade));
    const { rows: derived } = await pool.query(`
      SELECT grade_label,
             date_trunc('month', sold_date)::date::text AS date,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY price))::numeric(12,2) AS value
      FROM pc_sales
      WHERE catalog_id = $1 AND grade_label IS NOT NULL
      GROUP BY grade_label, date_trunc('month', sold_date)
      ORDER BY grade_label, date_trunc('month', sold_date)
    `, [item.catalog_id]);
    for (const r of derived) {
      if (tierSeriesLabels.has(r.grade_label)) continue;
      (historyByGrade[r.grade_label] ??= []).push({ date: r.date, value: parseFloat(r.value) });
    }

    // ── Grade price table: current, ~30d change, 90d volume ──────────────
    const { rows: vol } = await pool.query(`
      SELECT grade_label, COUNT(*)::int AS n
      FROM pc_sales
      WHERE catalog_id = $1 AND sold_date > NOW() - INTERVAL '90 days'
      GROUP BY grade_label
    `, [item.catalog_id]);
    const volumeByLabel = Object.fromEntries(vol.map(v => [v.grade_label, v.n]));

    const gradePrices = Object.entries(historyByGrade).map(([label, series]) => {
      const current = series[series.length - 1];
      const cutoff  = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      const past    = [...series].reverse().find(p => p.date <= cutoff) ?? series[0];
      return {
        grade:    label,
        current:  current.value,
        change:   past && past !== current ? parseFloat((current.value - past.value).toFixed(2)) : 0,
        volume_90d: volumeByLabel[label] ?? 0,
        is_user_grade: label === userSeries,
      };
    });

    // ── Sold listings for the user's bucket ──────────────────────────────
    const { rows: bucketSales } = await pool.query(`
      SELECT sold_date::text AS date, grade_label, price, title, url
      FROM pc_sales
      WHERE catalog_id = $1 AND grade_label = $2
      ORDER BY sold_date DESC
      LIMIT 60
    `, [item.catalog_id, userLabel]);

    let sales = bucketSales;
    let salesFiltered = false;
    if (halfGrade && item.grading_company) {
      // e.g. BGS 8.5: only actual 8.5 slabs from the Grade 8 bucket.
      // When no listing title carries the exact half grade, fall back to the
      // whole bucket — sales_filtered tells the UI which one it got.
      const esc = String(item.grade).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re  = new RegExp(`${item.grading_company}\\s*-?\\s*${esc}(?![0-9])`, 'i');
      const filtered = bucketSales.filter(s => re.test(s.title ?? ''));
      if (filtered.length) {
        sales = filtered;
        salesFiltered = true;
      }
    }

    res.json({
      user_tier:        userSeries,
      user_bucket:      userLabel,
      history_by_grade: historyByGrade,
      grade_prices:     gradePrices,
      sales:            sales.slice(0, 30).map(s => ({ ...s, price: parseFloat(s.price) })),
      sales_filtered:   salesFiltered,
    });
  } catch (err) {
    console.error('[portfolio GET /:id/market]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/portfolio/:id/listings
// Live active eBay listings for this item — fetched on demand by the item
// detail page (after the main item data, so the page renders fast).
// Returns { configured, listings: [{title, price, condition, seller, url,
// image}], search_query, ebay_search_url }.
router.get('/:id/listings', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT pi.condition, pi.grading_company, pi.grade,
             mc.item_type, mc.name, mc.year, mc.set_name, mc.card_number,
             mc.brand_publisher, mc.sport_game, mc.ebay_search_query, mc.rarity
      FROM portfolio_items pi
      JOIN master_catalog mc ON pi.catalog_id = mc.id
      WHERE pi.id = $1 AND pi.user_id = $2
    `, [req.params.id, req.user.userId]);

    if (!rows.length) return res.status(404).json({ error: 'Item not found' });

    const item          = rows[0];
    const searchQuery   = buildQuery(item);
    const ebaySearchUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(searchQuery)}&LH_BIN=1`;

    const hasEbay = !!(process.env.EBAY_APP_ID ?? '').trim() && !!(process.env.EBAY_CERT_ID ?? '').trim();
    if (!hasEbay) {
      return res.json({ configured: false, listings: [], search_query: searchQuery, ebay_search_url: ebaySearchUrl });
    }

    const { listings } = await fetchActiveListings(item, 8);
    res.json({ configured: true, listings, search_query: searchQuery, ebay_search_url: ebaySearchUrl });
  } catch (err) {
    console.error('[portfolio GET /:id/listings]', err.message);
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
