const express = require('express');
const pool = require('../db');
const {
  fetchActiveListings, buildQuery, titleMatchesCompany,
  getItemComps, pcTierLabelFor,
} = require('../jobs/ebay');

const router = express.Router();

// Shared SELECT fragment for portfolio items
const ITEM_SELECT = `
  pi.id, pi.catalog_id, pi.condition, pi.grading_company, pi.grade,
  pi.cert_number, pi.quantity, pi.purchase_price, pi.purchase_date,
  pi.current_value, pi.active_low, pi.forecast_30d,
  pi.scan_identified, pi.scan_source, pi.added_at,
  pi.is_one_of_one, pi.manual_value, pi.manual_value_set_at,
  pi.serial_number, pi.custom_value,
  mc.item_type, mc.name, mc.year, mc.brand_publisher, mc.set_name,
  mc.card_number, mc.variation, mc.sport_game, mc.rarity, mc.ebay_item_id,
  COALESCE(pi.custom_image, mc.image_url) AS image_url,
  (pi.custom_image IS NOT NULL)           AS has_custom_image,
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
          -- Portfolio value only counts each item from when the user owned
          -- it: purchase_date when entered, otherwise the add date.  Earlier
          -- market history (the multi-grade backfill reaches 2020) must not
          -- inflate the chart for periods before ownership.
          AND ph.recorded_at >= COALESCE(pi.purchase_date::timestamptz, pi.added_at)
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
    is_one_of_one, manual_value, serial_number,
  } = req.body ?? {};

  if (!catalog_id) {
    return res.status(400).json({ error: 'catalog_id is required' });
  }

  try {
    // ── Duplicate guard ───────────────────────────────────────────────────
    // Same catalog + condition + grade + company already in this portfolio?
    // body.on_duplicate: 'add' forces a second entry, 'increment' bumps the
    // existing quantity; otherwise 409 so the client can ask the user.
    const onDuplicate = req.body?.on_duplicate;
    if (onDuplicate !== 'add') {
      const { rows: dupes } = await pool.query(`
        SELECT id, quantity FROM portfolio_items
        WHERE user_id = $1 AND catalog_id = $2
          AND condition       IS NOT DISTINCT FROM $3
          AND grade           IS NOT DISTINCT FROM $4
          AND grading_company IS NOT DISTINCT FROM $5
        LIMIT 1
      `, [req.user.userId, catalog_id, condition ?? null, grade ?? null, grading_company ?? null]);

      if (dupes.length) {
        if (onDuplicate === 'increment') {
          const { rows: updated } = await pool.query(
            'UPDATE portfolio_items SET quantity = quantity + $1 WHERE id = $2 RETURNING *',
            [quantity ?? 1, dupes[0].id]
          );
          return res.json({ ...updated[0], duplicate_incremented: true });
        }
        return res.status(409).json({
          duplicate: true,
          existing_item_id: dupes[0].id,
          existing_quantity: dupes[0].quantity,
          error: 'This card is already in your collection',
        });
      }
    }

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
         manual_value_set_at, serial_number)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
      serial_number?.trim() || null,
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

    // Every graded item displays in its company's own grade format —
    // "BGS 9.5" / "PSA 9" / "CGC 8.5", never bare "Grade X" buckets (and
    // never "PSA 10" on a non-PSA item).  Comic-scale companies keep their
    // decimal formatting (CGC 8.0); sports companies trim trailing zeros.
    const companyScale = item.condition === 'graded' && !!item.grading_company;
    const coName = item.grading_company;
    const comicFormat = ['CGC', 'CBCS', 'PGX'].includes((coName ?? '').toUpperCase());
    const fmtGrade = n => comicFormat ? parseFloat(n).toFixed(1) : String(parseFloat(n));
    const displayLabel = (label) => {
      if (!companyScale || label === 'Ungraded') return label;
      if (label === 'PSA 10') return `${coName} ${fmtGrade(10)}`;
      const m = String(label).match(/^Grade (\d+(?:\.\d+)?)$/);
      return m ? `${coName} ${fmtGrade(m[1])}` : label;
    };
    const gradeExtractRe = companyScale
      ? new RegExp(`${coName}\\s*-?\\s*(\\d{1,2}(?:\\.\\d)?)\\b`, 'i')
      : null;

    const userSeries = displayLabel(tierLabel(item.condition, item.grade));

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
    // Skipped for comic-scale items: their sales are re-keyed by the EXACT
    // grade in each title below, and bucket-level series would double-count
    // the same sales under relabeled bucket names.
    if (!companyScale) {
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
    }

    // ── Recent sales per grade (for the chart's grade selector) ──────────
    const { rows: allSales } = await pool.query(`
      SELECT date, grade_label, price, title, url FROM (
        SELECT sold_date::text AS date, grade_label, price, title, url,
               ROW_NUMBER() OVER (PARTITION BY grade_label ORDER BY sold_date DESC) AS rn
        FROM pc_sales
        WHERE catalog_id = $1 AND grade_label IS NOT NULL
      ) t
      WHERE rn <= 15
      ORDER BY grade_label, date DESC
    `, [item.catalog_id]);
    let salesByGrade = {};
    for (const s of allSales) {
      // Strict company filtering: a graded user sees only their company's
      // listings in every grade bucket; the Ungraded bucket never shows
      // slabs regardless of who's looking.
      if (s.grade_label === 'Ungraded') {
        if (!titleMatchesCompany(s.title, null)) continue;
      } else if (item.condition === 'graded' && item.grading_company) {
        if (!titleMatchesCompany(s.title, item.grading_company)) continue;
      }
      (salesByGrade[s.grade_label] ??= []).push({ ...s, price: parseFloat(s.price) });
    }

    // Split exact subgrades out of their floor buckets — BGS/SGC/CGC half
    // grades live inside the whole-grade tables on PC, but deserve their own
    // selectable series ("Grade 8.5" pill → only 8.5 slabs).
    if (item.condition === 'graded' && item.grading_company) {
      for (const half of ['1.5', '2.5', '3.5', '4.5', '5.5', '6.5', '7.5', '8.5']) {
        const floorLabel = `Grade ${Math.floor(parseFloat(half))}`;
        const bucket = salesByGrade[floorLabel];
        if (!bucket?.length) continue;
        const re = new RegExp(`${item.grading_company}\\s*-?\\s*${half.replace('.', '\\.')}(?![0-9])`, 'i');
        const exact = bucket.filter(s => re.test(s.title ?? ''));
        if (exact.length) {
          salesByGrade[`Grade ${half}`] = exact;
          salesByGrade[floorLabel] = bucket.filter(s => !exact.includes(s));
        }
      }
    }

    // Comic-scale transform: re-key every sale by the EXACT grade in its
    // title ("CGC 9.8"), relabel the tier series to the company format, and
    // drop the sports-centric bucket labels entirely.
    if (companyScale) {
      const regrouped = {};
      for (const [label, list] of Object.entries(salesByGrade)) {
        for (const s of list) {
          const m = (s.title ?? '').match(gradeExtractRe);
          const key = m ? `${coName} ${fmtGrade(m[1])}` : displayLabel(label);
          (regrouped[key] ??= []).push({ ...s, grade_label: key });
        }
      }
      for (const k of Object.keys(regrouped)) {
        regrouped[k].sort((a, b) => b.date.localeCompare(a.date));
      }
      salesByGrade = regrouped;

      for (const key of Object.keys(historyByGrade)) {
        const nk = displayLabel(key);
        if (nk !== key) {
          historyByGrade[nk] = historyByGrade[key];
          delete historyByGrade[key];
        }
      }
    }

    // Subgrade series + table rows: derive monthly sale-medians for any sales
    // group that has no chart series yet (mirrors the lower-grade derivation).
    for (const [label, list] of Object.entries(salesByGrade)) {
      if (historyByGrade[label] || !list.length) continue;
      const byMonth = new Map();
      for (const s of [...list].sort((a, b) => a.date.localeCompare(b.date))) {
        const month = `${s.date.slice(0, 7)}-01`;
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month).push(s.price);
      }
      historyByGrade[label] = [...byMonth.entries()].map(([date, prices]) => {
        const sorted = prices.filter(p => p > 0).sort((a, b) => a - b);
        return { date, value: sorted[Math.floor(sorted.length / 2)] ?? 0 };
      }).filter(p => p.value > 0);
      if (!historyByGrade[label].length) delete historyByGrade[label];
    }

    // ── Grade price table: current, ~30d change, 90d volume ──────────────
    // Built AFTER the subgrade split so derived subgrade series get rows too.
    const { rows: vol } = await pool.query(`
      SELECT grade_label, COUNT(*)::int AS n
      FROM pc_sales
      WHERE catalog_id = $1 AND sold_date > NOW() - INTERVAL '90 days'
      GROUP BY grade_label
    `, [item.catalog_id]);
    const volumeByLabel = Object.fromEntries(vol.map(v => [v.grade_label, v.n]));
    const cutoff90 = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

    const gradePrices = Object.entries(historyByGrade).map(([label, series]) => {
      const current = series[series.length - 1];
      const cutoff  = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      const past    = [...series].reverse().find(p => p.date <= cutoff) ?? series[0];
      // Subgrade labels have no pc_sales grade_label of their own — count
      // their split-out sales instead.
      const volume = volumeByLabel[label]
        ?? (salesByGrade[label] ?? []).filter(s => s.date >= cutoff90).length;
      return {
        grade:    label,
        current:  current.value,
        change:   past && past !== current ? parseFloat((current.value - past.value).toFixed(2)) : 0,
        volume_90d: volume,
        is_user_grade: label === userSeries,
      };
    })
      // Never show a grade without real price data — no $0 / empty rows
      .filter(g => g.current > 0);

    // ── Sold listings + sold median for the user's exact grade ───────────
    // getItemComps is the same helper the pricer uses for the sold median —
    // the Recent Sales list and the Market Value always come from the exact
    // same filtered set.
    const comps = await getItemComps(item.catalog_id, item);

    // Recent Sales badges show the EXACT grade from each title for
    // comic-scale companies — never a bucket grade.
    let compsSales = comps.sales;
    if (companyScale) {
      compsSales = comps.sales.map(s => {
        const m = (s.title ?? '').match(gradeExtractRe);
        return { ...s, grade_label: m ? `${coName} ${fmtGrade(m[1])}` : displayLabel(s.grade_label) };
      });
    }

    // Human caption for the fallback case, in the company's own grade format:
    // "No CGC 8.5 sales found — showing CGC 8.0 and CGC 9.0 for reference"
    let compsNote = null;
    if (comps.halfGrade && !comps.filtered && item.grading_company) {
      const refs = comps.referenceGrades.length
        ? comps.referenceGrades.map(r => `${item.grading_company} ${r}`).join(' and ')
        : `nearby ${item.grading_company} grades`;
      compsNote = `No ${item.grading_company} ${item.grade} sales found — showing ${refs} for reference`;
    }

    // For comic-scale items the selection default is the user's exact grade
    // series when it has data, since bucket labels no longer exist as keys.
    const bucketDisplay = companyScale
      ? (salesByGrade[userSeries] || historyByGrade[userSeries] ? userSeries : displayLabel(userLabel))
      : userLabel;

    res.json({
      user_tier:        userSeries,
      user_bucket:      bucketDisplay,
      history_by_grade: historyByGrade,
      grade_prices:     gradePrices,
      sales:            compsSales,
      sales_filtered:   comps.filtered,
      sales_median:     comps.median,
      comps_note:       compsNote,
      sales_by_grade:   salesByGrade,
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
    manual_value, serial_number,
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
                                 THEN NOW() ELSE manual_value_set_at END,
        serial_number        = COALESCE($12, serial_number)
      WHERE id = $10 AND user_id = $11
      RETURNING *
    `, [
      condition, grading_company, grade, cert_number,
      quantity, purchase_price, purchase_date, current_value,
      manual_value ?? null,
      req.params.id, req.user.userId,
      serial_number ?? null,
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

// POST /api/portfolio/:id/image — set a per-user custom image for this item.
// Saved on portfolio_items.custom_image, NEVER on master_catalog: only this
// user's view changes; everyone else keeps the PriceCharting image.
router.post('/:id/image', async (req, res) => {
  const { image_base64 } = req.body ?? {};
  if (!image_base64) return res.status(400).json({ error: 'image_base64 is required' });

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
    const { rows } = await pool.query(
      `UPDATE portfolio_items SET custom_image = $1
       WHERE id = $2 AND user_id = $3
       RETURNING id`,
      [image_base64, req.params.id, req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true, image_url: image_base64, has_custom_image: true });
  } catch (err) {
    console.error('[portfolio image upload]', err.message);
    res.status(500).json({ error: 'Image update failed — please try again' });
  }
});

