import "./viewer.css";
import * as THREE from "three";
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import { parseSplatPly } from "./ply-parser.js";

const viewerEl      = document.getElementById("viewer");
const placeholderEl   = document.getElementById("placeholder");
const splashStatusEl  = document.getElementById("splash-status");
const splashCountEl   = document.getElementById("splash-count");
const overlayEl     = document.getElementById("transition-overlay");
const hudEl         = document.getElementById("scene-hud");
const captionNameEl = document.getElementById("caption-name");
const captionAuthEl = document.getElementById("caption-author");
const captionYearEl = document.getElementById("caption-year");
const captionStoryEl = document.getElementById("caption-story");
const captionClusterEl = document.getElementById("caption-cluster");
const authorRowEl   = document.getElementById("author-row");
const yearRowEl     = document.getElementById("year-row");
const clusterRowEl  = document.getElementById("cluster-row");
const storyRowEl    = document.getElementById("story-row");
const connectionEl  = document.getElementById("connection");
const loaderEl           = document.getElementById("processing-loader");
const timerArcEl         = document.getElementById("timer-arc");
const storyOverlayEl     = document.getElementById("story-overlay");
const overlayStoryTextEl = document.getElementById("overlay-story-text");
// sceneAudioEl kept in DOM but audio is now routed through Web Audio for spatialization
const sceneAudioEl       = document.getElementById("scene-audio");
const cursorReticleEl    = document.getElementById("cursor-reticle");

// ── Debug helpers ─────────────────────────────────────────────────────────
// ?limit=N in the URL loads only the first N memories into the world instead
// of all of them, and flies the camera straight to the loaded scene instead
// of parking at the overview — useful for isolating whether a viewer problem
// is caused by scene count/size (each PLY here is ~66MB) vs. something else.
const _urlParams  = new URLSearchParams(location.search);
const DEBUG_LIMIT = _urlParams.has("limit") ? parseInt(_urlParams.get("limit"), 10) : null;
console.log("[viewer] boot", { url: location.href, debugLimit: DEBUG_LIMIT });

window.addEventListener("error", e => {
  console.error("[viewer] window error:", e.message, e.error || e);
});
window.addEventListener("unhandledrejection", e => {
  console.error("[viewer] unhandled promise rejection:", e.reason);
});

// ── Spatial audio ─────────────────────────────────────────────────────────
// Uses the Web Audio API PannerNode so volume fades with distance and the
// stereo pan tracks which direction each scene is relative to where the
// camera is pointing — moving toward a memory makes it louder and centered,
// turning your head left/right shifts it in the headphones / speakers.

let _audioCtx = null;
const _audioBufferCache = new Map(); // url → Promise<AudioBuffer>
// sceneId → { source, panner, gainNode, worldPos }
const _activeSources = new Map();

function getAudioCtx() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _audioCtx;
}

// Resume the context on any user gesture so audio can start on mobile.
document.addEventListener("pointerdown", () => {
  if (_audioCtx && _audioCtx.state === "suspended") _audioCtx.resume().catch(() => {});
}, { passive: true });

function _fetchAudioBuffer(url) {
  if (_audioBufferCache.has(url)) return _audioBufferCache.get(url);
  const p = fetch(url)
    .then(r => r.arrayBuffer())
    .then(ab => getAudioCtx().decodeAudioData(ab))
    .catch(err => { console.error("Audio decode error:", err); return null; });
  _audioBufferCache.set(url, p);
  return p;
}

function stopSceneAudio(sceneId) {
  const entry = _activeSources.get(sceneId);
  if (!entry) return;
  try { entry.source.stop(); } catch {}
  try { entry.gainNode.disconnect(); } catch {}
  try { entry.stereoPanner.disconnect(); } catch {}
  _activeSources.delete(sceneId);
}

function stopAllAudio() {
  for (const id of [..._activeSources.keys()]) stopSceneAudio(id);
  sceneAudioEl.pause();
}

async function playSceneAudio(scene, worldPos) {
  if (!scene.audio_url) return;
  stopSceneAudio(scene.id);

  const ctx = getAudioCtx();
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});

  const buf = await _fetchAudioBuffer(scene.audio_url);
  if (!buf) return;

  // GainNode — distance-based volume, driven per-frame by updateSpatialAudio().
  const gainNode = ctx.createGain();
  gainNode.gain.value = 1.0;

  // StereoPannerNode — L/R panning driven per-frame by projecting the source
  // direction onto the camera's right vector, so it tracks gyro and look turns.
  const stereoPanner = ctx.createStereoPanner();
  stereoPanner.pan.value = 0;

  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.loop   = true;
  source.connect(gainNode);
  gainNode.connect(stereoPanner);
  stereoPanner.connect(ctx.destination);
  source.start();

  _activeSources.set(scene.id, { source, gainNode, stereoPanner, worldPos: [...worldPos] });
}

// ── Per-frame spatial audio update ────────────────────────────────────────
// Updates listener orientation for L/R pan AND manually drives each source's
// gain based on distance — this is what makes audio louder when you approach
// and quieter as you walk away, for every audio type.

const AUDIO_REF_DIST = 4;   // within this distance: full volume
const AUDIO_MAX_DIST = 30;  // beyond this: essentially silent
const AUDIO_SMOOTH   = 0.18; // gentle ramp so cross-fades feel seamless

function updateSpatialAudio() {
  const cam = viewer?.camera;
  if (!_audioCtx || !cam) return;
  if (_audioCtx.state === "suspended") { _audioCtx.resume().catch(() => {}); return; }

  const { x, y, z } = cam.position;
  const m = cam.matrixWorld.elements;
  // Camera right vector (column 0 of world matrix) — the key for L/R panning.
  // dot(dir_to_source, rightVec) > 0 means source is to the right → pan right.
  const rightX = m[0], rightY = m[1], rightZ = m[2];

  const now = _audioCtx.currentTime;
  for (const { gainNode, stereoPanner, worldPos } of _activeSources.values()) {
    const dx = worldPos[0] - x;
    const dy = worldPos[1] - y;
    const dz = worldPos[2] - z;
    const dist = Math.hypot(dx, dy, dz) || 0.001;

    // Distance gain: inverse-power curve, full within REF_DIST, ~0 at MAX_DIST
    const clamped = Math.max(AUDIO_REF_DIST, Math.min(dist, AUDIO_MAX_DIST));
    gainNode.gain.setTargetAtTime(Math.pow(AUDIO_REF_DIST / clamped, 1.6), now, AUDIO_SMOOTH);

    // L/R stereo pan: project source direction onto camera right axis.
    // Responds directly to gyro yaw and look-joystick turns from mobile.
    const pan = Math.max(-1, Math.min(1,
      (dx / dist) * rightX + (dy / dist) * rightY + (dz / dist) * rightZ
    ));
    stereoPanner.pan.setTargetAtTime(pan, now, AUDIO_SMOOTH);
  }
}


const DWELL_MS        = 60_000;
const WORLD_DWELL_MS  = 60_000; // time on each memory before auto-advancing
const POLL_INTERVAL   = 4_000;
const STATUS_INTERVAL = 3_000;
const OVERLAY_FADE_MS = 480;
const ERROR_SHOW_MS   = 4_000;
const TIMER_C         = 100.53; // 2π × 16

const INIT_POS    = [0, 0, -3];   // must match initialCameraPosition
const INIT_TARGET = [0, 0, 1];    // must match initialCameraLookAt

let viewer        = null;
let scenes        = [];
let currentIndex  = -1;
let activeSceneId = null;
let started       = false;
let errorTimer    = null;
let resetRaf      = null;
let storyOverlayTimer = null;

// ── World of Memories ─────────────────────────────────────────────────────

let worldMode = false;
let worldScenes    = [];  // scenes currently in Memory Verse (may be a subset)
let worldLoadedOrder = []; // scene ids ordered by viewer scene index
let worldFocusedId = null; // which scene's audio is currently active
const serverPositions = new Map(); // scene_id → {x_pct, y_pct} from /api/scene-positions

const WORLD_SPACING = 55;  // fallback gap between scene CENTERS (used only when extents unknown)
const SCENE_GAP     = 14;  // minimum gap between scene EDGES in world units
const worldPositions = new Map(); // scene id → [x, y, z]
// scene id → { xSpan, zSpan } — measured from PLY before placement
const sceneExtents   = new Map();

