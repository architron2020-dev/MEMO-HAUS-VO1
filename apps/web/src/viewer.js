import "./viewer.css";
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";

const viewerEl      = document.getElementById("viewer");
const placeholderEl = document.getElementById("placeholder");
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
const navHintTabEl       = document.getElementById("nav-hint-tab");
const navHintPanelEl     = document.getElementById("nav-hint-panel");
const navHintCloseEl     = document.getElementById("nav-hint-close");
const worldModeBtnEl     = document.getElementById("world-mode-btn");
const worldDebugEl       = document.getElementById("world-debug");

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
  try { entry.panner.disconnect(); } catch {}
  try { entry.gainNode.disconnect(); } catch {}
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

  // PannerNode handles ONLY left/right angle panning — distance volume is
  // driven manually below so every browser and audio type gets the same result.
  const panner = ctx.createPanner();
  panner.panningModel  = "equalpower"; // broadest device support for angle pan
  panner.distanceModel = "linear";
  panner.refDistance   = 1;
  panner.maxDistance   = 1;           // distance rolloff disabled on panner
  panner.rolloffFactor = 0;           // all volume control goes through gainNode
  if (panner.positionX) {
    panner.positionX.value = worldPos[0];
    panner.positionY.value = worldPos[1];
    panner.positionZ.value = worldPos[2];
  } else {
    panner.setPosition(worldPos[0], worldPos[1], worldPos[2]);
  }

  // GainNode that we update every frame based on camera distance → smooth,
  // dramatic intensity changes for voice, music, and background audio alike.
  const gainNode = ctx.createGain();
  gainNode.gain.value = 1.0;

  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.loop   = true;
  source.connect(panner);
  panner.connect(gainNode);
  gainNode.connect(ctx.destination);
  source.start();

  _activeSources.set(scene.id, { source, panner, gainNode, worldPos: [...worldPos] });
}

// ── Per-frame spatial audio update ────────────────────────────────────────
// Updates listener orientation for L/R pan AND manually drives each source's
// gain based on distance — this is what makes audio louder when you approach
// and quieter as you walk away, for every audio type.

const AUDIO_REF_DIST = 3;   // world units at which gain = 1.0 (full volume)
const AUDIO_MAX_DIST = 70;  // world units at which gain reaches 0
const AUDIO_SMOOTH   = 0.12; // AudioParam time-constant (seconds) for ramping

function updateSpatialAudio() {
  const cam = viewer?.camera;
  if (!_audioCtx || !cam) return;

  // Keep the context alive — resume if the browser suspended it
  if (_audioCtx.state === "suspended") { _audioCtx.resume().catch(() => {}); return; }

  // ── Listener position + orientation (drives L/R pan) ──────────────────
  const { x, y, z } = cam.position;
  const m = cam.matrixWorld.elements;
  const fwdX = -m[8], fwdY = -m[9], fwdZ = -m[10];
  const upX  =  m[4], upY  =  m[5], upZ  =  m[6];
  const L = _audioCtx.listener;
  if (L.positionX) {
    L.positionX.value = x;    L.positionY.value = y;    L.positionZ.value = z;
    L.forwardX.value  = fwdX; L.forwardY.value  = fwdY; L.forwardZ.value  = fwdZ;
    L.upX.value       = upX;  L.upY.value       = upY;  L.upZ.value       = upZ;
  } else {
    L.setPosition(x, y, z);
    L.setOrientation(fwdX, fwdY, fwdZ, upX, upY, upZ);
  }

  // ── Per-source distance gain (drives volume intensity) ─────────────────
  const now = _audioCtx.currentTime;
  for (const { gainNode, worldPos } of _activeSources.values()) {
    const dist = Math.hypot(x - worldPos[0], y - worldPos[1], z - worldPos[2]);
    // Inverse-power curve: full volume within REF_DIST, fades to ~0 at MAX_DIST
    const clamped = Math.max(AUDIO_REF_DIST, Math.min(dist, AUDIO_MAX_DIST));
    const gain    = Math.pow(AUDIO_REF_DIST / clamped, 1.6);
    gainNode.gain.setTargetAtTime(gain, now, AUDIO_SMOOTH);
  }
}

