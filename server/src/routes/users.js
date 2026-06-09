const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// GET /api/users/me/stats — current user account stats (must be before /:username)
router.get('/me/stats', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.userId;

    const [userRes, itemsRes, scansRes] = await Promise.all([
      pool.query(
        'SELECT id, email, username, is_public, created_at FROM users WHERE id = $1',
        [uid]
      ),
      pool.query(
        'SELECT COUNT(*) AS total FROM portfolio_items WHERE user_id = $1',
        [uid]
      ),
      pool.query(
        'SELECT COUNT(*) AS total FROM scan_logs WHERE user_id = $1',
        [uid]
      ),
    ]);

    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });

    res.json({
      ...userRes.rows[0],
      total_items: parseInt(itemsRes.rows[0].total, 10),
      total_scans: parseInt(scansRes.rows[0].total, 10),
    });
  } catch (err) {
    console.error('[users GET /me/stats]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/users/me — update profile (must be before /:username)
router.put('/me', authMiddleware, async (req, res) => {
  const { username, email, is_public } = req.body ?? {};

  try {
    const { rows } = await pool.query(
      `UPDATE users SET
         username  = COALESCE($1, username),
         email     = COALESCE($2, email),
         is_public = COALESCE($3, is_public)
       WHERE id = $4
       RETURNING id, email, username, is_public, created_at`,
      [username ?? null, email ?? null, is_public ?? null, req.user.userId]
    );

    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      const field = err.detail?.includes('username') ? 'username' : 'email';
      return res.status(409).json({ error: `That ${field} is already taken` });
    }
    console.error('[users PUT /me]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/users/me/password — change password (must be before /:username)
router.put('/me/password', authMiddleware, async (req, res) => {
  const { current_password, new_password } = req.body ?? {};

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.userId]);

    res.json({ success: true });
  } catch (err) {
    console.error('[users PUT /me/password]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/users/:username — public profile (dynamic, must be last)
router.get('/:username', async (req, res) => {
  try {
    const { rows: userRows } = await pool.query(
      'SELECT id, username, is_public, created_at FROM users WHERE LOWER(username) = LOWER($1)',
      [req.params.username]
    );

    if (!userRows.length) return res.status(404).json({ error: 'User not found' });

    const user = userRows[0];

    if (!user.is_public) {
      return res.json({ is_public: false, username: user.username });
    }

    const { rows: items } = await pool.query(
      `SELECT
         pi.id, pi.catalog_id, pi.condition, pi.grading_company, pi.grade,
         pi.cert_number, pi.quantity, pi.current_value, pi.added_at,
         mc.item_type, mc.name, mc.year, mc.brand_publisher, mc.set_name,
         mc.card_number, mc.variation, mc.sport_game, mc.rarity, mc.image_url,
         ph.sold_median AS ph_value,
         ph.source      AS price_source
       FROM portfolio_items pi
       JOIN master_catalog mc ON pi.catalog_id = mc.id
       LEFT JOIN LATERAL (
         SELECT sold_median, source
         FROM price_history
         WHERE catalog_id = pi.catalog_id
           AND sold_median IS NOT NULL
           AND source <> 'ebay'
           AND (source = 'mock'
                OR (condition IS NOT DISTINCT FROM pi.condition
                    AND grade IS NOT DISTINCT FROM pi.grade))
         ORDER BY CASE source WHEN 'pricecharting' THEN 1 WHEN 'manual' THEN 2 ELSE 3 END,
                  recorded_at DESC
         LIMIT 1
       ) ph ON true
       WHERE pi.user_id = $1
       ORDER BY pi.added_at DESC`,
      [user.id]
    );

    const total_items = items.length;
    const total_value = items.reduce(
      (sum, i) => sum + (parseFloat(i.current_value) || 0) * (i.quantity || 1),
      0
    );
    const graded_count = items.filter(i => i.condition === 'graded').length;
    const raw_count    = items.filter(i => i.condition === 'raw').length;
    const categories   = items.reduce((acc, i) => {
      acc[i.item_type] = (acc[i.item_type] || 0) + 1;
      return acc;
    }, {});

    res.json({
      is_public: true,
      username: user.username,
      created_at: user.created_at,
      stats: {
        total_items,
        total_value: total_value.toFixed(2),
        graded_count,
        raw_count,
        categories,
      },
      items,
    });
  } catch (err) {
    console.error('[users GET /:username]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
