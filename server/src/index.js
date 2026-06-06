require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

// ── Process-level safety net ───────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:\n', err.stack ?? String(err));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:\n',
    reason instanceof Error ? reason.stack : reason);
  process.exit(1);
});

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const pool    = require('./db');
const migrate = require('./migrate');
const seed    = require('./seed');
const authMiddleware = require('./middleware/auth');
const { runEbayJob } = require('./jobs/ebay');

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────
// CLIENT_URL is set in Railway env (e.g. https://slabr.vercel.app).
// Localhost variants are always allowed for local development.
const ALLOWED_ORIGINS = [
  process.env.CLIENT_URL,
  'http://localhost:3000',
  'http://localhost:5173',
].filter(Boolean);

// Log on startup so Railway logs confirm what origins are whitelisted.
console.log('[cors] Allowed origins:', ALLOWED_ORIGINS);

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    console.warn(`[cors] Blocked origin: ${origin}`);
    callback(new Error(`CORS: origin not allowed — ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// ── Root health probe ─────────────────────────────────────────────────────
// Railway (and other platforms) probe GET / to decide whether the instance
// is alive. This route must respond 200 immediately — no DB query —
// so the service is never killed for taking too long to start.
app.get('/', (req, res) => res.json({ ok: true, service: 'slabr-api' }));

// ── Load routes ───────────────────────────────────────────────────────────
// Wrapped in try/catch so a broken route file emits a clear error
// rather than a silent uncaughtException from the top-level require().
try {
  app.use('/api',           require('./routes/health'));
  app.use('/api/auth',      require('./routes/auth'));
  app.use('/api/portfolio', authMiddleware, require('./routes/portfolio'));
  app.use('/api/catalog',   require('./routes/catalog'));
  app.use('/api/scan',      authMiddleware, require('./routes/scan'));
  app.use('/api/users',     require('./routes/users'));
  app.use('/api/admin',     authMiddleware, require('./routes/admin'));
  console.log('[startup] All routes registered.');
} catch (err) {
  console.error('[startup] FATAL — failed to load a route file:\n', err.stack ?? String(err));
  process.exit(1);
}

// ── Startup ───────────────────────────────────────────────────────────────

async function start() {
  const PORT = process.env.PORT || 3001;

  // ── 1. Check required env vars ───────────────────────────────────────────
  console.log('[startup] NODE_ENV   :', process.env.NODE_ENV || 'development');
  console.log('[startup] PORT       :', PORT);
  console.log('[startup] DATABASE_URL:', process.env.DATABASE_URL ? '[set]' : '[MISSING]');
  console.log('[startup] JWT_SECRET :', process.env.JWT_SECRET  ? '[set]' : '[MISSING]');

  if (!process.env.DATABASE_URL) {
    console.error('[startup] FATAL: DATABASE_URL is not set.');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    console.error('[startup] FATAL: JWT_SECRET is not set.');
    process.exit(1);
  }

  try {
    // ── 2. Bind the HTTP server FIRST ────────────────────────────────────────
    // Start listening before migrations so Railway's health check at GET /
    // gets an immediate 200. Migrations and seeding happen afterwards.
    await new Promise((resolve, reject) => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`[startup] Listening on port ${PORT} — running migrations…`);
        resolve();
      }).on('error', reject);
    });

    // ── 3. Database connectivity ─────────────────────────────────────────────
    console.log('[startup] Testing database connection…');
    await pool.query('SELECT 1');
    console.log('[startup] Database connection OK.');

    // ── 4. Migrations ────────────────────────────────────────────────────────
    console.log('[startup] Running migrations…');
    await migrate();

    // ── 5. Seed ──────────────────────────────────────────────────────────────
    console.log('[startup] Seeding catalog…');
    await seed();

    console.log('[startup] Slabr API ready.');

    // ── 6. eBay cron ─────────────────────────────────────────────────────────
    if ((process.env.EBAY_APP_ID ?? '').trim()) {
      cron.schedule('0 3 * * *', () => {
        console.log('[cron] Running daily eBay price job…');
        runEbayJob().catch(err => console.error('[cron] eBay job failed:', err.message));
      });
      console.log('[startup] eBay price job scheduled (daily at 3:00 AM).');
    } else {
      console.log('[startup] eBay job not scheduled: EBAY_APP_ID not set.');
    }

  } catch (err) {
    console.error('[startup] FATAL — startup failed:\n', err.stack ?? String(err));
    process.exit(1);
  }
}

start();
