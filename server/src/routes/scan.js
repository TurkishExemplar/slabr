const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const pool       = require('../db');
const { scanLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// ── GET /api/scan/status — lightweight key-availability check ─────────────────
router.get('/status', (req, res) => {
  res.json({ available: !!(process.env.ANTHROPIC_API_KEY ?? '').trim() });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function itemTypeFromHint(hint) {
  if (!hint) return 'sports_card';
  if (hint === 'tcg')   return 'tcg';
  if (hint === 'comic') return 'comic';
  return 'sports_card';
}

// Find an existing master_catalog row or auto-insert one.
// scanImageBase64: data-URL from the scan photo — stored as a temporary
// image_url until priceSingleItem replaces it with a real eBay CDN image.
//
// Lookup strategy (most-specific → least-specific):
//   1. name + set_name + year   — prevents matching a different card that shares
//      only the player name (e.g. "Kobe Bryant" matching ANY Kobe catalog entry)
//   2. name + set_name           — year not extracted from label
//   3. full name only            — only safe when name includes set info
//   4. auto-create               — nothing matched
async function resolveCatalogId(fields, scanImageBase64 = null) {
  const { item_type, name, set_name, card_number, year, sport_game, rarity } = fields;
  if (!name) return null;

  let id = null;

  // 1. Most specific: name + set_name + year
  if (!id && set_name && year) {
    const r = await pool.query(
      `SELECT id FROM master_catalog
       WHERE name ILIKE $1 AND set_name ILIKE $2 AND year = $3 LIMIT 1`,
      [`%${name}%`, `%${set_name}%`, year]
    );
    if (r.rows.length) id = r.rows[0].id;
  }

  // 2. name + set_name (year not available)
  if (!id && set_name) {
    const r = await pool.query(
      `SELECT id FROM master_catalog
       WHERE name ILIKE $1 AND set_name ILIKE $2 LIMIT 1`,
      [`%${name}%`, `%${set_name}%`]
    );
    if (r.rows.length) id = r.rows[0].id;
  }

  // 3. Full name only — only used when set_name is unavailable; the scan prompt
  //    now returns a fully-qualified name ("Kobe Bryant 1996-97 E-X2000 Star Date
  //    2000") so a player-only name match is an intentional last resort.
  if (!id && !set_name) {
    const r = await pool.query(
      'SELECT id FROM master_catalog WHERE name ILIKE $1 LIMIT 1',
      [`%${name}%`]
    );
    if (r.rows.length) id = r.rows[0].id;
  }

  // 4. Auto-create
  if (!id) {
    const r = await pool.query(
      `INSERT INTO master_catalog
         (item_type, name, year, set_name, card_number, sport_game, rarity)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        item_type || 'sports_card',
        name, year ?? null, set_name ?? null,
        card_number ?? null, sport_game ?? null, rarity ?? null,
      ]
    );
    id = r.rows[0].id;
  }

  // ── Temporary image from scan photo ──────────────────────────────────────
  // Store the scan photo as a data-URI so the card shows an image immediately.
  // Accept up to 8 MB of base64 (covers standard phone-camera JPEGs at normal
  // quality settings).  eBay's priceSingleItem job will overwrite this with a
  // proper CDN URL once the background pricing run completes.
  if (scanImageBase64 && id && scanImageBase64.length <= 8_000_000) {
    await pool.query(
      `UPDATE master_catalog SET image_url = $1 WHERE id = $2 AND image_url IS NULL`,
      [scanImageBase64, id]
    );
  }

  return id;
}

const SCAN_PROMPT = `You are a collectibles identification expert specializing in graded trading card slabs.

Analyze this image carefully. Read EVERY word on the label verbatim — do not guess or paraphrase.

Return ONLY a valid JSON object — no markdown, no code fences, no other text. Use exactly this shape:
{
  "is_collectible": true,
  "item_type": "sports_card",
  "name": "Kobe Bryant 1996-97 E-X2000 Star Date 2000",
  "set_name": "E-X2000 Star Date 2000",
  "year": 1996,
  "card_number": "3",
  "sport_game": "basketball",
  "rarity": null,
  "condition": "graded",
  "grading_company": "BGS",
  "grade": "9.5",
  "cert_number": "0009218832",
  "confidence": 0.95
}

Field rules — read these carefully:

name:
  Include the full card identity: player/character name + year + set name.
  Example: "Kobe Bryant 1996-97 E-X2000 Star Date 2000", NOT just "Kobe Bryant".
  For TCG: "Charizard 1999 Base Set", NOT just "Charizard".

set_name:
  Copy verbatim from the label. E.g. "E-X2000 Star Date 2000", "Topps Chrome", "Base Set".

year:
  The card's release year as a 4-digit integer. For a season range like "1996-97", use 1996.

card_number:
  Just the number/code without "#". E.g. "3", "111", "DT23".

grading_company — CRITICAL, identify from visual cues:
  - "PSA"  → PSA logo (blue/red), label says "PSA", "Professional Sports Authenticator"
  - "BGS"  → Beckett logo, label says "BGS", "Beckett Grading Services", or "BECKETT"
  - "CGC"  → CGC logo, label says "CGC", "Certified Guaranty Company"
  - "SGC"  → SGC logo, label says "SGC", "Sportscard Guaranty"
  - null   → ungraded / raw card

grade:
  Exact grade text from the label (e.g. "10", "9.5", "9"). null if ungraded.

cert_number:
  The certification or serial number printed on the label as a string. null if absent.

item_type: "sports_card" | "tcg" | "comic" | "sealed" | "other"
condition: "graded" if inside a slab/holder with a grade label, otherwise "raw"
confidence: 0.0–1.0 representing your certainty

If this is not a recognizable collectible, return { "is_collectible": false }`;

// ── POST /api/scan ────────────────────────────────────────────────────────────
router.post('/', scanLimiter, async (req, res) => {
  if (!(process.env.ANTHROPIC_API_KEY ?? '').trim()) {
    return res.json({ error: 'Scan unavailable', fallback: 'search' });
  }

  const { image_base64, item_type, _mock } = req.body ?? {};

  // ── Mock mode (dev/test only) — returns realistic canned response ─────────
  if (_mock === true && process.env.NODE_ENV !== 'production') {
    const catalogId = await resolveCatalogId({
      item_type: item_type || 'sports_card',
      name: '2003 LeBron James Rookie Card',
      set_name: 'Topps Chrome', year: 2003,
      card_number: '111', sport_game: 'basketball', rarity: 'Base',
    });
    return res.json({
      match: true, catalog_id: catalogId,
      name: '2003 LeBron James Rookie Card',
      set_name: 'Topps Chrome', year: 2003,
      card_number: '111', sport_game: 'basketball', rarity: 'Base',
      condition: 'graded', grading_company: 'PSA', grade: '9',
      cert_number: null, current_value: null, forecast_30d: null,
      confidence: 0.92,
    });
  }

  if (!image_base64) {
    return res.status(400).json({ error: 'image_base64 is required' });
  }

  // Rate limit: 50 scans per user per 24 hours
  const { rows: rateRows } = await pool.query(
    `SELECT COUNT(*) FROM scan_logs WHERE user_id = $1 AND scanned_at > NOW() - INTERVAL '24 hours'`,
    [req.user.userId]
  );
  if (parseInt(rateRows[0].count) >= 50) {
    return res.status(429).json({ error: 'Scan limit reached', detail: '50 scans per 24 hours' });
  }

  // Detect media type from data-URI prefix; default to JPEG
  const mimeMatch = image_base64.match(/^data:([^;]+);base64,/);
  const mediaType = (mimeMatch?.[1] ?? 'image/jpeg');
  const base64 = image_base64.replace(/^data:[^;]+;base64,/, '');

  try {
    // Lazy init — only constructed when a scan is actually requested,
    // so a missing key never crashes the server on startup.
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 },
            },
            { type: 'text', text: SCAN_PROMPT },
          ],
        },
      ],
    });

    // Log successful Claude call against the rate limit
    await pool.query('INSERT INTO scan_logs (user_id) VALUES ($1)', [req.user.userId]);

    const raw = (message.content[0]?.text ?? '').trim();
    console.log('[scan] Claude response:', raw);

    let parsed;
    try {
      const jsonStr = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error('[scan] JSON parse error:', e.message, '— raw:', raw);
      return res.json({ match: false });
    }

    if (!parsed.is_collectible) return res.json({ match: false });
    if ((parsed.confidence ?? 1) < 0.4) return res.json({ match: false });

    const derivedType = item_type ?? itemTypeFromHint(parsed.item_type);

    const identified = {
      name:            parsed.name            ?? null,
      set_name:        parsed.set_name         ?? null,
      year:            parsed.year             ?? null,
      card_number:     parsed.card_number      ?? null,
      rarity:          parsed.rarity           ?? null,
      sport_game:      parsed.sport_game       ?? null,
      condition:       parsed.condition        ?? 'raw',
      grading_company: parsed.grading_company  ?? null,
      grade:           parsed.grade            ?? null,
      cert_number:     parsed.cert_number      ?? null,
      current_value:   null,
      forecast_30d:    null,
      confidence:      parsed.confidence       ?? 0.5,
    };

    // Pass the scan photo so resolveCatalogId can save it as a temporary
    // image_url (replaced by a real eBay CDN URL once priceSingleItem runs).
    const catalog_id = await resolveCatalogId({ ...identified, item_type: derivedType }, image_base64);

    res.json({ match: true, catalog_id, ...identified });

  } catch (err) {
    console.error('[scan]', err.message);
    res.status(500).json({ error: 'Scan failed', detail: err.message });
  }
});

module.exports = router;
