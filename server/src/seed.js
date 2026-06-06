require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const pool = require('./db');

const catalog = [
  // ── Sports Cards ──────────────────────────────────────────────────────────
  {
    item_type: 'sports_card', name: 'LeBron James Rookie Card', year: 2003,
    brand_publisher: 'Topps', set_name: 'Topps Chrome', card_number: '111',
    sport_game: 'basketball', rarity: 'Base',
    ebay_search_query: 'LeBron James 2003 Topps Chrome RC #111',
    mock_value: 3500.00,
  },
  {
    item_type: 'sports_card', name: 'Ken Griffey Jr. Rookie Card', year: 1989,
    brand_publisher: 'Upper Deck', set_name: 'Upper Deck', card_number: '1',
    sport_game: 'baseball', rarity: 'Base',
    ebay_search_query: 'Ken Griffey Jr 1989 Upper Deck RC #1',
    mock_value: 450.00,
  },
  {
    item_type: 'sports_card', name: 'Tom Brady Rookie Card', year: 2000,
    brand_publisher: 'Bowman', set_name: 'Bowman Chrome', card_number: '236',
    sport_game: 'football', rarity: 'Base',
    ebay_search_query: 'Tom Brady 2000 Bowman Chrome RC #236',
    mock_value: 1200.00,
  },
  {
    item_type: 'sports_card', name: 'Michael Jordan Rookie Card', year: 1986,
    brand_publisher: 'Fleer', set_name: 'Fleer', card_number: '57',
    sport_game: 'basketball', rarity: 'Base',
    ebay_search_query: 'Michael Jordan 1986 Fleer RC #57',
    mock_value: 8000.00,
  },
  {
    item_type: 'sports_card', name: 'Mickey Mantle', year: 1952,
    brand_publisher: 'Topps', set_name: 'Topps', card_number: '311',
    sport_game: 'baseball', rarity: 'Base',
    ebay_search_query: 'Mickey Mantle 1952 Topps #311',
    mock_value: 15000.00,
  },
  {
    item_type: 'sports_card', name: 'Patrick Mahomes Rookie Card', year: 2017,
    brand_publisher: 'Panini', set_name: 'Prizm', card_number: '269',
    sport_game: 'football', rarity: 'Base',
    ebay_search_query: 'Patrick Mahomes 2017 Panini Prizm RC #269',
    mock_value: 700.00,
  },

  // ── TCG ───────────────────────────────────────────────────────────────────
  {
    item_type: 'tcg', name: 'Charizard Holo 1st Edition', year: 1999,
    brand_publisher: 'Wizards of the Coast', set_name: 'Base Set', card_number: '4/102',
    variation: '1st Edition', sport_game: 'pokemon', rarity: 'Holo Rare',
    ebay_search_query: 'Charizard 1999 Base Set 1st Edition Holo #4',
    mock_value: 12000.00,
  },
  {
    item_type: 'tcg', name: 'Black Lotus', year: 1993,
    brand_publisher: 'Wizards of the Coast', set_name: 'Alpha',
    variation: 'Alpha', sport_game: 'mtg', rarity: 'Rare',
    ebay_search_query: 'Magic the Gathering Alpha Black Lotus',
    mock_value: 35000.00,
  },
  {
    item_type: 'tcg', name: 'Monkey D. Luffy', year: 2022,
    brand_publisher: 'Bandai', set_name: 'Romance Dawn', card_number: 'OP01-120',
    variation: 'Secret Rare', sport_game: 'one_piece', rarity: 'Secret Rare',
    ebay_search_query: 'One Piece TCG Monkey D Luffy OP01-120 Secret Rare',
    mock_value: 180.00,
  },
  {
    item_type: 'tcg', name: 'Pikachu Holo', year: 2016,
    brand_publisher: 'The Pokémon Company', set_name: 'Evolutions', card_number: '35/108',
    sport_game: 'pokemon', rarity: 'Holo Rare',
    ebay_search_query: 'Pikachu 2016 Pokemon Evolutions Holo #35',
    mock_value: 55.00,
  },
  {
    item_type: 'tcg', name: 'Polluted Delta', year: 2002,
    brand_publisher: 'Wizards of the Coast', set_name: 'Onslaught',
    sport_game: 'mtg', rarity: 'Rare',
    ebay_search_query: 'MTG Polluted Delta Onslaught',
    mock_value: 120.00,
  },
  {
    item_type: 'tcg', name: 'Umbreon VMAX Alt Art', year: 2021,
    brand_publisher: 'The Pokémon Company', set_name: 'Evolving Skies', card_number: '215/203',
    variation: 'Alternate Art', sport_game: 'pokemon', rarity: 'Secret Rare',
    ebay_search_query: 'Pokemon Umbreon VMAX Alternate Art 215/203 Evolving Skies',
    mock_value: 350.00,
  },

  // ── Comics ────────────────────────────────────────────────────────────────
  {
    item_type: 'comic', name: 'Amazing Fantasy #15', year: 1962,
    brand_publisher: 'Marvel', card_number: '15',
    variation: '1st Appearance Spider-Man', rarity: 'Key Issue',
    ebay_search_query: 'Amazing Fantasy #15 1962 Marvel 1st Spider-Man',
    mock_value: 45000.00,
  },
  {
    item_type: 'comic', name: 'Action Comics #1', year: 1938,
    brand_publisher: 'DC', card_number: '1',
    variation: '1st Appearance Superman', rarity: 'Key Issue',
    ebay_search_query: 'Action Comics #1 1938 DC 1st Superman',
    mock_value: 500000.00,
  },
  {
    item_type: 'comic', name: 'X-Men #1', year: 1963,
    brand_publisher: 'Marvel', card_number: '1',
    variation: '1st Appearance X-Men', rarity: 'Key Issue',
    ebay_search_query: 'X-Men #1 1963 Marvel 1st Appearance',
    mock_value: 8000.00,
  },
  {
    item_type: 'comic', name: 'Detective Comics #27', year: 1939,
    brand_publisher: 'DC', card_number: '27',
    variation: '1st Appearance Batman', rarity: 'Key Issue',
    ebay_search_query: 'Detective Comics #27 1939 DC 1st Batman',
    mock_value: 250000.00,
  },
  {
    item_type: 'comic', name: 'Incredible Hulk #181', year: 1974,
    brand_publisher: 'Marvel', card_number: '181',
    variation: '1st Full Appearance Wolverine', rarity: 'Key Issue',
    ebay_search_query: 'Incredible Hulk #181 1974 Marvel 1st Wolverine',
    mock_value: 2500.00,
  },
  {
    item_type: 'comic', name: 'Giant-Size X-Men #1', year: 1975,
    brand_publisher: 'Marvel', card_number: '1',
    variation: '1st Appearance New X-Men', rarity: 'Key Issue',
    ebay_search_query: 'Giant-Size X-Men #1 1975 Marvel 1st New X-Men',
    mock_value: 1800.00,
  },

  // ── Sealed Boxes ──────────────────────────────────────────────────────────
  {
    item_type: 'sealed', name: '2023 Topps Chrome Baseball Hobby Box', year: 2023,
    brand_publisher: 'Topps', set_name: 'Topps Chrome',
    variation: 'Hobby Box', sport_game: 'baseball', rarity: 'Sealed',
    ebay_search_query: '2023 Topps Chrome Baseball Hobby Box sealed',
    mock_value: 85.00,
  },
  {
    item_type: 'sealed', name: '2024 Panini National Treasures Basketball Hobby Box', year: 2024,
    brand_publisher: 'Panini', set_name: 'National Treasures',
    variation: 'Hobby Box', sport_game: 'basketball', rarity: 'Sealed',
    ebay_search_query: '2024 Panini National Treasures Basketball Hobby Box sealed',
    mock_value: 600.00,
  },
  {
    item_type: 'sealed', name: '2023 Pokémon Obsidian Flames Booster Box', year: 2023,
    brand_publisher: 'The Pokémon Company', set_name: 'Obsidian Flames',
    variation: 'Booster Box', sport_game: 'pokemon', rarity: 'Sealed',
    ebay_search_query: '2023 Pokemon Obsidian Flames Booster Box sealed',
    mock_value: 120.00,
  },
  {
    item_type: 'sealed', name: '2023 Panini Prizm Football Hobby Box', year: 2023,
    brand_publisher: 'Panini', set_name: 'Prizm',
    variation: 'Hobby Box', sport_game: 'football', rarity: 'Sealed',
    ebay_search_query: '2023 Panini Prizm Football Hobby Box sealed',
    mock_value: 145.00,
  },
  {
    item_type: 'sealed', name: '2024 MTG Murders at Karlov Manor Draft Booster Box', year: 2024,
    brand_publisher: 'Wizards of the Coast', set_name: 'Murders at Karlov Manor',
    variation: 'Draft Booster Box', sport_game: 'mtg', rarity: 'Sealed',
    ebay_search_query: '2024 MTG Murders at Karlov Manor Draft Booster Box sealed',
    mock_value: 95.00,
  },
];

