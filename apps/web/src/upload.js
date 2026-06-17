import "./upload.css";

const form = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
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
const genPercentEl = document.getElementById("gen-percent");
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

const dotName   = document.getElementById("dot-name");
const dotAuthor = document.getElementById("dot-author");
const dotYear   = document.getElementById("dot-year");
const dotStory  = document.getElementById("dot-story");

let selectedFile = null;

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

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0] ?? null;
  uploadButton.disabled = !selectedFile;

  if (selectedFile) {
    imagePreview.src = URL.createObjectURL(selectedFile);
    imagePreview.classList.add("visible");
    dropzoneHint.classList.add("hidden");

    // Brief "ANALYZING IMAGE…" scan sweep for a futuristic load-in feel
    dropzone.classList.remove("scanning");
    requestAnimationFrame(() => dropzone.classList.add("scanning"));
    setTimeout(() => dropzone.classList.remove("scanning"), 1200);
  } else {
    imagePreview.classList.remove("visible");
    dropzoneHint.classList.remove("hidden");
    dropzone.classList.remove("scanning");
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) return;

  setBusy(true);
  setStatus("Uploading photo and generating the 3D scene — this can take a minute…", "pending");

  try {
    const formData = new FormData();
    formData.append("image", selectedFile);
    formData.append("name", nameInput.value);
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
    await new Promise(r => setTimeout(r, 350)); // let the 100% register visually
    setStatus(
      `Done! “${scene.name}” is now live in the viewer. You can share another photo.`,
      "success",
    );
    resetForm();
  } catch (err) {
    console.error(err);
    setStatus(`Something went wrong: ${err.message}`, "error");
  } finally {
    setBusy(false);
  }
});

function setBusy(busy) {
  uploadButton.disabled = busy || !selectedFile;
  uploadButton.textContent = busy ? "Generating…" : "Upload & Generate";
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

  form.querySelectorAll("input[type=text], textarea").forEach(el => (el.value = ""));
  [dotName, dotAuthor, dotYear, dotStory].forEach(d => d.classList.remove("filled"));
  charCounter.textContent = "0 / 280";
  charCounter.classList.remove("near-limit");
}
