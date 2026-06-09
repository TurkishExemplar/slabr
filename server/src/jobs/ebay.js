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
    case 'sealed':
      return [name, year, sport_game, 'sealed'].filter(Boolean).join(' ');
    default:
      return [name, year, set_name].filter(Boolean).join(' ');
  }
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
    .filter(l => item.item_type === 'sealed' || !LISTING_JUNK_RE.test(l.title ?? ''))
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
      mc.brand_publisher, mc.sport_game, mc.ebay_search_query, mc.rarity
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
          soldMedian = pc.price;
          console.log(`[ebay-job] ${combo.name} | PriceCharting market value: $${soldMedian} (${pc.field})`);

          // Card image from the PriceCharting product — never overwrite a
          // user-uploaded photo (data: URI).
          if (pc.image) {
            await pool.query(
              `UPDATE master_catalog SET image_url = $1
               WHERE id = $2 AND (image_url IS NULL OR image_url NOT LIKE 'data:%')`,
              [pc.image, combo.catalog_id]
            );
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

// Allowed eBay category IDs — used to reject results that slipped through
// the categoryIds request filter.  Mirrors CARD_CATEGORY_IDS as a Set for O(1) lookup.
//   212      — Sports Trading Cards
//   183454   — CCG Individual Cards
//   259104   — Comics
//   183456   — Sealed Trading Card Packs & Sets
const ALLOWED_CAT_IDS = new Set(['212', '183454', '259104', '183456']);

// Returns true if the item belongs to a known card category (or has no category
// data — eBay doesn't always populate this field, so we fail open).
function hasValidCategory(item) {
  const cats = item.categories ?? [];
  if (!cats.length) return true;
  return cats.some(c => ALLOWED_CAT_IDS.has(String(c.categoryId)));
}

// Storage/accessory words that indicate a card holder, sleeve, binder, or
// case product rather than an actual card.  We block these UNLESS the title
// also contains a grading company — e.g. "PSA 9 slab case" is a legitimate
// graded card; a plain "card sleeve" or "binder" is not what we want to show.
const STORAGE_WORD_RE = /\b(holder|sleeve|binder)\b|(?<!\w)case(?!\s*(?:study|base))/i;
const GRADING_CO_RE   = /\b(psa|bgs|sgc|cgc)\b/i;

// Title patterns that definitively indicate non-card merchandise.
// Applied as a client-side safety net after eBay's category filter.
const REJECT_TITLE_RE =
  /\b(t-shirt|hoodie|sweatshirt|sneakers?|shoes?|shoe|boot|clothing|apparel|jersey(?!\s*card)|car\s*part|auto\s*part|bumper|tire|tyre|hat|cap|pants|jacket|adult|sexy|nude|bra|lingerie|bikini|swimsuit|nsfw|waifu|ecchi|gravure|yeezy|plush|fender|sticker|stamp|coin|patch(?!\s*(?:card|auto))|pin|poster|shirt|funko|figure(?!\s*card)|toy|magazine|video\s+game|dvd|book(?!let)|liftgate|chevy|gmc|truck)\b|air\s+jordan|jordan\s+\d+\s*(mid|low|high|og|retro)\b|size\s+\d{1,2}\b|blu[-\s]?ray|8\s*[xX]\s*10|18\+|signed\s+(photo|jersey|shirt|print)|anime\s+girl|idol\s+photo/i;

// Whitelisted TCG game names.  Any result classified as 'tcg' must match
// at least one of these or it is filtered out (blocks unknown or inappropriate
// TCG content from eBay's CCG category).
const TCG_GAME_RE =
  /\b(pokemon|pok[eé]mon|magic|m\.?t\.?g\.?|yu[-\s]?gi[-\s]?oh|yugioh|one\s+piece|dragon\s+ball|lorcana|flesh\s+and\s+blood|digimon|naruto|final\s+fantasy)\b/i;

// Positive context filter — every surviving result must contain at least one
// sport, brand, grade, or game term.  This is the last-resort backstop after
// REJECT_TITLE_RE; it kills adult-content listings that append "trading card"
// to an otherwise unrelated title.
//
// Covers:
//   • League abbreviations  : nba / nfl / mlb / nhl / mls
//   • Sports by name        : basketball, football, baseball, soccer, hockey
//   • Card-specific terms   : rookie, refractor, prizm, auto, patch, card
//   • Grading companies     : psa, bgs, sgc, cgc
//   • Serial number patterns: /10  /25  /50  /99  /100 … /299  and  #/N
//   • Card manufacturers    : topps, panini, bowman, donruss, fleer, score,
//                             leaf, upper deck
//   • TCG titles            : pokemon, pikachu, charizard, mtg,
//                             magic the gathering, yugioh, one piece,
//                             dragon ball, lorcana
const CONTENT_CONTEXT_RE =
  /\b(nba|nfl|mlb|nhl|mls|basketball|football|baseball|soccer|hockey|rookie|refractor|prizm|psa|bgs|sgc|cgc|panini|topps|bowman|donruss|fleer|score|leaf|pokemon|pok[eé]mon|pikachu|charizard|mtg|lorcana|yugioh|yu[-\s]?gi[-\s]?oh|card|auto|patch)\b|\bupper\s+deck\b|magic\s+the\s+gathering|one\s+piece|dragon\s+ball|#\/\d+|\/(10|25|50|99|100|149|199|249|299)\b/i;

async function ebaySearch(query, limit = 25) {
  const token = await getToken();
  const env   = (process.env.EBAY_ENV ?? 'production').toLowerCase();
  const base  = API_BASE[env] ?? API_BASE.production;

  // Append "trading card" to vague queries (e.g. "jordan 1") so eBay's
  // relevance engine ranks card listings first instead of sneakers or car parts.
  //
  // EXCEPTION: skip the append when the user already typed an explicit card
  // signal (grading company, major brand, card-number pattern).  Adding
  // "trading card" to "LeBron James Topps Chrome PSA 10 111" makes eBay
  // require ALL of those tokens AND "trading" AND "card" in the same title,
  // which returns 0 raw results for even the most iconic cards.
  const QUERY_CARD_SIGNAL_RE =
    /\b(psa|bgs|sgc|cgc|topps|panini|bowman|donruss|fleer|upper\s*deck|chrome|prizm|refractor|optic|pokemon|pok[eé]mon|mtg|yugioh)\b|#\d+|\d+\/\d+/i;

  const base_q = QUERY_CARD_SIGNAL_RE.test(query.trim())
    ? query.trim()                          // already card-specific — don't over-constrain
    : `${query.trim()} trading card`;       // vague query — nudge eBay toward cards

  // Negative keywords tell eBay's relevance engine to deprioritise junk.
  const q = `${base_q} -shirt -shoes -sneaker -clothing -apparel -jersey -funko -poster`;

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

  // ── Step 0: category sanity check ────────────────────────────────────────
  // If eBay returned category metadata on the result, reject anything outside
  // the Sports/TCG/Comic/Sealed card universe.  When no categories field is
  // present we fail open (true) so legitimate cards are never silently dropped.
  const afterCat = raw.filter(item => hasValidCategory(item));

  // ── Step 1: reject non-card merchandise ──────────────────────────────────
  // Hard block-list of title patterns that definitively indicate clothing,
  // adult content, automotive parts, toys, and storage accessories.
  // Storage words (holder/sleeve/binder/case) are a separate conditional check:
  // rejected unless the title also contains PSA/BGS/SGC/CGC, which indicates
  // the "case" or "holder" is part of a graded-slab listing, not an accessory.
  const afterJunk = afterCat.filter(item => {
    const title = item.title ?? '';
    if (REJECT_TITLE_RE.test(title)) return false;
    if (STORAGE_WORD_RE.test(title) && !GRADING_CO_RE.test(title)) return false;
    return true;
  });

  // ── Step 2: map to catalog shape ──────────────────────────────────────────
  const mapped = afterJunk.map(item => ({
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

  // ── Step 3: TCG whitelist — only pass known popular games ─────────────────
  // Prevents unknown, adult-themed, or irrelevant CCG results from slipping
  // through the category filter.
  const afterTcg = mapped.filter(item => {
    if (item.item_type !== 'tcg') return true;   // non-TCG items pass through
    return TCG_GAME_RE.test(item.name ?? '');
  });

  // ── Step 4: deduplicate by title prefix (first 40 chars, lowercased) ──────
  // eBay often returns near-identical listings for the same card (different
  // sellers, same title).  Keep the first occurrence — eBay sorts by relevance
  // so the first is the most relevant.  Prefer items with a real image.
  const sorted = afterTcg.sort((a, b) => {
    // Move items with an image URL to the front before deduping
    const aHasImg = a.image_url ? 1 : 0;
    const bHasImg = b.image_url ? 1 : 0;
    return bHasImg - aHasImg;
  });
  const seen  = new Set();
  const deduped = sorted.filter(item => {
    const key = (item.name ?? '').toLowerCase().slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Step 5: require sport/game/brand context ─────────────────────────────
  // Final backstop — every result must contain at least one sport league term,
  // card brand, grading company, TCG title, or serial-number pattern.
  // Adult-content items that append "trading card" to their title fail here
  // because they carry none of those signals.
  const clean = deduped.filter(item => CONTENT_CONTEXT_RE.test(item.name ?? ''));

  console.log(`[ebay] ebaySearch: ${raw.length} raw → ${afterCat.length} cat → ${afterJunk.length} junk → ${afterTcg.length} TCG → ${deduped.length} dedup → ${clean.length} context`);

  return clean;
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
// Price-field selection is grade-aware — see pcPriceFields().
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
// A WRONG card number is heavily penalized — a junk-wax-era Jordan #29
// must never price a 1986 Fleer Jordan #57.
function scorePcProduct(product, year, set_name, card_number) {
  const consoleName = (product['console-name'] ?? '').toLowerCase();
  const productName = (product['product-name'] ?? '').toLowerCase();
  let score = 0;
  if (year && consoleName.includes(String(year))) score += 3;
  if (set_name) {
    const setParts = set_name.toLowerCase().split(/\s+/);
    for (const part of setParts) {
      if (part.length > 2 && consoleName.includes(part)) score += 2;
    }
  }
  if (card_number) {
    const cn = String(card_number).toLowerCase();
    const m  = productName.match(/#\s*([a-z0-9-]+)/i);
    if (m) score += m[1].toLowerCase() === cn ? 4 : -4;
  }
  return score;
}

// ── Grade → PriceCharting price-field mapping ────────────────────────────────
// SportsCardsPro grade-specific price fields:
//   loose-price        = raw / ungraded
//   cib-price          = PSA 8 / BGS 9 equivalent
//   graded-price       = PSA 9 / BGS 9.5 equivalent
//   condition-17-price = PSA 10 gem mint
//   condition-18-price = BGS 10 Black Label
//
// PSA grades run roughly half a grade below BGS/SGC equivalents, so the
// graded-price cutoff is 9 for PSA but 9.5 for BGS/SGC half-grade scales.
// Returns an ordered field chain — the first field with a value > 0 wins.
function pcPriceFields(item) {
  const { condition, grading_company, grade } = item;
  if (condition !== 'graded') return ['loose-price'];

  const g = parseFloat(grade);
  if (isNaN(g)) return ['graded-price', 'cib-price']; // graded, but grade unknown

  const co = (grading_company ?? 'PSA').toUpperCase();
  if (g >= 10) return ['condition-17-price', 'graded-price'];   // PSA/BGS/SGC 10
  const gradedCutoff = co === 'PSA' ? 9 : 9.5;                  // PSA 9 ≈ BGS 9.5
  if (g >= gradedCutoff) return ['graded-price'];
  if (g >= 8) return ['cib-price'];                             // PSA 8 ≈ BGS 9
  return ['loose-price'];                                       // low-grade slabs ≈ raw floor
}

// Image-field candidates seen across PriceCharting/SportsCardsPro product
// responses — the API does not document an image field, so probe broadly.
const PC_IMAGE_FIELDS = ['image', 'image-url', 'image_url', 'photo', 'photo-url', 'cover-url', 'boxart-url'];

// Extract a card image from a PriceCharting product response.  Falls back to
// the predictable images CDN path, validated with a HEAD request so a wrong
// guess can never save a broken URL.  Returns null when no image exists —
// callers keep the item's current image in that case.
async function pcProductImage(product) {
  for (const f of PC_IMAGE_FIELDS) {
    const v = product[f];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  }
  if (!product.id) return null;
  const cdnUrl = `https://commondatastorage.googleapis.com/images.pricecharting.com/${product.id}/1600.jpg`;
  try {
    const head = await fetch(cdnUrl, { method: 'HEAD', signal: AbortSignal.timeout(6_000) });
    if (head.ok && (head.headers.get('content-type') ?? '').startsWith('image/')) return cdnUrl;
  } catch (_) { /* no CDN image */ }
  return null;
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

// Run the full query-variation ladder against one domain.
// Returns { price, image, field, productName, consoleName } or null.
async function pcLookupOnBase(baseUrl, item, token) {
  const { year, set_name, card_number, condition } = item;
  const tEnc    = encodeURIComponent(token);
  const queries = buildPcQueries(item);
  const host    = new URL(baseUrl).hostname.replace(/^www\./, '');

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

      // Grade-aware field chain — first field with a positive value wins.
      // Values are cents; 0 means "no price recorded".
      const fields = pcPriceFields(item);
      let cents = null;
      let field = null;
      for (const f of fields) {
        if (product[f] > 0) { cents = product[f]; field = f; break; }
      }

      if (cents == null) {
        console.log(`[pricecharting] ${tryTag}: "${product['product-name']}" (${product['console-name'] ?? best['console-name'] ?? '?'}) has no ${fields.join(' / ')} value — skipping`);
        continue;
      }

      const price = parseFloat((cents / 100).toFixed(2));
      const image = await pcProductImage(product);
      console.log(`[pricecharting] ${tryTag} matched: "${product['product-name']}" | ${product['console-name'] ?? best['console-name'] ?? '?'} — $${price} from ${field}${image ? ' (+image)' : ''} via "${q}"`);
      return {
        price,
        image,
        field,
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
      soldMedian = pc.price;
      console.log(`[pricing] PriceCharting market value: $${soldMedian} (${pc.field})`);

      // Card image comes from the PriceCharting product.  Never overwrite a
      // user-uploaded photo (data: URI from a scan or manual upload).
      if (pc.image) {
        await pool.query(
          `UPDATE master_catalog SET image_url = $1
           WHERE id = $2 AND (image_url IS NULL OR image_url NOT LIKE 'data:%')`,
          [pc.image, catalogId]
        );
        console.log(`[pricing] catalog image set from PriceCharting for catalog_id=${catalogId}`);
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

module.exports = {
  runEbayJob, ebaySearch, priceSingleItem, fetchActiveListings,
  buildQuery, fetchPriceCharting, scorePcProduct, buildPcQueries, pcPriceFields,
  PC_BASES, PC_JUNK_CONSOLE_RE,
};
