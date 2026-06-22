import "./contribute.css";

// ── DOM refs ────────────────────────────────────────────────────────────

const gapBrowserEl   = document.getElementById("gap-browser");
const gapStatusEl     = document.getElementById("gap-status");
const gapListEl       = document.getElementById("gap-list");
const formSectionEl  = document.getElementById("contribute-form-section");
const backBtn        = document.getElementById("back-to-gaps");
const pageBackBtn    = document.getElementById("page-back");
const targetLocationEl = document.getElementById("target-location");
const targetDecadeEl   = document.getElementById("target-decade");

const form = document.getElementById("contribute-form");
const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const authorInput = document.getElementById("author-input");
const yearInput = document.getElementById("year-input");
const storyInput = document.getElementById("story-input");
const uploadButton = document.getElementById("upload-button");
const statusEl = document.getElementById("status");
const imagePreview = document.getElementById("image-preview");
const dropzoneHint = document.getElementById("dropzone-hint");
const charCounter = document.getElementById("char-counter");
const generatingOverlay = document.getElementById("generating-overlay");
const genTextContent = document.getElementById("gen-text-content");
const genPercentEl = document.getElementById("gen-percent");

const dotAuthor = document.getElementById("dot-author");
const dotYear   = document.getElementById("dot-year");
const dotStory  = document.getElementById("dot-story");

let selectedFile = null;
let targetLocationLabel = "";   // becomes the "name" field on submit

// ── Gap browser ───────────────────────────────────────────────────────────

async function loadGaps() {
  try {
    const res = await fetch("/api/clusters", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderGaps(Object.values(data.locations || {}));
  } catch (err) {
    console.error(err);
    gapStatusEl.textContent = "Could not reach the archive — try again shortly.";
  }
}

function renderGaps(locations) {
  const withGaps = locations.filter(loc => (loc.gaps || []).length > 0);

  if (withGaps.length === 0) {
    gapStatusEl.textContent = "";
    gapListEl.innerHTML = `<p class="gap-empty">Every known era of every documented place is currently covered.<br>You can still add a brand-new memory from the main page.</p>`;
    return;
  }

  gapStatusEl.textContent = `${withGaps.length} place${withGaps.length > 1 ? "s" : ""} have memories missing from a time period:`;

  gapListEl.innerHTML = "";
  for (const loc of withGaps) {
    const covered = Object.entries(loc.decades || {})
      .filter(([, bucket]) => bucket.scene_ids?.length)
      .map(([decade]) => decade)
      .sort();

    const card = document.createElement("div");
    card.className = "gap-card";
    card.innerHTML = `
      <p class="gap-card-location">${escapeHtml(loc.location_label)}</p>
      <p class="gap-card-covered">Have memories from: ${covered.join(", ") || "none yet"}</p>
      ${loc.gaps.map(decade => `
        <div class="gap-decade-row">
          <span class="gap-decade-label">Missing — ${decade}</span>
          <button type="button" class="gap-decade-fill-btn" data-location="${escapeHtml(loc.location_label)}" data-decade="${decade}">
            I have one
          </button>
        </div>
      `).join("")}
    `;
    gapListEl.appendChild(card);
  }

  gapListEl.querySelectorAll(".gap-decade-fill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      openContributeForm(btn.dataset.location, btn.dataset.decade);
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ── View switching ───────────────────────────────────────────────────────

function openContributeForm(locationLabel, decade) {
  targetLocationLabel = locationLabel;
  targetLocationEl.textContent = locationLabel;
  targetDecadeEl.textContent = decade;

  // Hint the expected year range without forcing it
  const decadeStart = parseInt(decade, 10);
  if (!Number.isNaN(decadeStart)) {
    yearInput.placeholder = `e.g. ${decadeStart + 2}`;
  }

  gapBrowserEl.classList.add("hidden");
  formSectionEl.classList.remove("hidden");
}

backBtn.addEventListener("click", () => {
  formSectionEl.classList.add("hidden");
  gapBrowserEl.classList.remove("hidden");
});

pageBackBtn?.addEventListener("click", () => {
  if (window.history.length > 1) window.history.back();
  else window.location.href = "/index.html";
});

// ── Field dots + char counter (same pattern as the main upload page) ──────

function wireFieldDot(input, dot) {
  input.addEventListener("input", () => {
    dot.classList.toggle("filled", input.value.trim().length > 0);
  });
}
wireFieldDot(authorInput, dotAuthor);
wireFieldDot(yearInput, dotYear);
wireFieldDot(storyInput, dotStory);

storyInput.addEventListener("input", () => {
  const len = storyInput.value.length;
  charCounter.textContent = `${len} / 280`;
  charCounter.classList.toggle("near-limit", len >= 250);
});

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0] ?? null;
  uploadButton.disabled = !selectedFile;

  if (selectedFile) {
    imagePreview.src = URL.createObjectURL(selectedFile);
    imagePreview.classList.add("visible");
    dropzoneHint.classList.add("hidden");
    dropzone.classList.remove("scanning");
    requestAnimationFrame(() => dropzone.classList.add("scanning"));
    setTimeout(() => dropzone.classList.remove("scanning"), 1200);
  } else {
    imagePreview.classList.remove("visible");
    dropzoneHint.classList.remove("hidden");
    dropzone.classList.remove("scanning");
  }
});