// Light PLY parse (8 k sample) → X and Z extents of the gaussian cloud.
// Uses the 5th–95th percentile to ignore stray outlier splats.
async function measureSplatExtent(scene) {
  if (sceneExtents.has(scene.id)) return sceneExtents.get(scene.id);
  try {
    const data = await parseSplatPly(scene.ply_url, 8000);
    if (!data || data.count < 4) return null;
    const xs = [], zs = [];
    for (let i = 0; i < data.count; i++) {
      xs.push(data.positions[i * 3]);
      zs.push(data.positions[i * 3 + 2]);
    }
    xs.sort((a, b) => a - b);
    zs.sort((a, b) => a - b);
    const lo = Math.floor(data.count * 0.05);
    const hi = Math.ceil(data.count * 0.95) - 1;
    const ext = {
      xSpan: Math.max(4, xs[hi] - xs[lo]),
      zSpan: Math.max(4, zs[hi] - zs[lo]),
    };
    sceneExtents.set(scene.id, ext);
    return ext;
  } catch { return null; }
}

async function fetchServerPositions() {
  try {
    const r = await fetch("/api/scene-positions", { cache: "no-store" });
    if (r.ok) {
      const data = await r.json();
      Object.entries(data).forEach(([id, pos]) => serverPositions.set(id, pos));
    }
  } catch {}
}

const WORLD_SPREAD = 44; // world units for full word-cloud extent

// Places targetScenes using server positions where available, linear layout otherwise.
function assignWorldPositionsAdaptive(targetScenes) {
  const unpositioned = [];
  for (const s of targetScenes) {
    const sp = serverPositions.get(s.id);
    if (sp) {
      worldPositions.set(s.id, [(sp.x_pct - 0.5) * WORLD_SPREAD, 0, (sp.y_pct - 0.5) * WORLD_SPREAD]);
    } else {
      unpositioned.push(s);
    }
  }
  if (unpositioned.length === 0) return;

  const spans = unpositioned.map(s => {
    const e = sceneExtents.get(s.id);
    return e ? e.xSpan : WORLD_SPACING;
  });
  const totalWidth = spans.reduce((a, b) => a + b, 0) + (unpositioned.length - 1) * SCENE_GAP;
  let cursor = -totalWidth / 2;
  unpositioned.forEach((s, i) => {
    const cx = cursor + spans[i] / 2;
    worldPositions.set(s.id, [cx, 0, 0]);
    cursor += spans[i] + SCENE_GAP;
  });
}

// Fallback for scenes not in the current world subset.
let _fallbackCount = 0;
function assignWorldPosition(scene) {
  if (worldPositions.has(scene.id)) return worldPositions.get(scene.id);
  const sp = serverPositions.get(scene.id);
  if (sp) {
    const pos = [(sp.x_pct - 0.5) * WORLD_SPREAD, 0, (sp.y_pct - 0.5) * WORLD_SPREAD];
    worldPositions.set(scene.id, pos);
    return pos;
  }
  const pos = [1000 + _fallbackCount++ * WORLD_SPACING, 0, 0];
  worldPositions.set(scene.id, pos);
  return pos;
}

// Runs fn(item) over items with at most `limit` in flight at once — plain
// Promise.all over dozens of scenes means dozens of concurrent full PLY
// downloads (each ~66MB just to build a proxy), which is its own way to
// choke a weak connection/laptop even though nothing renders expensively.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Distant-view point-cloud proxies ─────────────────────────────────────
// Cheap stand-ins for every scene that isn't currently being visited: just
// the splat centers + colours as plain THREE.Points (a few thousand points,
// heavily decimated), rendered straight into the viewer's own THREE scene —
// entirely outside the gaussian-splat pipeline, so no covariance textures,
// no per-splat sorting, no octree. That pipeline is what a laptop actually
// chokes on with 10 full splats loaded at once (~23M gaussians); a scene's
// full quality only ever loads for whichever ONE scene the visitor is
// currently near, everything else stays a lightweight point cloud.
const POINT_CLOUD_MAX_POINTS = 12_000;
const POINT_SIZE = 0.05;
const PROXY_BUILD_CONCURRENCY = 3; // each proxy still downloads the full ~66MB PLY
const pointCloudProxies = new Map(); // scene id → THREE.Points

async function addPointCloudProxy(scene, worldPos) {
  if (pointCloudProxies.has(scene.id) || !viewer) return;
  const t0 = performance.now();
  const data = await parseSplatPly(scene.ply_url, POINT_CLOUD_MAX_POINTS);
  if (!data || data.count < 1 || !viewer) return;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions.subarray(0, data.count * 3), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(data.colors.subarray(0, data.count * 3), 3));
  const material = new THREE.PointsMaterial({ size: POINT_SIZE, vertexColors: true, sizeAttenuation: true });
  const points = new THREE.Points(geometry, material);
  points.position.set(worldPos[0], worldPos[1], worldPos[2]);
  viewer.threeScene.add(points);
  pointCloudProxies.set(scene.id, points);
  console.log(`[viewer] proxy ready for ${scene.id}: ${data.count} pts in ${(performance.now() - t0).toFixed(0)}ms`);
}

function hidePointCloudProxy(sceneId) {
  const p = pointCloudProxies.get(sceneId);
  if (p) p.visible = false;
}

function showPointCloudProxy(sceneId) {
  const p = pointCloudProxies.get(sceneId);
  if (p) p.visible = true;
}

function clearPointCloudProxies() {
  for (const p of pointCloudProxies.values()) {
    viewer?.threeScene?.remove(p);
    p.geometry.dispose();
    p.material.dispose();
  }
  pointCloudProxies.clear();
}

// ── Full-resolution swap (proximity-based) ───────────────────────────────
// Only ONE scene is ever loaded at full gaussian-splat quality at a time —
// whichever the visitor is currently near — bounding GPU/CPU cost no matter
// how many memories exist in total. Everything else stays a point-cloud
// proxy until approached.
const FULLRES_ENTER_DIST = 6;   // load full splat once this close
const FULLRES_EXIT_DIST  = 10;  // unload once this far (hysteresis gap avoids thrashing)
// The library rebuilds its entire splat-tree (octree) in the background
// after EVERY addSplatScene/removeSplatScenes call, taking many seconds for
// a scene this size — see the long comment in buildWorldMode(). Starting a
// NEW load or unload while a previous one's background build is still
// running is what throws "Cannot read properties of null (reading
// 'visitLeaves')" — and it's not just about waiting after a load: an
// unload's own rebuild can just as easily race a load's. There's no public
// hook to know when a rebuild has actually finished, so as a mitigation we
// enforce a flat cooldown between ANY two swap operations. Not a complete
// fix, but it covers realistic usage (nobody darting between memories
// faster than this).
const FULLRES_MIN_HOLD_MS = 15_000;

let fullResSceneId      = null; // what's ACTUALLY loaded right now (0 or 1 scenes)
let fullResDesiredId    = null; // what SHOULD be loaded, per proximity or explicit focus
let fullResBusy         = false; // a load/unload is actively in flight
let fullResCooldownUntil = 0;    // performance.now() timestamp; no new swap before this

// IMPORTANT: this is the ONLY place that calls loadFullRes()/unloadFullRes().
// Earlier versions let focusWorldScene() call loadFullRes() directly, which
// bypassed the busy/cooldown guard entirely and let two swaps run
// concurrently — that's what was piling up multiple full-res scenes at once
// (textures growing 4096×2048 → 4096×4096 in the console) and repeatedly
// throwing "Cannot add/remove splat scene while another load or unload is
// already in progress." Every caller (proximity LOD, explicit focus/click,
// mobile selection) now just sets fullResDesiredId and calls this — it's
// idempotent and safe to call as often as you like.
function reconcileFullRes() {
  if (fullResBusy || fullResDesiredId === fullResSceneId) return;
  const now = performance.now();
  if (now < fullResCooldownUntil) {
    console.log(`[viewer] LOD: swap to ${fullResDesiredId} requested but on cooldown for ${(fullResCooldownUntil - now).toFixed(0)}ms more`);
    return; // next updateLOD tick (or the next explicit focus call) will retry
  }

  const target = fullResDesiredId;
  console.log(`[viewer] LOD: reconciling full-res ${fullResSceneId ?? "(none)"} → ${target ?? "(none)"}`);
  fullResBusy = true;
  const t0 = performance.now();
  (async () => {
    if (fullResSceneId) await unloadFullRes();
    if (target) await loadFullRes(target);
  })()
    .catch(err => console.error("[viewer] LOD: reconcile failed:", err))
    .finally(() => {
      fullResCooldownUntil = performance.now() + FULLRES_MIN_HOLD_MS;
      fullResBusy = false;
      console.log(`[viewer] LOD: reconcile settled in ${(performance.now() - t0).toFixed(0)}ms, next swap allowed in ${FULLRES_MIN_HOLD_MS}ms`);
    });
}

