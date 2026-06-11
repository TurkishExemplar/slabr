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

  const { item_type, name, year, set_name, sport_game, card_number, brand_publisher, condition, grading_company, grade, rarity } = item;
  const gradeStr   = condition === 'graded' && grade ? `${grading_company ?? 'PSA'} ${grade}` : '';
  // Append "Rookie" when the card is explicitly tagged as a rookie — helps
  // eBay ranking favour the RC version over cheaper parallels or reprint sets.
  const rookieTag  = rarity && /\brookie\b/i.test(rarity) ? 'Rookie' : '';

  switch (item_type) {
    case 'sports_card':
      // card_number + rookieTag so "Stephen Curry 2009 Topps 321 Rookie PSA 9"
      // is specific enough to match the slab, not any other Curry card.
      return [name, year, set_name, card_number, rookieTag, gradeStr].filter(Boolean).join(' ');
    case 'tcg':
      return [name, set_name, card_number, gradeStr].filter(Boolean).join(' ');
    case 'comic':
      return [name, card_number ? `#${card_number}` : '', brand_publisher, gradeStr].filter(Boolean).join(' ');
    case 'sealed': {
      // Sealed boxes need the exact product + year + box type + "sealed" —
      // a bare set name surfaces single packs and opened product.
      const txt = `${name} ${set_name ?? ''} ${sport_game ?? ''}`;
      const boxType = /\b(box|case)\b/i.test(`${name} ${set_name ?? ''}`)
        ? null // product name already says which box it is
        : (/pokemon|magic|yu-?gi-?oh|lorcana|tcg/i.test(txt) ? 'booster box' : 'hobby box');
      return [name, year, boxType, 'sealed'].filter(Boolean).join(' ');
    }
    default:
      return [name, year, set_name].filter(Boolean).join(' ');
  }
}

// Sealed-box listing junk: single packs, opened/empty boxes, lots.  "pack" is
// junk only when the title isn't about a box/case (box titles legitimately
// say "36 packs").
function isSealedJunkTitle(title) {
  const t = title ?? '';
  if (/\b(single|opened|empty|lot|partial|repack)\b/i.test(t)) return true;
  if (/\bpacks?\b/i.test(t) && !/\b(box|case)\b/i.test(t)) return true;
  return false;
}

// ── Grade-aware result filters ────────────────────────────────────────────────

// Keep only items whose title includes "<COMPANY> <GRADE>" (e.g. "PSA 9").
// When gradeFilter.cardNumber is set, also requires the card number in the title
// so a cheaper Stephen Curry PSA 9 from a different set can't dilute the price.
// gradeFilter: { company: 'PSA', grade: '9', cardNumber: '321' }  — null for raw items.
function filterByGradeTag(items, gradeFilter, titleField = 'title') {
  if (!gradeFilter?.company) return items;
  const tag = `${gradeFilter.company} ${gradeFilter.grade ?? ''}`.trim().toUpperCase();
  const cn  = gradeFilter.cardNumber ? String(gradeFilter.cardNumber).toUpperCase() : null;
  return items.filter(i => {
    const title = (i[titleField] ?? '').toUpperCase();
    if (!title.includes(tag)) return false;
    // Card-number check: avoid matching other sets (e.g. Topps Chrome #321 vs base #321)
    if (cn && !title.includes(cn)) return false;
    return true;
  });
}

