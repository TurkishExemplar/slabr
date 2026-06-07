const rateLimit = require('express-rate-limit');

// ── Brute-force protection — login / signup / password reset ──────────────────
// 15 attempts per 15 minutes per IP.  Tight enough to stop credential stuffing
// without locking out a legitimate user who mistypes a few times.
const authLimiter = rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            15,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests — please try again in 15 minutes.' },
});

// ── Scan limiter — Claude Vision calls are expensive ──────────────────────────
// 5 scan requests per 60 seconds, keyed on the authenticated userId so that
// different users each get their own bucket (falls back to IP if no user yet).
const scanLimiter = rateLimit({
  windowMs:       60 * 1000,
  max:            5,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:   (req) => String(req.user?.userId ?? req.ip),
  message: { error: 'Scan rate limit reached — please wait before scanning again.' },
});

// ── Admin limiter — protect job-trigger endpoints ─────────────────────────────
// 30 requests per 5 minutes per IP.
const adminLimiter = rateLimit({
  windowMs:       5 * 60 * 1000,
  max:            30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many admin requests — slow down.' },
});

// ── Global API safety net ─────────────────────────────────────────────────────
// 300 requests per 15 minutes per IP.  Catches runaway clients / scrapers
// without affecting normal interactive usage.
const apiLimiter = rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            300,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests from this IP — please try again later.' },
});

module.exports = { authLimiter, scanLimiter, adminLimiter, apiLimiter };
