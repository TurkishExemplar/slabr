const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

// Find an existing master_catalog row or auto-insert one
async function resolveCatalogId(fields) {
  const { item_type, name, set_name, card_number, year, sport_game, rarity } = fields;
  if (!name) return null;

  // 1. Exact name match
  let res = await pool.query(
    'SELECT id FROM master_catalog WHERE name ILIKE $1 LIMIT 1',
    [`%${name}%`]
  );
  if (res.rows.length) return res.rows[0].id;

  // 2. Name + set match
  if (set_name) {
    res = await pool.query(
      'SELECT id FROM master_catalog WHERE set_name ILIKE $1 AND card_number = $2 LIMIT 1',
      [`%${set_name}%`, card_number]
    );
    if (res.rows.length) return res.rows[0].id;
  }

  // 3. Auto-create catalog entry from scan data
  res = await pool.query(
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
  return res.rows[0].id;
}

const SCAN_PROMPT = `You are a collectibles identification expert specializing in graded trading card slabs.

Analyze this image and identify the item. Read all text on the label very carefully.

Return ONLY a valid JSON object — no markdown, no code fences, no other text. Use exactly this shape:
{
  "is_collectible": true,
  "item_type": "sports_card",
  "name": "player or character name",
  "set_name": "set or product name",
  "year": 2021,
  "card_number": "DT23",
  "sport_game": "football",
  "rarity": null,
  "condition": "graded",
  "grading_company": "PSA",
  "grade": "10",
  "cert_number": "88813132",
  "confidence": 0.95
}

Rules:
- item_type: "sports_card" | "tcg" | "comic" | "sealed" | "other"
- condition: "graded" if inside a slab, otherwise "raw"
- grading_company: "PSA" | "BGS" | "CGC" | "SGC" | null
- grade: exact grade text from label (e.g. "10", "9.5") or null
- cert_number: the certification/serial number as a string, or null
- year: 4-digit integer or null; card_number: just the code without "#"
- confidence: 0.0–1.0 representing your certainty
- If this is not a recognizable collectible, return { "is_collectible": false }`;

// ── POST /api/scan ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
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

    const catalog_id = await resolveCatalogId({ ...identified, item_type: derivedType });

    res.json({ match: true, catalog_id, ...identified });

  } catch (err) {
    console.error('[scan]', err.message);
    res.status(500).json({ error: 'Scan failed', detail: err.message });
  }
});

module.exports = router;