// DELETE /api/portfolio/:id/image — remove the custom image, reverting to the
// catalog (PriceCharting) image.  Returns the image the item falls back to.
router.delete('/:id/image', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      UPDATE portfolio_items pi SET custom_image = NULL
      FROM master_catalog mc
      WHERE pi.id = $1 AND pi.user_id = $2 AND mc.id = pi.catalog_id
      RETURNING mc.image_url
    `, [req.params.id, req.user.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true, image_url: rows[0].image_url, has_custom_image: false });
  } catch (err) {
    console.error('[portfolio image remove]', err.message);
    res.status(500).json({ error: 'Image update failed — please try again' });
  }
});

// POST /api/portfolio/:id/custom-value — per-item valuation override.
// body: { mode: 'recent_sale' } → most recent company-matched sale for the
//                                 item's grade bucket from pc_sales
//       { mode: 'manual', value: 1234.56 } → user-entered value
//       { mode: 'clear' } → revert to market valuation
router.post('/:id/custom-value', async (req, res) => {
  const { mode, value } = req.body ?? {};
  if (!['recent_sale', 'manual', 'clear'].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'recent_sale', 'manual', or 'clear'" });
  }

  try {
    const { rows: items } = await pool.query(
      `SELECT pi.id, pi.catalog_id, pi.condition, pi.grade, pi.grading_company
       FROM portfolio_items pi WHERE pi.id = $1 AND pi.user_id = $2`,
      [req.params.id, req.user.userId]
    );
    if (!items.length) return res.status(404).json({ error: 'Item not found' });
    const item = items[0];

    let newValue = null;
    let saleInfo = null;

    if (mode === 'manual') {
      const v = parseFloat(value);
      if (isNaN(v) || v <= 0 || v > 99_999_999) {
        return res.status(400).json({ error: 'value must be a positive number' });
      }
      newValue = v;
    } else if (mode === 'recent_sale') {
      const { label } = pcTierLabelFor(item);
      const { rows: sales } = await pool.query(`
        SELECT sold_date::text AS date, price, title
        FROM pc_sales
        WHERE catalog_id = $1 AND grade_label = $2
        ORDER BY sold_date DESC
        LIMIT 60
      `, [item.catalog_id, label]);

      // Strict company match (and exact half grade when applicable)
      const g = parseFloat(item.grade);
      const halfGrade = item.condition === 'graded' && !isNaN(g) && g % 1 !== 0;
      let candidates = sales.filter(s =>
        titleMatchesCompany(s.title, item.condition === 'graded' ? item.grading_company : null));
      if (halfGrade && item.grading_company) {
        const esc = String(item.grade).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re  = new RegExp(`${item.grading_company}\\s*-?\\s*${esc}(?![0-9])`, 'i');
        const exact = candidates.filter(s => re.test(s.title ?? ''));
        if (exact.length) candidates = exact;
      }

      if (!candidates.length) {
        return res.status(404).json({ error: 'No recorded sales match this grade and grading company' });
      }
      newValue = parseFloat(candidates[0].price);
      saleInfo = { date: candidates[0].date, title: candidates[0].title };
    }
    // mode === 'clear' → newValue stays null

    await pool.query(
      'UPDATE portfolio_items SET custom_value = $1 WHERE id = $2 AND user_id = $3',
      [newValue, req.params.id, req.user.userId]
    );

    res.json({ ok: true, custom_value: newValue, sale: saleInfo });
  } catch (err) {
    console.error('[portfolio custom-value]', err.message);
    res.status(500).json({ error: 'Server error' });
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
