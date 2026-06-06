require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
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

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

app.use('/api',          healthRouter);
app.use('/api/auth',     authRouter);
app.use('/api/portfolio', authMiddleware, portfolioRouter);
app.use('/api/catalog',  catalogRouter);
app.use('/api/scan',     authMiddleware, scanRouter);
app.use('/api/users',    usersRouter);
app.use('/api/admin',    authMiddleware, adminRouter);

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  try {
    await migrate();
    await seed();

    app.listen(PORT, () => {
      console.log(`Slabr server running on http://localhost:${PORT}`);
    });

    // ── eBay cron job — every day at 3:00 AM ──────────────────────────────
    if ((process.env.EBAY_APP_ID ?? '').trim()) {
      cron.schedule('0 3 * * *', () => {
        console.log('[cron] Running daily eBay price job...');
        runEbayJob().catch(err => console.error('[cron] eBay job failed:', err.message));
      });
      console.log('[cron] eBay price job scheduled (daily at 3:00 AM)');
    } else {
      console.log('[cron] eBay job skipped: EBAY_APP_ID not set');
    }
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }
}

start();
