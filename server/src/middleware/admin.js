// ── Admin secret guard ────────────────────────────────────────────────────────
//
// When ADMIN_SECRET is set in env, every request to /api/admin/* must include:
//
//   X-Admin-Secret: <value>
//
// If ADMIN_SECRET is NOT set the check is skipped — the existing authMiddleware
// on the route is the only gate (useful in local dev before a secret is added).
//
// In production, always set ADMIN_SECRET to a long random string.
// The admin routes also remain behind authMiddleware, so an attacker needs
// both a valid JWT *and* the correct admin secret.

function adminMiddleware(req, res, next) {
  const secret = (process.env.ADMIN_SECRET ?? '').trim();

  if (!secret) {
    // Not configured — log a reminder and fall through so local dev still works.
    console.warn('[admin] ADMIN_SECRET is not set — admin routes are unguarded. Set it in production.');
    return next();
  }

  const provided = (req.headers['x-admin-secret'] ?? '').trim();

  if (!provided || provided !== secret) {
    console.warn(`[admin] Rejected request — bad or missing X-Admin-Secret from ${req.ip}`);
    return res.status(403).json({ error: 'Forbidden — invalid admin secret' });
  }

  next();
}

module.exports = adminMiddleware;
