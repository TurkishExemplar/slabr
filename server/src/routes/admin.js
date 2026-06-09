const express = require('express');
const pool    = require('../db');
const {
  runEbayJob, priceSingleItem, fetchPriceCharting,
  scorePcProduct, buildPcQueries, pcPriceFields, PC_BASES, PC_JUNK_CONSOLE_RE,
} = require('../jobs/ebay');

const router = express.Router();

// ── Full eBay price refresh ───────────────────────────────────────────────────
// POST /api/admin/ebay-job  — triggers price fetch for every item in the DB.
// GET  /api/admin/ebay-job  — kept for backward compat (curl usage).

async function handleFullJob(req, res) {
  try {
    const result = await runEbayJob();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[admin ebay-job]', err.message);
    res.status(500).json({ error: err.message });
  }
}

router.post('/ebay-job', handleFullJob);
router.get('/ebay-job',  handleFullJob);

// ── Single-item price refresh ─────────────────────────────────────────────────
// POST /api/admin/ebay-job/:catalog_id
// Prices all (condition, grade) combos for one catalog entry.

router.post('/ebay-job/:catalog_id', async (req, res) => {
  const catalogId = parseInt(req.params.catalog_id);
  if (isNaN(catalogId)) {
    return res.status(400).json({ error: 'Invalid catalog_id' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT DISTINCT condition, grade FROM portfolio_items WHERE catalog_id = $1',
      [catalogId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'No portfolio items found for this catalog entry' });
    }

    const results = [];
    for (const { condition, grade } of rows) {
      const r = await priceSingleItem(catalogId, condition, grade);
      results.push({ condition, grade, ...(r ?? {}) });
    }

    res.json({ ok: true, catalog_id: catalogId, results });
  } catch (err) {
    console.error('[admin ebay-job/:catalog_id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PriceCharting connectivity / endpoint probe ───────────────────────────────
// GET /api/admin/test-pricecharting
//   ?name=LeBron+James&year=2003&set_name=Topps+Chrome&card_number=111
//   &condition=graded&grading_company=BGS&grade=9.5
//
// Phase 1 — endpoint probe: hits every base-URL × endpoint combo with "LeBron James"
//   and returns the raw HTTP status + first 600 chars of every response body so
//   auth/routing issues are immediately visible.
//
// Phase 2 — full price lookup, mirroring fetchPriceCharting() exactly:
//   sportscardspro.com FIRST (real sports cards), pricecharting.com fallback
//   (its sports-name search surfaces Funko POP figures).  Per domain, runs all
//   query variations through the two-step flow (search → fetch by product ID).
//   Funko/figure console-names are filtered out before scoring.
//
// PriceCharting data model:
//   /api/products?q=  (search)  → [{id, product-name, console-name}]   (no prices)
//   /api/product?id=  (by ID)   → {id, product-name, loose-price, …}   (prices)
//
// Read-only — no DB writes.

async function pcRawFetch(url) {
  try {
    const resp   = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const text   = await resp.text();
    let   parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { http_status: resp.status, raw_body: text.slice(0, 600), parsed };
  } catch (err) {
    return { http_status: null, raw_body: null, error: err.message, parsed: null };
  }
}

router.get('/test-pricecharting', async (req, res) => {
  const token = (process.env.PRICE_CHARTING_TOKEN ?? '').trim();
  if (!token) {
    return res.status(503).json({ error: 'PRICE_CHARTING_TOKEN is not set in the environment' });
  }

  const name            = (req.query.name        ?? 'LeBron James').trim();
  const year            = req.query.year         ? parseInt(req.query.year, 10) : null;
  const set_name        = (req.query.set_name    ?? '').trim() || null;
  const card_number     = (req.query.card_number ?? '').trim() || null;
  const condition       = req.query.condition === 'graded' ? 'graded' : 'raw';
  const grading_company = (req.query.grading_company ?? '').trim() || null;
  const grade           = (req.query.grade           ?? '').trim() || null;

  // Grade-aware price-field chain (mirrors fetchPriceCharting exactly)
  const priceFields = pcPriceFields({ condition, grading_company, grade });

  // Token info for debugging (never expose the full token)
  const tokenInfo = {
    length:     token.length,
    prefix:     token.slice(0, 4),
    suffix:     token.slice(-4),
    looks_valid: token.length >= 20,
  };
  const tEnc        = encodeURIComponent(token);
  const maskedToken = `${token.slice(0, 4)}***${token.slice(-4)}`;

  // ── Phase 1: endpoint probe ───────────────────────────────────────────────
  // Try every combination of base URL × path, ordered by the same domain
  // priority the real pricer uses (sportscardspro.com first).
  // Uses a fixed simple query ("LeBron James") so results are comparable.
  const qEnc = encodeURIComponent('LeBron James');

  const probeTargets = [
    // sportscardspro.com — PRIMARY: indexes actual sports cards
    { label: 'SCP /api/products (search)', url: `https://www.sportscardspro.com/api/products?t=${tEnc}&q=${qEnc}` },
    // pricecharting.com — fallback: sports-name search surfaces Funko POPs
    { label: 'PC /api/products (search)',  url: `https://www.pricecharting.com/api/products?t=${tEnc}&q=${qEnc}` },
    // singular endpoint with q= — diagnostic only (not a real search endpoint)
    { label: 'SCP /api/product (q= probe)', url: `https://www.sportscardspro.com/api/product?t=${tEnc}&q=${qEnc}` },
    { label: 'PC /api/product (q= probe)',  url: `https://www.pricecharting.com/api/product?t=${tEnc}&q=${qEnc}` },
  ];

  const probeResults = [];
  let anyProducts = false;

  for (const target of probeTargets) {
    const raw = await pcRawFetch(target.url);
    const productsFound = Array.isArray(raw.parsed?.products) ? raw.parsed.products.length : 0;
    probeResults.push({
      label:       target.label,
      url:         target.url.replace(tEnc, maskedToken),
      http_status: raw.http_status,
      raw_body:    raw.raw_body,
      error:       raw.error ?? null,
      products_found: productsFound,
    });
    if (productsFound > 0) anyProducts = true;
  }

  if (!anyProducts) {
    // No endpoint returned data — return the full diagnostic so the caller can
    // see raw status codes + response bodies.
    return res.json({
      ok:           false,
      diagnosis:    'No endpoint returned products. Check raw_body on each probe result.',
      token_info:   tokenInfo,
      probe_results: probeResults,
    });
  }

  // ── Phase 2: full two-step price lookup (SCP primary → PC fallback) ───────
  // Mirrors fetchPriceCharting() exactly — same domain order, same query
  // variations, same Funko filter, same strict price-field mapping:
  //   1. GET {base}/api/products?t=TOKEN&q=QUERY  → product list + IDs
  //   2. Filter Funko/figure console-names, score the rest, pick best
  //   3. GET {base}/api/product?t=TOKEN&id=ID     → price data
  const queries = buildPcQueries({ name, year, set_name, card_number });
  const tried = [];

  for (const baseUrl of PC_BASES) {
    const host = new URL(baseUrl).hostname.replace(/^www\./, '');

    for (let i = 0; i < queries.length; i++) {
      const q             = queries[i];
      const searchUrl     = `${baseUrl}/api/products?t=${tEnc}&q=${encodeURIComponent(q)}`;
      const displaySearch = searchUrl.replace(tEnc, maskedToken);

      try {
        // Step 1: search
        const searchResp = await fetch(searchUrl, { signal: AbortSignal.timeout(10_000) });
        const searchText = await searchResp.text();
        let   searchData = null;
        try { searchData = JSON.parse(searchText); } catch (_) {}

        if (!searchData || searchData.status !== 'success' || !searchData.products?.length) {
          tried.push({
            base: host, try: i + 1, query: q, search_url: displaySearch,
            result: 'no_results',
            raw_search_body: searchText.slice(0, 300),
          });
          continue;
        }

        // Filter Funko/figure listings, then score + pick best product
        const candidates = searchData.products.filter(p => !PC_JUNK_CONSOLE_RE.test(p['console-name'] ?? ''));
        if (!candidates.length) {
          tried.push({
            base: host, try: i + 1, query: q, search_url: displaySearch,
            result: 'only_funko_results',
            total_search_results: searchData.products.length,
          });
          continue;
        }
        const scored = candidates
          .map(p => ({ p, score: scorePcProduct(p, year, set_name) }))
          .sort((a, b) => b.score - a.score);
        const best = scored[0].p;
        const productId = best.id;

        // Step 2: fetch price by ID
        const priceUrl     = `${baseUrl}/api/product?t=${tEnc}&id=${encodeURIComponent(productId)}`;
        const displayPrice = priceUrl.replace(tEnc, maskedToken);
        const priceResp    = await fetch(priceUrl, { signal: AbortSignal.timeout(10_000) });
        const priceText    = await priceResp.text();
        let   priceData    = null;
        try { priceData = JSON.parse(priceText); } catch (_) {}

        const product = (priceData && priceData.status === 'success') ? priceData : best;

        // Grade-aware field chain — first field with a positive value wins
        let cents = null;
        let selectedField = null;
        for (const f of priceFields) {
          if (product[f] > 0) { cents = product[f]; selectedField = f; break; }
        }

        // Image-field probe (mirrors pcProductImage candidates, minus the CDN
        // HEAD check) so production responses reveal what the API exposes.
        const imageField = ['image', 'image-url', 'image_url', 'photo', 'photo-url', 'cover-url', 'boxart-url']
          .find(f => typeof product[f] === 'string' && /^https?:\/\//.test(product[f])) ?? null;

        const entry = {
          base:             host,
          try:              i + 1,
          query:            q,
          search_url:       displaySearch,
          price_url:        displayPrice,
          result:           cents != null ? 'matched' : 'no_price',
          product_id:       productId,
          product_name:     product['product-name']  ?? best['product-name'],
          console_name:     product['console-name']  ?? best['console-name'] ?? null,
          console_score:    scored[0].score,
          price_field_chain: priceFields,
          selected_field:   selectedField,
          loose_price:        (product['loose-price']        ?? 0) / 100,
          cib_price:          (product['cib-price']          ?? 0) / 100,
          graded_price:       (product['graded-price']       ?? 0) / 100,
          condition_17_price: (product['condition-17-price'] ?? 0) / 100,
          condition_18_price: (product['condition-18-price'] ?? 0) / 100,
          selected_dollars: cents != null ? parseFloat((cents / 100).toFixed(2)) : null,
          image_field:      imageField,
          image:            imageField ? product[imageField] : null,
          product_keys:     Object.keys(product),
          total_search_results: searchData.products.length,
          funko_filtered:   searchData.products.length - candidates.length,
          top_candidates: scored.slice(0, 3).map(({ p, score }) => ({
            id: p.id, product_name: p['product-name'], console_name: p['console-name'] ?? null, score,
          })),
          raw_price_body: (priceData && priceData.status === 'success') ? null : priceText.slice(0, 300),
        };
        tried.push(entry);

        if (cents != null) {
          return res.json({
            ok:             true,
            winning_base:   host,
            winning_try:    i + 1,
            winning_query:  q,
            slabr_price:    entry.selected_dollars,
            condition,
            token_info:     tokenInfo,
            probe_results:  probeResults,
            variations:     tried,
          });
        }
      } catch (err) {
        tried.push({ base: host, try: i + 1, query: q, result: 'error', error: err.message });
      }
    }
  }

  res.json({
    ok:            false,
    slabr_price:   null,
    condition,
    token_info:    tokenInfo,
    probe_results: probeResults,
    variations:    tried,
  });
});

module.exports = router;
