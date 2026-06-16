import "./viewer.css";
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";

const viewerEl = document.getElementById("viewer");
const placeholderEl = document.getElementById("placeholder");
const overlayEl = document.getElementById("transition-overlay");
const captionEl = document.getElementById("caption");
const captionNameEl = document.getElementById("caption-name");
const captionAuthorEl = document.getElementById("caption-author");
const connectionEl = document.getElementById("connection");

const DWELL_MS = 15000; // how long each memory is shown before advancing
const POLL_INTERVAL_MS = 4000; // how often we check the backend for new uploads
const OVERLAY_TRANSITION_MS = 650;

let viewer = null;
let scenes = []; // ordered list of all known memories (oldest -> newest)
let currentIndex = -1;
let activeSceneId = null;
let started = false;
let dwellTimer = null;

// Serialize every scene swap so two timers never mutate the viewer at once.
let chain = Promise.resolve();
function runExclusive(task) {
  chain = chain.then(task, task);
  return chain;
}

// --- Poll the backend for the full list of memories ---
async function poll() {
  try {
    const response = await fetch("/api/scenes", { cache: "no-store" });
    if (!response.ok) throw new Error(`status ${response.status}`);
    connectionEl.dataset.state = "ok";

    const all = await response.json();
    if (!all.length) return;

    const known = new Set(scenes.map((s) => s.id));
    const fresh = all.filter((s) => !known.has(s.id));
    if (!fresh.length) return;

    scenes.push(...fresh);

    if (!started) {
      // First memories discovered: start the loop from the beginning.
      started = true;
      await goToIndex(0);
      scheduleAdvance();
    } else {
      // A new memory was just uploaded: feature it right away.
      clearTimeout(dwellTimer);
      await goToIndex(scenes.length - 1);
      scheduleAdvance();
    }
  } catch (err) {
    connectionEl.dataset.state = "error";
    console.warn("Could not reach backend:", err.message);
  }
}

// --- Advance to the next memory in the loop ---
function scheduleAdvance() {
  clearTimeout(dwellTimer);
  if (scenes.length < 2) return; // nothing to cycle through
  dwellTimer = setTimeout(async () => {
    const next = (currentIndex + 1) % scenes.length;
    await goToIndex(next);
    scheduleAdvance();
  }, DWELL_MS);
}

function goToIndex(index) {
  return runExclusive(async () => {
    if (index < 0 || index >= scenes.length) return;
    const scene = scenes[index];
    currentIndex = index;
    if (scene.id === activeSceneId) return; // already on screen

    try {
      await fadeOverlay(true);
      await swapToScene(scene.ply_url);
      activeSceneId = scene.id;
      updateCaption(scene);
      await fadeOverlay(false);
    } catch (err) {
      console.error("Failed to load memory", scene.id, err);
      await fadeOverlay(false);
    }
  });
}

// --- One long-lived Viewer; we add the new scene then drop the old ones.
// Recreating the Viewer per swap would leak WebGL contexts and eventually
// black-screen, so we keep a single context alive for the whole session. ---
function ensureViewer() {
  if (viewer) return;
  viewer = new GaussianSplats3D.Viewer({
    rootElement: viewerEl,
    cameraUp: [0, -1, 0],
    initialCameraPosition: [0, 0, -3],
    initialCameraLookAt: [0, 0, 1],
    sharedMemoryForWorkers: false,
  });
  viewer.start();
}

async function swapToScene(plyUrl) {
  ensureViewer();

  const previousCount = viewer.getSceneCount();

  await viewer.addSplatScene(plyUrl, {
    format: GaussianSplats3D.SceneFormat.Ply,
    splatAlphaRemovalThreshold: 5,
    showLoadingUI: false, // the black overlay already covers the load
  });

  // Drop every scene that existed before this one, leaving only the new memory.
  if (previousCount > 0) {
    const stale = Array.from({ length: previousCount }, (_, i) => i);
    await viewer.removeSplatScenes(stale, false);
  }

  placeholderEl.classList.add("hidden");
}

function fadeOverlay(active) {
  return new Promise((resolve) => {
    overlayEl.classList.toggle("active", active);
    setTimeout(resolve, OVERLAY_TRANSITION_MS);
  });
}

function updateCaption(scene) {
  captionNameEl.textContent = scene.name || "Untitled";
  captionAuthorEl.textContent = scene.author ? `shared by ${scene.author}` : "";
  captionEl.classList.remove("hidden");
}

poll();
setInterval(poll, POLL_INTERVAL_MS);
