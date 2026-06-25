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
document.querySelectorAll(".pres-anim").forEach((el) => animObserver.observe(el));

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
fullscreenBtn.addEventListener("click", () => {
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
  let index = 0;

  setInterval(() => {
    slides[index].classList.remove("active");
    dots[index]?.classList.remove("active");
    index = (index + 1) % slides.length;
    slides[index].classList.add("active");
    dots[index]?.classList.add("active");
  }, intervalMs);
}

initAutoSlider("mockup-slider", "mockup-slide", "mockup-dot", 4500);
initAutoSlider("problem-slider", "photo-slide", "photo-dot", 3200);
initAutoSlider("site-drawing-slider", "drawing-slide", "drawing-dot", 4000);
initAutoSlider("pavilion-drawing-slider", "drawing-slide", "drawing-dot", 4000);
