import "./viewer.css";
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";

const viewerEl      = document.getElementById("viewer");
const placeholderEl = document.getElementById("placeholder");
const overlayEl     = document.getElementById("transition-overlay");
const hudEl         = document.getElementById("scene-hud");
const captionNameEl = document.getElementById("caption-name");
const captionAuthEl = document.getElementById("caption-author");
const authorRowEl   = document.getElementById("author-row");
const connectionEl  = document.getElementById("connection");
const loaderEl      = document.getElementById("processing-loader");
const timerArcEl    = document.getElementById("timer-arc");

const DWELL_MS        = 60_000;
const POLL_INTERVAL   = 4_000;
const STATUS_INTERVAL = 3_000;
const OVERLAY_FADE_MS = 480;
const ERROR_SHOW_MS   = 4_000;
const TIMER_C         = 62.8;   // 2π × 10

let viewer        = null;
let scenes        = [];
let currentIndex  = -1;
let activeSceneId = null;
let started       = false;
let errorTimer    = null;

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
    img.crossOrigin = "anonymous";
    img.onload = () => {
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
    };
    img.onerror = () => resolve([100, 200, 255]);
    img.src = imageUrl;
  });
}

function applyHudColor([r, g, b]) {
  hudEl.style.setProperty("--hc", `${r}, ${g}, ${b}`);
  // Update the SVG arc glow filter inline (CSS filter can't use rgba vars)
  timerArcEl.style.filter = `drop-shadow(0 0 4px rgba(${r},${g},${b},0.65))`;
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

  captionNameEl.textContent = "";
  captionAuthEl.textContent = "";
  hudEl.classList.remove("hidden");

  // Stagger: name first, then author 300ms later
  const c1 = typewrite(captionNameEl, (scene.name || "Untitled").toUpperCase(), 55);
  cancelTypewriters.push(c1);
  if (scene.author) {
    authorRowEl.style.display = "";
    const c2 = typewrite(captionAuthEl, (scene.author).toUpperCase(), 48);
    cancelTypewriters.push(c2);
  } else {
    authorRowEl.style.display = "none";
  }

  // Start dwell ring once text starts appearing
  startDwell(onDwellEnd);
}

function hideHud() {
  clearTypewriters();
  hudEl.classList.add("hidden");
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

// ── Gaussian viewer ───────────────────────────────────────────────────────

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

// ── Transition ────────────────────────────────────────────────────────────

async function transitionTo(scene) {
  const oldCount = viewer ? viewer.getSceneCount() : 0;

  hideHud();
  await overlayTo(1);

  if (oldCount > 0 && viewer) {
    await viewer.removeSplatScenes(
      Array.from({ length: oldCount }, (_, i) => i), false
    );
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
      activeSceneId = scene.id;
      const advance = () => {
        if (scenes.length < 2) {
          // Only one scene — restart the dwell
          showHud(scene, advance);
        } else {
          goToIndex((currentIndex + 1) % scenes.length);
        }
      };
      if (loadPromise) {
        loadPromise.then(() => showHud(scene, advance)).catch(() => showHud(scene, advance));
      } else {
        showHud(scene, advance);
      }
    } catch (err) {
      console.error("Transition failed:", err);
    }
  });
}

// ── Polling ───────────────────────────────────────────────────────────────

async function poll() {
  try {
    const res = await fetch("/api/scenes", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    clearTimeout(errorTimer);
    connectionEl.dataset.state = "";

    const all   = await res.json();
    if (!all.length) return;
    const known = new Set(scenes.map(s => s.id));
    const fresh = all.filter(s => !known.has(s.id));
    if (!fresh.length) return;
    scenes.push(...fresh);
    if (!started) { started = true; goToIndex(0); }
    else goToIndex(scenes.length - 1);
  } catch (err) {
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

// ── Boot ──────────────────────────────────────────────────────────────────

poll();
setInterval(poll, POLL_INTERVAL);
setInterval(pollStatus, STATUS_INTERVAL);