// Temporary — writes status directly into the page since the browser
// console isn't always at hand while testing on the kiosk display itself.
const worldLog = (() => {
  let lines = [];
  return (msg) => {
    lines.push(msg);
    if (lines.length > 10) lines = lines.slice(-10);
    worldDebugEl.textContent = lines.join("\n");
    worldDebugEl.classList.remove("hidden");
    console.log("[memory-verse]", msg);
  };
})();

const DWELL_MS        = 60_000;
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

// ── World of Memories — every scene loaded at once, spread apart in a
// permanent, ever-expanding spiral so new memories just keep finding the
// next free slot instead of needing the whole field rearranged. ────────────

let worldMode = false;
let worldScenes = []; // scenes currently loaded in Memory Verse (may be a subset)
let worldLoadedOrder = []; // scene ids in the same order they were added to the viewer (index = viewer scene index)
const WORLD_SPACING = 50; // wide enough that even large splat extents never bleed into each other
const worldPositions = new Map(); // scene id -> [x, y, z]
let worldPlacementCount = 0;

// Square (Ulam-style) spiral: index 0 at the centre, each ring one step
// further out — grows forever without ever revisiting or overlapping a cell.
function spiralCoord(i) {
  if (i === 0) return [0, 0];
  let x = 0, y = 0;
  let dx = 1, dy = 0;
  let segmentLength = 1, segmentPassed = 0, legsInRing = 0;
  for (let n = 0; n < i; n++) {
    x += dx; y += dy;
    segmentPassed++;
    if (segmentPassed === segmentLength) {
      segmentPassed = 0;
      [dx, dy] = [-dy, dx];
      legsInRing++;
      if (legsInRing % 2 === 0) segmentLength++;
    }
  }
  return [x, y];
}

