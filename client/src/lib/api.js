// Base URL for all API requests.
//
// Local dev:  VITE_API_URL is unset → empty string → Vite's dev-server proxy
//             rewrites /api/* to http://localhost:3001, no change needed.
//
// Production: VITE_API_URL must be set in Vercel to the full Railway backend URL
//             *before* the Vercel build runs (Vite bakes it in at build time).
//             e.g. https://your-app.up.railway.app  (no trailing slash needed).
//
// Usage: fetch(`${API}/api/auth/login`, ...)
export const API = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

// ── Startup diagnostic ────────────────────────────────────────────────────────
// Always visible in the browser console. Confirms whether VITE_API_URL was
// baked into the build or is empty (which means requests go to the Vercel
// origin and will fail with a JSON parse error / "Network error").
console.log(
  '[slabr] VITE_API_URL (raw):', import.meta.env.VITE_API_URL,
  '\n[slabr] API base (resolved):', API || '⚠️  EMPTY — fetches will hit same-origin (Vercel), not Railway!',
);
