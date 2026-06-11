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
//
// Lookup strategy (most-specific → least-specific):
//   1. name + set_name + year   — prevents matching a different card that shares
//      only the player name (e.g. "Kobe Bryant" matching ANY Kobe catalog entry)
//   2. name + set_name           — year not extracted from label
//   3. full name only            — only safe when name includes set info
//   4. auto-create               — nothing matched
async function resolveCatalogId(fields) {
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

  // The scan photo is used ONLY for identification — never saved as the card
  // image.  The PriceCharting product image is fetched by the background
  // pricing run right after the item is added.

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

  // ── Payload validation (all checks run before any API call) ──────────────

  // Strip data-URI prefix safely — anything before the comma is metadata only.
  const base64 = image_base64.replace(/^data:[^;]+;base64,/, '');

  // 1. Base64 well-formedness — reject strings with characters outside the
  //    standard base64 alphabet.  Sample the start and end; checking the full
  //    multi-megabyte string with a regex would be slow and isn't necessary
  //    because the magic-byte decode below catches corrupt payloads.
  if (base64.length < 8 || !/^[A-Za-z0-9+/]/.test(base64)) {
    return res.status(400).json({ error: 'Only image files are accepted' });
  }

  // 2. Decoded-size estimate — base64 encodes 3 bytes as 4 chars, so
  //    decoded_bytes ≈ base64_length × ¾.  Reject before decoding the full
  //    payload to avoid allocating a huge buffer for oversized uploads.
  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > 10 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image too large — maximum 10MB' });
  }

  // 3. Magic-byte validation — check actual file header bytes, not the MIME
  //    type string claimed by the client (which can be set to anything).
  //    Decode only the first 16 bytes (24 base64 chars) to keep this fast.
  //
  //    Signatures:
  //      JPEG  FF D8 FF
  //      PNG   89 50 4E 47 0D 0A 1A 0A
  //      GIF   47 49 46 38  ("GIF8")
  //      WebP  52 49 46 46 .. .. .. .. 57 45 42 50  ("RIFF....WEBP")
  let mediaType;
  try {
    const h = Buffer.from(base64.slice(0, 24), 'base64');
    if (h[0] === 0xFF && h[1] === 0xD8 && h[2] === 0xFF) {
      mediaType = 'image/jpeg';
    } else if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47) {
      mediaType = 'image/png';
    } else if (h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46) {
      mediaType = 'image/gif';
    } else if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 &&
               h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50) {
      mediaType = 'image/webp';
    } else {
      return res.status(400).json({ error: 'Only image files are accepted' });
    }
  } catch {
    return res.status(400).json({ error: 'Only image files are accepted' });
  }

  // Rate limit: 50 scans per user per 24 hours
  const { rows: rateRows } = await pool.query(
    `SELECT COUNT(*) FROM scan_logs WHERE user_id = $1 AND scanned_at > NOW() - INTERVAL '24 hours'`,
    [req.user.userId]
  );
  if (parseInt(rateRows[0].count) >= 50) {
    return res.status(429).json({ error: 'Scan limit reached', detail: '50 scans per 24 hours' });
  }

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

    // ── Sanitise Claude's returned field values before touching the DB ────────
    // Parameterised queries block SQL injection, but we also:
    //   • Strip HTML tags  — prevents stored XSS if values are ever rendered raw
    //   • Cap string lengths — prevents oversized column inserts from crafted images
    //   • Range-validate numerics — year and grade must be within expected bounds

    // Strip any HTML/XML tags then trim whitespace
    const stripHtml = v =>
      typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim() : v;

    // Strip HTML, then truncate to max chars
    const clean = (v, max) => {
      const s = stripHtml(v);
      return typeof s === 'string' ? s.slice(0, max) : null;
    };

    // Year: must be a real integer in [1800, currentYear + 1]
    const rawYear = typeof parsed.year === 'number' ? Math.round(parsed.year) : null;
    const safeYear = rawYear != null && rawYear >= 1800 && rawYear <= new Date().getFullYear() + 1
      ? rawYear : null;

    // Grade: must be a number in [1, 10] — covers PSA/BGS/CGC/SGC scales.
    // Stored as text (e.g. "9.5") but validated numerically.
    let safeGrade = null;
    if (parsed.grade != null) {
      const g = parseFloat(parsed.grade);
      if (!isNaN(g) && g >= 1 && g <= 10) {
        safeGrade = String(parsed.grade).replace(/<[^>]*>/g, '').trim().slice(0, 10);
      }
    }

    // Grading company must be one of the known labels
    const KNOWN_GRADERS = new Set(['PSA', 'BGS', 'CGC', 'SGC']);
    const safeGrader = KNOWN_GRADERS.has(parsed.grading_company) ? parsed.grading_company : null;

    // Condition must be 'graded' or 'raw'
    const safeCondition = parsed.condition === 'graded' ? 'graded' : 'raw';

    const identified = {
      name:            clean(parsed.name,            200),
      set_name:        clean(parsed.set_name,        200),
      year:            safeYear,
      card_number:     clean(parsed.card_number,      20),
      rarity:          clean(parsed.rarity,          100),
      sport_game:      clean(parsed.sport_game,       50),
      condition:       safeCondition,
      grading_company: safeGrader,
      grade:           safeGrade,
      cert_number:     clean(parsed.cert_number,      40),
      current_value:   null,
      forecast_30d:    null,
      confidence:      typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };

    const catalog_id = await resolveCatalogId({ ...identified, item_type: derivedType });

    res.json({ match: true, catalog_id, ...identified });

  } catch (err) {
    console.error('[scan]', err.message);
    // Do not echo err.message to the client — it can contain internal details
    // (Anthropic API error bodies, paths, credentials fragments).
    res.status(500).json({ error: 'Scan failed — please try again' });
  }
});

module.exports = router;
