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

// Sealed/non-card keywords that disqualify a listing as a card image source.
const JUNK_IMAGE_RE = /\b(pack|box|lot|case|sealed|set|bundle|wrapper|wax|blaster|hobby)\b/i;

// Parallel/variation keywords that identify non-base parallels in eBay titles.
// Used to reject listing images that show the wrong version of a card —
// e.g. an X-Fractor or Refractor image for a catalog entry that is the base
// Topps Chrome version.  If the catalog item's own name or set_name already
// contains one of these terms it means the item IS that parallel, so we allow it.
const PARALLEL_IMAGE_RE = /\b(refractor|x[-\s]?fractor|prizm|optic|mosaic|superfractor|parallel|ssp|short\s*print)\b/i;

// Dedicated image search — completely separate from the price search so we can
// use a clean, non-graded query and apply strict per-result validation.
//
// Selection rules (all must pass):
//   1. Title must NOT contain junk keywords (pack, box, lot, case, sealed, set…)
//   2. Title must contain every significant word of the card/player name
//   3. Image URL must end in .jpg / .jpeg / .png (not a placeholder or webp)
//   4. If this catalog item is a base card (no parallel keyword in name/set_name),
//      reject listings that contain parallel/variation keywords (Refractor,
//      X-Fractor, Prizm, etc.) so we never show the wrong version of the card.
// Returns null if no result passes all three checks — better to show nothing
// than to save an image of a plastic pack.
async function fetchCardImage(item) {
  const { name, year, set_name, card_number } = item;
  // Appending "card" nudges eBay's ranking toward individual card listings.
  const q = [name, year, set_name, card_number, 'card'].filter(Boolean).join(' ');

  // Name parts used for title matching (skip short words like "Jr", "de")
  const nameParts = (name ?? '').toLowerCase().split(/\s+/).filter(p => p.length > 2);

  // Determine whether this catalog item is itself a parallel/variation.
  // If not, rule 4 will reject eBay listings that are parallels so we don't
  // accidentally display an X-Fractor image for a base Chrome card.
  const itemIdentity   = `${name ?? ''} ${set_name ?? ''}`;
  const itemIsParallel = PARALLEL_IMAGE_RE.test(itemIdentity);

  try {
    const data = await ebayGet('/buy/browse/v1/item_summary/search', {
      q,
      limit:  15,
      sort:   'newlyListed',
      filter: 'buyingOptions:{FIXED_PRICE}',
    });

    for (const listing of data.itemSummaries ?? []) {
      const title  = (listing.title ?? '').toLowerCase();
      const imgUrl = listing.image?.imageUrl ?? '';

      // Rule 1: no sealed product / lot / set in the title
      if (JUNK_IMAGE_RE.test(title)) continue;

      // Rule 2: title must contain the player/card name
      if (nameParts.length > 0 && !nameParts.every(p => title.includes(p))) continue;

      // Rule 3: real image file (not a CDN placeholder or webp thumbnail)
      if (!/\.(jpg|jpeg|png)(\?.*)?$/i.test(imgUrl)) continue;

      // Rule 4: reject parallel listings for base-card queries.
      // Prevents a "2003 Topps Chrome X-Fractor" image being used for the
      // base "2003 Topps Chrome" entry.  Skipped when the item itself is a
      // parallel (so "Topps Chrome Refractor" correctly gets a Refractor image).
      if (!itemIsParallel && PARALLEL_IMAGE_RE.test(title)) continue;

      console.log(`[ebay] fetchCardImage selected: "${listing.title}"`);
      return imgUrl;
    }

    console.log(`[ebay] fetchCardImage: no clean image found for "${q}" — leaving image_url unchanged`);
    return null;
  } catch (err) {
    console.error(`[ebay] fetchCardImage failed: ${err.message}`);
    return null;
  }
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

// Junk filter for display listings — lighter than JUNK_IMAGE_RE because card
// titles legitimately contain words like "set" ("Base Set") and "box" is fine
// for sealed items.  Blocks multi-card lots and fakes only.
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
        soldMedian = await fetchPriceCharting(combo);
        if (soldMedian != null) {
          console.log(`[ebay-job] ${combo.name} | PriceCharting market value: $${soldMedian}`);
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
// Price-field selection:
//   graded items    → graded-price
//   raw / ungraded  → loose-price
//
// Query variations (most → least specific):
//   Try 1: "name #card_number"           → "LeBron James #111"
//   Try 2: "name year brandShort"        → "LeBron James 2003 Topps"
//   Try 3: "name set_name"               → "LeBron James Topps Chrome"
//   Try 4: "name year"                   → "LeBron James 2003"
//   Try 5: "name"                        → "LeBron James"
//
// Returns a price in dollars (number) or null when no usable price was found.

const PC_BASES = [
  'https://www.sportscardspro.com',  // primary — real sports cards
  'https://www.pricecharting.com',   // fallback — Pokemon / TCG / video games
];

// Funko POPs and other figure lines share player names with cards on
// pricecharting.com — never price a card from a figure listing.
const PC_JUNK_CONSOLE_RE = /\bfunko\b|\bpop!/i;

// Score how well a PriceCharting product's console-name matches our set/year.
// Higher score = better match; used to rank products when a query returns many.
function scorePcProduct(product, year, set_name) {
  const consoleName = (product['console-name'] ?? '').toLowerCase();
  let score = 0;
  if (year && consoleName.includes(String(year))) score += 3;
  if (set_name) {
    const setParts = set_name.toLowerCase().split(/\s+/);
    for (const part of setParts) {
      if (part.length > 2 && consoleName.includes(part)) score += 2;
    }
  }
  return score;
}

// Build the deduplicated query-variation ladder for an item (most → least specific).
function buildPcQueries(item) {
  const { name, year, set_name, card_number } = item;
  // First word of set_name used as the short brand token
  // e.g. "Topps Chrome" → "Topps",  "Panini Prizm" → "Panini"
  const brandShort = set_name ? set_name.trim().split(/\s+/)[0] : null;

  const rawVariations = [
    card_number ? `${name} #${card_number}` : null,
    [name, year, brandShort].filter(Boolean).join(' '),
    [name, set_name].filter(Boolean).join(' '),
    [name, year].filter(Boolean).join(' '),
    name,
  ];
  return [...new Set(rawVariations.filter(Boolean).map(q => q.trim()))];
}

// Run the full query-variation ladder against one domain.
// Returns a price in dollars or null.
async function pcLookupOnBase(baseUrl, item, token) {
  const { year, set_name, condition } = item;
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
        .map(p => ({ p, score: scorePcProduct(p, year, set_name) }))
        .sort((a, b) => b.score - a.score);
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

      // Strict field mapping: graded → graded-price, raw → loose-price.
      // Values are cents; 0 means "no price recorded".
      const cents = condition === 'graded'
        ? (product['graded-price'] > 0 ? product['graded-price'] : null)
        : (product['loose-price']  > 0 ? product['loose-price']  : null);

      if (cents == null) {
        console.log(`[pricecharting] ${tryTag}: "${product['product-name']}" (${product['console-name'] ?? best['console-name'] ?? '?'}) has no ${condition === 'graded' ? 'graded' : 'loose'}-price — skipping`);
        continue;
      }

      const price = parseFloat((cents / 100).toFixed(2));
      console.log(`[pricecharting] ${tryTag} matched: "${product['product-name']}" | ${product['console-name'] ?? best['console-name'] ?? '?'} — $${price} via "${q}"`);
      return price;

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
    const price = await pcLookupOnBase(baseUrl, item, token);
    if (price != null) return price;
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
    soldMedian = await fetchPriceCharting(catalogRow);
    if (soldMedian != null) {
      console.log(`[pricing] PriceCharting market value: $${soldMedian}`);
    }
  }

  // Active listings and card image are always sourced from eBay (when configured).
  if (hasEbay) {
    const activeResult = await fetchActiveLow(keywords, gradeFilter, catalogRow.name);
    activeLow = activeResult.activeLow;

    // Fetch a card image from eBay and store it — but ONLY if the catalog entry
    // has no image yet.  This preserves user-uploaded scan photos: when someone
    // scans their physical card the photo they took is saved as a data: URL and
    // should remain the displayed image.  eBay images are a fallback for items
    // that have no photo at all (manually added or scan photo was too large to save).
    const imageUrl = await fetchCardImage(catalogRow);
    if (imageUrl) {
      await pool.query(
        'UPDATE master_catalog SET image_url = $1 WHERE id = $2 AND image_url IS NULL',
        [imageUrl, catalogId]
      );
      console.log(`[pricing] catalog image set from eBay for catalog_id=${catalogId}`);
    }
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
  runEbayJob, ebaySearch, priceSingleItem, fetchCardImage, fetchActiveListings,
  buildQuery, fetchPriceCharting, scorePcProduct, buildPcQueries, PC_BASES, PC_JUNK_CONSOLE_RE,
};
