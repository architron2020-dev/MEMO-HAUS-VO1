// Fully standalone — no build step, no bundler, no shared imports with
// apps/web. Just open this file's index.html (or serve the folder) directly.

const deck = document.getElementById("pres-deck");
const slides = Array.from(document.querySelectorAll(".pres-slide"));
const dotsEl = document.getElementById("pres-dots");

// ── Cursor (same flat mark as the main app) ────────────────────────────────

const cursorEl = document.getElementById("cursor-reticle");
document.addEventListener("pointermove", (e) => {
  cursorEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  const overClickable = e.target.closest("button, a, .pres-dot");
  cursorEl.classList.toggle("hoverable", !!overClickable);
});
document.addEventListener("pointerdown", () => cursorEl.classList.add("pressed"));
document.addEventListener("pointerup", () => cursorEl.classList.remove("pressed"));

// ── Per-element entrance animation ──────────────────────────────────────────

const animObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) entry.target.classList.add("in-view");
    }
  },
  { root: deck, threshold: 0.3 },
);
const _animEls = document.querySelectorAll(".pres-anim");
_animEls.forEach((el) => animObserver.observe(el));

// Safety net: some mobile browsers are inconsistent about firing
// IntersectionObserver callbacks reliably inside a custom scroll container
// (root: deck) — when it doesn't fire, .pres-anim elements are stuck at
// opacity:0 forever (see the base rule above), which is exactly what made
// the site/pavilion drawings and their captions invisible on mobile even
// though the images themselves loaded fine. This doesn't replace the
// observer — it just guarantees nothing stays permanently invisible if the
// observer never reports an element as intersecting.
setTimeout(() => {
  _animEls.forEach((el) => el.classList.add("in-view"));
}, 2500);

// ── Slide dots — one per slide, click to jump, highlight whichever is in view ──

slides.forEach((slide, i) => {
  const dot = document.createElement("div");
  dot.className = "pres-dot";
  dot.title = slide.id;
  dot.addEventListener("click", () => slide.scrollIntoView({ behavior: "smooth" }));
  dotsEl.appendChild(dot);
});
const dotEls = Array.from(dotsEl.children);

const navLinks = Array.from(document.querySelectorAll(".pres-nav-links a"));

const slideObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const i = slides.indexOf(entry.target);
        dotEls.forEach((d, di) => d.classList.toggle("active", di === i));
        navLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${entry.target.id}`));
      }
    }
  },
  { root: deck, threshold: 0.6 },
);
slides.forEach((s) => slideObserver.observe(s));

// ── Keyboard navigation — Arrow/Page keys step between slides ───────────────

function currentSlideIndex() {
  const active = dotEls.findIndex((d) => d.classList.contains("active"));
  return active === -1 ? 0 : active;
}

document.addEventListener("keydown", (e) => {
  const i = currentSlideIndex();
  if (["ArrowDown", "PageDown"].includes(e.code)) {
    e.preventDefault();
    slides[Math.min(slides.length - 1, i + 1)].scrollIntoView({ behavior: "smooth" });
  } else if (["ArrowUp", "PageUp"].includes(e.code)) {
    e.preventDefault();
    slides[Math.max(0, i - 1)].scrollIntoView({ behavior: "smooth" });
  }
});

// ── Fullscreen toggle ────────────────────────────────────────────────────────

const fullscreenBtn = document.getElementById("fullscreen-btn");
fullscreenBtn?.addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
});

// ── Tech pills — click to show a plain-language description ────────────────

const techDescEl = document.getElementById("tech-desc");
document.querySelectorAll(".pres-tag").forEach((tag) => {
  tag.addEventListener("click", () => {
    const alreadyActive = tag.classList.contains("active");
    document.querySelectorAll(".pres-tag").forEach((t) => t.classList.remove("active"));
    if (alreadyActive) {
      techDescEl.textContent = "";
    } else {
      tag.classList.add("active");
      techDescEl.textContent = tag.dataset.desc;
    }
  });
});

// ── Auto-advancing slider — shared by the mockup slider and the problem
// slide's photo slideshow. Cycles through .<prefix>-slide/.<prefix>-dot
// pairs, looping forever.

function initAutoSlider(containerId, slideClass, dotClass, intervalMs) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const slides = Array.from(container.querySelectorAll(`.${slideClass}`));
  const dots = Array.from(container.querySelectorAll(`.${dotClass}`));
  if (!slides.length) return;
  let index = Math.max(0, slides.findIndex((s) => s.classList.contains("active")));
  let timer = null;

  function show(i) {
    slides[index].classList.remove("active");
    dots[index]?.classList.remove("active");
    index = ((i % slides.length) + slides.length) % slides.length;
    slides[index].classList.add("active");
    dots[index]?.classList.add("active");
  }

  function restart() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => show(index + 1), intervalMs);
  }

  restart();

  // Tap/click anywhere on the slide to jump to the next one; tapping a
  // specific dot jumps straight to that slide. Either way resets the
  // auto-advance timer so it doesn't immediately flip again right after.
  container.addEventListener("click", (e) => {
    const dotIdx = dots.indexOf(e.target);
    show(dotIdx !== -1 ? dotIdx : index + 1);
    restart();
  });
}

initAutoSlider("mockup-slider", "mockup-slide", "mockup-dot", 4500);
initAutoSlider("problem-slider", "photo-slide", "photo-dot", 3200);
initAutoSlider("site-drawing-slider", "drawing-slide", "drawing-dot", 4000);
initAutoSlider("pavilion-drawing-slider", "drawing-slide", "drawing-dot", 4000);