async function loadFullRes(sceneId) {
  if (!viewer) return;
  const scene = worldScenes.find(s => s.id === sceneId) || scenes.find(s => s.id === sceneId);
  if (!scene) return;
  const t0 = performance.now();
  console.log(`[viewer] LOD: loading full-res splat for ${sceneId}`);
  try {
    await withLoadRetry(() => viewer.addSplatScene(scene.ply_url, {
      format: GaussianSplats3D.SceneFormat.Ply,
      splatAlphaRemovalThreshold: 5,
      showLoadingUI: false,
      position: worldPositions.get(sceneId) || [0, 0, 0],
    }));
    hidePointCloudProxy(sceneId);
    fullResSceneId = sceneId;
    console.log(`[viewer] LOD: full-res ready for ${sceneId} in ${(performance.now() - t0).toFixed(0)}ms`);
  } catch (err) {
    console.error(`[viewer] LOD: failed to load full-res for ${sceneId} after ${(performance.now() - t0).toFixed(0)}ms:`, err);
  }
}

async function unloadFullRes() {
  if (fullResSceneId === null || !viewer) return;
  const id = fullResSceneId;
  const t0 = performance.now();
  console.log(`[viewer] LOD: unloading full-res splat for ${id}`);
  try {
    // Only ever one scene loaded at a time in this path, so it's always index 0.
    await withLoadRetry(() => viewer.removeSplatScenes([0], false));
    console.log(`[viewer] LOD: unloaded ${id} in ${(performance.now() - t0).toFixed(0)}ms`);
  } catch (err) {
    console.error(`[viewer] LOD: failed to unload full-res for ${id} after ${(performance.now() - t0).toFixed(0)}ms:`, err);
  }
  showPointCloudProxy(id);
  fullResSceneId = null;
}

// Called every few frames from updateLOD() with the camera's world position.
// Only decides WHAT should be loaded (fullResDesiredId) — the actual
// load/unload is centralised in reconcileFullRes() above.
function updateFullResLOD(cx, cy, cz) {
  if (!worldMode || worldScenes.length === 0) return;

  let nearestId = null, nearestDist = Infinity;
  for (const s of worldScenes) {
    const pos = worldPositions.get(s.id);
    if (!pos) continue;
    const d = Math.hypot(cx - pos[0], cy - pos[1], cz - pos[2]);
    if (d < nearestDist) { nearestDist = d; nearestId = s.id; }
  }

  if (nearestId && nearestDist < FULLRES_ENTER_DIST) {
    fullResDesiredId = nearestId;
  } else if (fullResDesiredId) {
    const desiredPos = worldPositions.get(fullResDesiredId);
    const distToDesired = desiredPos
      ? Math.hypot(cx - desiredPos[0], cy - desiredPos[1], cz - desiredPos[2])
      : Infinity;
    if (distToDesired > FULLRES_EXIT_DIST) fullResDesiredId = null;
  }

  reconcileFullRes();
}

// Move the camera to the canonical front view of a scene in Memory Verse.
// Audio for ALL scenes runs simultaneously — distance controls volume via
// updateSpatialAudio() each frame, so no audio changes happen here.
function focusWorldScene(sceneId, worldPos) {
  flyToScene(worldPos, true);
  worldFocusedId = sceneId;
  // Explicit focus (click, mobile selection, auto-advance) always warrants
  // full quality, regardless of the camera's exact distance once it
  // arrives. Goes through the same reconciler as proximity-based LOD so the
  // two never race each other (see the comment above reconcileFullRes()).
  fullResDesiredId = sceneId;
  reconcileFullRes();
  // Update auto-advance index so it continues from the current scene
  const idx = worldScenes.findIndex(s => s.id === sceneId);
  if (idx !== -1) _worldAutoIndex = idx;
  startWorldDwell(); // reset 60s countdown
  // Show story overlay for the focused memory (disappears after reading time)
  const scene = worldScenes.find(s => s.id === sceneId) || scenes.find(s => s.id === sceneId);
  if (storyOverlayTimer) { clearTimeout(storyOverlayTimer); storyOverlayTimer = null; }
  storyOverlayEl.classList.add("hidden");
  if (scene?.story) {
    overlayStoryTextEl.textContent = "";
    storyOverlayEl.classList.remove("hidden");
    const c = typewrite(overlayStoryTextEl, scene.story, 32);
    cancelTypewriters.push(c);
    const visibleMs = scene.story.length * 32 + 8000;
    storyOverlayTimer = setTimeout(() => storyOverlayEl.classList.add("hidden"), visibleMs);
  }
}

let chain = Promise.resolve();
const runExclusive = fn => { chain = chain.then(fn, fn); return chain; };

// ── Color extraction ──────────────────────────────────────────────────────

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

async function extractSceneColor(imageUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    // No crossOrigin attribute — this image is same-origin (served by our
    // own backend), and setting crossOrigin="anonymous" anyway forces the
    // browser into CORS mode, which can silently fail to tag the response
    // as CORS-cleared depending on header quirks and taint the canvas. For
    // a same-origin image, leaving this off is both correct and simpler.
    img.onload = () => {
      try {
        const SIZE = 80;
        const canvas = document.createElement("canvas");
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

        let bestS = 0, bestH = 180;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] / 255, g = data[i+1] / 255, b = data[i+2] / 255;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const l = (max + min) / 2;
          // Skip very dark or blown-out pixels
          if (l < 0.12 || l > 0.92) continue;
          const d = max - min;
          const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
          if (s > bestS) {
            bestS = s;
            let h;
            if (max === r)      h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else                h = (r - g) / d + 4;
            bestH = (h * 60 + 360) % 360;
          }
        }

        if (bestS < 0.14) {
          // B&W or very desaturated — bright cyan is most visible on dark bg
          resolve([100, 200, 255]);
          return;
        }

        // Lock saturation high, set L to 0.70 for max screen visibility
        resolve(hslToRgb(bestH / 360, Math.min(bestS * 1.3, 1), 0.70));
      } catch (err) {
        console.error("Colour extraction failed:", err);
        resolve([100, 200, 255]);
      }
    };
    img.onerror = () => resolve([100, 200, 255]);
    img.src = imageUrl;
  });
}

function applyHudColor([r, g, b]) {
  const val = `${r}, ${g}, ${b}`;
  hudEl.style.setProperty("--hc", val);
  storyOverlayEl.style.setProperty("--hc", val);
  // Set on root too so elements outside the HUD (e.g. the nav hint and the
  // custom cursor, which is styled with rgb(var(--hc))) inherit it
  document.documentElement.style.setProperty("--hc", val);
  // Tab icon matches the same colour as the cursor/HUD — same source, so
  // they're never out of sync with each other.
  setFaviconColor(r, g, b);
}

