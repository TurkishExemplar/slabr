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
  scan_identified BOOLEAN DEFAULT false,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  catalog_id INT REFERENCES master_catalog(id),
  condition TEXT,
  grade TEXT,
  sold_median NUMERIC(10,2),
  active_low NUMERIC(10,2),
  source TEXT CHECK (source IN ('ebay','mock','manual','pricecharting')),
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
  -- Historical migration: early deployments created this column under a
  -- scan-provider-specific name; rename it on DBs that still have it.
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

-- Phase 9: eBay item ID for eBay-sourced catalog entries
ALTER TABLE master_catalog ADD COLUMN IF NOT EXISTS ebay_item_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS master_catalog_ebay_item_id_idx
  ON master_catalog(ebay_item_id)
  WHERE ebay_item_id IS NOT NULL;

-- Valid price sources: pricecharting (market value / sold median),
-- ebay (active-listing floor), manual (owner estimates), mock (seeded data).
-- Legacy 'ximilar' rows (never an integrated price source) become 'mock'
-- so the tightened constraint can apply.
UPDATE price_history SET source = 'mock' WHERE source = 'ximilar';
DO $$
BEGIN
  ALTER TABLE price_history DROP CONSTRAINT IF EXISTS price_history_source_check;
  ALTER TABLE price_history ADD CONSTRAINT price_history_source_check
    CHECK (source IN ('ebay','mock','manual','pricecharting'));
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Phase 12: password reset
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;

-- Phase 13: app_meta key-value store (one-time job markers)
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Phase 15: per-item personalization
-- serial_number: card serial / print run ("23/99", "1/1")
-- custom_image:  user-uploaded photo shown instead of the catalog image,
--                only for this user's portfolio item
-- custom_value:  user-set valuation (manual or most-recent-sale) that
--                overrides current_value for this item only
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS serial_number TEXT;
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS custom_image TEXT;
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS custom_value NUMERIC(12,2);

-- Phase 14: PriceCharting sold listings per grade tier (scraped from the
-- product page's completed-auctions tables; listing_id dedupes re-syncs)
CREATE TABLE IF NOT EXISTS pc_sales (
  id SERIAL PRIMARY KEY,
  catalog_id INT REFERENCES master_catalog(id) ON DELETE CASCADE,
  listing_id TEXT,
  grade_label TEXT,
  sold_date DATE,
  price NUMERIC(12,2),
  title TEXT,
  url TEXT,
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (catalog_id, listing_id)
);
CREATE INDEX IF NOT EXISTS pc_sales_catalog_grade_idx
  ON pc_sales (catalog_id, grade_label, sold_date DESC);

-- Clear bad CDN image_url values so priceSingleItem / refresh-image can re-fetch.
-- NOTE: data: URIs are intentionally preserved — they are scan photos uploaded
-- by the user and should remain until eBay's priceSingleItem replaces them with
-- a CDN URL.  Only clear eBay CDN URLs that contain junk keywords (pack, box, etc.)
-- Safe to run repeatedly — only NULLs rows that still have bad values.
UPDATE master_catalog
SET image_url = NULL
WHERE image_url IS NOT NULL
  AND image_url NOT LIKE 'data:%'
  AND (
    LOWER(image_url) LIKE '%pack%'
    OR LOWER(image_url) LIKE '%/lot/%'
    OR LOWER(image_url) LIKE '%sealed%'
    OR LOWER(image_url) LIKE '%wrapper%'
    OR LOWER(image_url) LIKE '%wax%'
  );
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
