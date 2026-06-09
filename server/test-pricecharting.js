/**
 * PriceCharting integration smoke test
 *
 * Usage:
 *   node test-pricecharting.js
 *
 * Requires PRICE_CHARTING_TOKEN in .env (or set inline):
 *   PRICE_CHARTING_TOKEN=xxx node test-pricecharting.js
 *
 * Tests fetchPriceCharting() against known cards and prints
 * what price Slabr would store in price_history.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { fetchPriceCharting } = require('./src/jobs/ebay');

if (!(process.env.PRICE_CHARTING_TOKEN ?? '').trim()) {
  console.error('\n  ✗  PRICE_CHARTING_TOKEN is not set.\n');
  console.error('  Add it to your .env or run:\n');
  console.error('    PRICE_CHARTING_TOKEN=xxx node test-pricecharting.js\n');
  process.exit(1);
}

const TEST_CARDS = [
  // A well-known rookie RC — should have strong loose + graded prices
  { name: 'LeBron James 2003 Topps Chrome', year: 2003, set_name: 'Topps Chrome', condition: 'raw'    },
  { name: 'LeBron James 2003 Topps Chrome', year: 2003, set_name: 'Topps Chrome', condition: 'graded' },
  // A more niche card — tests graceful null return when no price is recorded
  { name: 'Stephen Curry 2009 Topps',       year: 2009, set_name: 'Topps',        condition: 'graded' },
  // Pokemon — tests non-sports-card path
  { name: 'Charizard',                      year: 1999, set_name: 'Base Set',      condition: 'raw'    },
];

async function run() {
  console.log('\n── PriceCharting smoke test ──────────────────────────────────────\n');

  let passed = 0;
  let failed = 0;

  for (const card of TEST_CARDS) {
    const label = `${card.name} (${card.condition})`;
    try {
      const price = await fetchPriceCharting(card);
      if (price != null && price > 0) {
        console.log(`  ✓  ${label}\n     → $${price.toFixed(2)}\n`);
        passed++;
      } else {
        console.log(`  –  ${label}\n     → no price returned (null) — will fall back to eBay\n`);
        passed++; // null is a valid / expected result
      }
    } catch (err) {
      console.error(`  ✗  ${label}\n     → ERROR: ${err.message}\n`);
      failed++;
    }
  }

  console.log(`── ${passed} passed, ${failed} failed ─────────────────────────────────────\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
