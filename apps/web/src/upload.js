import "./upload.css";

const form = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const batchListEl = document.getElementById("batch-list");
const yearFieldEl = document.getElementById("year-field");
const nameInput = document.getElementById("name-input");
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
const genBatchEl = document.getElementById("gen-batch");

const GEN_PHRASES = [
  "DECODING LIGHT PATTERNS",
  "RECONSTRUCTING DEPTH",
  "WEAVING GAUSSIAN FIELDS",
  "ALIGNING SPATIAL ECHOES",
  "MATERIALIZING YOUR MEMORY",
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

// Simulated progress — decelerates toward 95% so it never falsely claims
// completion before the backend actually responds; jumps to 100% on success.
// Restarted for each photo when uploading a batch.
const genPercentEl = document.getElementById("gen-percent");
let genPercent = 0;
let genPercentTimer = null;

function startGenProgress() {
  genPercent = 0;
  genPercentEl.textContent = "0%";
  clearInterval(genPercentTimer);
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

const dotName   = document.getElementById("dot-name");
const dotAuthor = document.getElementById("dot-author");
const dotYear   = document.getElementById("dot-year");
const dotStory  = document.getElementById("dot-story");

// Each entry: { file: File, year: string }. With exactly one photo selected,
// the shared "When it happened" field is used instead of a per-photo year —
// the single-photo flow looks and behaves exactly as it always has.
let selectedFiles = [];

// Light up a field's status dot once it has a value
function wireFieldDot(input, dot) {
  input.addEventListener("input", () => {
    dot.classList.toggle("filled", input.value.trim().length > 0);
  });
}
wireFieldDot(nameInput, dotName);
wireFieldDot(authorInput, dotAuthor);
wireFieldDot(yearInput, dotYear);
wireFieldDot(storyInput, dotStory);

storyInput.addEventListener("input", () => {
  const len = storyInput.value.length;
  charCounter.textContent = `${len} / 280`;
  charCounter.classList.toggle("near-limit", len >= 250);
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

fileInput.addEventListener("change", () => {
  selectedFiles = Array.from(fileInput.files || []).map(file => ({ file, year: "" }));
  renderSelection();
});

function renderSelection() {
  uploadButton.disabled = selectedFiles.length === 0;

  if (selectedFiles.length === 0) {
    imagePreview.classList.remove("visible");
    imagePreview.removeAttribute("src");
    dropzoneHint.classList.remove("hidden");
    dropzone.classList.remove("scanning");
    batchListEl.classList.add("hidden");
    batchListEl.innerHTML = "";
    yearFieldEl.style.display = "";
    return;
  }

  // Always preview the first photo in the dropzone itself
  imagePreview.src = URL.createObjectURL(selectedFiles[0].file);
  imagePreview.classList.add("visible");
  dropzoneHint.classList.add("hidden");

  dropzone.classList.remove("scanning");
  requestAnimationFrame(() => dropzone.classList.add("scanning"));
  setTimeout(() => dropzone.classList.remove("scanning"), 1200);

  if (selectedFiles.length === 1) {
    batchListEl.classList.add("hidden");
    batchListEl.innerHTML = "";
    yearFieldEl.style.display = "";
    return;
  }

  // 2+ photos: each gets its own optional year; the shared year field hides
  // since per-photo years matter more here — this is exactly the input the
  // memory brain's alignment calculator needs to compare photos of the
  // same place across different times.
  yearFieldEl.style.display = "none";
  batchListEl.classList.remove("hidden");
  batchListEl.innerHTML =
    `<p class="batch-count-label">${selectedFiles.length} photos selected — same title applies to all; set each photo's year below (optional)</p>`;

  selectedFiles.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "batch-row";
    row.innerHTML = `
      <img class="batch-thumb" src="${URL.createObjectURL(entry.file)}" alt="" />
      <div class="batch-row-info">
        <span class="batch-row-name">${escapeHtml(entry.file.name)}</span>
        <input type="text" class="batch-year-input" placeholder="Year (optional)" maxlength="10" inputmode="numeric" value="${escapeHtml(entry.year)}" />
      </div>
      <button type="button" class="batch-remove" aria-label="Remove this photo">×</button>
    `;
    row.querySelector(".batch-year-input").addEventListener("input", e => {
      selectedFiles[i].year = e.target.value;
    });
    row.querySelector(".batch-remove").addEventListener("click", () => {
      selectedFiles.splice(i, 1);
      renderSelection();
    });
    batchListEl.appendChild(row);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFiles.length) return;

  setBusy(true);

  const total = selectedFiles.length;
  let uploaded = 0;
  let lastScene = null;

  try {
    for (let i = 0; i < total; i++) {
      const { file, year } = selectedFiles[i];
      const effectiveYear = total === 1 ? yearInput.value : year;

      if (total > 1) {
        genBatchEl.textContent = `PHOTO ${i + 1} / ${total}`;
        genBatchEl.classList.remove("hidden");
        setStatus(`Uploading photo ${i + 1} of ${total} — this can take a minute…`, "pending");
      } else {
        genBatchEl.classList.add("hidden");
        setStatus("Uploading photo and generating the 3D scene — this can take a minute…", "pending");
      }
      startGenProgress();

      const formData = new FormData();
      formData.append("image", file);
      formData.append("name", nameInput.value);
      formData.append("author", authorInput.value);
      formData.append("year", effectiveYear);
      formData.append("story", storyInput.value);

      const response = await fetch("/api/predict", { method: "POST", body: formData });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Photo ${i + 1} of ${total}: ${response.status} ${detail}`);
      }

      lastScene = await response.json();
      uploaded++;
      finishGenProgress();
      await new Promise(r => setTimeout(r, 300)); // let the 100% register visually
    }

    setStatus(
      total > 1
        ? `Done! ${uploaded} photos of "${lastScene.name}" are now live — the memory brain will check them for matches.`
        : `Done! "${lastScene.name}" is now live in the viewer. You can share another photo.`,
      "success",
    );
    resetForm();
  } catch (err) {
    console.error(err);
    setStatus(`Something went wrong: ${err.message} (${uploaded}/${total} uploaded)`, "error");
  } finally {
    setBusy(false);
  }
});

function setBusy(busy) {
  uploadButton.disabled = busy || selectedFiles.length === 0;
  uploadButton.textContent = busy ? "Generating…" : "Initiate Reconstruction";
  generatingOverlay.classList.toggle("hidden", !busy);
  if (busy) {
    startGenPhrases();
  } else {
    stopGenPhrases();
    stopGenProgress();
    genBatchEl.classList.add("hidden");
  }
}

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind ?? "";
}

function resetForm() {
  selectedFiles = [];
  fileInput.value = "";
  renderSelection();

  form.querySelectorAll("input[type=text], textarea").forEach(el => (el.value = ""));
  [dotName, dotAuthor, dotYear, dotStory].forEach(d => d.classList.remove("filled"));
  charCounter.textContent = "0 / 280";
  charCounter.classList.remove("near-limit");
}