function setFaviconColor(r, g, b) {
  const iconLink = document.querySelector('link[rel="icon"]');
  if (!iconLink) return;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`
    + `<circle cx="16" cy="16" r="15" fill="rgb(${r},${g},${b})"/>`
    + `<circle cx="16" cy="16" r="5" fill="#06080c"/></svg>`;
  iconLink.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ── Typewriter ────────────────────────────────────────────────────────────

// Returns a cancel function so we can abort mid-type on transition
function typewrite(el, text, charDelayMs = 52) {
  el.textContent = "";
  // Add blinking cursor span
  const cursor = document.createElement("span");
  cursor.className = "hud-cursor";
  cursor.textContent = "█";
  el.appendChild(cursor);

  let i = 0;
  let cancelled = false;
  let timer = null;

  const step = () => {
    if (cancelled) return;
    if (i < text.length) {
      // Insert char before cursor
      cursor.insertAdjacentText("beforebegin", text[i++]);
      timer = setTimeout(step, charDelayMs);
    } else {
      // Done typing — blink cursor for 1.2s then remove it
      timer = setTimeout(() => {
        if (!cancelled) cursor.remove();
      }, 1200);
    }
  };
  timer = setTimeout(step, charDelayMs);

  return () => { cancelled = true; clearTimeout(timer); };
}

let cancelTypewriters = [];

function clearTypewriters() {
  cancelTypewriters.forEach(fn => fn());
  cancelTypewriters = [];
}

// ── Overlay ───────────────────────────────────────────────────────────────

function overlayTo(opacity) {
  return new Promise(resolve => {
    overlayEl.style.transition = `opacity ${OVERLAY_FADE_MS}ms ease`;
    overlayEl.style.opacity    = String(opacity);
    setTimeout(resolve, OVERLAY_FADE_MS);
  });
}

// ── Scene HUD ─────────────────────────────────────────────────────────────

async function showHud(scene, onDwellEnd) {
  clearTypewriters();

  // Extract color from source image then apply
  if (scene.image_url) {
    const color = await extractSceneColor(scene.image_url);
    applyHudColor(color);
  }

  captionNameEl.textContent  = "";
  captionAuthEl.textContent  = "";
  captionYearEl.textContent  = "";
  captionStoryEl.textContent = "";
  hudEl.classList.remove("hidden");

  // Per-scene audio — played spatially: single scenes are always at world
  // origin [0,0,0], so the sound comes from directly ahead of the camera.
  stopAllAudio();
  playSceneAudio(scene, [0, 0, 0]);

  const c1 = typewrite(captionNameEl, (scene.name || "Untitled").toUpperCase(), 55);
  cancelTypewriters.push(c1);

  if (scene.author) {
    authorRowEl.style.display = "";
    const c2 = typewrite(captionAuthEl, (scene.author).toUpperCase(), 48);
    cancelTypewriters.push(c2);
  } else {
    authorRowEl.style.display = "none";
  }

  if (scene.year) {
    yearRowEl.style.display = "";
    const c3 = typewrite(captionYearEl, scene.year, 60);
    cancelTypewriters.push(c3);
  } else {
    yearRowEl.style.display = "none";
  }

  // cluster_id is "<location-slug>__<decade>", assigned by the backend's
  // memory brain — show the era half as a quiet hint that this scene is
  // grouped with other memories of the same place and decade.
  const era = scene.cluster_id ? scene.cluster_id.split("__")[1] : "";
  if (era && era !== "undated") {
    clusterRowEl.style.display = "";
    const c6 = typewrite(captionClusterEl, era.toUpperCase(), 60);
    cancelTypewriters.push(c6);
  } else {
    clusterRowEl.style.display = "none";
  }

  if (scene.story) {
    storyRowEl.style.display = "";
    const c4 = typewrite(captionStoryEl, scene.story, 26);
    cancelTypewriters.push(c4);
  } else {
    storyRowEl.style.display = "none";
  }
  // Story overlay only appears when a memory is explicitly selected in explore mode

  // Start dwell ring once text starts appearing
  startDwell(onDwellEnd);
}

function hideHud() {
  clearTypewriters();
  hudEl.classList.add("hidden");
  storyOverlayEl.classList.add("hidden");
  if (storyOverlayTimer) { clearTimeout(storyOverlayTimer); storyOverlayTimer = null; }
  stopAllAudio();
}

// ── Dwell timer ───────────────────────────────────────────────────────────

let timerRaf      = null;
let timerStart    = null;
let timerCallback = null;

function startDwell(onComplete) {
  if (timerRaf) cancelAnimationFrame(timerRaf);
  timerRaf = null;
  timerCallback = onComplete;
  timerStart    = performance.now();
  timerArcEl.style.strokeDashoffset = TIMER_C;

  const tick = (now) => {
    const p = Math.min((now - timerStart) / DWELL_MS, 1);
    timerArcEl.style.strokeDashoffset = TIMER_C * (1 - p);
    if (p < 1) {
      timerRaf = requestAnimationFrame(tick);
    } else {
      timerRaf = null;
      if (timerCallback) timerCallback();
    }
  };
  timerRaf = requestAnimationFrame(tick);
}

function stopDwell() {
  if (timerRaf) cancelAnimationFrame(timerRaf);
  timerRaf = null; timerCallback = null;
  timerArcEl.style.strokeDashoffset = TIMER_C;
}

// ── World auto-advance ────────────────────────────────────────────────────
// After WORLD_DWELL_MS of no user selection, the camera flies to the next
// memory in the world and the cycle continues indefinitely.

let _worldDwellTimer = null;
let _worldAutoIndex  = 0;

function startWorldDwell() {
  clearTimeout(_worldDwellTimer);
  _worldDwellTimer = setTimeout(_worldAdvance, WORLD_DWELL_MS);
}

function stopWorldDwell() {
  clearTimeout(_worldDwellTimer);
  _worldDwellTimer = null;
}

function _worldAdvance() {
  if (!worldMode || worldScenes.length === 0) return;
  _worldAutoIndex = (_worldAutoIndex + 1) % worldScenes.length;
  const s = worldScenes[_worldAutoIndex];
  const pos = worldPositions.get(s.id);
  if (pos) {
    focusWorldScene(s.id, pos);
  } else {
    // Position not ready yet — skip to next after a short gap
    _worldDwellTimer = setTimeout(_worldAdvance, 2000);
  }
}

// ── Gaussian viewer ───────────────────────────────────────────────────────

function ensureViewer() {
  if (viewer) return;
  console.log("[viewer] creating GaussianSplats3D.Viewer");
  viewer = new GaussianSplats3D.Viewer({
    rootElement: viewerEl,
    cameraUp: [0, -1, 0],
    initialCameraPosition: INIT_POS,
    initialCameraLookAt:   INIT_TARGET,
    sharedMemoryForWorkers: false,
    // The library's built-in controls create their own OrbitControls AND a
    // separate window-level keydown handler that rolls the camera on
    // ArrowLeft/ArrowRight (and binds KeyG/F/C/U/I/O/P to debug toggles).
    // That handler is what was tilting the scene on arrow-key presses —
    // disabling it entirely is the only way to stop it, since it runs
    // independently of any OrbitControls.enabled flag.
    useBuiltInControls: false,
    // Surfaces the library's own internal timings (splat-tree/octree build
    // time, sorting-worker setup) in the console — the part of "loading a
    // scene" that happens AFTER addSplatScene's promise resolves and isn't
    // otherwise visible from viewer.js.
    logLevel: GaussianSplats3D.LogLevel.Info,
  });
  viewer.start();
  console.log("[viewer] viewer.start() called");

  // Apply initial FPS look direction once camera is ready
  requestAnimationFrame(() => applyFPSCamera());
}

// ── FPS camera state ──────────────────────────────────────────────────────

let _yaw   = 0;   // horizontal look angle (radians)
let _pitch = 0;   // vertical look angle   (radians)

// Applies yaw/pitch to the camera by building an explicit orthonormal basis
// (right / up / forward) from a fixed world-up reference. This avoids the
// roll/skew artifacts that cam.lookAt() can introduce near steep pitch
// angles (its internal up-vector cross-product becomes unstable there).
// cameraUp is (0,-1,0) in this scene, so world -Y is visually "up".
function applyFPSCamera() {
  const cam = viewer?.camera;
  if (!cam) return;

  const cosP = Math.cos(_pitch);
  const forward = {
    x: Math.sin(_yaw) * cosP,
    y: -Math.sin(_pitch),
    z: Math.cos(_yaw) * cosP,
  };
  const worldUp = { x: 0, y: -1, z: 0 };

  // right = forward × worldUp, normalized
  let right = {
    x: forward.y * worldUp.z - forward.z * worldUp.y,
    y: forward.z * worldUp.x - forward.x * worldUp.z,
    z: forward.x * worldUp.y - forward.y * worldUp.x,
  };
  const rLen = Math.hypot(right.x, right.y, right.z) || 1;
  right = { x: right.x / rLen, y: right.y / rLen, z: right.z / rLen };

  // camUp = right × forward — always orthogonal, never twists/rolls
  const camUp = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };

  // Build vectors via the camera's own Vector3 constructor (no THREE import needed)
  const Vec3   = cam.position.constructor;
  const xAxis  = new Vec3(right.x, right.y, right.z);
  const yAxis  = new Vec3(camUp.x, camUp.y, camUp.z);
  const zAxis  = new Vec3(-forward.x, -forward.y, -forward.z); // camera looks down local -Z

  cam.matrix.makeBasis(xAxis, yAxis, zAxis);
  cam.quaternion.setFromRotationMatrix(cam.matrix);
  cam.updateMatrixWorld(true);
}

// ── Mouse FPS-look + click-to-reset ──────────────────────────────────────

let _dragging  = false;
let _prevX     = 0, _prevY = 0;
let _dragDist  = 0;

viewerEl.addEventListener("pointerdown", e => {
  _dragging = true;
  _prevX    = e.clientX;
  _prevY    = e.clientY;
  _dragDist = 0;
  viewerEl.setPointerCapture(e.pointerId);
});

viewerEl.addEventListener("pointermove", e => {
  if (!_dragging) return;
  const dx = e.clientX - _prevX;
  const dy = e.clientY - _prevY;
  _dragDist += Math.abs(dx) + Math.abs(dy);

  const SENS = 0.0025;
  _yaw   -= dx * SENS;
  _pitch -= dy * SENS;
  _pitch  = Math.max(-1.30, Math.min(1.30, _pitch)); // clamp ~74°, stays well clear of gimbal zone

  _prevX = e.clientX;
  _prevY = e.clientY;

  applyFPSCamera();
});

viewerEl.addEventListener("pointerup", e => {
  if (_dragDist < 6) {
    if (worldMode) {
      // Always find the nearest visible scene — no radius cutoff.
      // If all scene centers are behind the camera (deeply inside one),
      // fall back to the overview so the user can re-orient.
      const target = findNearestWorldSceneAndId(e.clientX, e.clientY);
      if (target) focusWorldScene(target.id, target.pos);
      else flyToWorldOverview();
    }
    // Single tap no longer resets camera — use double-click to reset
  }
  _dragging = false;
});

viewerEl.addEventListener("dblclick", () => {
  if (!worldMode) resetCamera();
});

// Scroll = move forward / backward along look direction
viewerEl.addEventListener("wheel", e => {
  e.preventDefault();
  if (!viewer?.camera) return;
  const cam = viewer.camera;
  const m   = cam.matrixWorld.elements;
  const fwd = { x: -m[8], y: -m[9], z: -m[10] };
  const d   = e.deltaY > 0 ? 0.18 : -0.18;
  cam.position.x += fwd.x * d;
  cam.position.y += fwd.y * d;
  cam.position.z += fwd.z * d;
  applyFPSCamera();
}, { passive: false });

// ── Click-to-reset (fly back to origin) ──────────────────────────────────

function resetCamera() {
  if (!viewer?.camera) return;
  if (resetRaf) cancelAnimationFrame(resetRaf);

  const cam = viewer.camera;
  const sp  = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
  const ep  = { x: INIT_POS[0],    y: INIT_POS[1],    z: INIT_POS[2]    };
  const sy  = _yaw, sp2 = _pitch;

  const t0  = performance.now();
  const DUR = 900;

  const tick = now => {
    const raw  = Math.min((now - t0) / DUR, 1);
    const ease = 1 - Math.pow(1 - raw, 3);  // cubic ease-out

    cam.position.x = sp.x + (ep.x - sp.x) * ease;
    cam.position.y = sp.y + (ep.y - sp.y) * ease;
    cam.position.z = sp.z + (ep.z - sp.z) * ease;

    // Simultaneously sweep yaw/pitch back to zero
    _yaw   = sy  * (1 - ease);
    _pitch = sp2 * (1 - ease);
    applyFPSCamera();

    if (raw < 1) {
      resetRaf = requestAnimationFrame(tick);
    } else {
      _yaw = 0; _pitch = 0;
      applyFPSCamera();
      resetRaf = null;
    }
  };
  resetRaf = requestAnimationFrame(tick);
}

// Generalised version of the same tween, used by World of Memories to fly
// the camera to a specific scene instead of always returning to the origin.
// Approaches from whichever side the camera already happens to be on, so the
// camera glides over rather than teleporting around the target.
// fromFront=true: always approach from the -Z side (canonical Memory Verse
// front view), regardless of where the camera currently is. Prevents the
// "black side" problem when the user navigated behind a scene.
function flyToScene(targetPos, fromFront = false) {
  if (!viewer?.camera) return;
  if (resetRaf) cancelAnimationFrame(resetRaf);

  const cam = viewer.camera;
  const sp  = { x: cam.position.x, y: cam.position.y, z: cam.position.z };

  let appX, appZ;
  if (fromFront) {
    appX = 0; appZ = -1; // canonical -Z approach (matching overview direction)
  } else {
    appX = sp.x - targetPos[0];
    appZ = sp.z - targetPos[2];
    const appLen = Math.hypot(appX, appZ) || 1;
    appX /= appLen; appZ /= appLen;
  }

  const STANDOFF = 3.2;
  const ep = {
    x: targetPos[0] + appX * STANDOFF,
    y: targetPos[1],
    z: targetPos[2] + appZ * STANDOFF,
  };

  const dx = targetPos[0] - ep.x;
  const dy = targetPos[1] - ep.y;
  const dz = targetPos[2] - ep.z;
  const horizDist = Math.hypot(dx, dz) || 1e-6;
  const targetYaw   = Math.atan2(dx, dz);
  const targetPitch = Math.max(-1.30, Math.min(1.30, -Math.atan2(dy, horizDist)));

  const sy = _yaw, sp2 = _pitch;
  // Shortest-path yaw delta, so it never spins the long way round
  let yawDelta = targetYaw - sy;
  yawDelta = ((yawDelta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

  const t0  = performance.now();
  const DUR = 1100;

  const tick = now => {
    const raw  = Math.min((now - t0) / DUR, 1);
    const ease = 1 - Math.pow(1 - raw, 3);

    cam.position.x = sp.x + (ep.x - sp.x) * ease;
    cam.position.y = sp.y + (ep.y - sp.y) * ease;
    cam.position.z = sp.z + (ep.z - sp.z) * ease;

    _yaw   = sy  + yawDelta * ease;
    _pitch = sp2 + (targetPitch - sp2) * ease;
    applyFPSCamera();

    if (raw < 1) {
      resetRaf = requestAnimationFrame(tick);
    } else {
      resetRaf = null;
    }
  };
  resetRaf = requestAnimationFrame(tick);
}

// Computes a camera position that frames the entire Memory Verse row.
// All scenes are on the X axis at Z=0, so the camera just needs to pull
// back along -Z far enough to fit the total width in the FOV.
function worldOverviewPos() {
  const activeScenes = worldScenes.length ? worldScenes : [];
  if (activeScenes.length === 0) return { x: 0, y: 0, z: -30, yaw: 0, pitch: 0.05 };

  // Compute the true outer edges of the scene row (center ± half-span for each scene).
  let minEdge = Infinity, maxEdge = -Infinity, maxDepth = 0;
  for (const s of activeScenes) {
    const pos = worldPositions.get(s.id);
    if (!pos) continue;
    const ext = sceneExtents.get(s.id);
    const halfX = ext ? ext.xSpan / 2 : WORLD_SPACING / 2;
    const depth  = ext ? ext.zSpan     : WORLD_SPACING;
    if (pos[0] - halfX < minEdge) minEdge = pos[0] - halfX;
    if (pos[0] + halfX > maxEdge) maxEdge = pos[0] + halfX;
    if (depth > maxDepth) maxDepth = depth;
  }
  if (minEdge === Infinity) return { x: 0, y: 0, z: -30, yaw: 0, pitch: 0.05 };

  const cx = (minEdge + maxEdge) / 2;
  const rowWidth = maxEdge - minEdge;
  // Pull back enough to fit the full row width in ~75° FOV, plus scene depth margin.
  const pullback = Math.max(rowWidth / 1.1 + maxDepth * 0.5 + SCENE_GAP, 30);
  return { x: cx, y: 0, z: -pullback, yaw: 0, pitch: 0.05 };
}

// Smoothly fly to the world overview — used as the Memory Verse "reset"
// when a click lands on empty space (mirrors resetCamera for single scenes).
function flyToWorldOverview() {
  if (!viewer?.camera) return;
  if (resetRaf) cancelAnimationFrame(resetRaf);

  const cam = viewer.camera;
  const sp = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
  const { x: ex, y: ey, z: ez, yaw: ty, pitch: tp } = worldOverviewPos();
  const ep = { x: ex, y: ey, z: ez };

  const sy = _yaw, sp2 = _pitch;
  let yawDelta = ty - sy;
  yawDelta = ((yawDelta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

  const t0 = performance.now();
  const DUR = 1100;

  const tick = now => {
    const raw  = Math.min((now - t0) / DUR, 1);
    const ease = 1 - Math.pow(1 - raw, 3);

    cam.position.x = sp.x + (ep.x - sp.x) * ease;
    cam.position.y = sp.y + (ep.y - sp.y) * ease;
    cam.position.z = sp.z + (ep.z - sp.z) * ease;

    _yaw   = sy  + yawDelta * ease;
    _pitch = sp2 + (tp - sp2) * ease;
    applyFPSCamera();

    if (raw < 1) {
      resetRaf = requestAnimationFrame(tick);
    } else {
      _yaw = ty; _pitch = tp;
      applyFPSCamera();
      resetRaf = null;
    }
  };
  resetRaf = requestAnimationFrame(tick);
}

// Projects a world position to on-screen pixel coordinates, using the
// viewer's own camera/canvas — used to find which scene a click landed near.
function projectToScreen(worldPos) {
  const cam = viewer?.camera;
  if (!cam) return null;
  const Vec3 = cam.position.constructor;
  const v = new Vec3(worldPos[0], worldPos[1], worldPos[2]);
  v.project(cam);
  if (v.z > 1) return null; // behind the camera
  const rect = viewerEl.getBoundingClientRect();
  return {
    x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
    y: (1 - (v.y * 0.5 + 0.5)) * rect.height + rect.top,
  };
}

// Always returns the nearest scene in worldScenes — no radius cutoff.
// Scenes whose center is behind the camera are skipped (projectToScreen returns null),
// but any visible scene is always reachable with a single tap.
function findNearestWorldScene(clickX, clickY) {
  let best = null, bestDist = Infinity;
  for (const scene of worldScenes) {
    const pos = worldPositions.get(scene.id);
    if (!pos) continue;
    const screen = projectToScreen(pos);
    if (!screen) continue;
    const d = Math.hypot(screen.x - clickX, screen.y - clickY);
    if (d < bestDist) { bestDist = d; best = pos; }
  }
  return best;
}

function findNearestWorldSceneAndId(clickX, clickY) {
  let best = null, bestDist = Infinity;
  for (const scene of worldScenes) {
    const pos = worldPositions.get(scene.id);
    if (!pos) continue;
    const screen = projectToScreen(pos);
    if (!screen) continue;
    const d = Math.hypot(screen.x - clickX, screen.y - clickY);
    if (d < bestDist) { bestDist = d; best = { pos, id: scene.id }; }
  }
  return best;
}

// ── World of Memories ────────────────────────────────────────────────────────
// The viewer is always in world mode — all memories live in one shared 3D
// environment. Positions come from /api/scene-positions (set by the mobile
// word cloud). Every scene gets a cheap point-cloud proxy up front; only the
// scene the visitor is currently near loads at full gaussian-splat quality
// (see updateFullResLOD()) — this is what actually bounds GPU/CPU cost
// regardless of how many memories exist in total.

async function buildWorldMode(sceneIds) {
  console.log("[viewer] buildWorldMode start", { requested: sceneIds, totalKnownScenes: scenes.length });
  await fetchServerPositions();
  console.log("[viewer] server positions fetched:", serverPositions.size);
  let targetScenes = sceneIds
    ? scenes.filter(s => sceneIds.includes(s.id))
    : scenes;
  if (DEBUG_LIMIT != null) {
    targetScenes = targetScenes.slice(0, DEBUG_LIMIT);
    console.log(`[viewer] DEBUG_LIMIT active — loading only ${targetScenes.length} scene(s):`, targetScenes.map(s => s.id));
  }
  if (targetScenes.length === 0) {
    console.warn("[viewer] buildWorldMode: no target scenes, aborting");
    return;
  }

  worldScenes = targetScenes;
  worldFocusedId = null;
  assignWorldPositionsAdaptive(targetScenes);

  worldMode = true;
  worldLoadedOrder = []; // proxy-loaded scene ids, in no particular order
  stopDwell();
  stopWorldDwell();
  hideHud();

  return runExclusive(async () => {
    await overlayTo(1);

    try {
      await removeAllScenes();
    } catch (err) {
      console.error("Failed clearing world:", err);
    }
    clearPointCloudProxies();
    fullResSceneId   = null;
    fullResDesiredId = null;
    fullResBusy      = false;
    fullResCooldownUntil = 0;
    ensureViewer();
    stopAllAudio();

    // Camera framing and auto-advance only depend on the positions already
    // assigned above — not on any splat actually being loaded — so set them
    // up right away instead of blocking behind the full load.
    if (viewer?.camera) {
      const { x, y, z, yaw, pitch } = worldOverviewPos();
      viewer.camera.position.set(x, y, z);
      _yaw = yaw; _pitch = pitch;
      applyFPSCamera();
      console.log("[viewer] camera placed at overview", { x, y, z, yaw, pitch });
    }

    const midIdx = Math.floor(targetScenes.length / 2);
    const midScene = targetScenes[midIdx];
    if (midScene) {
      worldFocusedId = midScene.id;
      _worldAutoIndex = worldScenes.findIndex(s => s.id === midScene.id);
      if (_worldAutoIndex === -1) _worldAutoIndex = midIdx;
    }
    startWorldDwell();

    // Build a lightweight point-cloud proxy for every scene. This is the
    // ONLY thing that loads for all N memories up front — each proxy is a
    // few thousand plain THREE.Points, nowhere near the cost of a full
    // gaussian splat (covariance/colour textures, octree, sort worker).
    // Full quality is loaded on demand per-scene by updateFullResLOD() as
    // the visitor actually approaches, and by focusWorldScene() when a
    // memory is explicitly selected.
    if (splashStatusEl) splashStatusEl.textContent = "entering the memory verse…";
    if (splashCountEl)  splashCountEl.textContent  = "";

    const total = targetScenes.length;
    console.log(`[viewer] building ${total} point-cloud proxy(ies), ${PROXY_BUILD_CONCURRENCY} at a time...`);
    const t0 = performance.now();
    let doneCount = 0;
    await mapWithConcurrency(targetScenes, PROXY_BUILD_CONCURRENCY, async s => {
      try {
        await addPointCloudProxy(s, worldPositions.get(s.id) || assignWorldPosition(s));
        worldLoadedOrder.push(s.id);
      } catch (err) {
        console.error(`[viewer] ✗ failed building proxy for ${s.id}:`, err);
      }
      doneCount++;
      if (splashCountEl) splashCountEl.textContent = `${doneCount} / ${total}`;
    });
    console.log(`[viewer] proxies ready: ${worldLoadedOrder.length}/${total} in ${(performance.now() - t0).toFixed(0)}ms`);

    // Audio doesn't depend on splat quality — start it for every scene now,
    // same distance-based spatial mix as before.
    for (const s of targetScenes) playSceneAudio(s, worldPositions.get(s.id) || [0, 0, 0]);

    if (splashStatusEl) splashStatusEl.textContent = "memory verse ready";
    placeholderEl.classList.add("hidden");
    overlayEl.style.transition = "opacity 1000ms ease-in";
    overlayEl.style.opacity = "0";

    // Debug mode: fly straight to the (only) scene and load it at full
    // quality so it's obvious the camera actually reached it.
    if (DEBUG_LIMIT != null && midScene) {
      const pos = worldPositions.get(midScene.id);
      console.log("[viewer] DEBUG_LIMIT: flying camera to scene", midScene.id, pos);
      if (pos) focusWorldScene(midScene.id, pos);
    }
  });
}

// ── Transition ────────────────────────────────────────────────────────────

// The library's internal "is loading" flag can apparently take a beat
// longer to clear than the promise it returns suggests — calling
// addSplatScene(s) again too soon throws "Cannot add splat scene while
// another load or unload is already in progress." A few short retries
// absorbs that instead of the whole operation failing outright.
async function withLoadRetry(fn, attempts = 3, delayMs = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function removeAllScenes() {
  const oldCount = viewer ? viewer.getSceneCount() : 0;
  if (oldCount === 0 || !viewer) return;
  await withLoadRetry(() =>
    viewer.removeSplatScenes(Array.from({ length: oldCount }, (_, i) => i), false)
  );
}

async function transitionTo(scene) {
  hideHud();
  await overlayTo(1);

  try {
    await removeAllScenes();
  } catch (err) {
    console.error("Failed clearing the previous scene:", err);
  }
  placeholderEl.classList.add("hidden");
  ensureViewer();

  // progressiveLoad streams the PLY so the forming materialisation is visible
  let loadPromise;
  try {
    loadPromise = viewer.addSplatScene(scene.ply_url, {
      format: GaussianSplats3D.SceneFormat.Ply,
      splatAlphaRemovalThreshold: 5,
      showLoadingUI: false,
      progressiveLoad: true,
    });
  } catch (err) {
    console.error("addSplatScene threw:", err);
    await overlayTo(0);
    return null;
  }

  // Slow ease-in reveal — splats materialise as overlay lifts
  overlayEl.style.transition = "opacity 2200ms ease-in";
  overlayEl.style.opacity    = "0";
  await new Promise(r => setTimeout(r, 2200));

  return loadPromise;
}

// ── Scene management ──────────────────────────────────────────────────────

function goToIndex(index) {
  return runExclusive(async () => {
    if (index < 0 || index >= scenes.length) return;
    const scene = scenes[index];
    currentIndex = index;
    if (scene.id === activeSceneId) return;
    stopDwell();
    try {
      const loadPromise = await transitionTo(scene);
      // Must actually wait for the splat to finish loading here, inside the
      // exclusive lock — addSplatScene()/removeSplatScenes() throw if called
      // again while a previous one is still in flight. Releasing the lock
      // before this settles (the old behaviour) let the next goToIndex call
      // collide mid-load, which is exactly what was producing "wrong scene,
      // audio doesn't match, jumps around fast".
      if (loadPromise) {
        try {
          await loadPromise;
        } catch (err) {
          console.error("Splat load failed for", scene.id, err);
        }
      }
      activeSceneId = scene.id;
      const advance = () => {
        if (scenes.length < 2) {
          // Only one scene — restart the dwell
          showHud(scene, advance);
        } else {
          goToIndex((currentIndex + 1) % scenes.length);
        }
      };
      showHud(scene, advance);
    } catch (err) {
      console.error("Transition failed:", err);
    }
  });
}

// ── Polling ───────────────────────────────────────────────────────────────

async function poll() {
  try {
    const scenesRes = await fetch("/api/scenes", { cache: "no-store" });
    if (!scenesRes.ok) throw new Error(`HTTP ${scenesRes.status}`);
    clearTimeout(errorTimer);
    connectionEl.dataset.state = "";

    const all = await scenesRes.json();
    console.log(`[viewer] poll: /api/scenes returned ${all.length} total scene(s)`);
    if (!all.length) return;
    const known = new Set(scenes.map(s => s.id));
    const fresh = all.filter(s => !known.has(s.id));
    if (!fresh.length) return;
    console.log(`[viewer] poll: ${fresh.length} new scene(s):`, fresh.map(s => s.id));
    scenes.push(...fresh);
    // Permanent world placement is assigned the moment a scene is known,
    // regardless of which mode is active — so a memory's spot never shifts.
    fresh.forEach(assignWorldPosition);

    if (worldMode) {
      if (DEBUG_LIMIT != null) {
        console.log("[viewer] poll: DEBUG_LIMIT active — skipping in-place add of new memories");
      } else {
        // Add newly-arrived memories straight into the world, in place,
        // without disturbing whatever's already there or anyone exploring
        // it. Just a point-cloud proxy each, same as the initial build —
        // full quality only loads later, automatically, if the visitor
        // actually walks near one (updateFullResLOD).
        if (viewer) {
          console.log(`[viewer] poll: already in world mode — adding ${fresh.length} scene(s) as proxies`);
          const t0 = performance.now();
          await mapWithConcurrency(fresh, PROXY_BUILD_CONCURRENCY, async s => {
            try {
              await addPointCloudProxy(s, worldPositions.get(s.id) || [0, 0, 0]);
              worldLoadedOrder.push(s.id);
              worldScenes.push(s);
              playSceneAudio(s, worldPositions.get(s.id) || [0, 0, 0]);
            } catch (err) {
              console.error("[viewer] poll: failed adding proxy for new memory:", s.id, err);
            }
          });
          console.log(`[viewer] poll: added ${fresh.length} scene(s) to world in ${(performance.now() - t0).toFixed(0)}ms`);
        }
      }
    } else if (!started) {
      // Auto-enter world mode with all memories on first load
      console.log("[viewer] poll: first load — entering world mode");
      started = true;
      await fetchServerPositions();
      buildWorldMode(null);
    } else {
      // New memory arrived while in non-world mode — rebuild world to include it
      console.log("[viewer] poll: rebuilding world mode to include new memory");
      await fetchServerPositions();
      buildWorldMode(null);
    }
  } catch (err) {
    console.error("[viewer] poll failed:", err);
    clearTimeout(errorTimer);
    connectionEl.dataset.state = "error";
    errorTimer = setTimeout(() => { connectionEl.dataset.state = ""; }, ERROR_SHOW_MS);
  }
}

async function pollStatus() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) return;
    const { processing } = await res.json();
    loaderEl.classList.toggle("hidden", !processing);
  } catch { /* ignore */ }
}

// ── Mobile-app scene selection ──────────────────────────────────────────
// Purely additive: the mobile app's "browse memories" page can ask the
// viewer to jump to a specific memory. This only decides *which* index to
// jump to — it calls the same goToIndex() the normal rotation already uses,
// so dwell time, transitions, and auto-advance afterward are all unchanged.

let lastSelectionAt = 0;

async function pollSelection() {
  try {
    const res = await fetch("/api/select-scene", { cache: "no-store" });
    if (!res.ok) return;
    const { scene_id, selected_at } = await res.json();
    if (!scene_id || !selected_at || selected_at <= lastSelectionAt) return;
    lastSelectionAt = selected_at;

    let index = scenes.findIndex(s => s.id === scene_id);
    if (index === -1) {
      // Requested scene isn't in our local list yet — refresh and retry once.
      await poll();
      index = scenes.findIndex(s => s.id === scene_id);
    }
    if (index === -1) return;

    // Always fly in world mode — single-scene goToIndex is never used
    const s = scenes[index];
    const pos = worldPositions.get(s.id);
    if (pos && worldMode) {
      focusWorldScene(s.id, pos);
    } else if (!worldMode && scenes.length > 0) {
      // World not ready yet — queue the focus for when it finishes loading
      const waitAndFocus = setInterval(() => {
        if (!worldMode) return;
        clearInterval(waitAndFocus);
        const p = worldPositions.get(s.id);
        if (p) focusWorldScene(s.id, p);
      }, 500);
    }
  } catch { /* ignore */ }
}

let lastWorldSelectionAt = 0;
let worldSelectionBaselined = false;

// Mobile app multi-selects which memories to place in Memory Verse, then
// calls /api/world-selection — this is what actually enters/rebuilds the
// world with exactly that set, on whichever screen the viewer is open.
async function pollWorldSelection() {
  try {
    const res = await fetch("/api/world-selection", { cache: "no-store" });
    if (!res.ok) return;
    const { scene_ids, selected_at } = await res.json();

    // The very first check just records whatever's already sitting on the
    // server (e.g. left over from an earlier session) as the baseline,
    // instead of treating it as a brand-new request — without this, the
    // viewer would jump straight into Memory Verse on every page load
    // whenever someone had used the mobile selector previously. Every
    // viewer always starts on the normal single-scene rotation; only a
    // selection made *after* this point should ever open the world.
    if (!worldSelectionBaselined) {
      worldSelectionBaselined = true;
      lastWorldSelectionAt = selected_at || 0;
      return;
    }

    if (!scene_ids?.length || !selected_at || selected_at <= lastWorldSelectionAt) return;
    lastWorldSelectionAt = selected_at;
    buildWorldMode(scene_ids);
  } catch { /* ignore */ }
}

// ── Fullscreen (kiosk) mode ───────────────────────────────────────────────

function isFullscreen() {
  return !!document.fullscreenElement;
}

let _fullscreenRequested = false;

function enterFullscreen() {
  // Guards against the document-level pointerdown listener and the splash
  // Start button both firing for the same physical click — a second
  // requestFullscreen() call before the first one resolves logs a harmless
  // but noisy "can only be initiated by a user gesture" warning.
  if (_fullscreenRequested || isFullscreen() || !document.documentElement.requestFullscreen) return;
  _fullscreenRequested = true;
  document.documentElement.requestFullscreen()
    .catch(() => {})
    .finally(() => { _fullscreenRequested = false; });
}

function toggleFullscreen() {
  if (isFullscreen()) {
    document.exitFullscreen?.();
  } else {
    enterFullscreen();
  }
}

// Browsers require a user gesture to enter fullscreen — grab the very first
// tap/click/keypress on the kiosk and use it to go fullscreen automatically.
document.addEventListener("pointerdown", enterFullscreen, { once: true });
document.addEventListener("keydown", enterFullscreen, { once: true });

// Placeholder stays visible until buildWorldMode finishes loading all scenes

// Manual toggle for testing/operator use
document.addEventListener("keydown", e => {
  if (e.code === "KeyF") toggleFullscreen();
});

// ── Keyboard fly navigation ───────────────────────────────────────────────

const _keys = new Set();
document.addEventListener("keydown", e => {
  _keys.add(e.code);
  // Stop browser from scrolling the page with arrow keys / space
  if (["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
       "PageUp","PageDown"].includes(e.code)) e.preventDefault();
});
document.addEventListener("keyup", e => _keys.delete(e.code));

const BASE_SPEED = 0.05;   // units per frame (~3 units/sec at 60fps)
const TURN_SPEED = 0.032;  // radians per frame (~110°/sec at 60fps)

// ── Remote navigation from mobile ─────────────────────────────────────────
let _remoteNav = { move_x:0, move_z:0, move_y:0, turn_x:0, turn_y:0, gyro:false, gyro_yaw:null, gyro_pitch:null, ts:0 };

(async function _pollRemoteNav() {
  while (true) {
    try {
      const r = await fetch("/api/navigate", { cache: "no-store" });
      if (r.ok) _remoteNav = await r.json();
    } catch {}
    await new Promise(res => setTimeout(res, 50));
  }
})();

// Separate poll for reset-view signal from mobile
let _lastResetTs = 0;
(async function _pollResetView() {
  while (true) {
    try {
      const r = await fetch("/api/reset-view", { cache: "no-store" });
      if (r.ok) {
        const { ts } = await r.json();
        if (ts > _lastResetTs) {
          _lastResetTs = ts;
          if (!worldMode) resetCamera(); else flyToWorldOverview();
        }
      }
    } catch {}
    await new Promise(res => setTimeout(res, 100));
  }
})();

// ── Distance-based LOD ────────────────────────────────────────────────────
// Single-scene mode: fades splat scale down when the camera backs far away
// from the one loaded scene (navigating inside it always stays full quality).
//
// Memory Verse (world) mode: LOD is now a hard swap, not a fade — see
// updateFullResLOD() above. At most one scene is ever loaded at full
// gaussian-splat quality at a time (whichever the visitor is near); every
// other scene is just its lightweight point-cloud proxy. So there's nothing
// to scale/fade here — the loaded scene is always the near one, always at
// full quality, and swapping it out for a different one is a load/unload,
// not a gradual visual transition.

const LOD_LERP_IN   = 0.12; // fast restore when approaching
const LOD_LERP_OUT  = 0.025; // slow fade when retreating

let _lodCurrentScale = 1.0;
let _lodFrame        = 0;
let _lodPrevDist     = 0;

function lodScale(dist, near, far, minScale) {
  if (dist <= near) return 1.0;
  if (dist >= far)  return minScale;
  const t = (dist - near) / (far - near);
  return 1.0 - t * (1.0 - minScale);
}

function updateLOD() {
  const cam = viewer?.camera;
  if (!cam) return;
  if (++_lodFrame % 3 !== 0) return;

  const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;

  if (worldMode) {
    updateFullResLOD(cx, cy, cz);
    return;
  }

  if (!viewer?.splatMesh?.material?.uniforms) return; // uniforms absent until the scene loads

  const minDist = Math.hypot(cx, cy, cz);
  const targetScale = lodScale(minDist, 10, 32, 0.20);

  const approaching = minDist < _lodPrevDist;
  const lerp = approaching ? LOD_LERP_IN : LOD_LERP_OUT;
  _lodPrevDist = minDist;

  _lodCurrentScale += (targetScale - _lodCurrentScale) * lerp * 3;
  try { viewer.splatMesh.setSplatScale(Math.max(0.10, _lodCurrentScale)); } catch {}
}

function flyLoop() {
  requestAnimationFrame(flyLoop);
  updateLOD();

  // Apply remote mobile navigation (joystick / gyro from mobile app)
  {
    const rn = _remoteNav;
    const isRecent = rn.ts > 0 && (Date.now() - rn.ts < 600);
    if (isRecent && viewer) {
      const cam = viewer.camera;
      if (cam) {
        const hasAct = rn.move_x || rn.move_z || rn.move_y || rn.turn_x || rn.turn_y || rn.gyro;
        if (hasAct) {
          const m = cam.matrixWorld.elements;
          const right   = { x: m[0],  y: m[1],  z: m[2]  };
          const camUp   = { x: m[4],  y: m[5],  z: m[6]  };
          const forward = { x: -m[8], y: -m[9], z: -m[10] };
          let dx = 0, dy = 0, dz = 0;
          const add = (v, s) => { dx += v.x*s; dy += v.y*s; dz += v.z*s; };
          if (rn.move_z) add(forward, rn.move_z * BASE_SPEED);
          if (rn.move_x) add(right,   rn.move_x * BASE_SPEED);
          if (rn.move_y) add(camUp,   rn.move_y * BASE_SPEED);
          if (rn.gyro && rn.gyro_yaw !== null) {
            _yaw   = rn.gyro_yaw;
            _pitch = Math.max(-1.30, Math.min(1.30, rn.gyro_pitch ?? 0));
          } else {
            if (rn.turn_x) { _yaw += rn.turn_x * TURN_SPEED; }
            if (rn.turn_y) { _pitch -= rn.turn_y * TURN_SPEED; _pitch = Math.max(-1.30, Math.min(1.30, _pitch)); }
          }
          cam.position.x += dx; cam.position.y += dy; cam.position.z += dz;
          applyFPSCamera();
        }
      }
    }
  }

  // Spatial audio runs every frame so distance-based gain updates
  // continuously — even when the camera is stationary or mid-flyTo.
  updateSpatialAudio();

  if (!viewer || _keys.size === 0) return;

  const cam = viewer.camera;
  if (!cam) return;

  // Camera axes from world matrix — always current after applyFPSCamera()
  const m = cam.matrixWorld.elements;
  const right   = { x: m[0],  y: m[1],  z: m[2]  };
  const camUp   = { x: m[4],  y: m[5],  z: m[6]  };
  const forward = { x: -m[8], y: -m[9], z: -m[10] };

  const sprint = _keys.has("ShiftLeft") || _keys.has("ShiftRight");
  const speed  = BASE_SPEED * (sprint ? 4 : 1);

  let dx = 0, dy = 0, dz = 0;
  const add = (v, s) => { dx += v.x * s; dy += v.y * s; dz += v.z * s; };

  // W/S + Up/Down: forward/back. A/D: strafe sideways. E/Q: up/down.
  if (_keys.has("KeyW") || _keys.has("ArrowUp"))    add(forward,  speed);
  if (_keys.has("KeyS") || _keys.has("ArrowDown"))  add(forward, -speed);
  if (_keys.has("KeyA"))                            add(right,   -speed);
  if (_keys.has("KeyD"))                            add(right,    speed);
  if (_keys.has("KeyE") || _keys.has("PageUp"))     add(camUp,    speed);
  if (_keys.has("KeyQ") || _keys.has("PageDown"))   add(camUp,   -speed);

  // Side arrow keys turn your head (yaw) instead of strafing
  let turned = false;
  if (_keys.has("ArrowLeft"))  { _yaw -= TURN_SPEED; turned = true; }
  if (_keys.has("ArrowRight")) { _yaw += TURN_SPEED; turned = true; }
  if (turned) {
    // Keep yaw bounded so it never loses precision in a long-running kiosk
    _yaw = ((_yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  }

  if (dx !== 0 || dy !== 0 || dz !== 0 || turned) {
    cam.position.x += dx;
    cam.position.y += dy;
    cam.position.z += dz;
    applyFPSCamera();  // re-apply look direction after position/yaw changes
  }
}

flyLoop();

// ── Keyboard nav hint: small tab, expands/closes on click ─────────────────



// ── Boot ──────────────────────────────────────────────────────────────────

poll();
const _pollId      = setInterval(poll, POLL_INTERVAL);
const _statusId    = setInterval(pollStatus, STATUS_INTERVAL);
const _selectionId = setInterval(pollSelection, 2_000);  // snappier than POLL_INTERVAL — this is a direct user action
const _worldSelectionId = setInterval(pollWorldSelection, 2_000);

// A dev-server hot-reload of this module without a full page reload would
// otherwise leave the old poll/select/status intervals running alongside
// the new ones — multiple overlapping goToIndex() calls racing each other
// is exactly what produces "wrong scene plays, audio doesn't match, jumps
// around fast". Clearing them on dispose guarantees only one set ever runs.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearInterval(_pollId);
    clearInterval(_statusId);
    clearInterval(_selectionId);
    clearInterval(_worldSelectionId);
  });
}
