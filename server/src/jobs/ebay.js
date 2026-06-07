/**
 * eBay Market Data Job — uses eBay Browse API + Marketplace Insights API (OAuth)
 *
 * Required env vars:
 *   EBAY_APP_ID   — Client ID from eBay Developer Program
 *   EBAY_CERT_ID  — Client Secret (Cert ID) from eBay Developer Program
 *   EBAY_ENV      — 'production' (default) or 'sandbox'
 *
 * The old Finding API (svcs.ebay.com) was retired Dec 2023. These endpoints replace it:
 *   Active listings → GET /buy/browse/v1/item_summary/search
 *   Sold items      → GET /buy/marketplace_insights/v1_beta/item_sales/search
 */

const pool = require('../db');

const OAUTH_URL = {
  production: 'https://api.ebay.com/identity/v1/oauth2/token',
  sandbox:    'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
};
const API_BASE = {
  production: 'https://api.ebay.com',
  sandbox:    'https://api.sandbox.ebay.com',
};

// Token cache — reuse until 90% of lifetime elapsed
let _cachedToken = null;

// ── Auth ─────────────────────────────────────────────────────────────────────

async function getToken() {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt) {
    return _cachedToken.value;
  }

  const appId  = (process.env.EBAY_APP_ID  ?? '').trim();
  const certId = (process.env.EBAY_CERT_ID ?? '').trim();

  if (!appId || !certId) {
    throw new Error('Both EBAY_APP_ID and EBAY_CERT_ID are required. Add EBAY_CERT_ID to your .env.');
  }

  const env         = (process.env.EBAY_ENV ?? 'production').toLowerCase();
  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');

  const res = await fetch(OAUTH_URL[env] ?? OAUTH_URL.production, {
    method: 'POST',
    headers: {
      Authorization:  `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: [
      'grant_type=client_credentials',
      // Basic scope covers Browse API (active listings).
      // buy.marketplace.insights is a beta scope that needs separate eBay approval for sold-price data.
      'scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
    ].join('&'),
    signal: AbortSignal.timeout(10_000),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`eBay OAuth failed (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
  }

  _cachedToken = {
    value:     data.access_token,
    expiresAt: Date.now() + data.expires_in * 900, // 90 % of lifetime in ms
  };

  console.log('[ebay-job] OAuth token refreshed');
  return _cachedToken.value;
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function ebayGet(path, params = {}) {
  const token = await getToken();
  const env   = (process.env.EBAY_ENV ?? 'production').toLowerCase();
  const base  = API_BASE[env] ?? API_BASE.production;
  const url   = `${base}${path}?${new URLSearchParams(params)}`;

  const res = await fetch(url, {
    headers: {
      Authorization:             `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'X-EBAY-C-ENDUSERCTX':    'contextualLocation=country=US',
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`eBay API HTTP ${res.status} ${path}: ${text.slice(0, 160)}`);
  }

  return res.json();
}

// ── Query builder ─────────────────────────────────────────────────────────────

function buildQuery(item) {
  if (item.ebay_search_query) return item.ebay_search_query;

  const { item_type, name, year, set_name, sport_game, card_number, brand_publisher, condition, grading_company, grade } = item;
  const gradeStr = condition === 'graded' && grade ? `${grading_company ?? 'PSA'} ${grade}` : '';

  switch (item_type) {
    case 'sports_card':
      return [name, year, set_name, gradeStr].filter(Boolean).join(' ');
    case 'tcg':
      return [name, set_name, card_number, gradeStr].filter(Boolean).join(' ');
    case 'comic':
      return [name, card_number ? `#${card_number}` : '', brand_publisher, gradeStr].filter(Boolean).join(' ');
    case 'sealed':
      return [name, year, sport_game, 'sealed'].filter(Boolean).join(' ');
    default:
      return [name, year, set_name].filter(Boolean).join(' ');
  }
}

// Loose query for sold-price searches — strips grade/condition so we don't
// over-specify and get zero results from Marketplace Insights.
function buildSoldQuery(item) {
  const { item_type, name, year, set_name, sport_game, card_number, brand_publisher } = item;
  switch (item_type) {
    case 'sports_card': return [name, year, set_name].filter(Boolean).join(' ');
    case 'tcg':         return [name, set_name, card_number].filter(Boolean).join(' ');
    case 'comic':       return [name, card_number ? `#${card_number}` : '', brand_publisher].filter(Boolean).join(' ');
    case 'sealed':      return [name, year, sport_game, 'sealed'].filter(Boolean).join(' ');
    default:            return [name, year, set_name].filter(Boolean).join(' ');
  }
}

// Trim 10 % from each end, return median
function computeMedian(prices) {
  if (!prices.length) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const cut    = Math.floor(sorted.length * 0.1);
  const list   = cut > 0 ? sorted.slice(cut, sorted.length - cut) : sorted;
  return list[Math.floor(list.length / 2)];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── eBay fetch helpers ────────────────────────────────────────────────────────

// Fetch prices for sold-median calculation.
//
// Strategy:
//   1. Try eBay Marketplace Insights API (real sold data).
//      Requires buy.marketplace.insights scope — needs explicit eBay approval.
//      If 0 results with specific query, retry with a looser query (no grade).
//   2. If scope isn't approved (403 / invalid_scope), fall back to Browse API
//      active-listing prices as a market proxy so the chart is never empty.
//
async function fetchMarketPrices(specificKeywords, looseKeywords) {
  // ── Attempt 1: Marketplace Insights (real sold data) ──────────────────────
  try {
    console.log(`[ebay] Sold query (specific): "${specificKeywords}"`);
    const data = await ebayGet('/buy/marketplace_insights/v1_beta/item_sales/search', {
      q:     specificKeywords,
      limit: 15,
      sort:  'newlyListed',
    });
    let prices = (data.itemSales ?? [])
      .map(i => parseFloat(i.lastSoldPrice?.value))
      .filter(v => !isNaN(v) && v > 0);
    console.log(`[ebay] Sold results (specific): ${prices.length}${prices.length ? ', median: $' + computeMedian(prices) : ''}`);

    // Retry with loose query when specific returns nothing
    if (prices.length === 0 && looseKeywords && looseKeywords !== specificKeywords) {
      console.log(`[ebay] Sold query (loose): "${looseKeywords}"`);
      const data2 = await ebayGet('/buy/marketplace_insights/v1_beta/item_sales/search', {
        q:     looseKeywords,
        limit: 15,
        sort:  'newlyListed',
      });
      prices = (data2.itemSales ?? [])
        .map(i => parseFloat(i.lastSoldPrice?.value))
        .filter(v => !isNaN(v) && v > 0);
      console.log(`[ebay] Sold results (loose): ${prices.length}${prices.length ? ', median: $' + computeMedian(prices) : ''}`);
    }

    if (prices.length > 0) return prices;
    // Fall through to Browse API fallback
    console.log(`[ebay] Sold: 0 results from Marketplace Insights — using Browse API active prices as proxy`);
  } catch (err) {
    if (err.message?.includes('invalid_scope') || err.message?.includes('403')) {
      console.log(`[ebay] Marketplace Insights scope not approved (buy.marketplace.insights requires eBay approval) — using Browse API active prices as proxy`);
    } else {
      console.error(`[ebay] Sold prices error: ${err.message} — falling back to Browse API`);
    }
  }

  // ── Fallback: Browse API active-listing median ────────────────────────────
  // Uses active fixed-price listings as a market-value proxy.
  // Not as accurate as sold data but ensures sold_median is never null.
  try {
    const q = looseKeywords || specificKeywords;
    console.log(`[ebay] Active-price fallback query: "${q}"`);
    const data = await ebayGet('/buy/browse/v1/item_summary/search', {
      q:      q,
      limit:  10,
      sort:   'price',
      filter: 'buyingOptions:{FIXED_PRICE}',
    });
    const prices = (data.itemSummaries ?? [])
      .map(i => parseFloat(i.price?.value))
      .filter(v => !isNaN(v) && v > 0);
    console.log(`[ebay] Active fallback results: ${prices.length}${prices.length ? ', median: $' + computeMedian(prices) : ''}`);
    return prices;
  } catch (err2) {
    console.error(`[ebay] Active-price fallback failed: ${err2.message}`);
    return [];
  }
}

// Active low (Fixed Price) via Browse API.
// Returns { activeLow, imageUrl } — imageUrl is the first listing's image so
// priceSingleItem can replace a temporary scan photo with a real eBay CDN URL.
async function fetchActiveLow(keywords) {
  const data = await ebayGet('/buy/browse/v1/item_summary/search', {
    q:      keywords,
    limit:  5,
    sort:   'price',
    filter: 'buyingOptions:{FIXED_PRICE}',
  });

  const items  = data.itemSummaries ?? [];
  const prices = items
    .map(i => parseFloat(i.price?.value))
    .filter(v => !isNaN(v) && v > 0);

  return {
    activeLow: prices.length ? Math.min(...prices) : null,
    imageUrl:  items[0]?.image?.imageUrl ?? null,
  };
}

// Single most-recent sold comparable (for 1/1 parallel search)
async function fetchComparableSale(keywords) {
  try {
    const data = await ebayGet('/buy/marketplace_insights/v1_beta/item_sales/search', {
      q:     keywords,
      limit: 1,
      sort:  'newlyListed',
    });
    const sale = data.itemSales?.[0];
    if (!sale) return null;
    const price = parseFloat(sale.lastSoldPrice?.value);
    const date  = sale.lastSoldDate?.slice(0, 10) ?? null;
    const url   = sale.itemWebUrl ?? null;
    return isNaN(price) ? null : { price, date, url };
  } catch (err) {
    if (err.message?.includes('invalid_scope') || err.message?.includes('403')) return null;
    throw err;
  }
}

// ── Main job ──────────────────────────────────────────────────────────────────

async function runEbayJob() {
  const appId  = (process.env.EBAY_APP_ID  ?? '').trim();
  const certId = (process.env.EBAY_CERT_ID ?? '').trim();

  if (!appId) {
    console.log('[ebay-job] Skipped: EBAY_APP_ID not set');
    return { skipped: true, reason: 'EBAY_APP_ID not set' };
  }

  if (!certId) {
    console.log('[ebay-job] Skipped: EBAY_CERT_ID not set — add it to .env to enable live pricing');
    return { skipped: true, reason: 'EBAY_CERT_ID not set' };
  }

  console.log('[ebay-job] Starting (Browse API)...');
  const startedAt = Date.now();

  // Distinct (catalog_id, condition, grade) combos
  const { rows: combos } = await pool.query(`
    SELECT DISTINCT ON (pi.catalog_id, pi.condition, pi.grade)
      pi.catalog_id, pi.condition, pi.grade, pi.grading_company,
      pi.is_one_of_one,
      mc.item_type, mc.name, mc.year, mc.set_name, mc.card_number,
      mc.brand_publisher, mc.sport_game, mc.ebay_search_query
    FROM portfolio_items pi
    JOIN master_catalog mc ON pi.catalog_id = mc.id
    ORDER BY pi.catalog_id, pi.condition, pi.grade
  `);

  console.log(`[ebay-job] ${combos.length} unique combo(s) to process`);

  let updated = 0;
  let errors  = 0;
  let skippedOneOfOne = 0;

  for (const combo of combos) {
    try {
      const keywords      = buildQuery(combo);
      const soldKeywords  = buildSoldQuery(combo);
      const isOneOfOne    = combo.is_one_of_one === true;

      let soldMedian = null;
      let activeLow  = null;

      // Market prices (skip for 1/1)
      if (!isOneOfOne) {
        const prices = await fetchMarketPrices(keywords, soldKeywords);
        soldMedian   = computeMedian(prices);
        console.log(`[ebay-job] ${combo.name} | sold/proxy median: ${soldMedian != null ? '$' + soldMedian : '—'}`);
        await sleep(400);
      } else {
        skippedOneOfOne++;
      }

      // Active low (imageUrl unused in bulk job — priceSingleItem handles image updates)
      ({ activeLow } = await fetchActiveLow(keywords));
      console.log(`[ebay-job] ${combo.name} | active low: ${activeLow ? '$' + activeLow : '—'}`);
      await sleep(400);

      // Write price_history row
      if (soldMedian != null || activeLow != null) {
        await pool.query(`
          INSERT INTO price_history (catalog_id, condition, grade, sold_median, active_low, source)
          VALUES ($1, $2, $3, $4, $5, 'ebay')
        `, [combo.catalog_id, combo.condition, combo.grade, soldMedian, activeLow]);
      }

      // Update portfolio_items
      if (!isOneOfOne && (soldMedian != null || activeLow != null)) {
        await pool.query(`
          UPDATE portfolio_items
          SET current_value = COALESCE($1, current_value),
              active_low    = COALESCE($2, active_low)
          WHERE catalog_id = $3
            AND (condition IS NOT DISTINCT FROM $4)
            AND (grade     IS NOT DISTINCT FROM $5)
            AND (is_one_of_one IS NOT TRUE)
        `, [soldMedian, activeLow, combo.catalog_id, combo.condition, combo.grade]);
      }

      if (isOneOfOne && activeLow != null) {
        await pool.query(`
          UPDATE portfolio_items SET active_low = $1
          WHERE catalog_id = $2 AND is_one_of_one = true
        `, [activeLow, combo.catalog_id]);
      }

      // Comparable sales for 1/1 items
      if (isOneOfOne) {
        const { rows: oneOfOneItems } = await pool.query(
          `SELECT id FROM portfolio_items WHERE catalog_id = $1 AND is_one_of_one = true`,
          [combo.catalog_id]
        );

        const baseParts = [combo.name, combo.year, combo.set_name].filter(Boolean).join(' ');
        const parallels = ['/5', '/10', '/25', '/50', '/99', '/100'];

        for (const pi of oneOfOneItems) {
          for (const label of parallels) {
            try {
              const sale = await fetchComparableSale(`${baseParts} ${label}`);
              if (sale) {
                await pool.query(`
                  INSERT INTO comparable_sales
                    (portfolio_item_id, parallel_label, sold_price, sold_date, ebay_listing_url, source)
                  VALUES ($1, $2, $3, $4, $5, 'ebay')
                `, [pi.id, label, sale.price, sale.date, sale.url]);
              }
              await sleep(300);
            } catch { /* skip individual parallel errors */ }
          }
        }
        console.log(`[ebay-job] ${combo.name} | 1/1 comparable sales updated`);
      }

      updated++;
    } catch (err) {
      console.error(`[ebay-job] Error for ${combo.name ?? combo.catalog_id}: ${err.message}`);
      errors++;
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const result = { updated, errors, skippedOneOfOne, elapsed };
  console.log(`[ebay-job] Done in ${elapsed}s —`, JSON.stringify(result));
  return result;
}

// ── Catalog search helper (used by GET /api/catalog/search) ──────────────────
//
// Returns up to `limit` eBay results mapped to the catalog item shape:
//   { source, ebay_item_id, name, item_type, year, set_name,
//     image_url, current_value, condition }

function inferItemType(item) {
  const title = (item.title ?? '').toLowerCase();
  const cats  = (item.categories ?? []).map(c => (c.categoryName ?? '').toLowerCase());
  if (cats.some(c => /tcg|pokemon|magic.*gathering|yugioh|trading card game/.test(c))) return 'tcg';
  if (cats.some(c => c.includes('comic'))) return 'comic';
  if (cats.some(c => c.includes('sealed')) || /sealed box|sealed pack/.test(title)) return 'sealed';
  return 'sports_card';
}

// eBay category IDs that cover the entire collectibles card universe.
// Passing these eliminates shoes, clothing, car parts, etc.
//   212      — Sports Trading Cards
//   183454   — CCG Individual Cards (Pokémon, MTG, Yu-Gi-Oh…)
//   259104   — Comics
//   183456   — Sealed Trading Card Packs & Sets
const CARD_CATEGORY_IDS = '212,183454,259104,183456';

// Title patterns that definitively indicate non-card merchandise.
// Applied as a client-side safety net after eBay's category filter.
const REJECT_TITLE_RE =
  /\b(t-shirt|hoodie|sweatshirt|sneaker|shoe|boot|clothing|apparel|jersey(?!\s*card)|car\s*part|auto\s*part|bumper|tire|tyre|hat\b|cap\b|pants\b|jacket\b)\b/i;

async function ebaySearch(query, limit = 25) {
  const token = await getToken();
  const env   = (process.env.EBAY_ENV ?? 'production').toLowerCase();
  const base  = API_BASE[env] ?? API_BASE.production;

  // Single-word queries are too generic — append "trading card" so eBay's
  // relevance ranking focuses on card listings even within the category filter.
  const words = query.trim().split(/\s+/);
  const base_q = words.length < 2 ? `${query.trim()} trading card` : query.trim();

  // Negative keywords suppress common non-card merchandise.
  // eBay Browse API has limited boolean support but this still helps ranking.
  const q = `${base_q} -shirt -shoes -clothing -apparel -jersey`;

  // ── Build URL manually ────────────────────────────────────────────────────
  // URLSearchParams encodes commas as %2C.  eBay Browse API requires literal
  // commas in categoryIds (e.g. "212,183454") — the encoded form is silently
  // ignored, causing the category filter to have no effect.
  const qs = [
    `q=${encodeURIComponent(q)}`,
    `limit=${Math.min(limit, 50)}`,
    `categoryIds=${CARD_CATEGORY_IDS}`,                     // commas stay literal
    `filter=${encodeURIComponent('buyingOptions:{FIXED_PRICE}')}`,
    `sort=newlyListed`,
  ].join('&');
  const url = `${base}/buy/browse/v1/item_summary/search?${qs}`;

  console.log(`[ebay] ebaySearch URL: ${url}`);

  const res = await fetch(url, {
    headers: {
      Authorization:             `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'X-EBAY-C-ENDUSERCTX':    'contextualLocation=country=US',
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`eBay search HTTP ${res.status}: ${text.slice(0, 160)}`);
  }

  const data  = await res.json();
  const raw   = data.itemSummaries ?? [];

  // ── Client-side safety filter ─────────────────────────────────────────────
  // Removes any items that slipped through with obviously non-card titles.
  const clean = raw.filter(item => !REJECT_TITLE_RE.test(item.title ?? ''));

  console.log(`[ebay] ebaySearch: ${raw.length} raw → ${clean.length} after title filter`);

  return clean.map(item => ({
    source:        'ebay',
    ebay_item_id:  item.itemId,
    name:          item.title,
    item_type:     inferItemType(item),
    year:          null,
    set_name:      null,
    image_url:     item.image?.imageUrl ?? null,
    current_value: item.price?.value != null ? parseFloat(item.price.value) : null,
    condition:     item.condition ?? null,
  }));
}

// ── Instant single-item pricer (called right after a portfolio add) ───────────
//
// Fetches eBay prices for one (catalogId, condition, grade) combo,
// writes a price_history row, and updates portfolio_items. Non-blocking —
// callers should fire this with setImmediate() so the HTTP response goes
// out first.

async function priceSingleItem(catalogId, condition, grade) {
  const appId  = (process.env.EBAY_APP_ID  ?? '').trim();
  const certId = (process.env.EBAY_CERT_ID ?? '').trim();
  if (!appId || !certId) return null;

  // Grab the catalog metadata + grading company from the matching portfolio row
  const { rows } = await pool.query(`
    SELECT
      mc.item_type, mc.name, mc.year, mc.set_name, mc.card_number,
      mc.brand_publisher, mc.sport_game, mc.ebay_search_query,
      pi.grading_company, pi.is_one_of_one
    FROM master_catalog mc
    JOIN portfolio_items pi ON pi.catalog_id = mc.id
    WHERE mc.id = $1
      AND (pi.condition IS NOT DISTINCT FROM $2)
      AND (pi.grade     IS NOT DISTINCT FROM $3)
    LIMIT 1
  `, [catalogId, condition, grade]);

  if (!rows.length) return null;

  const catalogRow   = { ...rows[0], condition, grade };
  const keywords     = buildQuery(catalogRow);
  const soldKeywords = buildSoldQuery(catalogRow);
  const isOneOfOne   = catalogRow.is_one_of_one === true;

  console.log(`[pricing] Auto-pricing "${catalogRow.name}" — active query: "${keywords}" | sold query: "${soldKeywords}"`);

  let soldMedian = null;
  let activeLow  = null;

  if (!isOneOfOne) {
    const prices = await fetchMarketPrices(keywords, soldKeywords);
    soldMedian   = computeMedian(prices);
  }

  const activeResult = await fetchActiveLow(keywords);
  activeLow = activeResult.activeLow;

  // Replace a temporary scan-photo data URL with a real eBay CDN image.
  // Only fires when eBay returned at least one listing with a real image URL.
  if (activeResult.imageUrl) {
    await pool.query(
      `UPDATE master_catalog
       SET image_url = $1
       WHERE id = $2
         AND (image_url IS NULL OR image_url LIKE 'data:%')`,
      [activeResult.imageUrl, catalogId]
    );
    console.log(`[pricing] catalog image updated from eBay for catalog_id=${catalogId}`);
  }

  if (soldMedian != null || activeLow != null) {
    await pool.query(`
      INSERT INTO price_history (catalog_id, condition, grade, sold_median, active_low, source)
      VALUES ($1, $2, $3, $4, $5, 'ebay')
    `, [catalogId, condition, grade, soldMedian, activeLow]);
    console.log(`[pricing] price_history row inserted — catalog_id=${catalogId}, sold_median=${soldMedian != null ? '$'+soldMedian : 'null'}, active_low=${activeLow != null ? '$'+activeLow : 'null'}`);

    if (!isOneOfOne) {
      await pool.query(`
        UPDATE portfolio_items
        SET current_value = COALESCE($1, current_value),
            active_low    = COALESCE($2, active_low)
        WHERE catalog_id = $3
          AND (condition IS NOT DISTINCT FROM $4)
          AND (grade     IS NOT DISTINCT FROM $5)
          AND (is_one_of_one IS NOT TRUE)
      `, [soldMedian, activeLow, catalogId, condition, grade]);
    } else {
      await pool.query(
        'UPDATE portfolio_items SET active_low = $1 WHERE catalog_id = $2 AND is_one_of_one = true',
        [activeLow, catalogId]
      );
    }
    console.log(`[pricing] Done — sold_median=${soldMedian != null ? '$'+soldMedian : '—'}, active_low=${activeLow != null ? '$'+activeLow : '—'}`);
  } else {
    console.log(`[pricing] No prices found for "${keywords}" — price_history row NOT inserted`);
  }

  return { soldMedian, activeLow };
}

module.exports = { runEbayJob, ebaySearch, priceSingleItem };
