# Slabr — Build Phases

This file is the source of truth for how Slabr is built. Work through phases in order.
**Complete each phase fully and confirm the app runs before starting the next one.**

---

## Ground Rules

- The app must be runnable after every phase using only `DATABASE_URL` and `JWT_SECRET`
- All other env vars are optional — their features must degrade gracefully when missing
- Never break a previously working phase
- Catch all API errors and return clean JSON responses
- Keep a `.env.example` updated with every env var added, with descriptions
- Dark mode by default — ALT.xyz meets Collectr aesthetic

---

## Phase Tracker

| Phase | Name                        | Status      | Env Vars Required                        |
|-------|-----------------------------|-------------|------------------------------------------|
| 1     | Project Setup & Database    | [x] Complete    | `DATABASE_URL`                       |
| 2     | Auth                        | [x] Complete    | `DATABASE_URL`, `JWT_SECRET`         |
| 3     | Portfolio API & Dashboard   | [x] Complete    | same as above                        |
| 4     | Manual Add Flow             | [x] Complete    | same as above                        |
| 5     | Claude Vision Scan-to-Add   | [x] Complete    | + `ANTHROPIC_API_KEY`                |
| 6     | Item Detail Page            | [x] Complete    | same as above                        |
| 7     | Public Profiles & Settings  | [x] Complete    | same as above                        |
| 8     | eBay Market Data Engine     | [x] Complete    | + `EBAY_APP_ID`, `EBAY_CERT_ID`, `EBAY_ENV` |

Update `[ ]` to `[x]` as each phase is completed.

---

## Phase 1 — Project Setup & Database

**Goal:** Runnable project with database connected and seeded.

### Tasks
- [ ] Initialize `server/` as Node.js + Express project
- [ ] Initialize `client/` as React + Tailwind project
- [ ] Connect to PostgreSQL via `DATABASE_URL`
- [ ] Run all migrations (see schema below)
- [ ] Seed 20+ catalog items across all four categories with mock prices
- [ ] `GET /api/health` returns `{ status: "ok" }`
- [ ] Write `.env.example`

