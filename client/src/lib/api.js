// Base URL for all API requests.
//
// Local dev:  VITE_API_URL is unset → empty string → Vite's dev-server proxy
//             rewrites /api/* to http://localhost:3001, no change needed.
//
// Production: VITE_API_URL must be set in Vercel to the full Railway backend URL,
//             e.g. https://your-app.up.railway.app  (no trailing slash needed).
//
// Usage: fetch(`${API}/api/auth/login`, ...)
export const API = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
