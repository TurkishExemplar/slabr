# Slabr

A collectibles portfolio tracker for sports cards, TCG, comics, and sealed boxes.
Track your collection, monitor prices, and share your portfolio publicly.

---

## Features

- **Portfolio dashboard** — total value, cost basis, P&L, value-over-time chart, category breakdown
- **Scan to add** — photograph a card or slab, Claude Vision reads the label and pre-fills the form
- **Manual add** — search the catalog and add items with condition, grade, and purchase details
- **Item detail pages** — price history chart, eBay sold median, active listing low, cert verification links (PSA / BGS / CGC)
- **1-of-1 handling** — owner-estimated values, comparable parallel sales, never overwritten by automated pricing
- **Live eBay pricing** — daily cron job pulls active listing prices via the eBay Browse API
- **Public profiles** — shareable `/profile/:username` pages with collection stats
- **Settings** — update username, email, password, and profile visibility

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express (CJS) |
| Database | PostgreSQL (via `pg` pool) |
| Auth | JWT (`jsonwebtoken`), bcrypt (`bcryptjs`) |
| Scheduling | `node-cron` |
| Card identification | Anthropic Claude Vision (`claude-opus-4-8`) |
| Market data | eBay Browse API + Marketplace Insights API (OAuth 2.0 client credentials) |
| Frontend | React 18, React Router v7, Vite |
| Styling | Tailwind CSS |
| Charts | Recharts |

---

## Local Setup

### Prerequisites

- Node.js 18+
- PostgreSQL 14+ (running locally or via Docker)
- npm

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd Slabr
npm install          # root (if any shared deps)
cd server && npm install
cd ../client && npm install
```

### 2. Create the database

```bash
# Docker (quickest)
docker run -d \
  --name slabr-postgres \
  -e POSTGRES_USER=slabr \
  -e POSTGRES_PASSWORD=slabr \
  -e POSTGRES_DB=slabr \
  -p 5432:5432 \
  postgres:16

# Or use an existing PostgreSQL instance and create the database manually:
# CREATE DATABASE slabr;
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in at minimum:

```env
DATABASE_URL=postgresql://slabr:slabr@localhost:5432/slabr
JWT_SECRET=your-random-secret-minimum-32-characters
```

All other variables are optional — their features degrade gracefully when unset.

### 4. Start the backend

```bash
cd server
npm run dev        # nodemon, auto-restarts on changes
# or: npm start    # plain node
```

On first start the server auto-runs migrations (creates all tables) and seeds 24+ catalog items with mock pricing data. You will see:

```
[migrate] Schema up to date.
[seed] 24 catalog items already present, skipping.
Slabr server running on http://localhost:3001
```

### 5. Start the frontend

```bash
cd client
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The Vite dev server proxies all `/api` requests to `http://localhost:3001`.

### 6. Sign up

Visit `/signup` and create an account. The seeded catalog has 24 items across all four categories ready to add.

---

## Environment Variables

All variables are read from a `.env` file at the project root. Copy `.env.example` to get started.

### Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Example: `postgresql://user:pass@localhost:5432/slabr` |
| `JWT_SECRET` | Secret used to sign JWTs. Use at least 32 random characters. |

### Optional — server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Port the Express server listens on |
| `CLIENT_URL` | `http://localhost:3000` | CORS allowed origin (set to your frontend URL in production) |

### Optional — Claude Vision scan-to-add

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | From [console.anthropic.com](https://console.anthropic.com). Enables the Scan tab — photographing a card auto-identifies it via Claude Vision. Without this key the scan endpoint returns `{ error: "Scan unavailable", fallback: "search" }` and the UI falls back to manual search. |

### Optional — eBay market data

| Variable | Description |
|---|---|
| `EBAY_APP_ID` | Client ID from the [eBay Developer Program](https://developer.ebay.com) production keyset. Required to enable live pricing. Without this key the eBay cron job skips silently. |
| `EBAY_CERT_ID` | Client Secret (Cert ID) from the same production keyset. Required alongside `EBAY_APP_ID` for OAuth 2.0 token requests. |
| `EBAY_ENV` | `production` (default) or `sandbox`. Use `sandbox` during development with sandbox API keys. |

> **Note on sold prices:** The eBay Marketplace Insights API (`buy.marketplace.insights`) is a beta scope that requires separate approval from the eBay Developer Program. Until approved, `sold_median` will be `null` and the job will still populate `active_low` from the Browse API. Once approved, sold medians populate automatically — no code changes needed.

---

## Running the eBay Price Job Manually

The job runs automatically every day at 3:00 AM when `EBAY_APP_ID` is set. To trigger it on demand:

```bash
# 1. Get a JWT token (log in via the API)
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com","password":"yourpassword"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# 2. Trigger the job
curl -s http://localhost:3001/api/admin/ebay-job \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expected response:

```json
{
  "ok": true,
  "updated": 9,
  "errors": 0,
  "skippedOneOfOne": 0,
  "elapsed": "14.6"
}
```

The job processes each unique `(catalog_id, condition, grade)` combination across all portfolio items, updates `portfolio_items.active_low`, and writes a row to `price_history` with `source = 'ebay'`.

---

## Project Structure

```
Slabr/
├── .env                  # Local secrets — never committed
├── .env.example          # Template for all environment variables
├── PHASES.md             # Build phase tracker and feature spec
│
├── server/
│   └── src/
│       ├── index.js          # Express app, cron setup, route registration
│       ├── db.js             # pg Pool
│       ├── migrate.js        # Idempotent schema migrations (runs on startup)
│       ├── seed.js           # Catalog seed data (runs on startup, idempotent)
│       ├── middleware/
│       │   └── auth.js       # JWT verification middleware
│       ├── routes/
│       │   ├── auth.js       # POST /auth/signup, /auth/login, GET /auth/me
│       │   ├── portfolio.js  # CRUD for portfolio items + price history
│       │   ├── catalog.js    # GET /catalog/search
│       │   ├── scan.js       # POST /scan — Claude Vision card identification
│       │   ├── users.js      # Public profiles + settings
│       │   └── admin.js      # GET /admin/ebay-job (manual trigger)
│       └── jobs/
│           └── ebay.js       # eBay Browse API + Marketplace Insights job
│
└── client/
    └── src/
        ├── App.jsx           # Route definitions
        ├── context/
        │   └── AuthContext.jsx
        └── pages/
            ├── Dashboard.jsx
            ├── Item.jsx        # Item detail with price chart
            ├── Add.jsx         # Search + Scan tabs
            ├── Profile.jsx     # Public profile pages
            ├── Settings.jsx    # Account settings
            ├── Login.jsx
            └── Signup.jsx
```

---

## Database Schema

```sql
users                  — accounts (email, username, password_hash, is_public)
master_catalog         — canonical item catalog (sports cards, TCG, comics, sealed)
portfolio_items        — items in a user's collection (linked to catalog)
price_history          — time-series pricing (source: 'ebay' | 'mock' | 'manual')
comparable_sales       — parallel card sales for 1-of-1 items (source: 'ebay')
```

---

## Pricing Logic

Prices are resolved in priority order:

1. **eBay sold median** (`source = 'ebay'`) — populated by the daily cron job
2. **Owner estimated** (`source = 'manual'`) — used for 1-of-1 items; never overwritten by automation
3. **Mock seed value** (`source = 'mock'`) — present from day one so the dashboard renders immediately

**1-of-1 rule:** If `portfolio_items.is_one_of_one = true`, no automated job will ever overwrite `current_value`. The eBay job still tracks active listings and comparable parallel sales for reference.