### Schema

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  is_public BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE master_catalog (
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

CREATE TABLE portfolio_items (
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
  -- 1/1 fields
  is_one_of_one BOOLEAN DEFAULT false,
  manual_value NUMERIC(10,2),
  manual_value_set_at TIMESTAMPTZ,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE price_history (
  id SERIAL PRIMARY KEY,
  catalog_id INT REFERENCES master_catalog(id),
  condition TEXT,
  grade TEXT,
  sold_median NUMERIC(10,2),
  active_low NUMERIC(10,2),
  source TEXT CHECK (source IN ('ebay','mock','manual')),
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Stores comparable parallel sales for 1/1 items
-- e.g. the /5, /10, /25 versions of the same card for reference pricing
CREATE TABLE comparable_sales (
  id SERIAL PRIMARY KEY,
  portfolio_item_id INT REFERENCES portfolio_items(id) ON DELETE CASCADE,
  parallel_label TEXT,        -- e.g. "/5 Superfractor", "/10 Gold", "/25 Red"
  sold_price NUMERIC(10,2),
  sold_date DATE,
  ebay_listing_url TEXT,
  source TEXT DEFAULT 'ebay',
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Seed Data Requirements
Include at least:
- 5 sports cards (mix of baseball, basketball, football)
- 5 TCG cards (mix of Pokémon, MTG, One Piece)
- 5 comics (mix of Marvel, DC, key issues)
- 5 sealed boxes (mix of hobby, blaster, booster)
- 1 item seeded as a 1/1 (e.g. a Superfractor or printing plate) with `is_one_of_one: true` and a `manual_value` set, so the 1/1 UI path is testable from day one
- All seeded items get a mock `current_value` so the dashboard renders immediately

### Done When
- `GET /api/health` returns 200
- Database has all four tables
- Seed data is present and queryable

---

## Phase 2 — Auth

**Goal:** Users can sign up, log in, and stay logged in.

### Tasks
- [ ] `POST /api/auth/signup` — validate email/password/username, hash password, return JWT
- [ ] `POST /api/auth/login` — verify credentials, return JWT
- [ ] `GET /api/auth/me` — return current user from JWT (protected)
- [ ] `authMiddleware` — verify JWT, attach user to `req.user`, return 401 if invalid
- [ ] Apply `authMiddleware` to all `/api/portfolio/*` routes
- [ ] React auth context — stores token in memory, exposes `user`, `login()`, `logout()`
- [ ] `/login` page — email + password form, redirects to `/dashboard` on success
- [ ] `/signup` page — email + password + username form, redirects to `/dashboard` on success
- [ ] Protected route wrapper — redirects to `/login` if not authenticated

### Done When
- New user can sign up and be redirected to dashboard
- Existing user can log in
- Visiting `/dashboard` while logged out redirects to `/login`
- `GET /api/auth/me` returns user data with valid token, 401 without

---

## Phase 3 — Portfolio API & Dashboard

**Goal:** Logged-in users see their portfolio with stats and charts.

### API Routes
- [ ] `GET /api/portfolio` — return all portfolio items for current user, joined with catalog data
- [ ] `POST /api/portfolio` — add item to portfolio
- [ ] `PUT /api/portfolio/:id` — update item fields
- [ ] `DELETE /api/portfolio/:id` — remove item
- [ ] `GET /api/catalog/search?q=` — search master_catalog, return top 10 matches

### Dashboard (`/dashboard`)
- [ ] Total portfolio value (sum of `current_value * quantity`)
- [ ] Total cost basis (sum of `purchase_price * quantity`)
- [ ] Profit/loss in dollars and percentage
- [ ] Portfolio value over time — line chart (Recharts), uses price_history
- [ ] Category breakdown — pie chart (Recharts)
- [ ] Collection grid — one card per portfolio item showing:
  - Item image
  - Name, set, year
  - Grade + grading company badge (if graded)
  - Current value
  - Cost basis
  - Gain/loss with color (green/red)
  - Last updated timestamp
- [ ] Filter bar: All / Sports / TCG / Comics / Sealed
- [ ] Graded / Raw toggle filter

### Pricing Source Priority (enforced from day one)
```
1. eBay sold median     (source = 'ebay')      ← Phase 8, not live yet
2. Manual value         (source = 'manual')    ← used for 1/1 items always
3. Mock seeded value    (source = 'mock')       ← active now
```
Build the logic now even though only sources 2 and 3 are active. When Phase 8 runs, eBay slots in as the primary source automatically.

**Special rule:** If `is_one_of_one = true`, NEVER overwrite `current_value` from eBay or any automated job — manual_value is always the source of truth for 1/1 items. eBay job still runs for active listing monitoring and comparable sales only.

### Done When
- Dashboard loads with seeded mock data
- Stats are calculated correctly
- Both charts render
- Filters work
- No crashes on empty portfolio

---

## Phase 4 — Manual Add Flow

**Goal:** Users can search the catalog and add items to their portfolio.

### Tasks
- [ ] `/add` page with two tabs: **Search** (active) and **Scan** (placeholder)
- [ ] Search tab: input hits `GET /api/catalog/search?q=`, shows results list
- [ ] Result item shows: name, set, year, item_type badge
- [ ] Clicking a result opens a slide-in / modal form pre-filled with item details
- [ ] Form fields: condition (graded/raw), grading company, grade, quantity, purchase price, purchase date
- [ ] Grading company + grade fields only appear when condition = "graded"
- [ ] If card_number contains `"1/1"`, `"#1/1"`, `"Superfractor"`, `"Printing Plate"`, or `"One of One"` → auto-check `is_one_of_one` and show manual value field instead of relying on automated pricing
- [ ] Submit calls `POST /api/portfolio`, closes form, redirects to dashboard
- [ ] Scan tab: placeholder card — "Scan Coming Soon — use Search for now"
- [ ] Empty state on dashboard: prompt to add first item with link to `/add`

### Done When
- User can search catalog, select a result, fill the form, and see the item on their dashboard
- Form validates required fields before submitting
- Scan tab is visible but clearly marked as placeholder

---

## Phase 5 — Claude Vision Scan-to-Add

**Goal:** Users can photograph a card or slab and have it auto-identified and added.

> **Note:** Originally designed around Ximilar Collectibles Recognition API. Switched to Claude Vision
> (`claude-opus-4-8`) because Ximilar's Collectibles API requires a separate subscription beyond
> standard API credits. Claude Vision reads slab labels directly from the image and returns structured
> JSON — no external dependency, more reliable, and simpler to maintain.

### Env Var
```
ANTHROPIC_API_KEY=        # From console.anthropic.com — used for card/slab identification via Claude Vision
```

### Backend
- [x] `POST /api/scan` — accepts `{ image_base64, item_type? }`
- [x] Send image to Claude Vision (`claude-opus-4-8`) with structured JSON prompt
- [x] Claude reads label text and returns: name, set_name, year, card_number, sport_game, rarity,
      condition, grading_company, grade, cert_number, confidence
- [x] If `ANTHROPIC_API_KEY` is not set → return `{ error: "Scan unavailable", fallback: "search" }`
- [x] If Claude returns `is_collectible: false` or confidence < 0.4 → return `{ match: false }`
- [x] Auto-resolve or create `master_catalog` entry from identified fields
- [x] If Claude Vision response indicates card number is `"1/1"`, `"#1/1"`, `"Superfractor"`, `"Printing Plate"`, or `"One of One"` → set `is_one_of_one: true` in the mapped response
- [x] `current_value` and `forecast_30d` are null until Phase 8 (eBay pricing)

### Frontend — Scan Tab
- [x] Camera capture button (uses `<input type="file" accept="image/*" capture="environment">`)
- [x] File upload fallback
- [x] Item type selector: Sports / TCG / Comics / Auto-detect
- [x] Loading state while scan is in progress
- [x] On success: show identified card preview with all fields pre-filled and editable
  - Show confidence indicator (High / Medium / Low based on confidence score)
- [x] On failure / low confidence: show "Couldn't identify this item" with auto-switch to Search tab
- [x] Confirm button → calls `POST /api/portfolio`, saves with `ximilar_identified: true`
- [x] Scan tab no longer shows placeholder

### Pricing
- `current_value` and `forecast_30d` remain null until Phase 8 (eBay market data)
- Price history rows with `source = 'ximilar'` are no longer written; eBay will be the live source

### Done When
- User can photograph a card and have it identified via Claude Vision
- Form pre-fills from scan result
- Low confidence gracefully falls back to search
- Works without ANTHROPIC_API_KEY set (returns fallback message, scan tab shows "unavailable" state)

---

## Phase 6 — Item Detail Page

**Goal:** Each item has a dedicated page with full data and price history.

### Tasks
- [ ] `/item/:id` page — loads single portfolio item + price history
- [ ] Display: large image, name, set, year, card number, variation, sport/game
- [ ] Condition badge — "PSA 10", "BGS 9.5", "Raw", etc.
- [ ] Current value, cost basis, profit/loss
- [ ] Price history line chart (Recharts) with 30-day / 90-day / All toggle
  - Uses price_history table — renders whatever data exists (mock, ximilar, or ebay)
- [ ] 30-day forecast badge — shows `forecast_30d` value with an up/down indicator
- [ ] Active low price row — label "Active Listings" with real value if available, "—" if not
- [ ] Sold median row — label "Sold Median" with real value if available, "—" if not
- [ ] Pricing source badge:
  - "Mock Data" → gray
  - "Powered by Ximilar" → blue
  - "Powered by eBay" → green (Phase 8)
- [ ] If graded + cert_number exists → "Verify Cert" button linking to:
  - PSA: `https://www.psacard.com/cert/{cert_number}`
  - BGS: `https://www.beckett.com/grading/verify`
  - CGC: `https://www.cgccomics.com/certlookup/{cert_number}`
- [ ] Edit button → opens same form as add flow pre-filled with current values
- [ ] Delete button with confirmation → removes item, redirects to dashboard
- [ ] Clicking item card on dashboard navigates to this page

### 1/1 Item Detail — Special Treatment
If `is_one_of_one = true`, the item detail page renders a distinct layout:

- [ ] Gold holographic **"1 of 1"** badge displayed prominently at the top of the card
- [ ] Replace the standard "Current Value" block with an **"Owner Estimated Value"** block
  - Shows `manual_value` with an "Owner Estimated" sub-label
  - Inline edit button — clicking opens an input to update the value in place
  - Saving calls `PUT /api/portfolio/:id` with new `manual_value` and sets `manual_value_set_at`
  - Inserts a new `price_history` row with `source = 'manual'`
- [ ] Hide the 30-day forecast badge (no forecast data for unique items)
- [ ] Hide the "Sold Median" row — replace with note: *"No sold comps — this is a 1 of 1"*
- [ ] Keep "Active Listings" row — shows real eBay BIN price if one exists (Phase 8), otherwise "—"
- [ ] **Comparable Sales section** below the price block:
  - Header: "Comparable Parallel Sales"
  - Sub-header: "Reference prices from lower-numbered parallels of this card"
  - Table: parallel label, sold price, sold date (from `comparable_sales` table)
  - Empty state: "No comparable sales data yet — check back after the next price update"
  - Populated by Phase 8 eBay job
- [ ] Price history chart still renders — shows manual value updates over time as data points

### Done When
- Every item in portfolio has a working detail page
- Price chart renders with available data
- Cert lookup links work for graded items
- Edit and delete work correctly

---

## Phase 7 — Public Profiles & Settings

**Goal:** Users have shareable profile pages and can manage their account.

### Tasks

**Profile Page (`/profile/:username`)**
- [ ] Fetch user by username — if `is_public: false`, show "This collection is private"
- [ ] Public view shows:
  - Username + join date
  - Stats: total items, total portfolio value, number of graded vs raw
  - Collection grid (same component as dashboard, read-only)
  - Category breakdown badge row
- [ ] Own profile shows an "Edit Profile" link

**Settings Page (`/settings`)**
- [ ] Toggle public/private profile (calls `PUT /api/users/me`)
- [ ] Update username (validates uniqueness)
- [ ] Update email
- [ ] Change password (requires current password)
- [ ] Account stats: member since, total items, total scans performed

**API Routes**
- [ ] `GET /api/users/:username` — public profile data
- [ ] `PUT /api/users/me` — update profile fields (protected)
- [ ] `PUT /api/users/me/password` — change password (protected)

### Done When
- Public profiles are viewable without login
- Private profiles show the private message
- Settings page saves changes correctly

---

## Phase 8 — eBay Market Data Engine

> **Skip this phase until eBay Developer API access is approved.**
> The app is fully functional through Phase 7 without it.
> All pricing shows as "—" until this phase runs.

### Env Vars
```
EBAY_APP_ID=              # From eBay Developer Program production keyset
EBAY_ENV=production       # or 'sandbox' for testing
```

### Background Job (node-cron)
- [ ] Runs every 24 hours at 3:00 AM
- [ ] Only runs if `EBAY_APP_ID` is set — otherwise skips silently and logs "eBay job skipped: no API key"
- [ ] For each unique `(catalog_id, condition, grade)` across all portfolio items:
  1. Build search query from catalog fields
     - Sports: `"{name} {year} {set_name} {grade} {sport_game}"`
     - TCG: `"{name} {set_name} {card_number} {grade}"`
     - Comics: `"Comics {name} #{card_number} {brand_publisher} {grade}"`
     - Sealed: `"{name} {year} {sport_game} {box_type} sealed"`
  2. `findCompletedItems` with `soldItemsOnly=true` → last 15 sold prices
     - Strip top 10% and bottom 10% outliers
     - Store median as sold_median
  3. `findItemsAdvanced` with `listingType=FixedPrice` → store lowest BIN as active_low
  4. Update `portfolio_items.current_value` and `active_low` for all users with this combo
  5. Insert row in `price_history` with `source = 'ebay'`
  6. Log: item name, new value, previous value, timestamp

### Pricing Source Update
Once eBay job runs for an item, it becomes the primary source:
```
eBay sold median   → portfolio_items.current_value
eBay active low    → portfolio_items.active_low
```
Mock values remain in price_history for historical chart continuity.

### 1/1 Item Handling in eBay Job
For items where `is_one_of_one = true`, the job runs a modified flow:

- [ ] **Skip** `findCompletedItems` — no sold comps exist for a unique card
- [ ] **Run** `findItemsAdvanced` as normal — if it's ever listed, surface the active price
- [ ] **Run comparable sales fetch** — search for the same card in lower-numbered parallels:
  - Build queries for `/5`, `/10`, `/25`, `/50` versions of the same card
  - For each: pull the most recent sold listing (one result is enough)
  - Insert into `comparable_sales` table with `parallel_label`, `sold_price`, `sold_date`
- [ ] **Never overwrite** `portfolio_items.current_value` — `manual_value` is always the source of truth for 1/1s
- [ ] Log: `"1/1 item skipped for sold median — comparable sales updated"`

### Frontend Updates (in this phase only)
- [ ] Replace "—" on item detail page active listings row with real eBay active low
- [ ] Replace "—" on item detail page sold median row with real eBay sold median
- [ ] Update pricing source badge to "Powered by eBay" once eBay data exists for that item
- [ ] Add "Sold on eBay" and "Listed on eBay" sub-labels to the two price rows
- [ ] Dashboard "last updated" timestamps now reflect eBay job run time
- [ ] 1/1 items: populate the Comparable Sales section on item detail page

### API Route
- [ ] `GET /api/admin/ebay-job` (protected, admin only) — manually trigger the eBay price fetch job for testing

### Done When
- Cron job runs on schedule when `EBAY_APP_ID` is present
- Portfolio values update after job runs
- Item detail pages show real eBay sold median and active low
- App still works normally if `EBAY_APP_ID` is missing

---

## Environment Variables Reference

```env
# Required always
DATABASE_URL=              # PostgreSQL connection string
JWT_SECRET=                # Secret for signing JWTs (min 32 chars)

# Required for Phase 5 (scan-to-add)
ANTHROPIC_API_KEY=         # From console.anthropic.com — Claude Vision card/slab identification

# Required for Phase 8 (eBay pricing)
EBAY_APP_ID=               # eBay Developer Program production App ID / Client ID
EBAY_ENV=production        # 'production' or 'sandbox'

# Optional
PORT=3001                  # Backend port (default 3001)
CLIENT_URL=http://localhost:3000  # For CORS config
```

---

## Feature Availability by Phase

| Feature                                       | Available From |
|-----------------------------------------------|----------------|
| View seeded catalog items                     | Phase 1        |
| Sign up / Log in                              | Phase 2        |
| Portfolio dashboard                           | Phase 3        |
| 1/1 manual valuation                          | Phase 3        |
| Search and add items manually                 | Phase 4        |
| 1/1 auto-detection on add                     | Phase 4        |
| Scan to add via Claude Vision                 | Phase 5        |
| 1/1 detection via scan                        | Phase 5        |
| Item detail + price history                   | Phase 6        |
| 1/1 special detail page + comparable sales UI | Phase 6        |
| Public profile pages                          | Phase 7        |
| Live eBay sold + active prices                | Phase 8        |
| 1/1 comparable parallel sales                 | Phase 8        |

---

## Notes for Claude Code

- Always check which phase is currently active before writing new code
- When adding a new route or component, check if a similar one already exists first
- Run `npm run dev` (or equivalent) after each major change to confirm nothing is broken
- If a phase requires an external API that isn't configured, the feature should fail gracefully with a clear message — never a crash
- Commit-worthy checkpoint = phase complete + app runs + previous phases still work
- **1/1 rule:** `is_one_of_one = true` items must NEVER have their `current_value` overwritten by any automated job — `manual_value` is always the source of truth. Enforce this check in the eBay job and any future pricing update path.
