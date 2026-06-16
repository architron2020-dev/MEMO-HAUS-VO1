import "./viewer.css";
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";

const viewerEl        = document.getElementById("viewer");
const placeholderEl   = document.getElementById("placeholder");
const overlayEl       = document.getElementById("transition-overlay");
const captionEl       = document.getElementById("caption");
const captionNameEl   = document.getElementById("caption-name");
const captionAuthorEl = document.getElementById("caption-author");
const connectionEl    = document.getElementById("connection");

const DWELL_MS      = 15_000;
const POLL_INTERVAL = 4_000;
const FADE_MS       = 600;

let viewer        = null;
let scenes        = [];
let currentIndex  = -1;
let activeSceneId = null;
let started       = false;
let dwellTimer    = null;

let chain = Promise.resolve();
const runExclusive = fn => { chain = chain.then(fn, fn); return chain; };

// ── Gaussian-splat viewer ────────────────────────────────────────────────────

function ensureViewer() {
  if (viewer) return;
  viewer = new GaussianSplats3D.Viewer({
    rootElement: viewerEl,
    cameraUp: [0, -1, 0],
    initialCameraPosition: [0, 0, -3],
    initialCameraLookAt:   [0, 0, 1],
    sharedMemoryForWorkers: false,
  });
  viewer.start();
}

async function swapSplat(plyUrl) {
  ensureViewer();
  const prev = viewer.getSceneCount();
  await viewer.addSplatScene(plyUrl, {
    format: GaussianSplats3D.SceneFormat.Ply,
    splatAlphaRemovalThreshold: 5,
    showLoadingUI: false,
  });
  if (prev > 0) {
    await viewer.removeSplatScenes(
      Array.from({ length: prev }, (_, i) => i), false
    );
  }
  placeholderEl.classList.add("hidden");
}

// ── Fade overlay ─────────────────────────────────────────────────────────────

function fadeOverlay(active) {
  return new Promise(resolve => {
    overlayEl.classList.toggle("active", active);
    setTimeout(resolve, FADE_MS);
  });
}

// ── Scene transition ──────────────────────────────────────────────────────────

function goToIndex(index) {
  return runExclusive(async () => {
    if (index < 0 || index >= scenes.length) return;
    const scene = scenes[index];
    currentIndex = index;
    if (scene.id === activeSceneId) return;

    try {
      await fadeOverlay(true);
      await swapSplat(scene.ply_url);
      activeSceneId = scene.id;
      updateCaption(scene);
      await fadeOverlay(false);
    } catch (err) {
      console.error("Failed to load scene", scene.id, err);
      await fadeOverlay(false);
    }
  });
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function poll() {
  try {
    const res = await fetch("/api/scenes", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    connectionEl.dataset.state = "ok";

    const all = await res.json();
    if (!all.length) return;

    const known = new Set(scenes.map(s => s.id));
    const fresh = all.filter(s => !known.has(s.id));
    if (!fresh.length) return;

    scenes.push(...fresh);

    if (!started) {
      started = true;
      await goToIndex(0);
      scheduleAdvance();
    } else {
      clearTimeout(dwellTimer);
      await goToIndex(scenes.length - 1);
      scheduleAdvance();
    }
  } catch (err) {
    connectionEl.dataset.state = "error";
    console.warn("Backend unreachable:", err.message);
  }
}

function scheduleAdvance() {
  clearTimeout(dwellTimer);
  if (scenes.length < 2) return;
  dwellTimer = setTimeout(async () => {
    await goToIndex((currentIndex + 1) % scenes.length);
    scheduleAdvance();
  }, DWELL_MS);
}

function updateCaption(scene) {
  captionNameEl.textContent   = scene.name   || "Untitled";
  captionAuthorEl.textContent = scene.author ? `shared by ${scene.author}` : "";
  captionEl.classList.remove("hidden");
}

poll();
setInterval(poll, POLL_INTERVAL);