// ── Generating overlay (phrases + simulated progress) ──────────────────

const GEN_PHRASES = [
  "DECODING LIGHT PATTERNS",
  "MATCHING AGAINST KNOWN GAP",
  "RECONSTRUCTING DEPTH",
  "WEAVING GAUSSIAN FIELDS",
  "CLOSING THE GAP",
];
let genPhraseTimer = null;

function startGenPhrases() {
  let i = 0;
  genTextContent.textContent = GEN_PHRASES[0];
  genPhraseTimer = setInterval(() => {
    i = (i + 1) % GEN_PHRASES.length;
    genTextContent.textContent = GEN_PHRASES[i];
  }, 1800);
}
function stopGenPhrases() {
  clearInterval(genPhraseTimer);
  genPhraseTimer = null;
}

let genPercent = 0;
let genPercentTimer = null;

function startGenProgress() {
  genPercent = 0;
  genPercentEl.textContent = "0%";
  genPercentTimer = setInterval(() => {
    genPercent += (95 - genPercent) * 0.045;
    genPercentEl.textContent = `${Math.round(genPercent)}%`;
  }, 220);
}
function stopGenProgress() {
  clearInterval(genPercentTimer);
  genPercentTimer = null;
}
function finishGenProgress() {
  clearInterval(genPercentTimer);
  genPercentTimer = null;
  genPercentEl.textContent = "100%";
}

// ── Submit ────────────────────────────────────────────────────────────────

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) return;

  setBusy(true);
  setStatus(`Uploading your ${targetDecadeEl.textContent} memory of ${targetLocationEl.textContent}…`, "pending");

  try {
    const formData = new FormData();
    formData.append("image", selectedFile);
    formData.append("name", targetLocationLabel);   // locks it into the right location cluster
    formData.append("author", authorInput.value);
    formData.append("year", yearInput.value);
    formData.append("story", storyInput.value);

    const response = await fetch("/api/predict", { method: "POST", body: formData });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${response.status} ${detail}`);
    }

    const scene = await response.json();
    finishGenProgress();
    await new Promise(r => setTimeout(r, 350));
    setStatus(`Done! Your memory of “${scene.name}” may help close that gap. Thank you.`, "success");
    resetForm();
    loadGaps(); // refresh gap list — this contribution may have closed one
  } catch (err) {
    console.error(err);
    setStatus(`Something went wrong: ${err.message}`, "error");
  } finally {
    setBusy(false);
  }
});

function setBusy(busy) {
  uploadButton.disabled = busy || !selectedFile;
  uploadButton.textContent = busy ? "Generating…" : "Initiate Reconstruction";
  generatingOverlay.classList.toggle("hidden", !busy);
  if (busy) {
    startGenPhrases();
    startGenProgress();
  } else {
    stopGenPhrases();
    stopGenProgress();
  }
}

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind ?? "";
}

function resetForm() {
  selectedFile = null;
  fileInput.value = "";
  imagePreview.classList.remove("visible");
  imagePreview.removeAttribute("src");
  dropzoneHint.classList.remove("hidden");
  dropzone.classList.remove("scanning");
  uploadButton.disabled = true;

  authorInput.value = "";
  yearInput.value = "";
  storyInput.value = "";
  [dotAuthor, dotYear, dotStory].forEach(d => d.classList.remove("filled"));
  charCounter.textContent = "0 / 280";
  charCounter.classList.remove("near-limit");
}

// ── Boot ──────────────────────────────────────────────────────────────────

loadGaps();
