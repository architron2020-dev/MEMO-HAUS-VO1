// Runtime backend origin for the Memo-House frontend.
//
// The static site (upload / viewer / memories pages) is served from GitHub
// Pages, but the data plane (SHARP inference, splats, photos, audio) runs on a
// separate backend. Point this at that backend's public origin — the scheme +
// host (+ port), with NO trailing path and NO trailing slash.
//
// Examples:
//   window.MEMO_API_BASE = "https://memo-backend.example.com";
//   window.MEMO_API_BASE = "https://abcd-1-2-3-4.trycloudflare.com";
//
// Leave it empty ("") for local `npm run dev`, where the Vite proxy serves the
// backend on the same origin. You can edit this file on the deployed site to
// swap backends without rebuilding.
window.MEMO_API_BASE = "";
