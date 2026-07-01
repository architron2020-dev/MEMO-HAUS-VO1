// Dark/light theme toggle, shared across every page (upload, contribute,
// memories, and the viewer). The actual theme attribute is already applied
// pre-paint by the inline script in each page's <head> — this just keeps the
// switch position in sync and persists future choices. The logo is an inline
// <svg> styled with `rgb(var(--hc))`/`var(--page-bg)`, so it re-colours
// itself automatically on theme change — no JS needed for that anymore.

export function initThemeToggle() {
  const input = document.getElementById("theme-switch-input");
  if (!input) return;

  function sync() {
    input.checked = document.documentElement.dataset.theme === "light";
  }
  sync();

  input.addEventListener("change", () => {
    const next = input.checked ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("memo-theme", next);
    sync();
  });
}

// Carries this tab's randomly-picked accent colour along to the viewer when
// you open it from here, so the viewer tab's icon matches the mobile tab you
// came from instead of landing on yet another random colour of its own.
export function carryAccentToViewerLinks() {
  const rgb = window.__memoAccentRgb;
  if (!rgb) return;
  document.querySelectorAll('a[href^="/viewer.html"]').forEach((a) => {
    a.href = `/viewer.html?accent=${rgb.join(",")}`;
  });
}

// Custom cursor — native cursor is hidden (cursor:none), this reticle div
// takes its place, coloured by --hc so it matches whichever accent this
// tab picked. Same logic the viewer already uses.
export function initCursor() {
  const cursorEl = document.getElementById("cursor-reticle");
  if (!cursorEl) return;

  document.addEventListener("pointermove", (e) => {
    cursorEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    const overClickable = e.target.closest("button, a, input, textarea, [role='button']");
    cursorEl.classList.toggle("hoverable", !!overClickable);
  });

  document.addEventListener("pointerdown", (e) => {
    cursorEl.classList.add("pressed");
    spawnClickPing(e.clientX, e.clientY);
  });
  document.addEventListener("pointerup", () => cursorEl.classList.remove("pressed"));

  function spawnClickPing(x, y) {
    const ping = document.createElement("div");
    ping.className = "click-ping";
    ping.style.left = `${x}px`;
    ping.style.top = `${y}px`;
    document.body.appendChild(ping);
    ping.addEventListener("animationend", () => ping.remove());
  }
}

// Intro splash — sits in front of everything until the visitor actually
// taps through it. Deliberately not a timed auto-fade: a kiosk/shared-device
// app should wait for a real gesture, not assume everyone reads at the
// same pace.
export function initSplash() {
  const splash = document.getElementById("app-splash");
  const btn = document.getElementById("splash-start-btn");
  if (!splash || !btn) return;
  btn.addEventListener("click", () => {
    splash.classList.add("hidden");
    // Must happen inside this click handler — fullscreen requests are only
    // honoured directly off a user gesture. Some mobile browsers (notably
    // iOS Safari) don't support it at all, so a rejection here is expected
    // and harmless; the app works the same either way.
    document.documentElement.requestFullscreen?.().catch(() => {});
  });
}

// Manual fullscreen toggle — a fallback for when the splash auto-request
// didn't fire (browser doesn't support it, or the visitor exited fullscreen
// later and wants back in).
export function initFullscreenToggle() {
  const btn = document.getElementById("fullscreen-toggle-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  });
}

const FS_KEY = "memo-fullscreen";

// Persist fullscreen across page navigations. Call on every page.
// When the user enters fullscreen, the preference is saved; when they exit
// via ESC or the toggle button it is cleared. On pages without a splash,
// the first tap the visitor makes will restore fullscreen automatically.
export function initFullscreenPersistence() {
  // Distinguish navigation-triggered exit from user-triggered exit.
  // When the user navigates away the browser exits fullscreen automatically
  // (pagehide fires first), so we must NOT clear the pref in that case.
  let navigating = false;
  window.addEventListener("pagehide", () => { navigating = true; });

  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) {
      localStorage.setItem(FS_KEY, "1");
    } else if (!navigating) {
      // User intentionally exited (ESC or toggle button) — forget the pref.
      localStorage.removeItem(FS_KEY);
    }
  });

  if (localStorage.getItem(FS_KEY) !== "1") return;
  if (document.fullscreenElement) return;

  // Try immediately — works on some Android Chrome builds after a
  // same-origin fullscreen navigation; silently fails elsewhere.
  document.documentElement.requestFullscreen?.().catch(() => {});

  // Reliable fallback: restore on the very first tap on this page,
  // which is always a genuine user gesture the browser will honour.
  document.addEventListener("click", function restore() {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }, { once: true, capture: true });
}

// Tap/click feedback sound — a tiny synthesized "tick", not an audio file,
// so there's nothing to load or fail to load. AudioContext can't start
// until a user gesture happens anyway, which a click already is, so it's
// created lazily on the very first tap rather than up front.
let _audioCtx = null;

function tickSound(freq = 740, duration = 0.045, gainPeak = 0.05) {
  if (!_audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _audioCtx = new AC();
  }
  if (_audioCtx.state === "suspended") _audioCtx.resume();

  const osc = _audioCtx.createOscillator();
  const gain = _audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;

  const now = _audioCtx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(gainPeak, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain);
  gain.connect(_audioCtx.destination);
  osc.start(now);
  osc.stop(now + duration);
}

export function initTapSounds() {
  document.addEventListener("click", (e) => {
    const target = e.target.closest(
      "button, a, input[type='checkbox'], .theme-switch, [role='button']"
    );
    if (!target) return;
    // Slightly higher pitch for the theme switch flipping on, lower for off —
    // a small bit of character instead of one identical tick for everything.
    if (target.matches(".theme-switch")) {
      const input = target.querySelector("input");
      tickSound(input?.checked ? 880 : 600);
    } else {
      tickSound();
    }
  });
}
