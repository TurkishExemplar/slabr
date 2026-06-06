require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

// ── Process-level safety net ───────────────────────────────────────────────
// Catches anything thrown outside of the try/catch in start() (e.g. during
// module loading or inside a callback that escapes the async chain).
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
const cors = require('cors');
const cron = require('node-cron');
const pool = require('./db');
const migrate = require('./migrate');
const seed = require('./seed');
const healthRouter    = require('./routes/health');
const authRouter      = require('./routes/auth');
const portfolioRouter = require('./routes/portfolio');
const authMiddleware  = require('./middleware/auth');
const catalogRouter   = require('./routes/catalog');
const scanRouter      = require('./routes/scan');
const usersRouter     = require('./routes/users');
const adminRouter     = require('./routes/admin');
const { runEbayJob }  = require('./jobs/ebay');

const app = express();

// Build an allow-list: CLIENT_URL (set in Railway) + localhost variants for local dev.
// Requests with no Origin header (curl, server-to-server) are always allowed.
const ALLOWED_ORIGINS = [
  process.env.CLIENT_URL,         // e.g. https://slabr.vercel.app
  'http://localhost:3000',
  'http://localhost:5173',
].filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    console.warn(`[cors] Blocked origin: ${origin}`);
    callback(new Error(`CORS: origin not allowed — ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

app.use('/api',           healthRouter);
app.use('/api/auth',      authRouter);
app.use('/api/portfolio', authMiddleware, portfolioRouter);
app.use('/api/catalog',   catalogRouter);
app.use('/api/scan',      authMiddleware, scanRouter);
app.use('/api/users',     usersRouter);
app.use('/api/admin',     authMiddleware, adminRouter);

// ── Startup ────────────────────────────────────────────────────────────────

async function start() {
  const PORT = process.env.PORT || 3001;

  // ── 1. Verify required env vars ──────────────────────────────────────────
  console.log('[startup] NODE_ENV   :', process.env.NODE_ENV || 'development');
  console.log('[startup] PORT       :', PORT);
  console.log('[startup] DATABASE_URL:', process.env.DATABASE_URL ? '[set]' : '[MISSING]');
  console.log('[startup] JWT_SECRET :', process.env.JWT_SECRET  ? '[set]' : '[MISSING]');

  if (!process.env.DATABASE_URL) {
    console.error('[startup] FATAL: DATABASE_URL is not set. Add it to Railway environment variables.');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    console.error('[startup] FATAL: JWT_SECRET is not set. Add it to Railway environment variables.');
    process.exit(1);
  }

  try {
    // ── 2. Verify database connectivity ────────────────────────────────────
    console.log('[startup] Testing database connection...');
    await pool.query('SELECT 1');
    console.log('[startup] Database connection OK.');

    // ── 3. Run migrations ───────────────────────────────────────────────────
    console.log('[startup] Running migrations...');
    await migrate();

    // ── 4. Seed catalog data ────────────────────────────────────────────────
    console.log('[startup] Seeding catalog...');
    await seed();

    // ── 5. Start HTTP server ────────────────────────────────────────────────
    await new Promise((resolve, reject) => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`[startup] Slabr server running on port ${PORT}`);
        resolve();
      }).on('error', reject);
    });

    // ── 6. Schedule eBay cron job ───────────────────────────────────────────
    if ((process.env.EBAY_APP_ID ?? '').trim()) {
      cron.schedule('0 3 * * *', () => {
        console.log('[cron] Running daily eBay price job...');
        runEbayJob().catch(err => console.error('[cron] eBay job failed:', err.message));
      });
      console.log('[startup] eBay price job scheduled (daily at 3:00 AM).');
    } else {
      console.log('[startup] eBay job not scheduled: EBAY_APP_ID not set.');
    }

  } catch (err) {
    console.error('[startup] FATAL — server failed to start:\n', err.stack ?? String(err));
    process.exit(1);
  }
}

start();