// Assigns a scene its permanent grid slot the first time it's seen — once
// set, a memory's place in the world never moves again, in this mode or out
// of it, so revisiting the world later still finds everything where it was.
function assignWorldPosition(scene) {
  if (worldPositions.has(scene.id)) return worldPositions.get(scene.id);
  const [gx, gy] = spiralCoord(worldPlacementCount++);
  const pos = [gx * WORLD_SPACING, 0, gy * WORLD_SPACING];
  worldPositions.set(scene.id, pos);
  return pos;
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

  if (storyOverlayTimer) { clearTimeout(storyOverlayTimer); storyOverlayTimer = null; }

  if (scene.story) {
    storyRowEl.style.display = "";
    const c4 = typewrite(captionStoryEl, scene.story, 26);
    cancelTypewriters.push(c4);
    // Also typewrite into the cinematic overlay — but only briefly, so it
    // doesn't sit over the scene and get in the way of free navigation.
    overlayStoryTextEl.textContent = "";
    storyOverlayEl.classList.remove("hidden");
    const c5 = typewrite(overlayStoryTextEl, scene.story, 36);
    cancelTypewriters.push(c5);

    const visibleMs = scene.story.length * 36 + 1200 /* cursor blink */ + 5000 /* reading time */;
    storyOverlayTimer = setTimeout(() => storyOverlayEl.classList.add("hidden"), visibleMs);
  } else {
    storyRowEl.style.display = "none";
    storyOverlayEl.classList.add("hidden");
  }

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

// ── Gaussian viewer ───────────────────────────────────────────────────────

function ensureViewer() {
  if (viewer) return;
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
  });
  viewer.start();

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
    if (worldMode && gumballMode) {
      // Gumball mode: tap selects the nearest scene for moving
      const nearest = findNearestWorldSceneAndId(e.clientX, e.clientY);
      if (nearest) selectGumballScene(nearest.id);
      else deselectGumball();
    } else if (worldMode) {
      const target = findNearestWorldScene(e.clientX, e.clientY);
      if (target) flyToScene(target);
      else flyToWorldOverview();
    } else {
      resetCamera();
    }
  }
  _dragging = false;
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
function flyToScene(targetPos) {
  if (!viewer?.camera) return;
  if (resetRaf) cancelAnimationFrame(resetRaf);

  const cam = viewer.camera;
  const sp  = { x: cam.position.x, y: cam.position.y, z: cam.position.z };

  let appX = sp.x - targetPos[0];
  let appZ = sp.z - targetPos[2];
  const appLen = Math.hypot(appX, appZ) || 1;
  appX /= appLen; appZ /= appLen;

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

// Computes a camera position/angle that frames all currently-placed Memory
// Verse scenes in one overview shot. Falls back gracefully when no scenes
// are placed yet or the world set is empty.
function worldOverviewPos() {
  const positions = worldScenes.length
    ? worldScenes.map(s => worldPositions.get(s.id)).filter(Boolean)
    : [...worldPositions.values()];

  if (positions.length === 0) return { x: 0, y: 0, z: -8, yaw: 0, pitch: 0.1 };

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [px, , pz] of positions) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const spread = Math.max(maxX - minX, maxZ - minZ);
  // Pull back far enough to see the whole spread; minimum 8 units.
  const pullback = Math.max(spread * 0.7 + WORLD_SPACING * 0.5, 8);
  return { x: cx, y: 0, z: cz - pullback, yaw: 0, pitch: 0.1 };
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

const WORLD_CLICK_RADIUS_PX = 260;

function findNearestWorldScene(clickX, clickY) {
  let best = null, bestDist = Infinity;
  for (const scene of scenes) {
    const pos = worldPositions.get(scene.id);
    if (!pos) continue;
    const screen = projectToScreen(pos);
    if (!screen) continue;
    const d = Math.hypot(screen.x - clickX, screen.y - clickY);
    if (d < bestDist) { bestDist = d; best = pos; }
  }
  return bestDist <= WORLD_CLICK_RADIUS_PX ? best : null;
}

// Same as findNearestWorldScene but returns { pos, id } for gumball use.
function findNearestWorldSceneAndId(clickX, clickY) {
  let best = null, bestDist = Infinity;
  for (const scene of scenes) {
    const pos = worldPositions.get(scene.id);
    if (!pos) continue;
    const screen = projectToScreen(pos);
    if (!screen) continue;
    const d = Math.hypot(screen.x - clickX, screen.y - clickY);
    if (d < bestDist) { bestDist = d; best = { pos, id: scene.id }; }
  }
  return bestDist <= WORLD_CLICK_RADIUS_PX ? best : null;
}

// ── World of Memories — enter / exit ────────────────────────────────────────

// sceneIds: optional explicit subset (from the mobile app's multi-select).
// Omitted entirely -> every known scene, same as the viewer's own button.
// Loading a curated handful instead of everything is also what keeps this
// smooth — two dozen scenes (some of them giant stitched merges) at once is
// what made navigation laggy in the first place.
function buildWorldMode(sceneIds) {
  const targetScenes = sceneIds
    ? scenes.filter(s => sceneIds.includes(s.id))
    : scenes;
  if (targetScenes.length === 0) return;
  worldScenes = targetScenes;

  const wasAlreadyIn = worldMode;
  worldMode = true;
  worldLoadedOrder = [];
  worldModeBtnEl.textContent = "Exit Memory Verse";
  worldModeBtnEl.classList.add("active");
  gumballBtnEl.classList.remove("hidden");
  stopDwell();
  hideHud();

  return runExclusive(async () => {
    worldLog(
      wasAlreadyIn
        ? `Rebuilding Memory Verse — ${targetScenes.length} memories selected.`
        : `Entering Memory Verse — ${targetScenes.length} memories to place.`
    );
    await overlayTo(1);

    try {
      await removeAllScenes();
    } catch (err) {
      console.error("Failed clearing scenes before (re)entering the world:", err);
    }
    placeholderEl.classList.add("hidden");
    ensureViewer();

    // addSplatScenes() downloads every file in parallel before anything
    // renders — fine for 2-3 scenes, but with a couple dozen (some of them
    // multi-hundred-MB stitched merges) it just hangs on the browser's
    // connection limit instead of ever resolving. Loading one at a time
    // means the first memory appears almost immediately, and the rest keep
    // streaming in afterward without blocking anything already visible.
    let loadedCount = 0;
    for (const s of targetScenes) {
      const position = assignWorldPosition(s);
      const label = s.year ? `${s.name || "Untitled"}, ${s.year}` : (s.name || "Untitled");
      try {
        await withLoadRetry(() => viewer.addSplatScene(s.ply_url, {
          format: GaussianSplats3D.SceneFormat.Ply,
          splatAlphaRemovalThreshold: 5,
          showLoadingUI: false,
          position,
        }));
        loadedCount++;
        worldLoadedOrder.push(s.id);
        worldLog(`${loadedCount}/${targetScenes.length} — ${label}`);
      } catch (err) {
        worldLog(`Skipped "${label}" (failed to load)`);
      }

      // Reveal as soon as the very first scene is in, instead of making
      // the visitor wait for all of them — the rest populate live.
      if (loadedCount === 1) {
        if (viewer?.camera) {
          // Place camera at a computed overview position so all selected
          // scenes are in view — not a hardcoded origin that ignores where
          // the spiral actually placed the chosen subset.
          const { x, y, z, yaw, pitch } = worldOverviewPos();
          viewer.camera.position.set(x, y, z);
          _yaw = yaw;
          _pitch = pitch;
          applyFPSCamera();
        }
        overlayEl.style.transition = "opacity 1200ms ease-in";
        overlayEl.style.opacity = "0";
        await new Promise(r => setTimeout(r, 1200));
      }
    }
    worldLog(`All ${loadedCount} memories are in the world.`);
    setTimeout(() => worldDebugEl.classList.add("hidden"), 1800);

    // Start spatial audio for every scene that has one — each plays from
    // its own world position, so proximity and head-turn drive volume/pan.
    for (const s of targetScenes) {
      const pos = worldPositions.get(s.id) || [0, 0, 0];
      playSceneAudio(s, pos);
    }
  });
}

function enterWorldMode() {
  if (worldMode || scenes.length === 0) return;
  return buildWorldMode(null);
}

function exitWorldMode() {
  if (!worldMode) return;
  worldMode = false;
  worldScenes = [];
  worldLoadedOrder = [];
  gumballMode = false;
  deselectGumball();
  gumballBtnEl.classList.add("hidden");
  gumballBtnEl.classList.remove("active");
  stopAllAudio();
  worldModeBtnEl.textContent = "Enter Memory Verse";
  worldModeBtnEl.classList.remove("active");

  return runExclusive(async () => {
    await overlayTo(1);

    try {
      await removeAllScenes();
    } catch (err) {
      console.error("Failed clearing the world on exit:", err);
    }
    activeSceneId = null; // force the next goToIndex to actually (re)load a scene
    await overlayTo(0);
    goToIndex(currentIndex >= 0 ? currentIndex : 0);
  });
}

worldModeBtnEl.addEventListener("click", () => {
  if (worldMode) exitWorldMode();
  else enterWorldMode();
});

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
    const [scenesRes, stitchedRes] = await Promise.all([
      fetch("/api/scenes", { cache: "no-store" }),
      fetch("/api/stitched-scenes", { cache: "no-store" }).catch(() => null),
    ]);
    if (!scenesRes.ok) throw new Error(`HTTP ${scenesRes.status}`);
    clearTimeout(errorTimer);
    connectionEl.dataset.state = "";

    const individual = await scenesRes.json();
    const stitched = stitchedRes && stitchedRes.ok ? await stitchedRes.json() : [];
    const all = [...individual, ...stitched];
    if (!all.length) return;
    const known = new Set(scenes.map(s => s.id));
    const fresh = all.filter(s => !known.has(s.id));
    if (!fresh.length) return;
    scenes.push(...fresh);
    worldModeBtnEl.disabled = false;
    // Permanent world placement is assigned the moment a scene is known,
    // regardless of which mode is active — so a memory's spot never shifts.
    fresh.forEach(assignWorldPosition);

    if (worldMode) {
      // Add newly-arrived memories straight into the world, in place,
      // without disturbing whatever's already there or anyone exploring it.
      for (const s of fresh) {
        if (!viewer) break;
        try {
          await withLoadRetry(() => viewer.addSplatScene(s.ply_url, {
            format: GaussianSplats3D.SceneFormat.Ply,
            splatAlphaRemovalThreshold: 5,
            position: worldPositions.get(s.id),
            showLoadingUI: false,
          }));
        } catch (err) {
          console.error("Failed adding new memory to the world:", err);
        }
      }
    } else if (!started) {
      started = true;
      goToIndex(0);
    } else {
      goToIndex(scenes.length - 1);
    }
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

    if (worldMode) {
      // Same remote-select gesture, but inside the world it flies the
      // camera to that memory's spot instead of switching the single scene.
      const pos = worldPositions.get(scenes[index].id);
      if (pos) flyToScene(pos);
    } else {
      goToIndex(index);
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

// The intro splash's Start button is the explicit version of that same
// gesture — also dismisses the placeholder immediately rather than waiting
// for a scene to load, in case scenes are already loaded and it just never
// got hidden (or there simply aren't any yet).
const splashStartBtn = document.getElementById("splash-start-btn");
splashStartBtn?.addEventListener("click", () => {
  enterFullscreen();
  placeholderEl.classList.add("hidden");
});

// Manual toggle for testing/operator use
document.addEventListener("keydown", e => {
  if (e.code === "KeyF") toggleFullscreen();
});

// ── Gumball — scene position tool ────────────────────────────────────────
// Active only while Memory Verse is open. Clicking the ⊕ MOVE button enters
// move mode; tapping a scene selects it; dragging the red X or blue Z handle
// repositions that scene. On drag-end the scene is removed and re-added at
// the new position so the GPU data is rebuilt correctly.

const gumballBtnEl     = document.getElementById("gumball-btn");
const gumballOverlayEl = document.getElementById("gumball-overlay");
const gumballCenterEl  = document.getElementById("gumball-center");
const gumballXEl       = document.getElementById("gumball-x-handle");
const gumballZEl       = document.getElementById("gumball-z-handle");
const gumballLabelEl   = document.getElementById("gumball-label");

let gumballMode         = false;
let gumballSelectedId   = null;   // scene id currently being moved
let gumballDragAxis     = null;   // "x" | "z" | null
let gumballDragStart    = null;   // { clientX, clientY }
let gumballDragOrigin   = null;   // original [x,y,z] before this drag

// Pixels-to-world-units scale at the distance of the selected scene.
function screenToWorldScale(worldPos) {
  if (!viewer?.camera) return 0.02;
  const cam = viewer.camera;
  const dist = Math.hypot(
    cam.position.x - worldPos[0],
    cam.position.y - worldPos[1],
    cam.position.z - worldPos[2]
  );
  const fovRad = ((cam.fov || 75) * Math.PI) / 180;
  const focalPx = (viewerEl.clientHeight / 2) / Math.tan(fovRad / 2);
  return dist / focalPx;
}

function deselectGumball() {
  gumballSelectedId = null;
  gumballOverlayEl.classList.add("hidden");
}

function selectGumballScene(sceneId) {
  const scene = worldScenes.find(s => s.id === sceneId);
  if (!scene) return;
  gumballSelectedId = sceneId;
  gumballLabelEl.textContent = (scene.name || "Untitled").toUpperCase();
  gumballOverlayEl.classList.remove("hidden");
}

// Updates handle screen positions every frame while gumball is active.
function updateGumballOverlay() {
  if (!gumballMode || !gumballSelectedId || !worldMode) return;
  const pos = worldPositions.get(gumballSelectedId);
  if (!pos) return;
  const screen = projectToScreen(pos);
  if (!screen) { gumballOverlayEl.classList.add("hidden"); return; }
  gumballOverlayEl.classList.remove("hidden");

  const HANDLE_OFFSET = 72; // px from center to each axis handle
  gumballCenterEl.style.cssText = `left:${screen.x}px;top:${screen.y}px`;
  gumballXEl.style.cssText      = `left:${screen.x + HANDLE_OFFSET}px;top:${screen.y}px`;
  gumballZEl.style.cssText      = `left:${screen.x}px;top:${screen.y - HANDLE_OFFSET}px`;
  gumballLabelEl.style.cssText  = `left:${screen.x}px;top:${screen.y}px`;
}

// After a drag ends, remove the scene at its old viewer index and re-add
// at the updated worldPosition — the only reliable way to move a loaded splat.
async function commitGumballMove() {
  if (!gumballSelectedId) return;
  const id    = gumballSelectedId;
  const scene = worldScenes.find(s => s.id === id);
  if (!scene) return;

  const newPos    = worldPositions.get(id);
  const vIndex    = worldLoadedOrder.indexOf(id);
  if (vIndex === -1) return;

  await runExclusive(async () => {
    try {
      await withLoadRetry(() => viewer.removeSplatScenes([vIndex], false));
      worldLoadedOrder.splice(vIndex, 1);
    } catch (err) { console.error("Gumball remove failed:", err); return; }

    try {
      await withLoadRetry(() => viewer.addSplatScene(scene.ply_url, {
        format: GaussianSplats3D.SceneFormat.Ply,
        splatAlphaRemovalThreshold: 5,
        showLoadingUI: false,
        position: newPos,
      }));
      worldLoadedOrder.push(id);
    } catch (err) { console.error("Gumball re-add failed:", err); }
  });
}

// ── Handle drag listeners ──────────────────────────────────────────────────

function startHandleDrag(axis, e) {
  e.stopPropagation();
  if (!gumballSelectedId) return;
  gumballDragAxis  = axis;
  gumballDragStart = { x: e.clientX, y: e.clientY };
  gumballDragOrigin = [...(worldPositions.get(gumballSelectedId) || [0,0,0])];
  e.currentTarget.setPointerCapture(e.pointerId);
}

function onHandlePointerMove(e) {
  if (!gumballDragAxis || !gumballSelectedId) return;
  if (!viewer?.camera) return;

  const dx = e.clientX - gumballDragStart.x;
  const dy = e.clientY - gumballDragStart.y;
  const scale = screenToWorldScale(worldPositions.get(gumballSelectedId));
  const m = viewer.camera.matrixWorld.elements;

  if (gumballDragAxis === "x") {
    // Map screen-X drag → world movement along the camera's right vector
    const rightX = m[0], rightZ = m[2];
    worldPositions.set(gumballSelectedId, [
      gumballDragOrigin[0] + dx * scale * rightX,
      gumballDragOrigin[1],
      gumballDragOrigin[2] + dx * scale * rightZ,
    ]);
  } else {
    // Map screen-Y drag (up = forward) → world movement along camera's forward vector
    const fwdX = -m[8], fwdZ = -m[10];
    worldPositions.set(gumballSelectedId, [
      gumballDragOrigin[0] + (-dy) * scale * fwdX,
      gumballDragOrigin[1],
      gumballDragOrigin[2] + (-dy) * scale * fwdZ,
    ]);
  }
}

function onHandlePointerUp() {
  if (!gumballDragAxis) return;
  gumballDragAxis = null;
  commitGumballMove();
}

[gumballXEl, gumballZEl].forEach(el => {
  el.addEventListener("pointerdown", e => startHandleDrag(el.dataset.axis, e));
  el.addEventListener("pointermove", onHandlePointerMove);
  el.addEventListener("pointerup",   onHandlePointerUp);
  el.addEventListener("pointercancel", onHandlePointerUp);
});

gumballBtnEl.addEventListener("click", () => {
  if (!worldMode) return;
  gumballMode = !gumballMode;
  gumballBtnEl.classList.toggle("active", gumballMode);
  if (!gumballMode) deselectGumball();
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

function flyLoop() {
  requestAnimationFrame(flyLoop);
  updateSpatialAudio();
  updateGumballOverlay();
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

navHintTabEl.addEventListener("click", () => navHintPanelEl.classList.toggle("hidden"));
navHintCloseEl.addEventListener("click", () => navHintPanelEl.classList.add("hidden"));

// ── Custom cursor ─────────────────────────────────────────────────────────
// The native cursor is hidden globally (kiosk look) — this reticle div takes
// its place, positioned directly from clientX/clientY on every move, so it's
// always obvious exactly where a click will land.

document.addEventListener("pointermove", e => {
  cursorReticleEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  const overClickable = e.target.closest("button, a, [role='button']");
  cursorReticleEl.classList.toggle("hoverable", !!overClickable);
});

document.addEventListener("pointerdown", e => {
  cursorReticleEl.classList.add("pressed");
  spawnClickPing(e.clientX, e.clientY);
});
document.addEventListener("pointerup", () => cursorReticleEl.classList.remove("pressed"));

function spawnClickPing(x, y) {
  const ping = document.createElement("div");
  ping.className = "click-ping";
  ping.style.left = `${x}px`;
  ping.style.top  = `${y}px`;
  document.body.appendChild(ping);
  ping.addEventListener("animationend", () => ping.remove());
}

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
