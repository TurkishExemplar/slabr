const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const pool    = require('../db');
const authMiddleware        = require('../middleware/auth');
const { authLimiter }       = require('../middleware/rateLimiter');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,30}$/;

function signToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/signup
router.post('/signup', authLimiter, async (req, res) => {
  const { email, password, username } = req.body ?? {};

  if (!email || !password || !username) {
    return res.status(400).json({ error: 'email, password, and username are required' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–30 characters (letters, numbers, _ -)' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, username)
       VALUES ($1, $2, $3)
       RETURNING id, email, username, is_public, created_at`,
      [email.toLowerCase().trim(), passwordHash, username.trim()]
    );
    const user = rows[0];
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    if (err.code === '23505') {
      const field = err.constraint?.includes('email') ? 'Email' : 'Username';
      return res.status(409).json({ error: `${field} already in use` });
    }
    console.error('[signup]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const { password_hash, ...safeUser } = user;
    res.json({ token: signToken(safeUser), user: safeUser });
  } catch (err) {
    console.error('[login]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Password reset ────────────────────────────────────────────────────────────

async function sendResetEmail(to, resetUrl) {
  const apiKey = (process.env.RESEND_API_KEY ?? '').trim();
  const from   = (process.env.FROM_EMAIL ?? 'noreply@slabr.app').trim();

  if (!apiKey) {
    // Dev fallback — log the link so the feature works without an email provider
    console.log(`[auth] Password reset link (no RESEND_API_KEY set):\n  ${resetUrl}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Reset your Slabr password',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#09090b;color:#e4e4e7;border-radius:16px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px">
            <div style="width:36px;height:36px;background:#6366f1;border-radius:10px;display:flex;align-items:center;justify-content:center">
              <span style="color:#fff;font-weight:700;font-size:16px">S</span>
            </div>
            <span style="font-size:20px;font-weight:700;color:#fff">Slabr</span>
          </div>
          <h1 style="font-size:22px;font-weight:600;color:#fff;margin:0 0 8px">Reset your password</h1>
          <p style="color:#a1a1aa;font-size:15px;line-height:1.6;margin:0 0 28px">
            We received a request to reset the password for your Slabr account. Click the button below to choose a new password.
          </p>
          <a href="${resetUrl}"
             style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:600;font-size:15px">
            Reset password
          </a>
          <p style="color:#71717a;font-size:13px;margin:28px 0 0">
            This link expires in <strong style="color:#a1a1aa">1 hour</strong>.
            If you didn't request a password reset, you can safely ignore this email.
          </p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${text.slice(0, 200)}`);
  }
}

// POST /api/auth/forgot-password
router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body ?? {};
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  // Always return 200 — don't reveal whether the email exists
  res.json({ ok: true });

  // Fire-and-forget so the response goes out immediately
  setImmediate(async () => {
    try {
      const { rows } = await pool.query(
        'SELECT id, email FROM users WHERE email = $1',
        [email.toLowerCase().trim()]
      );
      if (!rows.length) return; // no such user — silently drop

      const token   = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await pool.query(
        'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
        [token, expires, rows[0].id]
      );

      const frontendUrl = (process.env.FRONTEND_URL ?? 'https://slabr.vercel.app').replace(/\/$/, '');
      const resetUrl    = `${frontendUrl}/reset-password?token=${token}`;

      await sendResetEmail(rows[0].email, resetUrl);
      console.log(`[auth] Password reset email sent to ${rows[0].email}`);
    } catch (err) {
      console.error('[auth] forgot-password error:', err.message);
    }
  });
});

// POST /api/auth/reset-password
router.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body ?? {};

  if (!token || !password) {
    return res.status(400).json({ error: 'token and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id FROM users
       WHERE reset_token = $1 AND reset_token_expires > NOW()`,
      [token]
    );

    if (!rows.length) {
      return res.status(400).json({ error: 'Reset link is invalid or has expired' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query(
      `UPDATE users
       SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL
       WHERE id = $2`,
      [passwordHash, rows[0].id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] reset-password error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, username, is_public, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[me]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