// Pick the best image from a list of eBay listing summaries.
// Prefers a listing whose title contains all significant words of the card name
// so we don't end up showing a pack image or the wrong player.
function pickBestImage(items, name) {
  if (!items.length) return null;
  if (!name) return items[0]?.image?.imageUrl ?? null;
  // Significant words: length > 2 chars (skips "Jr", "De", etc.)
  const parts = name.toLowerCase().split(/\s+/).filter(p => p.length > 2);
  if (!parts.length) return items[0]?.image?.imageUrl ?? null;
  const best = items.find(i =>
    parts.every(p => (i.title ?? '').toLowerCase().includes(p))
  );
  return (best ?? items[0])?.image?.imageUrl ?? null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── eBay fetch helpers ────────────────────────────────────────────────────────
// eBay is an active-listing source only — market value (sold median) comes
// exclusively from PriceCharting.

// Active low (Fixed Price) via Browse API.
// Returns { activeLow, imageUrl } — imageUrl is used to replace a temporary
// scan photo with a real eBay CDN URL.
//
// gradeFilter: { company, grade } — keeps only graded-slab listings.
// itemName: card name (e.g. "Stephen Curry") — used to pick the best image
//   from the filtered results so we don't accidentally show a pack image.
async function fetchActiveLow(keywords, gradeFilter = null, itemName = null) {
  const data = await ebayGet('/buy/browse/v1/item_summary/search', {
    q:      keywords,
    // 25-deep pool: with sort=price the cheapest results are often raw cards
    // that the graded-title filter rejects — a shallow pool can miss every
    // slab listing and return null even when slabs exist (matches the pool
    // depth used by fetchActiveListings).
    limit:  25,
    sort:   'price',
    filter: 'buyingOptions:{FIXED_PRICE}',
  });

  const raw    = data.itemSummaries ?? [];
  // Keep only listings whose title contains the grading company + grade
  // (e.g. "PSA 9") — prevents a $10 raw card from becoming the active-low
  // or providing the wrong image.
  const items  = filterByGradeTag(raw, gradeFilter);
  const prices = items
    .map(i => parseFloat(i.price?.value))
    .filter(v => !isNaN(v) && v > 0);

  return {
    activeLow: prices.length ? Math.min(...prices) : null,
    // Prefer an image from a listing that names the card/player to avoid
    // showing a pack, wrapper, or completely unrelated item.
    imageUrl:  pickBestImage(items.length ? items : raw, itemName),
  };
}

// Junk filter for display listings — intentionally light: card titles
// legitimately contain words like "set" ("Base Set") and "box" is fine for
// sealed items.  Blocks multi-card lots and fakes only.
const LISTING_JUNK_RE = /\b(lot|bundle|reseal|resealed|proxy|digital|custom|reprint)\b/i;

// ── Active eBay listings for the item detail page ─────────────────────────────
// Returns up to `limit` live fixed-price listings mapped for display:
//   { title, price, currency, condition, seller, url, image }
// plus the search query used (for a "view all on eBay" link).
//
// Graded items are title-filtered to the matching company + grade + card number
// so a raw copy never shows under a PSA 9 slab's listings.  Sorted by price
// ascending (eBay sort=price), so the first card is the cheapest.
async function fetchActiveListings(item, limit = 8) {
  const keywords    = buildQuery(item);
  const gradeFilter = item.condition === 'graded' && item.grading_company
    ? { company: item.grading_company, grade: item.grade, cardNumber: item.card_number }
    : null;

  const data = await ebayGet('/buy/browse/v1/item_summary/search', {
    q:      keywords,
    limit:  25,          // wide pool — title filtering below cuts it down
    sort:   'price',
    filter: 'buyingOptions:{FIXED_PRICE}',
  });

  const raw      = data.itemSummaries ?? [];
  const filtered = filterByGradeTag(raw, gradeFilter)
    .filter(l => item.item_type === 'sealed'
      ? !isSealedJunkTitle(l.title)
      : !LISTING_JUNK_RE.test(l.title ?? ''))
    .filter(l => parseFloat(l.price?.value) > 0);

  return {
    search_query: keywords,
    listings: filtered.slice(0, limit).map(l => ({
      title:     l.title ?? '',
      price:     parseFloat(l.price.value),
      currency:  l.price?.currency ?? 'USD',
      condition: l.condition ?? null,
      seller:    l.seller?.username ?? null,
      url:       l.itemWebUrl ?? null,
      image:     l.image?.imageUrl ?? l.thumbnailImages?.[0]?.imageUrl ?? null,
    })),
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

// In-process overlap guard — the boot backfill, the 3 AM cron, and the manual
// admin trigger all live in one process; concurrent runs would insert duplicate
// price_history rows for the same day.
let _jobRunning = false;

async function runEbayJob() {
  const appId   = (process.env.EBAY_APP_ID  ?? '').trim();
  const certId  = (process.env.EBAY_CERT_ID ?? '').trim();
  const pcToken = (process.env.PRICE_CHARTING_TOKEN ?? '').trim();
  const hasEbay = !!(appId && certId);

  if (!hasEbay && !pcToken) {
    console.log('[ebay-job] Skipped: no pricing source configured (need EBAY_APP_ID+EBAY_CERT_ID or PRICE_CHARTING_TOKEN)');
    return { skipped: true, reason: 'No pricing source configured' };
  }
  if (_jobRunning) {
    console.log('[ebay-job] Skipped: a price job is already running');
    return { skipped: true, reason: 'Job already running' };
  }
  _jobRunning = true;
  try {
    return await _runEbayJobInner(hasEbay);
  } finally {
    _jobRunning = false;
  }
}

async function _runEbayJobInner(hasEbay) {
  if (!hasEbay) {
    console.log('[ebay-job] eBay credentials not set — PriceCharting-only run (no active-low / comparable sales)');
  }

  console.log('[ebay-job] Starting (Browse API)...');
  const startedAt = Date.now();

  // Distinct (catalog_id, condition, grade) combos
  const { rows: combos } = await pool.query(`
    SELECT DISTINCT ON (pi.catalog_id, pi.condition, pi.grade)
      pi.catalog_id, pi.condition, pi.grade, pi.grading_company,
      pi.is_one_of_one,
      mc.item_type, mc.name, mc.year, mc.set_name, mc.card_number,
      mc.brand_publisher, mc.sport_game, mc.ebay_search_query, mc.rarity,
      mc.ebay_item_id
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
      const isOneOfOne    = combo.is_one_of_one === true;
      // Grade filter: graded results must have company+grade+card_number in the title
      // so cheaper same-player cards from other sets can't dilute the price sample.
      const gradeFilter   = combo.condition === 'graded' && combo.grading_company
        ? { company: combo.grading_company, grade: combo.grade, cardNumber: combo.card_number }
        : null;

      let soldMedian = null;
      let activeLow  = null;

      // Market value (skip for 1/1) — PriceCharting only; eBay is an
      // active-listing source, not a sold-price source.
      if (!isOneOfOne) {
        const pc = await fetchPriceCharting(combo);
        if (pc != null) {
          soldMedian = pc.price; // tier-mapped baseline
          console.log(`[ebay-job] ${combo.name} | PriceCharting tier value: $${soldMedian} (${pc.field})`);

          // Catalog image always comes from PriceCharting — per-user photos
          // live on portfolio_items.custom_image, never here.
          if (pc.image) {
            await pool.query(
              `UPDATE master_catalog SET image_url = $1 WHERE id = $2`,
              [pc.image, combo.catalog_id]
            );
          }

          // Sync sales/history first, then sold median = median of the exact
          // comps Recent Sales displays (shared getItemComps).
          await syncPcHistory(combo.catalog_id, combo.condition, combo.grade, pc);
          const comps = await getItemComps(combo.catalog_id, combo);
          if (comps.count >= 3 && comps.median > 0) {
            console.log(`[ebay-job] ${combo.name} | sold median from ${comps.count} comps: $${comps.median}`);
            soldMedian = comps.median;
          }
        }
      } else {
        skippedOneOfOne++;
      }

      // Active low is always sourced from eBay active listings
      if (hasEbay) {
        ({ activeLow } = await fetchActiveLow(keywords, gradeFilter, combo.name));
        console.log(`[ebay-job] ${combo.name} | active low: ${activeLow ? '$' + activeLow : '—'}`);
        await sleep(400);
      }

      // Write price_history rows — one per source so `source` stays
      // unambiguous: pricecharting = market value, ebay = active-listing floor.
      if (soldMedian != null) {
        await pool.query(`
          INSERT INTO price_history (catalog_id, condition, grade, sold_median, active_low, source)
          VALUES ($1, $2, $3, $4, NULL, 'pricecharting')
        `, [combo.catalog_id, combo.condition, combo.grade, soldMedian]);
      }
      if (activeLow != null) {
        await pool.query(`
          INSERT INTO price_history (catalog_id, condition, grade, sold_median, active_low, source)
          VALUES ($1, $2, $3, NULL, $4, 'ebay')
        `, [combo.catalog_id, combo.condition, combo.grade, activeLow]);
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

      // Comparable sales for 1/1 items (eBay-only feature)
      if (isOneOfOne && hasEbay) {
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

// ── PriceCharting price lookup ────────────────────────────────────────────────
//
// Two-step API flow (same API + token on both domains):
//   Step 1 (search) : GET {base}/api/products?t=TOKEN&q=QUERY
//                       → [{id, product-name, console-name}]
//   Step 2 (by ID)  : GET {base}/api/product?t=TOKEN&id=PRODUCT_ID
//                       → {product-name, loose-price, graded-price, …}
//
// Domain priority — sportscardspro.com FIRST:
//   pricecharting.com's sports-name search surfaces Funko POP figures
//   ("Funko POP Basketball"), while sportscardspro.com indexes the actual
//   cards ("Basketball Cards 2003 Topps") with real loose/graded prices.
//   pricecharting.com remains the fallback for Pokemon/TCG/video games,
//   which sportscardspro doesn't cover.
//
// Prices are in CENTS — divide by 100 for dollars.
// PriceCharting stores 0 for "no price recorded"; treat as missing.
//
// Price selection is grade-aware with half-grade interpolation — see pcPriceForGrade().
//
// Query variations (most → least specific):
//   Try 1: "name #card_number"           → "LeBron James #111"
//   Try 2: "name year brandShort"        → "LeBron James 2003 Topps"
//   Try 3: "name set_name"               → "LeBron James Topps Chrome"
//   Try 4: "name year"                   → "LeBron James 2003"
//   Try 5: "name"                        → "LeBron James"
//
// Returns { price, image, field, productName, consoleName } or null when no
// usable price was found.  `image` is the card image from the PriceCharting
// product (or its images CDN), null when unavailable.

const PC_BASES = [
  'https://www.sportscardspro.com',  // primary — real sports cards
  'https://www.pricecharting.com',   // fallback — Pokemon / TCG / video games
];

// Funko POPs and other figure lines share player names with cards on
// pricecharting.com — never price a card from a figure listing.
const PC_JUNK_CONSOLE_RE = /\bfunko\b|\bpop!/i;

// Score how well a PriceCharting product matches our item.
// console-name carries the set/year ("Basketball Cards 1986 Fleer"),
// product-name carries the card number ("Michael Jordan #57").
//
// Set words that are MISSING from the console count against the match — a
// search for "Donruss Optic Downtown" must never settle for base Donruss
// Optic when the Downtown insert isn't in PC's database at all.  Numeric
// tokens (e.g. "1986-87") are exempt from the penalty since consoles write
// seasons differently.  A DIFFERENT card number is near-disqualifying:
// base Optic #23 is not Downtown #DT-23.
function scorePcProduct(product, year, set_name, card_number) {
  const consoleName = (product['console-name'] ?? '').toLowerCase();
  const productName = (product['product-name'] ?? '').toLowerCase();
  let score = 0;
  if (year && consoleName.includes(String(year))) score += 3;
  if (set_name) {
    const setParts = set_name.toLowerCase().split(/\s+/);
    for (const part of setParts) {
      if (part.length <= 2) continue;
      if (consoleName.includes(part)) {
        score += 2;
      } else if (!/^\d/.test(part)) {
        score -= 2;
      }
    }
  }
  if (card_number) {
    const cn = String(card_number).toLowerCase();
    const m  = productName.match(/#\s*([a-z0-9-]+)/i);
    if (m) score += m[1].toLowerCase() === cn ? 4 : -8;
  }
  return score;
}

// ── Grade → PriceCharting price selection ─────────────────────────────────────
// EMPIRICALLY CONFIRMED field ↔ grade mapping — validated by matching live
// production API values against the labeled grade columns on the
// pricecharting.com product page for 2003 Topps Chrome LeBron James #111:
//
//   loose-price        = Ungraded     ($1,417 on the reference card)
//   cib-price          = Grade 7      ($1,266)
//   new-price          = Grade 8      ($1,873)
//   graded-price       = Grade 9      ($2,997.50 — exact match to the API)
//   box-only-price     = Grade 9.5    ($4,422)
//   manual-only-price  = PSA 10       ($12,293 — matches its PSA 10 sales)
//   condition-17/18-price = SGC 10 / CGC 10 / BGS 10 tiers (exact per-company
//     assignment unconfirmed — compare all_price_fields in the admin test
//     endpoint against the product page's labeled 10s columns)
//
// Grade tiers below 10 are company-agnostic (PC infers the grade from listing
// titles), so PSA/BGS/SGC share the 7/8/9/9.5 ladder.  Half grades now sit
// between ADJACENT grade tiers, so a plain average is accurate — the old
// 40-60% clamp existed only because the previous (wrong) ladder averaged
// tiers two whole grades apart.
//
// When one side of an average has no data, the available side is used alone;
// exact tiers fall back down the ladder when their field is empty.
// Returns { cents, field } or null when no usable price exists.
function pcPriceForGrade(product, item) {
  const val = f => (product[f] > 0 ? product[f] : null);
  const single = (...fields) => {
    for (const f of fields) {
      const v = val(f);
      if (v != null) return { cents: v, field: f };
    }
    return null;
  };
  const avg = (fLow, fHigh) => {
    const a = val(fLow);
    const b = val(fHigh);
    if (a != null && b != null) return { cents: Math.round((a + b) / 2), field: `avg(${fLow}, ${fHigh})` };
    return single(fLow, fHigh);
  };

  const { condition, grading_company, grade } = item;
  if (condition !== 'graded') return single('loose-price');

  const g = parseFloat(grade);
  if (isNaN(g)) return single('graded-price', 'new-price'); // graded, but grade unknown

  const co = (grading_company ?? 'PSA').toUpperCase() === 'BECKETT'
    ? 'BGS'
    : (grading_company ?? 'PSA').toUpperCase();

  if (g >= 10) {
    // PSA 10 = manual-only-price (confirmed).  Other companies' 10s live in
    // the condition-17/18 fields; fall back toward the PSA 10 / 9.5 tiers
    // when those are empty rather than returning nothing.
    return co === 'PSA'
      ? single('manual-only-price', 'box-only-price')
      : single('condition-17-price', 'condition-18-price', 'manual-only-price', 'box-only-price');
  }
  if (g >= 9.5) return single('box-only-price', 'graded-price'); // Grade 9.5 tier
  if (g >= 9)   return single('graded-price');                   // Grade 9
  if (g >= 8.5) return avg('new-price', 'graded-price');         // between 8 and 9
  if (g >= 8)   return single('new-price');                      // Grade 8
  if (g >= 7.5) return avg('cib-price', 'new-price');            // between 7 and 8
  if (g >= 7)   return single('cib-price');                      // Grade 7
  return single('loose-price');                                  // below 7 ≈ raw floor
}

// Image-field candidates seen across PriceCharting/SportsCardsPro product
// responses — the API does not document an image field, so probe broadly.
const PC_IMAGE_FIELDS = ['image', 'image-url', 'image_url', 'photo', 'photo-url', 'cover-url', 'boxart-url'];

// Extract a card image from a PriceCharting product response — explicit image
// fields only (the API rarely sets any).  The real image lives on the product
// PAGE at storage.googleapis.com/images.pricecharting.com/<hash>/1600.jpg,
// where <hash> is NOT derivable from the product id — see fetchPcPageImage.
function pcProductImage(product) {
  for (const f of PC_IMAGE_FIELDS) {
    const v = product[f];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  }
  return null;
}

// ── PriceCharting product PAGE data ───────────────────────────────────────────
//
// The product page embeds everything the API doesn't expose:
//   VGPC.chart_data — per-tier monthly price series back to ~2020:
//     used=Ungraded, cib=Grade 7, new=Grade 8, graded=Grade 9,
//     boxonly=Grade 9.5, manualonly=PSA 10   ([epoch_ms, cents] pairs)
//   completed-auctions-* tables — the ~30 most recent sold listings per tier
//     (<tr id="ebay-LISTINGID"> rows with date / title / price / eBay URL)
//   the real card image (storage.googleapis.com/images.pricecharting.com/<hash>/)
//
// /game/<id> 301s to the canonical page, so the numeric API product id is all
// that's needed.  PC rate-limits bursts (403) — fetches are cached on success,
// never cached on failure, and callers degrade gracefully.

const PC_PAGE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// chart_data key → tier identity.  Tiers below 10 are company-agnostic; the
// top tier is PC's "PSA 10" column.
const PC_TIERS = {
  used:       { condition: 'raw',    grade: null,  label: 'Ungraded'  },
  cib:        { condition: 'graded', grade: '7',   label: 'Grade 7'   },
  new:        { condition: 'graded', grade: '8',   label: 'Grade 8'   },
  graded:     { condition: 'graded', grade: '9',   label: 'Grade 9'   },
  boxonly:    { condition: 'graded', grade: '9.5', label: 'Grade 9.5' },
  manualonly: { condition: 'graded', grade: '10',  label: 'PSA 10'    },
};

// completed-auctions section suffix → tier label (sales tables)
const PC_SALES_SECTIONS = {
  'used':        'Ungraded',
  'cib':         'Grade 7',
  'new':         'Grade 8',
  'graded':      'Grade 9',
  'box-only':    'Grade 9.5',
  'manual-only': 'PSA 10',
};

const PC_WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// Resolve a completed-auctions section key to a display label.
// Returns null for sections we can't truthfully label (game-completeness
// combos like "loose-and-box", and the numbered 17+ company tiers whose
// company assignment is unconfirmed) — their rows are skipped.
function pcSectionLabel(key) {
  if (PC_SALES_SECTIONS[key]) return PC_SALES_SECTIONS[key];
  const gm = key?.match(/^grade-([a-z]+)$/);
  if (gm && PC_WORD_NUMBERS[gm[1]] != null) return `Grade ${PC_WORD_NUMBERS[gm[1]]}`;
  return null;
}

// Pure parser — exercised in tests against a saved real page.
// Returns { image, chart: {tierKey: [{date, cents}]}, sales: [{listingId,
// gradeLabel, date, price, title, url}] }.
function parsePcPage(html) {
  // Image
  const im = html.match(/https:\/\/storage\.googleapis\.com\/images\.pricecharting\.com\/([a-z0-9]+)\/\d+\.jpg/i);
  const image = im ? `https://storage.googleapis.com/images.pricecharting.com/${im[1]}/1600.jpg` : null;

  // Chart series
  const chart = {};
  const cm = html.match(/VGPC\.chart_data\s*=\s*(\{[\s\S]*?\});/);
  if (cm) {
    try {
      const raw = JSON.parse(cm[1]);
      for (const [key, series] of Object.entries(raw)) {
        if (!PC_TIERS[key] || !Array.isArray(series)) continue;
        chart[key] = series
          .filter(pt => Array.isArray(pt) && pt[1] > 0)
          .map(pt => ({ date: new Date(pt[0]).toISOString().slice(0, 10), cents: Math.round(pt[1]) }));
      }
    } catch (err) {
      console.warn(`[pricecharting] chart_data parse failed: ${err.message}`);
    }
  }

  // Sold listings — rows live inside per-tier containers like
  // <div class="completed-auctions-used">.  (The class must START with the
  // marker — tab-bar buttons carry "tab ... completed-auctions-used" and are
  // navigation, not containers.)  Rows attribute to the nearest preceding
  // container marker.
  const sales = [];
  const sectionRe = /<div class="completed-auctions-([a-z0-9-]+)"/g;
  const markers = [];
  let sm;
  while ((sm = sectionRe.exec(html)) !== null) {
    markers.push({ key: sm[1], index: sm.index });
  }
  const rowRe = /<tr id="ebay-(\d+)">\s*<td class="date">(\d{4}-\d{2}-\d{2})<\/td>[\s\S]*?(?:href="([^"]*)"[^>]*>\s*([^<]+?)\s*<\/a>\s*\[eBay\][\s\S]*?)?<span class="js-price"\s*>\$([\d,]+(?:\.\d+)?)<\/span>/g;
  let rm;
  while ((rm = rowRe.exec(html)) !== null) {
    // nearest preceding section marker
    let section = null;
    for (const mk of markers) {
      if (mk.index < rm.index) section = mk.key;
      else break;
    }
    const gradeLabel = pcSectionLabel(section);
    if (!gradeLabel) continue; // ambiguous section — skip rather than mislabel

    sales.push({
      listingId:  rm[1],
      gradeLabel,
      date:       rm[2],
      url:        rm[3] ?? null,
      title:      (rm[4] ?? '').trim() || null,
      price:      parseFloat(rm[5].replace(/,/g, '')),
    });
  }

  return { image, chart, sales };
}

// Cached page fetch+parse.  Successful parses are cached with a 20-hour TTL —
// long enough that one daily cron pass reuses a single fetch across all of a
// catalog's combos, short enough that the NEXT day's pass picks up newly
// published points and sales (the server process lives across cron runs).
// Bot-protection failures are never cached so later attempts can succeed.
const _pcPageCache = new Map();
const PC_PAGE_TTL_MS = 20 * 60 * 60 * 1000;

async function fetchPcPage(productId) {
  const id = String(productId ?? '');
  if (!/^\d+$/.test(id)) return null;
  const hit = _pcPageCache.get(id);
  if (hit && Date.now() - hit.at < PC_PAGE_TTL_MS) return hit.data;

  try {
    const resp = await fetch(`https://www.pricecharting.com/game/${id}`, {
      redirect: 'follow',
      headers: { 'User-Agent': PC_PAGE_UA },
      signal: AbortSignal.timeout(12_000),
    });
    if (resp.ok) {
      const parsed = parsePcPage(await resp.text());
      console.log(`[pricecharting] page /game/${id}: image=${parsed.image ? 'yes' : 'no'}, chart tiers=${Object.keys(parsed.chart).length}, sales=${parsed.sales.length}`);
      _pcPageCache.set(id, { data: parsed, at: Date.now() });
      return parsed;
    }
    console.warn(`[pricecharting] page /game/${id} → HTTP ${resp.status} (not cached)`);
  } catch (err) {
    console.warn(`[pricecharting] page /game/${id} failed: ${err.message} (not cached)`);
  }
  return null;
}

// Image-only convenience wrapper (used by the pricing and search paths)
async function fetchPcPageImage(productId) {
  const page = await fetchPcPage(productId);
  return page?.image ?? null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Scanned cards often arrive with everything stuffed into the name —
// "Michael Jordan 1986-87 Fleer #57" — which duplicates the structured
// year/set_name/card_number fields and turns query variations into garbage
// like "Michael Jordan 1986-87 Fleer #57 #57".  Strip those tokens (plus
// grading and rookie markers) so the queries are built from a clean core
// name like "Michael Jordan".
function cleanPcName(item) {
  const { name, set_name } = item;
  let n = ` ${name ?? ''} `;
  if (set_name) n = n.replace(new RegExp(escapeRegExp(set_name.trim()), 'ig'), ' ');
  n = n
    .replace(/\b(19|20)\d{2}\s*[-/–]\s*\d{2,4}\b/g, ' ')             // seasons: 1986-87
    .replace(/\b(19|20)\d{2}\b/g, ' ')                               // plain years
    .replace(/#\s*[a-z0-9-]+\b/gi, ' ')                              // card numbers
    .replace(/\b(psa|bgs|sgc|cgc|beckett)\s*\d+(\.\d+)?\b/gi, ' ')   // grade strings
    .replace(/\b(rookie\s+card|rookie|rc)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n || (name ?? '').trim();
}

// Build the deduplicated query-variation ladder for an item (most → least specific).
function buildPcQueries(item) {
  const { name, year, set_name, card_number } = item;
  const coreName = cleanPcName(item);

  // Brand token from set_name with any leading year/season stripped —
  // "1986-87 Fleer" → "Fleer", "Topps Chrome" → "Topps".
  const setBrand   = set_name ? set_name.replace(/\b(19|20)\d{2}([-/–]\d{2,4})?\b/g, ' ').trim() : '';
  const brandShort = setBrand ? setBrand.split(/\s+/)[0] : null;

  const rawVariations = [
    card_number ? `${coreName} #${card_number}` : null,
    [coreName, year, brandShort].filter(Boolean).join(' '),
    [coreName, setBrand || set_name].filter(Boolean).join(' '),
    [coreName, year].filter(Boolean).join(' '),
    coreName,
    // Raw name last — only differs from coreName for scan-style names, and
    // by then every structured variation has already been tried.
    name,
  ];
  return [...new Set(rawVariations.filter(Boolean).map(q => q.trim()).filter(Boolean))];
}

function isHalfGrade(grade) {
  const g = parseFloat(grade);
  return !isNaN(g) && g % 1 !== 0;
}

// Log every *-price field PC returned for a matched product — visibility into
// what grade-specific pricing the API actually exposes (condition-17/18 hint
// there may be more condition-keyed fields than the documented five).
function logPcPriceFields(product) {
  const prices = {};
  for (const [k, v] of Object.entries(product)) {
    if (/-price$/.test(k) && typeof v === 'number' && v > 0) {
      prices[k] = `$${(v / 100).toFixed(2)}`;
    }
  }
  console.log(`[pricecharting] price fields for "${product['product-name']}": ${JSON.stringify(prices)}`);
}

// Half grades sometimes exist as their own SCP product entry (e.g.
// "Michael Jordan #57 [BGS 8.5]") with exact market data — always better
// than tier interpolation.  Searches "name #num BGS 8.5" and only trusts
// products whose name/console explicitly carries that grade marker, so the
// regular (all-grades) product can never be mistaken for a grade-specific one.
// Returns the same shape as pcLookupOnBase, or null when no entry exists.
async function pcGradeSpecificLookup(baseUrl, item, token) {
  const { condition, grading_company, grade, card_number, year, set_name } = item;
  if (condition !== 'graded' || !grading_company || !isHalfGrade(grade)) return null;

  const co = grading_company.toUpperCase() === 'BECKETT' ? 'BGS' : grading_company.toUpperCase();
  if (!['BGS', 'SGC'].includes(co)) return null;

  const coreName = cleanPcName(item);
  const gradeTag = `${co} ${grade}`;
  const gradeRe  = new RegExp(`${co.toLowerCase()}[\\s-]*${escapeRegExp(String(grade))}(?![0-9])`, 'i');
  const tEnc     = encodeURIComponent(token);
  const host     = new URL(baseUrl).hostname.replace(/^www\./, '');

  const queries = [...new Set([
    card_number ? `${coreName} #${card_number} ${gradeTag}` : null,
    `${coreName} ${gradeTag}`,
  ].filter(Boolean))];

  for (const q of queries) {
    try {
      console.log(`[pricecharting] ${host} grade-specific: search "${q}"`);
      const resp = await fetch(`${baseUrl}/api/products?t=${tEnc}&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) continue;
      const data = await resp.json().catch(() => null);
      if (!data || data.status !== 'success' || !data.products?.length) continue;

      // Only products that explicitly name this grade qualify.
      const gradeProducts = data.products.filter(p =>
        gradeRe.test(`${p['product-name'] ?? ''} ${p['console-name'] ?? ''}`) &&
        !PC_JUNK_CONSOLE_RE.test(p['console-name'] ?? ''));
      if (!gradeProducts.length) {
        console.log(`[pricecharting] ${host} grade-specific: no products carry "${gradeTag}" — falling back to tier mapping`);
        continue;
      }

      const scored = gradeProducts
        .map(p => ({ p, score: scorePcProduct(p, year, set_name, card_number) }))
        .sort((a, b) => b.score - a.score);
      if ((year || set_name || card_number) && scored[0].score <= 0) continue;
      const best = scored[0].p;

      let product = best;
      if (best.id) {
        try {
          const priceResp = await fetch(`${baseUrl}/api/product?t=${tEnc}&id=${encodeURIComponent(best.id)}`, { signal: AbortSignal.timeout(10_000) });
          if (priceResp.ok) {
            const priceData = await priceResp.json().catch(() => null);
            if (priceData?.status === 'success') product = priceData;
          }
        } catch (_) { /* keep search-result product */ }
      }
      logPcPriceFields(product);

      // A grade-specific product's graded-price IS this grade's market value;
      // some entries carry it under loose-price instead.
      const cents = (product['graded-price'] > 0 ? product['graded-price'] : null)
                 ?? (product['loose-price']  > 0 ? product['loose-price']  : null);
      if (cents == null) continue;

      const price = parseFloat((cents / 100).toFixed(2));
      const image = pcProductImage(product) ?? await fetchPcPageImage(best.id);
      console.log(`[pricecharting] ${host} grade-specific matched: "${product['product-name']}" | ${product['console-name'] ?? '?'} — $${price} via "${q}"`);
      return {
        price,
        image,
        field:       'graded-price (grade-specific product)',
        productId:   best.id ?? null,
        baseUrl,
        productName: product['product-name'],
        consoleName: product['console-name'] ?? best['console-name'] ?? null,
      };
    } catch (err) {
      console.error(`[pricecharting] ${host} grade-specific error for "${q}": ${err.message}`);
    }
  }
  return null;
}

// Run the full query-variation ladder against one domain.
// Returns { price, image, field, productId, baseUrl, productName, consoleName } or null.
async function pcLookupOnBase(baseUrl, item, token) {
  const { year, set_name, card_number, condition } = item;
  const tEnc    = encodeURIComponent(token);
  const queries = buildPcQueries(item);
  const host    = new URL(baseUrl).hostname.replace(/^www\./, '');

  // Half grades: a grade-specific product entry (exact market data) beats
  // any tier mapping or interpolation.
  const gradeSpecific = await pcGradeSpecificLookup(baseUrl, item, token);
  if (gradeSpecific) return gradeSpecific;

  // Exact-product short-circuit: SCP-imported catalog rows carry the SCP
  // product id in ebay_item_id (numeric) — fetch it directly instead of
  // re-searching by text, which could land on a different card.  eBay-era
  // ids ("v1|...|0") fail the numeric test and fall through to the ladder.
  const directId = /^\d+$/.test(String(item.ebay_item_id ?? '')) ? String(item.ebay_item_id) : null;
  if (directId) {
    try {
      const resp = await fetch(`${baseUrl}/api/product?t=${tEnc}&id=${encodeURIComponent(directId)}`, { signal: AbortSignal.timeout(10_000) });
      if (resp.ok) {
        const product = await resp.json().catch(() => null);
        if (product?.status === 'success') {
          logPcPriceFields(product);
          const priced = pcPriceForGrade(product, item);
          if (priced != null) {
            const price = parseFloat((priced.cents / 100).toFixed(2));
            const image = pcProductImage(product) ?? await fetchPcPageImage(directId);
            console.log(`[pricecharting] ${host} direct-id ${directId} matched: "${product['product-name']}" | ${product['console-name'] ?? '?'} — $${price} from ${priced.field}`);
            return {
              price,
              image,
              field:       priced.field,
              productId:   directId,
              baseUrl,
              productName: product['product-name'],
              consoleName: product['console-name'] ?? null,
            };
          }
        }
      }
    } catch (err) {
      console.warn(`[pricecharting] ${host} direct-id ${directId} lookup failed: ${err.message} — falling back to text search`);
    }
  }

  for (let i = 0; i < queries.length; i++) {
    const q      = queries[i];
    const tryTag = `${host} try ${i + 1}/${queries.length}`;

    try {
      // ── Step 1: search for products matching the query ──────────────────
      const searchUrl = `${baseUrl}/api/products?t=${tEnc}&q=${encodeURIComponent(q)}`;
      console.log(`[pricecharting] ${tryTag}: search "${q}" (condition=${condition ?? 'raw'})`);

      const searchResp = await fetch(searchUrl, { signal: AbortSignal.timeout(10_000) });
      if (!searchResp.ok) {
        console.warn(`[pricecharting] ${tryTag} search HTTP ${searchResp.status} — skipping`);
        continue;
      }

      const searchData = await searchResp.json().catch(() => null);
      if (!searchData || searchData.status !== 'success' || !searchData.products?.length) {
        console.log(`[pricecharting] ${tryTag}: no search results`);
        continue;
      }

      // Drop Funko/figure listings, then score by console-name match.
      const candidates = searchData.products.filter(p => !PC_JUNK_CONSOLE_RE.test(p['console-name'] ?? ''));
      if (!candidates.length) {
        console.log(`[pricecharting] ${tryTag}: only Funko/figure results — skipping`);
        continue;
      }
      const scored = candidates
        .map(p => ({ p, score: scorePcProduct(p, year, set_name, card_number) }))
        .sort((a, b) => b.score - a.score);

      // When the item carries identifying fields, never accept a best match
      // that corroborates NONE of them (score ≤ 0).  A name-only hit from a
      // broad query can be a different card entirely — wrong set, wrong era,
      // wrong card number — whose price is wildly off (e.g. a $20 junk-wax
      // Jordan pricing a 1986 Fleer #57).
      if ((year || set_name || card_number) && scored[0].score <= 0) {
        console.log(`[pricecharting] ${tryTag}: best match "${scored[0].p['product-name']}" (${scored[0].p['console-name'] ?? '?'}) scored ${scored[0].score} — rejected, trying next query`);
        continue;
      }
      const best = scored[0].p;

      // ── Step 2: fetch full price data by product ID ─────────────────────
      // The search endpoint returns only {id, product-name, console-name}.
      // Prices live on the singular /api/product?id= endpoint.
      let product = best;
      if (best.id) {
        try {
          const priceUrl  = `${baseUrl}/api/product?t=${tEnc}&id=${encodeURIComponent(best.id)}`;
          const priceResp = await fetch(priceUrl, { signal: AbortSignal.timeout(10_000) });
          if (priceResp.ok) {
            const priceData = await priceResp.json().catch(() => null);
            if (priceData?.status === 'success') product = priceData;
          }
        } catch (priceErr) {
          console.warn(`[pricecharting] ${tryTag} price-fetch failed for id=${best.id}: ${priceErr.message}`);
        }
      }

      logPcPriceFields(product);

      // Grade-aware price selection — half grades interpolate between the two
      // surrounding tier prices.  Values are cents; 0 means "no price recorded".
      const priced = pcPriceForGrade(product, item);
      if (priced == null) {
        console.log(`[pricecharting] ${tryTag}: "${product['product-name']}" (${product['console-name'] ?? best['console-name'] ?? '?'}) has no usable price for ${item.grading_company ?? ''} ${item.grade ?? item.condition ?? 'raw'} — skipping`);
        continue;
      }
      const { cents, field } = priced;

      const price = parseFloat((cents / 100).toFixed(2));
      const image = pcProductImage(product) ?? await fetchPcPageImage(best.id);
      console.log(`[pricecharting] ${tryTag} matched: "${product['product-name']}" | ${product['console-name'] ?? best['console-name'] ?? '?'} — $${price} from ${field}${image ? ' (+image)' : ''} via "${q}"`);
      return {
        price,
        image,
        field,
        productId:   best.id ?? null,
        baseUrl,
        productName: product['product-name'],
        consoleName: product['console-name'] ?? best['console-name'] ?? null,
      };

    } catch (err) {
      console.error(`[pricecharting] ${tryTag} error for "${q}": ${err.message}`);
      // fall through to next variation
    }
  }

  return null;
}

// ── Strict grading-company title matching ─────────────────────────────────────
// A PSA card's comps must be PSA listings only — a BGS 9.5 in the title means
// it's not a comp for a PSA 9.5.  BGS and Beckett are the same company.
// company=null means RAW: no grading company may appear at all.
const PC_COMPANY_RES = {
  PSA:     /\bPSA\b/i,
  BGS:     /\b(BGS|BECKETT)\b/i,
  SGC:     /\bSGC\b/i,
  CGC:     /\bCGC\b/i,
};

function titleMatchesCompany(title, company) {
  const t = title ?? '';
  const co = company ? (company.toUpperCase() === 'BECKETT' ? 'BGS' : company.toUpperCase()) : null;

  if (!co || !PC_COMPANY_RES[co]) {
    // Raw (or unknown company): reject titles naming any grading company
    return !Object.values(PC_COMPANY_RES).some(re => re.test(t));
  }
  if (!PC_COMPANY_RES[co].test(t)) return false;
  return !Object.entries(PC_COMPANY_RES).some(([k, re]) => k !== co && re.test(t));
}

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

// ── THE single source of truth for an item's sold comparables ────────────────
// Both the Recent Sales display AND the sold-median calculation use this exact
// query + filter chain, so they can never disagree: bucket by tier, strict
// grading-company match, exact half-grade title filter (with fallback), 30
// most recent.  median is computed over precisely the sales that render.
async function getItemComps(catalogId, item) {
  const { label: bucket, halfGrade } = pcTierLabelFor(item);

  const { rows } = await pool.query(`
    SELECT sold_date::text AS date, grade_label, price, title, url
    FROM pc_sales
    WHERE catalog_id = $1 AND grade_label = $2
    ORDER BY sold_date DESC
    LIMIT 60
  `, [catalogId, bucket]);

  let sales = rows;
  if (item.condition !== 'graded') {
    sales = sales.filter(s => titleMatchesCompany(s.title, null));
  } else if (item.grading_company) {
    sales = sales.filter(s => titleMatchesCompany(s.title, item.grading_company));
  }

  let filtered = false;
  if (halfGrade && item.grading_company) {
    const re = new RegExp(`${item.grading_company}\\s*-?\\s*${escapeRegExp(String(item.grade))}(?![0-9])`, 'i');
    const exact = sales.filter(s => re.test(s.title ?? ''));
    if (exact.length) {
      sales = exact;
      filtered = true;
    }
  }

  sales = sales.slice(0, 30).map(s => ({ ...s, price: parseFloat(s.price) }));
  const prices = sales.map(s => s.price).filter(p => p > 0).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;

  return { bucket, halfGrade, sales, filtered, median, count: prices.length };
}

async function fetchPriceCharting(item) {
  const token = (process.env.PRICE_CHARTING_TOKEN ?? '').trim();
  if (!token) return null;

  // sportscardspro.com first; pricecharting.com only when it yields nothing.
  for (const baseUrl of PC_BASES) {
    const result = await pcLookupOnBase(baseUrl, item, token);
    if (result != null) return result;
  }

  console.log('[pricecharting] all domains and query variations exhausted — no usable price');
  return null;
}

// ── PriceCharting price history ───────────────────────────────────────────────
//
// PC doesn't document a history endpoint, so every known candidate is probed
// and the response parsed leniently for {date, price}-shaped entries:
//   1. /api/product/prices?t=&id=          (undocumented, reported to exist)
//   2. /api/sales?t=&id=                   (listed in PC's endpoint inventory)
//   3. /api/product?t=&id=&country=US      (main product call — some guides
//                                           attach history arrays here)
// Whatever responds first with parseable points wins.  Numeric prices are
// cents (PC convention); "$1,234.56" strings are dollars.

const PC_DATE_KEYS  = ['date', 'sale-date', 'sold-date', 'created-date', 'transaction-date', 'when'];
const PC_PRICE_KEYS = ['price', 'sale-price', 'sold-price', 'close-price', 'amount', 'value'];

// Scan a response object for the first array whose entries carry a date and a
// price.  Returns [{date: 'YYYY-MM-DD', cents}] — one point per day (last
// sale of the day wins), unlimited range: everything PC exposes is kept.
function extractPcHistoryPoints(data) {
  if (!data || typeof data !== 'object') return [];
  // A bare top-level array is the most natural shape for a sales endpoint
  const arrays = Array.isArray(data)
    ? [data]
    : Object.values(data).filter(v => Array.isArray(v) && v.length);

  for (const arr of arrays) {
    const points = [];
    for (const entry of arr) {
      if (entry == null || typeof entry !== 'object') continue;

      let date = null;
      for (const k of PC_DATE_KEYS) {
        const d = entry[k];
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) { date = d.slice(0, 10); break; }
      }

      let cents = null;
      for (const k of PC_PRICE_KEYS) {
        const p = entry[k];
        if (typeof p === 'number' && p > 0) { cents = Math.round(p); break; }
        if (typeof p === 'string') {
          const n = parseFloat(p.replace(/[$,]/g, ''));
          if (!isNaN(n) && n > 0) { cents = Math.round(n * 100); break; }
        }
      }

      if (date && cents != null) points.push({ date, cents });
    }

    if (points.length) {
      const byDay = new Map();
      for (const pt of points.sort((a, b) => a.date.localeCompare(b.date))) {
        byDay.set(pt.date, pt.cents);
      }
      return [...byDay.entries()].map(([date, cents]) => ({ date, cents }));
    }
  }
  return [];
}

async function fetchPcPriceHistory(baseUrl, productId, token) {
  const tEnc = encodeURIComponent(token);
  const idEnc = encodeURIComponent(productId);
  const candidates = [
    `${baseUrl}/api/product/history?t=${tEnc}&id=${idEnc}`,
    `${baseUrl}/api/product/prices?t=${tEnc}&id=${idEnc}`,
    `${baseUrl}/api/product/sales?t=${tEnc}&id=${idEnc}`,
    `${baseUrl}/api/prices?t=${tEnc}&id=${idEnc}`,
    `${baseUrl}/api/sales?t=${tEnc}&id=${idEnc}`,
    `${baseUrl}/api/product?t=${tEnc}&id=${idEnc}&country=US`,
  ];

  for (const url of candidates) {
    const masked = url.replace(tEnc, '***');
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const text = await resp.text();
      // Verbose by design: these endpoints are undocumented, and the raw
      // bodies in the Railway logs are how we learn what history PC exposes.
      console.log(`[pricecharting] history probe ${masked} → HTTP ${resp.status}: ${text.slice(0, 600)}`);
      if (!resp.ok) continue;

      let data = null;
      try { data = JSON.parse(text); } catch (_) { continue; }
      if (!data || data.status === 'error') continue;

      const points = extractPcHistoryPoints(data);
      if (points.length) {
        console.log(`[pricecharting] history: ${points.length} daily points via ${masked}`);
        return points;
      }
    } catch (err) {
      console.log(`[pricecharting] history probe ${masked} → ${err.message}`);
    }
  }

  console.log(`[pricecharting] history: no candidate endpoint returned parseable points for id=${productId}`);
  return [];
}

// Insert historic points as pricecharting rows for one (catalog, condition,
// grade) combo, skipping dates that already have a pricecharting row.
// Only STRICTLY PAST dates are inserted — today's value comes exclusively
// from the live grade-mapped pricer, so a product-level history point can
// never shadow it (recorded_at ranking would otherwise prefer the noon-
// stamped backfill row over the 3 AM cron row all day).
// Points outside [lo, hi] × todayPrice (dollars) are dropped — the history
// endpoints are product-level, and an off-scale point usually means a sale
// of a different grade.
async function backfillPcHistory(catalogId, condition, grade, points, todayPrice, lo = 0.25, hi = 4) {
  const today = new Date().toISOString().slice(0, 10);
  const sane = points.filter(pt =>
    pt.date < today &&
    (todayPrice == null || (pt.cents >= todayPrice * 100 * lo && pt.cents <= todayPrice * 100 * hi)));

  let inserted = 0;
  for (const { date, cents } of sane) {
    const { rowCount } = await pool.query(`
      INSERT INTO price_history (catalog_id, condition, grade, sold_median, active_low, source, recorded_at)
      SELECT $1, $2, $3, $4, NULL, 'pricecharting', $5::date + INTERVAL '12 hours'
      WHERE NOT EXISTS (
        SELECT 1 FROM price_history
        WHERE catalog_id = $1
          AND condition IS NOT DISTINCT FROM $2
          AND grade     IS NOT DISTINCT FROM $3
          AND source = 'pricecharting'
          AND recorded_at::date = $5::date
      )
    `, [catalogId, condition, grade, (cents / 100).toFixed(2), date]);
    inserted += rowCount;
  }
  return inserted;
}

// Upsert sold listings scraped from the product page; the (catalog_id,
// listing_id) unique constraint makes re-syncs no-ops for known sales.
async function upsertPcSales(catalogId, sales) {
  let inserted = 0;
  for (const s of sales) {
    if (!s.listingId || !s.date || !(s.price > 0)) continue;
    const { rowCount } = await pool.query(`
      INSERT INTO pc_sales (catalog_id, listing_id, grade_label, sold_date, price, title, url)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (catalog_id, listing_id) DO NOTHING
    `, [catalogId, s.listingId, s.gradeLabel, s.date, s.price, s.title, s.url]);
    inserted += rowCount;
  }
  return inserted;
}

// Market-data sync — runs on EVERY price refresh.  Idempotent throughout:
// history inserts skip existing dates, sales upserts skip known listings.
//
// Primary source is the product PAGE: its embedded chart carries SIX per-tier
// monthly series back to ~2020 (each stored under that tier's own
// (condition, grade) combo — this is what drives the multi-grade chart), and
// its completed-auctions tables carry the recent sold listings per tier.
// When the page is unreachable (PC bot protection), falls back to probing the
// undocumented API endpoints for a single banded series, as before.
async function syncPcHistory(catalogId, condition, grade, pc) {
  const token = (process.env.PRICE_CHARTING_TOKEN ?? '').trim();
  if (!pc?.productId || !token) return;
  try {
    const page = await fetchPcPage(pc.productId);
    if (page && (Object.keys(page.chart).length || page.sales.length)) {
      let histInserted = 0;
      for (const [key, series] of Object.entries(page.chart)) {
        const tier = PC_TIERS[key];
        // Tier series ARE their grade's data — no sanity band needed.
        histInserted += await backfillPcHistory(catalogId, tier.condition, tier.grade, series, null);
      }
      const salesInserted = await upsertPcSales(catalogId, page.sales);
      if (histInserted || salesInserted) {
        console.log(`[pricecharting] page sync catalog_id=${catalogId}: +${histInserted} history points, +${salesInserted} sales`);
      }
      return;
    }

    // ── Fallback: undocumented API history endpoints (single series) ───────
    if (!pc.baseUrl) return;
    const points = await fetchPcPriceHistory(pc.baseUrl, pc.productId, token);
    const gradeSpecific = (pc.field ?? '').includes('grade-specific');
    const [lo, hi] = gradeSpecific            ? [0.25, 4]
                   : condition !== 'graded'   ? [0.5, 2]
                   :                            [0.6, 1.67];
    const inserted = await backfillPcHistory(catalogId, condition, grade, points, pc.price, lo, hi);
    if (inserted) {
      console.log(`[pricecharting] endpoint backfill: ${inserted} points for catalog_id=${catalogId} (${condition} ${grade ?? ''}, band ${lo}-${hi}x)`);
    }
  } catch (err) {
    console.warn(`[pricecharting] market sync failed for catalog_id=${catalogId}: ${err.message}`);
  }
}

// ── Instant single-item pricer (called right after a portfolio add) ───────────
//
// Fetches eBay prices for one (catalogId, condition, grade) combo,
// writes a price_history row, and updates portfolio_items. Non-blocking —
// callers should fire this with setImmediate() so the HTTP response goes
// out first.

async function priceSingleItem(catalogId, condition, grade) {
  const appId   = (process.env.EBAY_APP_ID  ?? '').trim();
  const certId  = (process.env.EBAY_CERT_ID ?? '').trim();
  const pcToken = (process.env.PRICE_CHARTING_TOKEN ?? '').trim();
  const hasEbay = !!(appId && certId);

  // Need at least one pricing source to proceed
  if (!pcToken && !hasEbay) return null;

  // Grab the catalog metadata + grading company from the matching portfolio row
  const { rows } = await pool.query(`
    SELECT
      mc.item_type, mc.name, mc.year, mc.set_name, mc.card_number,
      mc.brand_publisher, mc.sport_game, mc.ebay_search_query, mc.rarity,
      mc.ebay_item_id,
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
  const isOneOfOne   = catalogRow.is_one_of_one === true;
  // Grade filter: ensures active-listing searches match graded slabs with the
  // correct card number — prevents cheaper same-player same-grade cards from
  // other sets diluting the price (e.g. Topps Chrome #321 vs base Topps #321).
  const gradeFilter  = condition === 'graded' && catalogRow.grading_company
    ? { company: catalogRow.grading_company, grade, cardNumber: catalogRow.card_number }
    : null;

  console.log(`[pricing] Auto-pricing "${catalogRow.name}" — active: "${keywords}"${gradeFilter ? ` | grade filter: ${gradeFilter.company} ${gradeFilter.grade}` : ''}`);

  let soldMedian = null;
  let activeLow  = null;

  if (!isOneOfOne) {
    // Market value (sold median) comes from PriceCharting only — eBay is an
    // active-listing source, not a sold-price source.
    const pc = await fetchPriceCharting(catalogRow);
    if (pc != null) {
      soldMedian = pc.price; // tier-mapped baseline
      console.log(`[pricing] PriceCharting tier value: $${soldMedian} (${pc.field})`);

      // Catalog image always comes from PriceCharting — per-user photos live
      // on portfolio_items.custom_image, never here.
      if (pc.image) {
        await pool.query(
          `UPDATE master_catalog SET image_url = $1 WHERE id = $2`,
          [pc.image, catalogId]
        );
        console.log(`[pricing] catalog image set from PriceCharting for catalog_id=${catalogId}: ${pc.image}`);
      }

      // Sync sales/history FIRST so the comps below read fresh data.
      await syncPcHistory(catalogId, condition, grade, pc);

      // Sold median = median of the EXACT comps the Recent Sales section
      // displays (getItemComps is shared with the /market endpoint), so the
      // two can never disagree.  Tier value remains the fallback for thin
      // markets (< 3 comps).
      const comps = await getItemComps(catalogId, catalogRow);
      if (comps.count >= 3 && comps.median > 0) {
        console.log(`[pricing] sold median from ${comps.count} displayed comps: $${comps.median} (tier said $${pc.price})`);
        soldMedian = comps.median;
      }
    }
  }

  // Active-listing floor is always sourced from eBay (when configured).
  if (hasEbay) {
    const activeResult = await fetchActiveLow(keywords, gradeFilter, catalogRow.name);
    activeLow = activeResult.activeLow;
  }

  if (soldMedian != null || activeLow != null) {
    // One row per source: pricecharting rows carry the market value
    // (sold_median) only; ebay rows carry the active-listing floor
    // (active_low) only.  Keeps `source` unambiguous per row.
    if (soldMedian != null) {
      await pool.query(`
        INSERT INTO price_history (catalog_id, condition, grade, sold_median, active_low, source)
        VALUES ($1, $2, $3, $4, NULL, 'pricecharting')
      `, [catalogId, condition, grade, soldMedian]);
    }
    if (activeLow != null) {
      await pool.query(`
        INSERT INTO price_history (catalog_id, condition, grade, sold_median, active_low, source)
        VALUES ($1, $2, $3, NULL, $4, 'ebay')
      `, [catalogId, condition, grade, activeLow]);
    }
    console.log(`[pricing] price_history inserted — catalog_id=${catalogId}, sold_median=${soldMedian != null ? '$'+soldMedian+' (pricecharting)' : 'null'}, active_low=${activeLow != null ? '$'+activeLow+' (ebay)' : 'null'}`);

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

// ── SportsCardsPro catalog search (used by GET /api/catalog/search) ──────────
//
// Replaces the old eBay Browse search on the /add page.  Searches the SCP
// database (then pricecharting.com — same API, covers Pokemon/TCG that SCP
// doesn't index) and enriches each hit with prices and an image from the
// per-product endpoint.

// Non-card noise the search must never surface.  Standalone "pop" is NOT
// junk — Pokemon "POP Series" promo sets and Leaf "Pop Century" are real card
// products, and Funko consoles always carry the word "funko" anyway.
// "figure" is bounded so Figure Skating sports cards survive.
const SCP_SEARCH_JUNK_RE = /funko|\bpop!|video\s*game|amiibo|\bfigures?\b(?!\s*skating)/i;

// Video-game platforms: pricecharting.com (the TCG fallback base) indexes
// games whose console-name is the PLATFORM ("GameBoy", "Playstation 4") and
// whose product-name is the game title ("Pokemon Red") — no text the junk
// regex could catch.  Applied to console-name only.
const SCP_PLATFORM_RE = /\b(game\s*boy|gameboy|nintendo|playstation|ps[1-5]|psp|ps\s*vita|xbox|sega|dreamcast|wii|switch|n64|gamecube|snes|nes|atari|neo\s*geo|turbografx|3ds|ds)\b/i;

const SCP_TCG_RE   = /pokemon|magic|yu-?gi-?oh|lorcana|one\s+piece|dragon\s+ball|digimon|flesh\s+and\s+blood/i;
const SCP_SPORT_RE = /\b(basketball|football|baseball|hockey|soccer|wrestling|golf|tennis|racing|ufc|boxing)\b/i;

function scpInferItemType(consoleName) {
  const c = (consoleName ?? '').toLowerCase();
  if (SCP_TCG_RE.test(c)) return 'tcg';
  if (/comic/.test(c)) return 'comic';
  return 'sports_card';
}

// "Basketball Cards 2003 Topps Chrome" → { year: 2003, sport: 'basketball',
// set_name: 'Topps Chrome' }.  TCG consoles like "Pokemon Base Set" keep the
// game as sport and the rest as the set.
function scpParseConsole(consoleName) {
  const cn = consoleName ?? '';

  const yearMatch = cn.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : null;

  const sportMatch = cn.match(SCP_SPORT_RE) ?? cn.match(SCP_TCG_RE);
  const sport = sportMatch ? sportMatch[0].toLowerCase() : null;

  // Brand/set: strip the "<sport> Cards" prefix and year tokens
  let set = cn
    .replace(/^.*?\bcards?\b\s*/i, '')
    .replace(/\b(19|20)\d{2}([-/]\d{2,4})?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!set && sportMatch) {
    set = cn.replace(sportMatch[0], '').replace(/\s+/g, ' ').trim();
  }

  return { year, sport, set_name: set || null };
}

// Normalize a user query for SCP's literal search: lowercase, strip special
// characters, collapse whitespace.
function normalizeScpQuery(q) {
  return String(q ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9#/.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns results mapped to the catalog shape the /add page expects.
// The SCP product id is stored in ebay_item_id (reused column) so future
// lookups can reference the exact product.
//
// opts.category: 'sports' | 'tcg' | 'comics' | 'sealed' — result filter
// opts.sport:    'basketball' | … — appended to the query and result-filtered
// opts.condition:'graded' | 'raw' — keeps only products with that price data
//
// Long queries that return nothing retry with fewer words (first 2, then 1) —
// SCP's search is literal and over-specific queries silently miss.
async function scpSearch(query, limit = 8, opts = {}) {
  const token = (process.env.PRICE_CHARTING_TOKEN ?? '').trim();
  if (!token) return [];
  const tEnc = encodeURIComponent(token);

  const norm  = normalizeScpQuery(query);
  if (!norm) return [];
  const words = norm.split(' ');
  const attempts = [...new Set([
    opts.sport && !norm.includes(opts.sport) ? `${norm} ${opts.sport}` : null,
    norm,
    words.length >= 3 ? words.slice(0, 2).join(' ') : null,
    words.length >= 2 ? words[0] : null,
  ].filter(Boolean))];

  for (const baseUrl of PC_BASES) {
    for (const attempt of attempts) {
    try {
      const resp = await fetch(`${baseUrl}/api/products?t=${tEnc}&q=${encodeURIComponent(attempt)}`, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) continue;
      const data = await resp.json().catch(() => null);
      if (!data || data.status !== 'success' || !data.products?.length) continue;

      const candidates = data.products
        .filter(p => !SCP_SEARCH_JUNK_RE.test(`${p['console-name'] ?? ''} ${p['product-name'] ?? ''}`))
        .filter(p => !SCP_PLATFORM_RE.test(p['console-name'] ?? ''))
        .slice(0, limit);
      if (!candidates.length) continue;

      // Enrich with prices + image via the per-product endpoint (parallel)
      const enriched = await Promise.all(candidates.map(async (p, idx) => {
        let product = p;
        try {
          const r = await fetch(`${baseUrl}/api/product?t=${tEnc}&id=${encodeURIComponent(p.id)}`, { signal: AbortSignal.timeout(10_000) });
          if (r.ok) {
            const d = await r.json().catch(() => null);
            if (d?.status === 'success') product = d;
          }
        } catch (_) { /* keep search-result fields */ }

        // One full response per search — shows exactly which fields (image,
        // history, condition prices) the API exposes on this plan.
        if (idx === 0) {
          console.log(`[scp-search] sample product response: ${JSON.stringify(product).slice(0, 1200)}`);
        }

        const consoleName = product['console-name'] ?? p['console-name'] ?? '';
        const productName = product['product-name'] ?? p['product-name'] ?? '';
        const { year, sport, set_name } = scpParseConsole(consoleName);

        // Card number from the product name ("Michael Jordan #57" → "57") —
        // stored on the catalog row so later re-pricing keeps the scorer's
        // card-number signal.
        const cnMatch = productName.match(/#\s*([A-Za-z0-9-]+)/);

        // Reference price: raw first, graded as fallback (cents → dollars)
        const cents = (product['loose-price']  > 0 ? product['loose-price']  : null)
                   ?? (product['graded-price'] > 0 ? product['graded-price'] : null);

        // Image: explicit API field first, then the real image scraped from
        // the product page (process-cached).  Page fetches are limited to the
        // top few results — PC rate-limits bursts, and a blocked burst would
        // leave everything imageless anyway.
        const productId = String(product.id ?? p.id);
        const image_url = pcProductImage(product)
          ?? (idx < 3 ? await fetchPcPageImage(productId) : null);

        return {
          source:        'scp',
          ebay_item_id:  productId,
          name:          productName,
          item_type:     scpInferItemType(consoleName),
          year,
          set_name,
          card_number:   cnMatch?.[1] ?? null,
          sport_game:    product.genre ?? sport,
          image_url,
          current_value: cents != null ? parseFloat((cents / 100).toFixed(2)) : null,
          condition:     null,
          has_graded:    product['graded-price'] > 0,
          has_loose:     product['loose-price']  > 0,
        };
      }));

      // Apply the /add page filters
      let results = enriched;
      if (opts.category === 'sports') results = results.filter(r => r.item_type === 'sports_card');
      if (opts.category === 'tcg')    results = results.filter(r => r.item_type === 'tcg');
      if (opts.category === 'comics') results = results.filter(r => r.item_type === 'comic');
      if (opts.category === 'sealed') results = results.filter(r => /\b(box|case|bundle|tin|etb)\b/i.test(r.name));
      if (opts.sport) {
        results = results.filter(r => (r.sport_game ?? '').toLowerCase().includes(opts.sport));
      }
      if (opts.condition === 'graded') results = results.filter(r => r.has_graded);
      if (opts.condition === 'raw')    results = results.filter(r => r.has_loose);

      if (!results.length) continue; // filters emptied this attempt — broaden

      console.log(`[scp-search] "${attempt}" → ${results.length} result(s) via ${new URL(baseUrl).hostname}`);
      results.forEach(e => console.log(`[scp-search]   "${e.name}" image: ${e.image_url ?? 'none'}`));
      return results;
    } catch (err) {
      console.error(`[scp-search] ${baseUrl} "${attempt}" error: ${err.message}`);
    }
    }
  }

  return [];
}

module.exports = {
  runEbayJob, scpSearch, priceSingleItem, fetchActiveListings,
  buildQuery, fetchPriceCharting, scorePcProduct, buildPcQueries, pcPriceForGrade,
  extractPcHistoryPoints, fetchPcPriceHistory, parsePcPage, fetchPcPage,
  backfillPcHistory, upsertPcSales, titleMatchesCompany,
  getItemComps, pcTierLabelFor,
  PC_BASES, PC_JUNK_CONSOLE_RE, PC_TIERS,
};
