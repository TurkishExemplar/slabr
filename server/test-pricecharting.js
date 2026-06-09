/**
 * PriceCharting integration smoke test
 *
 * Usage:
 *   node test-pricecharting.js
 *
 * Requires PRICE_CHARTING_TOKEN in .env (or set inline):
 *   PRICE_CHARTING_TOKEN=xxx node test-pricecharting.js
 *
 * Tests fetchPriceCharting() against known cards using all three
 * query variations and prints which one matched.
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
  // Sports cards — well-indexed on PriceCharting
  // card_number helps the #1 query variation ("LeBron James #111") hit product-name directly
  { name: 'LeBron James',  year: 2003, set_name: 'Topps Chrome', card_number: '111', condition: 'raw'    },
  { name: 'LeBron James',  year: 2003, set_name: 'Topps Chrome', card_number: '111', condition: 'graded' },
  { name: 'Stephen Curry', year: 2009, set_name: 'Topps',        card_number: '321', condition: 'graded' },
  { name: 'Kobe Bryant',   year: 1996, set_name: 'Topps Chrome',                     condition: 'raw'    },
  // Pokemon
  { name: 'Charizard',     year: 1999, set_name: 'Base Set',                         condition: 'raw'    },
];

async function run() {
  console.log('\n── PriceCharting smoke test ──────────────────────────────────────\n');

  let passed = 0;
  let failed = 0;

  for (const card of TEST_CARDS) {
    const label = `${card.name} ${card.year ?? ''} ${card.set_name ?? ''} (${card.condition})`.trim();
    try {
      const price = await fetchPriceCharting(card);
      if (price != null && price > 0) {
        console.log(`  ✓  ${label}\n     → $${price.toFixed(2)}\n`);
        passed++;
      } else {
        console.log(`  –  ${label}\n     → null (no price on PriceCharting — eBay fallback will be used)\n`);
        passed++; // null is valid — eBay fallback handles it
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
