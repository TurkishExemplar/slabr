const express = require('express');
const pool    = require('../db');
const { runEbayJob, priceSingleItem, fetchCardImage, fetchPriceCharting, scorePcProduct } = require('../jobs/ebay');

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

// ── Manual image refresh ──────────────────────────────────────────────────────
// POST /api/admin/refresh-image/:catalog_id
// Runs fetchCardImage for a specific catalog entry and unconditionally updates
// master_catalog.image_url.  Useful when an old wrong image is already saved
// and priceSingleItem's auto-refresh hasn't run yet.

router.post('/refresh-image/:catalog_id', async (req, res) => {
  const catalogId = parseInt(req.params.catalog_id);
  if (isNaN(catalogId)) {
    return res.status(400).json({ error: 'Invalid catalog_id' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, name, year, set_name, card_number FROM master_catalog WHERE id = $1',
      [catalogId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Catalog entry not found' });
    }

    const imageUrl = await fetchCardImage(rows[0]);
    if (!imageUrl) {
      return res.json({ ok: false, message: 'No clean image found — image_url unchanged' });
    }

    await pool.query('UPDATE master_catalog SET image_url = $1 WHERE id = $2', [imageUrl, catalogId]);
    console.log(`[admin] refresh-image: catalog_id=${catalogId} → ${imageUrl}`);
    res.json({ ok: true, catalog_id: catalogId, image_url: imageUrl });
  } catch (err) {
    console.error('[admin refresh-image]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PriceCharting connectivity / endpoint probe ───────────────────────────────
// GET /api/admin/test-pricecharting
//   ?name=LeBron+James&year=2003&set_name=Topps+Chrome&card_number=111&condition=raw
//
// Phase 1 — endpoint probe: tries every base-URL × endpoint combo with "LeBron James"
//   to discover which one actually responds with data.  Returns the raw HTTP status
//   and first 600 chars of every response body so you can see exactly what the API
//   returns (including error messages).
//
// Phase 2 — full price lookup: once we know which endpoint works, runs all query
//   variations through the two-step flow (search → fetch by product ID) and returns
//   the winning price + which variation found it.
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

  const name        = (req.query.name        ?? 'LeBron James').trim();
  const year        = req.query.year         ? parseInt(req.query.year, 10) : null;
  const set_name    = (req.query.set_name    ?? '').trim() || null;
  const card_number = (req.query.card_number ?? '').trim() || null;
  const condition   = req.query.condition === 'graded' ? 'graded' : 'raw';

  // Token info for debugging (never expose the full token)
  const tokenInfo = {
    length:     token.length,
    prefix:     token.slice(0, 4),
    suffix:     token.slice(-4),
    looks_valid: token.length >= 20,
  };

  // ── Phase 1: endpoint probe ───────────────────────────────────────────────
  // Try every combination of base URL × path × query-param style.
  // Uses a fixed simple query ("LeBron James") so results are comparable.
  const PROBE_QUERY = 'LeBron James';
  const tEnc = encodeURIComponent(token);
  const qEnc = encodeURIComponent(PROBE_QUERY);

  const probeTargets = [
    // pricecharting.com — plural search endpoint (correct for text search)
    { label: 'PC /api/products (search)',  url: `https://www.pricecharting.com/api/products?t=${tEnc}&q=${qEnc}` },
    // pricecharting.com — singular endpoint with q= (what we were calling before)
    { label: 'PC /api/product (search)',   url: `https://www.pricecharting.com/api/product?t=${tEnc}&q=${qEnc}` },
    // sportscardspro.com — same paths, different domain (sports-card specific mirror)
    { label: 'SCP /api/products (search)', url: `https://www.sportscardspro.com/api/products?t=${tEnc}&q=${qEnc}` },
    { label: 'SCP /api/product (search)',  url: `https://www.sportscardspro.com/api/product?t=${tEnc}&q=${qEnc}` },
  ];

  const probeResults = [];
  let searchBase  = null; // base URL that returned products
  let searchPath  = null; // path that returned products

  for (const target of probeTargets) {
    // Mask token in the URL shown to the caller
    const displayUrl = target.url.replace(tEnc, `${token.slice(0,4)}***${token.slice(-4)}`);
    const raw = await pcRawFetch(target.url);
    const entry = {
      label:       target.label,
      url:         displayUrl,
      http_status: raw.http_status,
      raw_body:    raw.raw_body,
      error:       raw.error ?? null,
      products_found: Array.isArray(raw.parsed?.products) ? raw.parsed.products.length : 0,
    };
    probeResults.push(entry);

    // First endpoint that returns at least one product wins
    if (!searchBase && Array.isArray(raw.parsed?.products) && raw.parsed.products.length > 0) {
      const urlObj = new URL(target.url);
      searchBase = urlObj.origin;
      searchPath = urlObj.pathname;
    }
  }

  if (!searchBase) {
    // No endpoint returned data — return the full diagnostic so the caller can
    // see raw status codes + response bodies.
    return res.json({
      ok:           false,
      diagnosis:    'No endpoint returned products. Check raw_body on each probe result.',
      token_info:   tokenInfo,
      probe_results: probeResults,
    });
  }

  // ── Phase 2: full two-step price lookup ───────────────────────────────────
  // Now that we know which endpoint works, run all query variations through:
  //   1. GET {searchBase}{searchPath}?t=TOKEN&q=QUERY  → get product list + IDs
  //   2. Pick best product by console-name score
  //   3. GET {searchBase}/api/product?t=TOKEN&id=ID    → get price data
  const brandShort = set_name ? set_name.split(/\s+/)[0] : null;
  const rawVariations = [
    card_number ? `${name} #${card_number}` : null,
    [name, year, brandShort].filter(Boolean).join(' '),
    [name, set_name        ].filter(Boolean).join(' '),
    [name, year            ].filter(Boolean).join(' '),
    name,
  ];
  const queries = [...new Set(rawVariations.filter(Boolean).map(q => q.trim()))];

  const tried = [];

  for (let i = 0; i < queries.length; i++) {
    const q        = queries[i];
    const searchUrl = `${searchBase}${searchPath}?t=${tEnc}&q=${encodeURIComponent(q)}`;
    const displaySearch = searchUrl.replace(tEnc, `${token.slice(0,4)}***${token.slice(-4)}`);

    try {
      // Step 1: search
      const searchResp = await fetch(searchUrl, { signal: AbortSignal.timeout(10_000) });
      const searchText = await searchResp.text();
      let   searchData = null;
      try { searchData = JSON.parse(searchText); } catch (_) {}

      if (!searchData || searchData.status !== 'success' || !searchData.products?.length) {
        tried.push({
          try: i + 1, query: q, search_url: displaySearch,
          result: 'no_results',
          raw_search_body: searchText.slice(0, 300),
        });
        continue;
      }

      // Score + pick best product
      const scored = searchData.products
        .map(p => ({ p, score: scorePcProduct(p, year, set_name) }))
        .sort((a, b) => b.score - a.score);
      const best = scored[0].p;
      const productId = best.id;

      // Step 2: fetch price by ID
      const priceUrl     = `${searchBase}/api/product?t=${tEnc}&id=${encodeURIComponent(productId)}`;
      const displayPrice = priceUrl.replace(tEnc, `${token.slice(0,4)}***${token.slice(-4)}`);
      const priceResp    = await fetch(priceUrl, { signal: AbortSignal.timeout(10_000) });
      const priceText    = await priceResp.text();
      let   priceData    = null;
      try { priceData = JSON.parse(priceText); } catch (_) {}

      const product = priceData ?? best; // fall back to search result if price fetch fails

      const cents = condition === 'graded'
        ? ((product['graded-price'] > 0 ? product['graded-price'] : null) ?? (product['cib-price'] > 0 ? product['cib-price'] : null))
        : ((product['loose-price']  > 0 ? product['loose-price']  : null) ?? (product['cib-price'] > 0 ? product['cib-price'] : null));

      const entry = {
        try:              i + 1,
        query:            q,
        search_url:       displaySearch,
        price_url:        displayPrice,
        result:           cents != null ? 'matched' : 'no_price',
        product_id:       productId,
        product_name:     product['product-name']  ?? best['product-name'],
        console_name:     product['console-name']  ?? best['console-name'] ?? null,
        console_score:    scored[0].score,
        loose_price:      (product['loose-price']  ?? 0) / 100,
        cib_price:        (product['cib-price']    ?? 0) / 100,
        graded_price:     (product['graded-price'] ?? 0) / 100,
        selected_dollars: cents != null ? parseFloat((cents / 100).toFixed(2)) : null,
        total_search_results: searchData.products.length,
        top_candidates: scored.slice(0, 3).map(({ p, score }) => ({
          id: p.id, product_name: p['product-name'], console_name: p['console-name'] ?? null, score,
        })),
        raw_price_body: priceData ? null : priceText.slice(0, 300), // only if parse failed
      };
      tried.push(entry);

      if (cents != null) {
        return res.json({
          ok:             true,
          winning_try:    i + 1,
          winning_query:  q,
          slabr_price:    entry.selected_dollars,
          condition,
          working_base:   searchBase,
          working_path:   searchPath,
          token_info:     tokenInfo,
          probe_results:  probeResults,
          variations:     tried,
        });
      }
    } catch (err) {
      tried.push({ try: i + 1, query: q, result: 'error', error: err.message });
    }
  }

  res.json({
    ok:            false,
    slabr_price:   null,
    condition,
    working_base:  searchBase,
    working_path:  searchPath,
    token_info:    tokenInfo,
    probe_results: probeResults,
    variations:    tried,
  });
});

module.exports = router;
