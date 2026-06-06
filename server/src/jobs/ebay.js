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

// Sold prices via Marketplace Insights API (beta — requires buy.marketplace.insights scope)
// Returns [] if the scope hasn't been granted yet; job still updates active_low.
async function fetchSoldPrices(keywords) {
  try {
    const data = await ebayGet('/buy/marketplace_insights/v1_beta/item_sales/search', {
      q:     keywords,
      limit: 15,
      sort:  'newlyListed',
    });
    return (data.itemSales ?? [])
      .map(i => parseFloat(i.lastSoldPrice?.value))
      .filter(v => !isNaN(v) && v > 0);
  } catch (err) {
    // Scope not approved yet — sold median stays null
    if (err.message?.includes('invalid_scope') || err.message?.includes('403')) {
      return [];
    }
    throw err;
  }
}

// Active low (Fixed Price) via Browse API
async function fetchActiveLow(keywords) {
  const data = await ebayGet('/buy/browse/v1/item_summary/search', {
    q:      keywords,
    limit:  5,
    sort:   'price',
    filter: 'buyingOptions:{FIXED_PRICE}',
  });

  const prices = (data.itemSummaries ?? [])
    .map(i => parseFloat(i.price?.value))
    .filter(v => !isNaN(v) && v > 0);

  return prices.length ? Math.min(...prices) : null;
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
      const keywords   = buildQuery(combo);
      const isOneOfOne = combo.is_one_of_one === true;

      let soldMedian = null;
      let activeLow  = null;

      // Sold prices (skip for 1/1)
      if (!isOneOfOne) {
        const prices = await fetchSoldPrices(keywords);
        soldMedian   = computeMedian(prices);
        console.log(`[ebay-job] ${combo.name} | sold: ${prices.length} results, median: ${soldMedian ? '$' + soldMedian : '—'}`);
        await sleep(400);
      } else {
        skippedOneOfOne++;
      }

      // Active low
      activeLow = await fetchActiveLow(keywords);
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

module.exports = { runEbayJob };
