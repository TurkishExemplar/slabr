require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const pool = require('./db');

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  is_public BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS master_catalog (
  id SERIAL PRIMARY KEY,
  item_type TEXT NOT NULL CHECK (item_type IN ('sports_card','tcg','comic','sealed')),
  name TEXT NOT NULL,
  year INT,
  brand_publisher TEXT,
  set_name TEXT,
  card_number TEXT,
  variation TEXT,
  sport_game TEXT,
  rarity TEXT,
  image_url TEXT,
  ebay_search_query TEXT
);

CREATE TABLE IF NOT EXISTS portfolio_items (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  catalog_id INT REFERENCES master_catalog(id),
  condition TEXT CHECK (condition IN ('graded','raw')),
  grading_company TEXT,
  grade TEXT,
  cert_number TEXT,
  quantity INT DEFAULT 1,
  purchase_price NUMERIC(10,2),
  purchase_date DATE,
  current_value NUMERIC(10,2),
  active_low NUMERIC(10,2),
  forecast_30d NUMERIC(10,2),
  ximilar_identified BOOLEAN DEFAULT false,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  catalog_id INT REFERENCES master_catalog(id),
  condition TEXT,
  grade TEXT,
  sold_median NUMERIC(10,2),
  active_low NUMERIC(10,2),
  source TEXT CHECK (source IN ('ebay','ximilar','mock')),
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scan_logs (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  scanned_at TIMESTAMPTZ DEFAULT NOW()
);
`;

// Idempotent column migrations (safe to run on every startup)
const alterations = `
DO $$
BEGIN
  -- Rename ximilar_identified → scan_identified
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'portfolio_items' AND column_name = 'ximilar_identified'
  ) THEN
    ALTER TABLE portfolio_items RENAME COLUMN ximilar_identified TO scan_identified;
  END IF;
END $$;

ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS scan_source TEXT;

-- Phase 8: 1/1 item fields
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS is_one_of_one BOOLEAN DEFAULT false;
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS manual_value NUMERIC(10,2);
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS manual_value_set_at TIMESTAMPTZ;

-- Phase 8: comparable sales table (for 1/1 items)
CREATE TABLE IF NOT EXISTS comparable_sales (
  id SERIAL PRIMARY KEY,
  portfolio_item_id INT REFERENCES portfolio_items(id) ON DELETE CASCADE,
  parallel_label TEXT,
  sold_price NUMERIC(10,2),
  sold_date DATE,
  ebay_listing_url TEXT,
  source TEXT DEFAULT 'ebay',
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Expand price_history source constraint to include 'manual'
DO $$
BEGIN
  ALTER TABLE price_history DROP CONSTRAINT IF EXISTS price_history_source_check;
  ALTER TABLE price_history ADD CONSTRAINT price_history_source_check
    CHECK (source IN ('ebay','ximilar','mock','manual'));
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(schema);
    await client.query(alterations);
    console.log('[migrate] Schema up to date.');
  } finally {
    client.release();
  }
}

module.exports = migrate;

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] Failed:', err.message);
      process.exit(1);
    });
}
