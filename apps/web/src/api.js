// Central backend-origin resolution + a global fetch shim.
//
// This frontend is served as a static site (GitHub Pages), but its data plane
// — SHARP inference, scene store, splats, photos, audio — lives on a separate
// backend. Every page talks to that backend through absolute paths under
// /api, /outputs, /uploads and /audio. Locally those resolve same-origin via
// the Vite proxy; online they must be rerouted to the backend's own origin.
//
// Base precedence:
//   1. window.MEMO_API_BASE  — set by public/runtime-config.js, editable on the
//      deployed site without a rebuild (handy at an event / kiosk).
//   2. import.meta.env.VITE_MEMO_API_BASE — baked in at build time.
//   3. ""  — same origin, which is exactly what `npm run dev` needs (Vite proxy).

const RAW_BASE =
  (typeof window !== "undefined" && window.MEMO_API_BASE) ||
  import.meta.env.VITE_MEMO_API_BASE ||
  "";

// Strip any trailing slash so `${API_BASE}${path}` never doubles it.
export const API_BASE = String(RAW_BASE).replace(/\/+$/, "");

// True when the data plane is on a different origin than the page.
export const API_IS_REMOTE = API_BASE !== "";

// Path prefixes the backend owns. A request starting with one of these is a
// data-plane call that must hit the backend, not the static host.
const BACKEND_PREFIXES = ["/api", "/outputs", "/uploads", "/audio"];

function isBackendPath(p) {
  return (
    typeof p === "string" &&
    BACKEND_PREFIXES.some(
      (pre) => p === pre || p.startsWith(pre + "/") || p.startsWith(pre + "?"),
    )
  );
}

// Reroute a backend-owned path onto the configured backend origin. Anything
// else (blob:, data:, http(s):, static assets) is returned untouched, so it's
// safe to wrap element `.src`/`background-image` values that may or may not be
// backend paths.
export function apiUrl(path) {
  if (!API_BASE) return path;
  return isBackendPath(path) ? API_BASE + path : path;
}

// When the backend is a different origin, images whose pixels we read back
// (canvas colour extraction) must load in CORS mode or the canvas is tainted.
// The backend already sends `Access-Control-Allow-Origin: *`, so this is safe.
export const CROSS_ORIGIN = API_IS_REMOTE ? "anonymous" : null;

// Global fetch shim: transparently reroute backend paths so the ~30 existing
// `fetch("/api/...")` call sites need no edits. Installed once.
if (
  API_IS_REMOTE &&
  typeof window !== "undefined" &&
  !window.__memoFetchPatched
) {
  window.__memoFetchPatched = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === "string") return orig(apiUrl(input), init);
    if (input instanceof Request) {
      const u = new URL(input.url, window.location.href);
      if (u.origin === window.location.origin && isBackendPath(u.pathname)) {
        return orig(new Request(API_BASE + u.pathname + u.search, input), init);
      }
    }
    return orig(input, init);
  };
}