async function seedPriceHistory(client) {
  const { rows: [counts] } = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM master_catalog)        AS catalog_count,
      (SELECT COUNT(*)::int FROM price_history
       WHERE source = 'mock')                           AS history_count
  `);

  const DAYS = 7;
  if (counts.history_count >= counts.catalog_count * DAYS) {
    console.log(`[seed] Price history already has ${counts.history_count} mock rows, skipping.`);
    return;
  }

  // Get the current price per catalog item to use as the day-0 anchor
  const { rows: basePrices } = await client.query(`
    SELECT DISTINCT ON (catalog_id) catalog_id, sold_median
    FROM price_history
    WHERE source = 'mock'
    ORDER BY catalog_id, recorded_at DESC
  `);

  if (!basePrices.length) return;

  await client.query("DELETE FROM price_history WHERE source = 'mock'");

  for (const { catalog_id, sold_median } of basePrices) {
    let price = parseFloat(sold_median);
    for (let daysAgo = DAYS - 1; daysAgo >= 0; daysAgo--) {
      // slight positive drift historically (collectibles tend to appreciate)
      if (daysAgo > 0) price = price * (1 + (Math.random() * 0.07 - 0.025));
      const ts = new Date();
      ts.setDate(ts.getDate() - daysAgo);
      ts.setHours(12, 0, 0, 0);
      await client.query(
        `INSERT INTO price_history
           (catalog_id, condition, grade, sold_median, active_low, source, recorded_at)
         VALUES ($1, 'raw', NULL, $2, $3, 'mock', $4)`,
        [catalog_id, +price.toFixed(2), +(price * 0.9).toFixed(2), ts.toISOString()]
      );
    }
  }

  console.log(`[seed] Generated ${DAYS} days of mock price history for ${basePrices.length} catalog items.`);
}

async function seed() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT COUNT(*) FROM master_catalog');
    if (parseInt(rows[0].count) > 0) {
      console.log(`[seed] ${rows[0].count} catalog items already present, skipping.`);
    } else {
      for (const item of catalog) {
        const { mock_value, ...fields } = item;

        const res = await client.query(
          `INSERT INTO master_catalog
            (item_type, name, year, brand_publisher, set_name, card_number,
             variation, sport_game, rarity, image_url, ebay_search_query)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [
            fields.item_type, fields.name, fields.year ?? null,
            fields.brand_publisher ?? null, fields.set_name ?? null,
            fields.card_number ?? null, fields.variation ?? null,
            fields.sport_game ?? null, fields.rarity ?? null,
            fields.image_url ?? null, fields.ebay_search_query ?? null,
          ]
        );

        const catalogId = res.rows[0].id;

        // Insert day-0 anchor price so seedPriceHistory has something to expand from
        await client.query(
          `INSERT INTO price_history (catalog_id, condition, grade, sold_median, active_low, source)
           VALUES ($1, 'raw', NULL, $2, $3, 'mock')`,
          [catalogId, mock_value, +(mock_value * 0.9).toFixed(2)]
        );
      }
      console.log(`[seed] Inserted ${catalog.length} catalog items.`);
    }

    await seedPriceHistory(client);
  } finally {
    client.release();
  }
}

module.exports = seed;

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] Failed:', err.message);
      process.exit(1);
    });
}
