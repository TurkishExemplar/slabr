// ── Input sanitization middleware ─────────────────────────────────────────────
//
// Applied globally to all routes.  Cleans req.body by:
//   1. Trimming leading/trailing whitespace from all string values
//   2. Stripping null bytes (\0) and bare carriage returns (\r) from strings
//   3. Capping string length at MAX_STRING_LENGTH (skips image_base64 fields
//      since a base64-encoded image is legitimately large)
//
// SQL injection is already prevented by parameterised queries throughout the
// codebase — this middleware is a defence-in-depth measure, not the primary
// protection.  It does NOT strip HTML because this is a JSON-only API; the
// React frontend is responsible for escaping output.

const MAX_STRING_LENGTH = 10_000;

// Fields that are allowed to exceed the cap (base64 image payloads)
const UNCAPPED_FIELDS = new Set(['image_base64']);

function sanitizeString(key, value) {
  // Remove null bytes and bare carriage returns, then trim whitespace
  let s = value.replace(/\0/g, '').replace(/\r/g, '').trim();
  // Enforce cap unless the field is explicitly excluded
  if (!UNCAPPED_FIELDS.has(key) && s.length > MAX_STRING_LENGTH) {
    s = s.slice(0, MAX_STRING_LENGTH);
  }
  return s;
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      out[k] = sanitizeString(k, v);
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitizeObject(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sanitizeMiddleware(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  next();
}

module.exports = sanitizeMiddleware;
