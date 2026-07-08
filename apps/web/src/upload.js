import "./upload.css";
import { initThemeToggle, carryAccentToViewerLinks, initCursor, initSplash, initFullscreenToggle, initFullscreenPersistence, initTapSounds } from "./theme.js";

initThemeToggle();
carryAccentToViewerLinks();
initCursor();
initSplash();
initFullscreenToggle();
initFullscreenPersistence();
initTapSounds();

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
const dotAudio  = document.getElementById("dot-audio");

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

// ── Draft save / restore ─────────────────────────────────────────────────
// Text fields → localStorage (fast, synchronous).
// Selected photos → IndexedDB (only option for binary File data).
// Audio can't be reliably persisted; the user re-adds it after restore.

const DRAFT_KEY    = "memo-upload-draft";
const DB_NAME      = "memo-draft-db";
const DB_VER       = 1;
const FILES_STORE  = "draft-files";

let _draftTimer = null;

// ── IndexedDB helpers ─────────────────────────────────────────────────────

function _openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(FILES_STORE))
        db.createObjectStore(FILES_STORE, { keyPath: "idx" });
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = ()  => rej(req.error);
  });
}

async function saveDraftFiles(entries) {
  try {
    const db = await _openDb();
    const tx = db.transaction(FILES_STORE, "readwrite");
    const st = tx.objectStore(FILES_STORE);
    st.clear();
    entries.forEach(({ file, year }, idx) => {
      st.put({ idx, blob: file, name: file.name, type: file.type, year });
    });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  } catch (e) { console.warn("saveDraftFiles:", e); }
}

async function loadDraftFiles() {
  try {
    const db  = await _openDb();
    const tx  = db.transaction(FILES_STORE, "readonly");
    const all = await new Promise((res, rej) => {
      const r = tx.objectStore(FILES_STORE).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror   = rej;
    });
    return all
      .sort((a, b) => a.idx - b.idx)
      .map(item => ({ file: new File([item.blob], item.name, { type: item.type }), year: item.year || "" }));
  } catch { return []; }
}

async function clearDraftFiles() {
  try {
    const db = await _openDb();
    db.transaction(FILES_STORE, "readwrite").objectStore(FILES_STORE).clear();
  } catch {}
}

// ── Text field draft (localStorage) ──────────────────────────────────────

function saveDraft() {
  const draft = {
    name: nameInput.value, author: authorInput.value,
    year: yearInput.value, story:  storyInput.value,
    ts:   Date.now(),
  };
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {}
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
  clearDraftFiles();
}

function scheduleDraftSave() {
  clearTimeout(_draftTimer);
  _draftTimer = setTimeout(saveDraft, 600);
}

// Auto-save text on every keystroke (debounced).
[nameInput, authorInput, yearInput, storyInput].forEach(el =>
  el.addEventListener("input", scheduleDraftSave)
);

// Restore on load — async so files come back from IndexedDB too.
async function restoreDraft() {
  let hadText = false;
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d.ts && Date.now() - d.ts < 4 * 60 * 60 * 1000) {
        if (d.name)   { nameInput.value   = d.name;   dotName.classList.add("filled");   hadText = true; }
        if (d.author) { authorInput.value = d.author; dotAuthor.classList.add("filled"); hadText = true; }
        if (d.year)   { yearInput.value   = d.year;   dotYear.classList.add("filled");   hadText = true; }
        if (d.story)  {
          storyInput.value = d.story; dotStory.classList.add("filled"); hadText = true;
          const len = d.story.length;
          charCounter.textContent = `${len} / 280`;
          charCounter.classList.toggle("near-limit", len >= 250);
        }
      } else { clearDraft(); }
    }
  } catch {}

  // Restore photos from IndexedDB.
  const restored = await loadDraftFiles();
  if (restored.length) {
    selectedFiles = restored;
    renderSelection();
    if (hadText || restored.length) {
      setStatus("Draft restored — re-add your audio clip to continue.", "pending");
    }
  } else if (hadText) {
    setStatus("Draft restored — re-select your photo to continue.", "pending");
  }
}

restoreDraft();

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

fileInput.addEventListener("change", () => {
  selectedFiles = Array.from(fileInput.files || []).map(file => ({ file, year: "" }));
  renderSelection();
  saveDraftFiles(selectedFiles); // persist photos to IndexedDB
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
      saveDraftFiles(selectedFiles);
    });
    row.querySelector(".batch-remove").addEventListener("click", () => {
      selectedFiles.splice(i, 1);
      renderSelection();
      saveDraftFiles(selectedFiles);
    });
    batchListEl.appendChild(row);
  });
}

// ── Audio: record voice, browse music, or upload a file — then crop ───────
// `selectedAudioBlob` is whichever one the user lands on; it's attached to
// every photo in the current submission (a batch upload is still one
// "moment" being shared, so one voice note / one music clip for all of it).
// Both the recording and the crop range are hard-capped to MAX_AUDIO_SECONDS
// so a memory's sound never outlasts the time it's actually shown for.

const MAX_AUDIO_SECONDS = 60; // must match the viewer's DWELL_MS (60_000ms)

const audioEmptyEl = document.getElementById("audio-empty");
const recordVoiceBtn = document.getElementById("record-voice-btn");
const browseMusicBtn = document.getElementById("browse-music-btn");
const uploadAudioBtn = document.getElementById("upload-audio-btn");
const audioFileInput = document.getElementById("audio-file-input");
const audioRecordingEl = document.getElementById("audio-recording");
const recordTimerEl = document.getElementById("record-timer");
const recordProgressFillEl = document.getElementById("record-progress-fill");
const stopRecordBtn = document.getElementById("stop-record-btn");
const audioPreviewEl = document.getElementById("audio-preview");
const audioPreviewPlayer = document.getElementById("audio-preview-player");
const removeAudioBtn = document.getElementById("remove-audio-btn");
const musicBrowserEl = document.getElementById("music-browser");
const musicSearchInput = document.getElementById("music-search-input");
const musicSearchBtn = document.getElementById("music-search-btn");
const musicResultsEl = document.getElementById("music-results");
const closeMusicBrowserBtn = document.getElementById("close-music-browser-btn");
const musicCropEl = document.getElementById("music-crop");
const cropTrackTitleEl = document.getElementById("crop-track-title");
const cropPlayer = document.getElementById("crop-player");
const waveformWrapEl = document.getElementById("waveform-wrap");
const waveformCanvas = document.getElementById("waveform-canvas");
const cropBoxEl = document.getElementById("crop-box");
const cropHandleLeftEl = document.getElementById("crop-handle-left");
const cropHandleRightEl = document.getElementById("crop-handle-right");
const cropPlayheadEl = document.getElementById("crop-playhead");
const cropStartLabel = document.getElementById("crop-start-label");
const cropEndLabel = document.getElementById("crop-end-label");
const cropDurationLabel = document.getElementById("crop-duration-label");
const previewCropBtn = document.getElementById("preview-crop-btn");
const confirmCropBtn = document.getElementById("confirm-crop-btn");
const cancelCropBtn = document.getElementById("cancel-crop-btn");

let selectedAudioBlob = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordStartTime = 0;
let recordTimerInterval = null;

let decodedBuffer = null;   // currently-loaded AudioBuffer for the crop UI
let cropDuration = 0;
let cropStartSec = 0;
let cropEndSec = 0;
let previewRaf = null;

function showAudioPanel(panel) {
  [audioEmptyEl, audioRecordingEl, audioPreviewEl, musicBrowserEl, musicCropEl]
    .forEach(el => el.classList.add("hidden"));
  panel.classList.remove("hidden");
}

function setSelectedAudio(blob) {
  selectedAudioBlob = blob;
  dotAudio.classList.toggle("filled", !!blob);
}

function formatTime(secs) {
  secs = Math.max(0, Math.floor(secs));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function resetAudioUI() {
  setSelectedAudio(null);
  showAudioPanel(audioEmptyEl);
  audioPreviewPlayer.removeAttribute("src");
  decodedBuffer = null;
  audioFileInput.value = "";
  cropPlayer.pause();
  cancelAnimationFrame(previewRaf);
}

// Guards against accidentally losing a recording or clip you already made —
// starting a new recording, browsing music, or uploading a file all replace
// `selectedAudioBlob`, so confirm first if there's already something there.
function confirmReplaceIfNeeded() {
  if (!selectedAudioBlob) return true;
  return window.confirm("You already have a voice note or music clip added. Replace it with a new one?");
}

// --- Voice recording — auto-stops at MAX_AUDIO_SECONDS ---

recordVoiceBtn.addEventListener("click", async () => {
  if (!confirmReplaceIfNeeded()) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      setSelectedAudio(blob);
      audioPreviewPlayer.src = URL.createObjectURL(blob);
      showAudioPanel(audioPreviewEl);
      clearInterval(recordTimerInterval);
    };
    mediaRecorder.start();
    recordStartTime = Date.now();
    recordProgressFillEl.style.width = "0%";
    recordTimerInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - recordStartTime) / 1000);
      recordTimerEl.textContent = formatTime(secs);
      recordProgressFillEl.style.width = `${Math.min(100, (secs / MAX_AUDIO_SECONDS) * 100)}%`;
      if (secs >= MAX_AUDIO_SECONDS && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop(); // hits the memory's display-time cap — stop automatically
      }
    }, 200);
    showAudioPanel(audioRecordingEl);
  } catch (err) {
    console.error(err);
    const reason = err.name === "NotAllowedError"
      ? "Microphone permission was denied. Allow it in your browser's site settings and try again."
      : err.message;
    setStatus(`Could not access microphone: ${reason}`, "error");
  }
});

stopRecordBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
});

removeAudioBtn.addEventListener("click", resetAudioUI);

// --- Music browsing (Openverse via our own backend proxy — multilingual:
// it's a plain text search, so any language works, but only against
// openly-licensed tracks, not mainstream commercial music) ---

browseMusicBtn.addEventListener("click", () => {
  if (!confirmReplaceIfNeeded()) return;
  showAudioPanel(musicBrowserEl);
  musicSearchInput.focus();
});

closeMusicBrowserBtn.addEventListener("click", resetAudioUI);

async function searchMusic() {
  const q = musicSearchInput.value.trim();
  if (!q) return;
  musicResultsEl.innerHTML = `<p class="music-status">Searching…</p>`;
  try {
    const res = await fetch(`/api/music/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderMusicResults(await res.json());
  } catch (err) {
    console.error(err);
    musicResultsEl.innerHTML = `<p class="music-status">Search failed: ${err.message}</p>`;
  }
}
musicSearchBtn.addEventListener("click", searchMusic);
musicSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); searchMusic(); }
});

function renderMusicResults(tracks) {
  if (!tracks.length) {
    musicResultsEl.innerHTML = `<p class="music-status">No tracks found — try another search.</p>`;
    return;
  }
  musicResultsEl.innerHTML = "";
  for (const track of tracks) {
    const row = document.createElement("div");
    row.className = "music-result-row";
    row.innerHTML = `
      <div class="music-result-info">
        <p class="music-result-title">${escapeHtml(track.title)}</p>
        <p class="music-result-meta">${escapeHtml(track.creator)}</p>
      </div>
      <button type="button" class="music-crop-btn">Crop &amp; Use</button>
    `;
    row.querySelector(".music-crop-btn").addEventListener("click", () => {
      // Stream through our own backend — third-party hosts rarely send CORS
      // headers, which would otherwise block the Web Audio decode below.
      const proxiedUrl = `/api/music/fetch?url=${encodeURIComponent(track.audio_url)}`;
      openCropUI(proxiedUrl, `${track.title} — ${track.creator}`);
    });
    musicResultsEl.appendChild(row);
  }
}

// --- Upload an audio file directly — feeds the same crop UI ---

uploadAudioBtn.addEventListener("click", () => {
  if (!confirmReplaceIfNeeded()) return;
  audioFileInput.click();
});
audioFileInput.addEventListener("change", () => {
  const file = audioFileInput.files?.[0];
  if (!file) return;
  openCropUI(URL.createObjectURL(file), file.name, file);
});

// --- Crop UI: real waveform with a draggable selection box ────────────────

// `rawFile` is only set for direct file uploads — if the browser can't
// decode it for cropping (some codecs/containers just aren't supported by
// the Web Audio API), this is the fallback so the upload isn't a dead end:
// use the original file exactly as picked, no waveform/crop, instead of
// just failing outright.
async function openCropUI(sourceUrl, title, rawFile = null) {
  showAudioPanel(musicCropEl);
  cropTrackTitleEl.textContent = title;
  previewCropBtn.textContent = "▶ Preview";

  try {
    const res = await fetch(sourceUrl);
    const arrayBuffer = await res.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    audioCtx.close();
  } catch (err) {
    console.error(err);
    if (rawFile) {
      setSelectedAudio(rawFile);
      audioPreviewPlayer.src = sourceUrl;
      showAudioPanel(audioPreviewEl);
      setStatus(
        `Could not show a waveform for "${title}" (unsupported for cropping), but it's attached as-is — uncropped.`,
        "pending",
      );
    } else {
      setStatus(`Could not load that audio: ${err.message}`, "error");
      resetAudioUI();
    }
    return;
  }

  cropPlayer.src = sourceUrl;
  cropDuration = decodedBuffer.duration;
  cropStartSec = 0;
  cropEndSec = Math.min(cropDuration, MAX_AUDIO_SECONDS);
  cropPlayheadEl.classList.remove("hidden");

  drawWaveform(decodedBuffer);
  requestAnimationFrame(() => {
    positionCropBox();
    positionPlayhead(cropStartSec); // wait one frame so the canvas has real layout size
  });
}

function drawWaveform(buffer) {
  const ctx = waveformCanvas.getContext("2d");
  const width = waveformCanvas.width;
  const height = waveformCanvas.height;
  const mid = height / 2;
  ctx.clearRect(0, 0, width, height);

  // The waveform "scope" stays dark in both themes (like an instrument
  // readout), but --hc flips to near-black in light mode for page text —
  // using it here would make the bars invisible against the dark scope.
  // --accent-pick is the vivid colour regardless of theme, so it stays
  // visible against the dark backdrop either way.
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent-pick").trim() || "100, 200, 255";
  ctx.fillStyle = `rgba(${accent}, 0.85)`;

  const data = buffer.getChannelData(0);
  const samplesPerPixel = Math.max(1, Math.floor(data.length / width));
  for (let x = 0; x < width; x++) {
    let min = 1, max = -1;
    const start = x * samplesPerPixel;
    for (let i = 0; i < samplesPerPixel; i++) {
      const v = data[start + i] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid + min * mid;
    const y2 = mid + max * mid;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

function updateCropLabels() {
  cropStartLabel.textContent = formatTime(cropStartSec);
  cropEndLabel.textContent = formatTime(cropEndSec);
  cropDurationLabel.textContent = `${Math.round(cropEndSec - cropStartSec)}s`;
}

function positionCropBox() {
  const width = waveformWrapEl.clientWidth || waveformCanvas.width;
  if (!cropDuration) return;
  const pxPerSec = width / cropDuration;
  const leftPx = cropStartSec * pxPerSec;
  const rightPx = cropEndSec * pxPerSec;
  cropBoxEl.style.left = `${leftPx}px`;
  cropBoxEl.style.width = `${Math.max(6, rightPx - leftPx)}px`;
  updateCropLabels();
}

function secFromClientX(clientX) {
  const rect = waveformWrapEl.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  return (x / rect.width) * cropDuration;
}

function wireDrag(handleEl, mode) {
  handleEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleEl.setPointerCapture(e.pointerId);
    const grabStartSec = secFromClientX(e.clientX);
    const boxStartAtGrab = cropStartSec;
    const boxEndAtGrab = cropEndSec;
    let dragDist = 0;
    let lastClientX = e.clientX;

    const onMove = (ev) => {
      dragDist += Math.abs(ev.clientX - lastClientX);
      lastClientX = ev.clientX;
      if (mode === "left") {
        let t = secFromClientX(ev.clientX);
        t = Math.max(0, Math.min(t, cropEndSec - 0.2));
        if (cropEndSec - t > MAX_AUDIO_SECONDS) t = cropEndSec - MAX_AUDIO_SECONDS;
        cropStartSec = t;
      } else if (mode === "right") {
        let t = secFromClientX(ev.clientX);
        t = Math.min(cropDuration, Math.max(t, cropStartSec + 0.2));
        if (t - cropStartSec > MAX_AUDIO_SECONDS) t = cropStartSec + MAX_AUDIO_SECONDS;
        cropEndSec = t;
      } else {
        const widthSec = boxEndAtGrab - boxStartAtGrab;
        const deltaSec = secFromClientX(ev.clientX) - grabStartSec;
        let newStart = boxStartAtGrab + deltaSec;
        newStart = Math.max(0, Math.min(cropDuration - widthSec, newStart));
        cropStartSec = newStart;
        cropEndSec = newStart + widthSec;
      }
      positionCropBox();
    };
    const onUp = () => {
      handleEl.releasePointerCapture(e.pointerId);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      // A plain click on the box (not an actual drag) — e.g. when the box
      // covers most/all of a short track — seeks and plays from that point
      // instead of just "moving" a selection that barely budged.
      if (mode === "move" && dragDist < 4) {
        scrubTo(e.clientX);
        cropPlayer.play().catch(() => {});
        trackPlayhead(null);
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}
wireDrag(cropHandleLeftEl, "left");
wireDrag(cropHandleRightEl, "right");
wireDrag(cropBoxEl, "move");

function positionPlayhead(sec) {
  const width = waveformWrapEl.clientWidth || waveformCanvas.width;
  cropPlayheadEl.style.left = `${(sec / cropDuration) * width}px`;
}

// Keeps the playhead in sync with playback. `stopAtSec` set => stops there
// (the Preview button, which only ever plays the cropped start–end range);
// null => plays freely (free-roam scrubbing, for exploring the whole track
// to decide where the crop should go).
function trackPlayhead(stopAtSec) {
  cancelAnimationFrame(previewRaf);
  const tick = () => {
    if (cropPlayer.paused || (stopAtSec != null && cropPlayer.currentTime >= stopAtSec)) {
      if (stopAtSec != null && cropPlayer.currentTime >= stopAtSec) cropPlayer.pause();
      syncPlayButton();
      return;
    }
    positionPlayhead(cropPlayer.currentTime);
    previewRaf = requestAnimationFrame(tick);
  };
  previewRaf = requestAnimationFrame(tick);
}

function syncPlayButton() {
  previewCropBtn.textContent = cropPlayer.paused ? "▶ Preview" : "⏸ Pause";
}
cropPlayer.addEventListener("pause", syncPlayButton);
cropPlayer.addEventListener("play", syncPlayButton);

// Play/Pause toggle — strictly the cropped start–end range, never the rest
// of the track, regardless of where free-roam scrubbing last left the
// playhead.
previewCropBtn.addEventListener("click", () => {
  if (!cropPlayer.paused) {
    cropPlayer.pause();
    return;
  }
  cropPlayer.currentTime = cropStartSec;
  positionPlayhead(cropStartSec);
  cropPlayer.play().catch(() => {});
  trackPlayhead(cropEndSec);
});

// Click or drag anywhere on the waveform (outside the crop box itself, which
// has its own drag-to-move handler) to scrub the playhead and preview from
// wherever you like — not limited to the current crop window, so you can
// explore the whole track to decide where the crop should go.
function scrubTo(clientX) {
  const t = secFromClientX(clientX);
  cropPlayer.currentTime = t;
  positionPlayhead(t);
}

function startScrubDrag(target, e) {
  e.preventDefault();
  e.stopPropagation();
  target.setPointerCapture(e.pointerId);
  scrubTo(e.clientX);
  cropPlayer.play().catch(() => {});
  trackPlayhead(null);

  const onMove = (ev) => scrubTo(ev.clientX);
  const onUp = () => {
    target.releasePointerCapture(e.pointerId);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

// Grab the playhead directly and drag it anywhere to preview from there...
cropPlayheadEl.addEventListener("pointerdown", (e) => startScrubDrag(cropPlayheadEl, e));

// ...or click/drag anywhere else on the waveform (outside the crop box,
// which has its own drag-to-move handler) to jump the playhead there.
waveformWrapEl.addEventListener("pointerdown", (e) => {
  if (e.target === cropBoxEl || e.target === cropHandleLeftEl || e.target === cropHandleRightEl || e.target === cropPlayheadEl) return;
  startScrubDrag(waveformWrapEl, e);
});

cancelCropBtn.addEventListener("click", resetAudioUI);

confirmCropBtn.addEventListener("click", () => {
  confirmCropBtn.disabled = true;
  confirmCropBtn.textContent = "Cropping…";
  try {
    const blob = cropDecodedBufferToBlob(decodedBuffer, cropStartSec, cropEndSec);
    setSelectedAudio(blob);
    audioPreviewPlayer.src = URL.createObjectURL(blob);
    showAudioPanel(audioPreviewEl);
  } catch (err) {
    console.error(err);
    setStatus(`Could not crop that track: ${err.message}`, "error");
  } finally {
    confirmCropBtn.disabled = false;
    confirmCropBtn.textContent = "Use this clip";
  }
});

// Slice the already-decoded buffer and re-encode as a 16-bit PCM WAV — no
// re-fetch needed since openCropUI() already decoded it for the waveform.
function cropDecodedBufferToBlob(buffer, startSec, endSec) {
  const sampleRate = buffer.sampleRate;
  const startSample = Math.floor(startSec * sampleRate);
  const endSample = Math.min(Math.floor(endSec * sampleRate), buffer.length);
  const frameCount = Math.max(0, endSample - startSample);
  const numChannels = buffer.numberOfChannels;

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const cropped = audioCtx.createBuffer(numChannels, frameCount, sampleRate);
  for (let ch = 0; ch < numChannels; ch++) {
    cropped.copyToChannel(buffer.getChannelData(ch).subarray(startSample, endSample), ch);
  }
  audioCtx.close();
  return encodeWav(cropped);
}

function encodeWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData = [];
  for (let ch = 0; ch < numChannels; ch++) channelData.push(audioBuffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFiles.length) return;

  saveDraft(); // ensure latest field values are persisted before the long request
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
      if (selectedAudioBlob) {
        const filename = selectedAudioBlob.type.includes("wav") ? "clip.wav" : "voice.webm";
        formData.append("audio", selectedAudioBlob, filename);
      }

      let response;
      try {
        response = await fetch("/api/predict", { method: "POST", body: formData });
      } catch (networkErr) {
        throw new Error(`Cannot reach the server — check that the laptop and phone are on the same Wi-Fi network. (${networkErr.message})`);
      }
      if (!response.ok) {
        let detail = "";
        try { detail = await response.text(); } catch {}
        // FastAPI wraps detail in JSON: {"detail": "..."} — unwrap it if so
        try { const j = JSON.parse(detail); if (j?.detail) detail = j.detail; } catch {}
        throw new Error(`Upload failed (${response.status}): ${detail || "unknown server error"}`);
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
  uploadButton.textContent = busy ? "building…" : "preserve →";
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
  clearDraft();
  selectedFiles = [];
  fileInput.value = "";
  renderSelection();
  resetAudioUI();

  form.querySelectorAll("input[type=text], textarea").forEach(el => (el.value = ""));
  [dotName, dotAuthor, dotYear, dotStory].forEach(d => d.classList.remove("filled"));
  charCounter.textContent = "0 / 280";
  charCounter.classList.remove("near-limit");
}

// ═══════════════════════════════════════════════════════
// SPA — Tab switching, Navigate controls, Memoverse
// ═══════════════════════════════════════════════════════

// ── Tab switching ─────────────────────────────────────

let _activeTab = "preserve";
const tabBtns   = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

const preserveActionBtn   = document.getElementById("preserve-action-btn");

// Proxy: visible action button → hidden submit button inside the form
if (preserveActionBtn && uploadButton) {
  new MutationObserver(() => {
    preserveActionBtn.disabled = uploadButton.disabled;
    preserveActionBtn.textContent = uploadButton.textContent.includes("building") ? "building…" : "preserve";
  }).observe(uploadButton, { attributes: true, attributeFilter: ["disabled"], childList: true, subtree: true, characterData: true });
  preserveActionBtn.addEventListener("click", () => { if (!uploadButton.disabled) uploadButton.click(); });
}

function switchTab(target) {
  if (target === _activeTab) return;
  _activeTab = target;
  tabBtns.forEach(b  => b.classList.toggle("active",  b.dataset.tab === target));
  tabPanels.forEach(p => p.classList.toggle("active", p.id === `tab-${target}`));
  updateBottomBar();
  if (target === "explore") loadExplore();
}

tabBtns.forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

// ── Bottom bar coordination ───────────────────────────

function updateBottomBar() {
  if (preserveActionBtn) preserveActionBtn.style.display = _activeTab === "preserve" ? "" : "none";
}

// ── Memoverse ─────────────────────────────────────────

// ── Explore — word cloud + navigation ────────────────────

const exploreCloudEl  = document.getElementById("explore-cloud");
const exploreWordsEl  = document.getElementById("explore-words");
const exploreHintEl   = document.getElementById("explore-hint");
const exploreTimelineEl  = document.getElementById("explore-timeline");
const tlSliderFromEl     = document.getElementById("tl-slider-from");
const tlSliderToEl       = document.getElementById("tl-slider-to");
const tlFillEl           = document.getElementById("tl-fill");
const tlYrFromEl         = document.getElementById("tl-yr-from");
const tlYrToEl           = document.getElementById("tl-yr-to");

const _exploreWords = new Map(); // scene_id → {el, pos, scene}
let _exploreFocusedId = null;
let _exploreLoaded = false;
let _allExploreScenes = [];

// ── Zoom / pan state ─────────────────────────────────────
let _cZoom = 1, _cPanX = 0, _cPanY = 0;
const _cloudPtrs = new Map(); // pointerId → {x, y}
let _pinchDist0 = null, _pinchZoom0 = 1;
let _panning = false, _panPt = null;

function _applyCloudTransform() {
  if (!exploreWordsEl) return;
  exploreWordsEl.style.transform =
    `translate(${_cPanX}px,${_cPanY}px) scale(${_cZoom})`;
}

function _clampPan() {
  const maxPan = 200 * _cZoom;
  _cPanX = Math.max(-maxPan, Math.min(maxPan, _cPanX));
  _cPanY = Math.max(-maxPan, Math.min(maxPan, _cPanY));
}

// Scroll-wheel zoom (desktop)
exploreCloudEl?.addEventListener("wheel", e => {
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.12 : 0.89;
  _cZoom = Math.max(0.35, Math.min(4.5, _cZoom * f));
  _clampPan();
  _applyCloudTransform();
}, { passive: false });

// Cloud pointer events for pinch zoom + background pan
exploreCloudEl?.addEventListener("pointerdown", e => {
  if (e.target.closest(".explore-word")) return; // let words handle their own events
  e.preventDefault();
  exploreCloudEl.setPointerCapture(e.pointerId);
  _cloudPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (_cloudPtrs.size === 1) {
    _panning = true;
    _panPt = { x: e.clientX, y: e.clientY, px: _cPanX, py: _cPanY };
  }
  if (_cloudPtrs.size === 2) {
    _panning = false;
    const pts = [..._cloudPtrs.values()];
    _pinchDist0 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    _pinchZoom0 = _cZoom;
  }
}, { passive: false });

exploreCloudEl?.addEventListener("pointermove", e => {
  if (!_cloudPtrs.has(e.pointerId)) return;
  _cloudPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (_cloudPtrs.size === 2 && _pinchDist0) {
    const pts = [..._cloudPtrs.values()];
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    _cZoom = Math.max(0.35, Math.min(4.5, _pinchZoom0 * dist / _pinchDist0));
    _clampPan();
    _applyCloudTransform();
  } else if (_panning && _panPt) {
    _cPanX = _panPt.px + (e.clientX - _panPt.x);
    _cPanY = _panPt.py + (e.clientY - _panPt.y);
    _clampPan();
    _applyCloudTransform();
  }
});

exploreCloudEl?.addEventListener("pointerup", e => {
  _cloudPtrs.delete(e.pointerId);
  _panning = false;
  _pinchDist0 = null;
});
exploreCloudEl?.addEventListener("pointercancel", e => {
  _cloudPtrs.delete(e.pointerId);
  _panning = false;
  _pinchDist0 = null;
});

async function loadExplore() {
  if (_exploreLoaded) return;
  if (exploreHintEl) exploreHintEl.textContent = "loading memories…";
  try {
    const [scenesRes, posRes] = await Promise.all([
      fetch("/api/scenes", { cache: "no-store" }),
      fetch("/api/scene-positions", { cache: "no-store" }),
    ]);
    const allScenes = await scenesRes.json();
    const storedPos = posRes.ok ? await posRes.json() : {};
    _allExploreScenes = allScenes;

    if (!allScenes.length) {
      if (exploreHintEl) exploreHintEl.textContent = "no memories yet — preserve one first";
      return;
    }

    // Golden-angle phyllotaxis default layout
    const n = allScenes.length;
    allScenes.forEach((scene, i) => {
      if (!storedPos[scene.id]) {
        const angle = i * 2.39996 * 2 * Math.PI;
        const r = 0.10 + 0.34 * Math.sqrt((i + 1) / n);
        storedPos[scene.id] = {
          x_pct: Math.max(0.10, Math.min(0.90, 0.5 + r * Math.cos(angle))),
          y_pct: Math.max(0.10, Math.min(0.90, 0.5 + r * Math.sin(angle))),
        };
      }
    });

    // Send all to viewer world
    fetch("/api/world-selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene_ids: allScenes.map(s => s.id) }),
    }).catch(() => {});

    buildWordCloud(allScenes, storedPos);
    setupTimeline(allScenes);
    startCameraIndicator();
    if (exploreHintEl) exploreHintEl.style.display = "none";
    _exploreLoaded = true;
  } catch {
    if (exploreHintEl) exploreHintEl.textContent = "could not load memories";
  }
}

// ── Live camera indicator on the map ──────────────────────────────────────
// The 3D viewer posts its camera pose to /api/camera-state; we mirror it here
// as a "you are here" arrow so the map shows where the viewer is standing and
// which way it's looking, in the SAME coordinate space as the memory words.
const MAP_GROUND_SPAN = 640; // MUST match GROUND_SPAN in viewer.js
let _camMarkerEl = null;
let _camPollId = null;

function _ensureCamMarker() {
  if (_camMarkerEl && _camMarkerEl.parentNode) return _camMarkerEl;
  if (!exploreWordsEl) return null;
  const el = document.createElement("div");
  el.className = "map-camera";
  el.innerHTML = '<span class="map-camera-cone"></span><span class="map-camera-dot"></span>';
  exploreWordsEl.appendChild(el); // inside the pan/zoom-transformed layer
  _camMarkerEl = el;
  return el;
}

async function _pollCameraState() {
  try {
    const r = await fetch("/api/camera-state", { cache: "no-store" });
    if (!r.ok) return;
    const { x, z, yaw, ts } = await r.json();
    const el = _ensureCamMarker();
    if (!el) return;
    if (!ts) { el.style.display = "none"; return; }
    el.style.display = "";
    // Same mapping the viewer uses, inverted: world (x,z) → unit-square pct.
    const xp = Math.max(-0.05, Math.min(1.05, x / MAP_GROUND_SPAN + 0.5));
    const yp = Math.max(-0.05, Math.min(1.05, z / MAP_GROUND_SPAN + 0.5));
    // Heading on the map: forward is (sin yaw, cos yaw) in (right, down); the
    // arrow art points up, so rotate it by atan2(sinYaw, -cosYaw).
    const deg = Math.atan2(Math.sin(yaw), -Math.cos(yaw)) * 180 / Math.PI;
    el.style.left = `${xp * 100}%`;
    el.style.top  = `${yp * 100}%`;
    el.style.transform = `rotate(${deg}deg)`;
  } catch {}
}

function startCameraIndicator() {
  if (_camPollId) return;
  _pollCameraState();
  _camPollId = setInterval(_pollCameraState, 300);
}

function buildWordCloud(allScenes, positions) {
  if (!exploreWordsEl) return;
  exploreWordsEl.innerHTML = "";
  _camMarkerEl = null; // wiped by innerHTML reset; re-created on next poll
  _exploreWords.clear();

  allScenes.forEach(scene => {
    const pos = positions[scene.id] ?? { x_pct: 0.5, y_pct: 0.5 };
    const el = document.createElement("button");
    el.type = "button";
    el.className = "explore-word";
    el.dataset.id = scene.id;

    const name = (scene.name || "Untitled").substring(0, 22);
    const year = scene.year ? scene.year.substring(0, 4) : "";
    el.innerHTML = `<span class="explore-word-name">${name}</span>${year ? `<span class="explore-word-year">${year}</span>` : ""}`;

    el.style.left = `${pos.x_pct * 100}%`;
    el.style.top  = `${pos.y_pct * 100}%`;

    let pressTimer = null;
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let origXpct = pos.x_pct, origYpct = pos.y_pct;

    el.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      isDragging = false;
      dragStartX = e.clientX; dragStartY = e.clientY;
      origXpct = pos.x_pct; origYpct = pos.y_pct;
      pressTimer = setTimeout(() => {
        isDragging = true;
        el.classList.add("dragging");
        haptic(25);
      }, 420);
    }, { passive: false });

    el.addEventListener("pointermove", e => {
      if (!isDragging) return;
      const rect = exploreCloudEl.getBoundingClientRect();
      // Divide by zoom so drag distance matches visual movement
      const dx = (e.clientX - dragStartX) / (_cZoom * rect.width);
      const dy = (e.clientY - dragStartY) / (_cZoom * rect.height);
      pos.x_pct = Math.max(0.04, Math.min(0.96, origXpct + dx));
      pos.y_pct = Math.max(0.04, Math.min(0.96, origYpct + dy));
      el.style.left = `${pos.x_pct * 100}%`;
      el.style.top  = `${pos.y_pct * 100}%`;
    });

    el.addEventListener("pointerup", () => {
      clearTimeout(pressTimer);
      el.classList.remove("dragging");
      if (isDragging) {
        isDragging = false;
        fetch("/api/scene-position", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scene_id: scene.id, x_pct: pos.x_pct, y_pct: pos.y_pct }),
        }).catch(() => {});
        haptic(20);
      } else {
        focusExploreScene(scene);
      }
    });

    el.addEventListener("pointercancel", () => {
      clearTimeout(pressTimer);
      el.classList.remove("dragging");
      isDragging = false;
    });

    exploreWordsEl.appendChild(el);
    _exploreWords.set(scene.id, { el, pos, scene });
  });
}

function setupTimeline(allScenes) {
  const years = allScenes.map(s => parseInt(s.year)).filter(y => !isNaN(y) && y > 1900);
  if (years.length < 2 || !exploreTimelineEl) return;
  const minY = Math.min(...years), maxY = Math.max(...years);
  exploreTimelineEl.style.display = "flex";

  [tlSliderFromEl, tlSliderToEl].forEach(el => {
    el.min = minY; el.max = maxY; el.step = 1;
  });
  tlSliderFromEl.value = minY;
  tlSliderToEl.value   = maxY;
  if (tlYrFromEl) tlYrFromEl.textContent = minY;
  if (tlYrToEl)   tlYrToEl.textContent   = maxY;
  _updateTlFill(minY, maxY, minY, maxY);

  function onChange() {
    let from = parseInt(tlSliderFromEl.value);
    let to   = parseInt(tlSliderToEl.value);
    // Prevent handles crossing
    if (from > to) { from = to; tlSliderFromEl.value = from; }
    if (to < from) { to = from; tlSliderToEl.value   = to;   }

    const isAll = from === minY && to === maxY;
    if (tlYrFromEl) tlYrFromEl.textContent = isAll ? "all" : from;
    if (tlYrToEl)   tlYrToEl.textContent   = isAll ? ""    : to;
    _updateTlFill(minY, maxY, from, to);
    _applyTimelineFilter(from, to, isAll);
  }

  tlSliderFromEl?.addEventListener("input", onChange);
  tlSliderToEl?.addEventListener("input", onChange);
}

function _updateTlFill(minY, maxY, from, to) {
  if (!tlFillEl) return;
  const span  = maxY - minY || 1;
  const left  = (from - minY) / span * 100;
  const right = (maxY - to)   / span * 100;
  tlFillEl.style.left  = `${left}%`;
  tlFillEl.style.right = `${right}%`;
}

function _applyTimelineFilter(from, to, isAll) {
  const visible = [];
  _exploreWords.forEach(({ el, scene }) => {
    const sy   = parseInt(scene.year);
    const show = isAll || isNaN(sy) || (sy >= from && sy <= to);
    el.style.opacity       = show ? "" : "0.08";
    el.style.pointerEvents = show ? "" : "none";
    if (show) visible.push(scene.id);
  });
  // Sync viewer — show only in-range memories
  fetch("/api/world-selection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scene_ids: isAll ? _allExploreScenes.map(s => s.id) : visible }),
  }).catch(() => {});
}

function focusExploreScene(scene) {
  haptic(20);
  _exploreWords.forEach(({ el }) => el.classList.remove("focused"));
  _exploreWords.get(scene.id)?.el.classList.add("focused");
  _exploreFocusedId = scene.id;
  fetch("/api/select-scene", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scene_id: scene.id }),
  }).catch(() => {});
}

// ── Navigate — joystick + altitude + gyroscope ────────

function haptic(pattern) {
  // Android minimum effective vibration is ~20ms; shorter durations are ignored
  if (!navigator.vibrate) return;
  if (typeof pattern === "number") pattern = Math.max(20, pattern);
  navigator.vibrate(pattern);
}

let _navState = { move_x: 0, move_z: 0, move_y: 0, turn_x: 0, turn_y: 0, gyro: false, gyro_yaw: null, gyro_pitch: null, ts: 0 };
let _navLoopTimer = null;
let _gyroActive = false;
let _gyroRef    = { alpha: 0, beta: 0 };
let _gyroListening = false;

function _sendNav() {
  _navState.ts = Date.now();
  fetch("/api/navigate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(_navState),
    keepalive: true,
  }).catch(() => {});
}

function _startNavLoop() {
  if (_navLoopTimer) return;
  _navLoopTimer = setInterval(_sendNav, 50);
}

function _stopNavLoop() {
  clearInterval(_navLoopTimer);
  _navLoopTimer = null;
  _navState.move_x = 0; _navState.move_z = 0; _navState.move_y = 0;
  _navState.turn_x = 0; _navState.turn_y = 0;
  if (!_gyroActive) { _navState.gyro = false; _navState.gyro_yaw = null; _navState.gyro_pitch = null; }
  _sendNav();
}

function _checkStopNav() {
  if (!_navState.move_x && !_navState.move_z && !_navState.move_y &&
      !_navState.turn_x && !_navState.turn_y && !_gyroActive) {
    _stopNavLoop();
  }
}

function initJoystick(stickEl, knobEl, onUpdate) {
  let _active    = false;
  let _pid       = null;
  let _wasAtMax  = false;

  function getPos(e) {
    const rect = stickEl.getBoundingClientRect();
    const ox = e.clientX - (rect.left + rect.width  / 2);
    const oy = e.clientY - (rect.top  + rect.height / 2);
    const maxR = rect.width * 0.38;
    const dist = Math.hypot(ox, oy);
    const atMax = dist > maxR;
    const scale = atMax ? maxR / dist : 1;
    return { dx: ox * scale, dy: oy * scale,
             nx: (ox * scale) / maxR, ny: (oy * scale) / maxR, atMax };
  }

  stickEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    stickEl.setPointerCapture(e.pointerId);
    _active = true; _pid = e.pointerId; _wasAtMax = false;
    haptic(20);
    const { dx, dy, nx, ny } = getPos(e);
    knobEl.style.transition = "none";
    knobEl.style.transform  = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    onUpdate(nx, ny);
    _startNavLoop();
  }, { passive: false });

  stickEl.addEventListener("pointermove", (e) => {
    if (!_active || e.pointerId !== _pid) return;
    const { dx, dy, nx, ny, atMax } = getPos(e);
    if (atMax && !_wasAtMax) haptic(20);
    _wasAtMax = atMax;
    knobEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    onUpdate(nx, ny);
  });

  function onEnd(e) {
    if (!_active || e.pointerId !== _pid) return;
    _active = false; _pid = null; _wasAtMax = false;
    knobEl.style.transition = "transform 0.22s ease";
    knobEl.style.transform  = "translate(-50%, -50%)";
    onUpdate(0, 0);
    _checkStopNav();
  }
  stickEl.addEventListener("pointerup",     onEnd);
  stickEl.addEventListener("pointercancel", onEnd);
}

function initAltSlider(trackEl, thumbEl) {
  let _active = false;

  function altFrom(cy) {
    const rect = trackEl.getBoundingClientRect();
    return Math.max(-1, Math.min(1, 1 - ((cy - rect.top) / rect.height) * 2));
  }
  function setThumb(alt) {
    thumbEl.style.top = `${(1 - (alt + 1) / 2) * 100}%`;
  }

  trackEl.addEventListener("touchstart", (e) => {
    e.preventDefault();
    _active = true;
    trackEl.classList.add("active");
    haptic(20);
    const alt = altFrom(e.touches[0].clientY);
    setThumb(alt);
    thumbEl.style.transition = "none";
    _navState.move_y = alt;
    _startNavLoop();
  }, { passive: false });

  trackEl.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (!_active) return;
    const alt = altFrom(e.touches[0].clientY);
    setThumb(alt);
    _navState.move_y = alt;
  }, { passive: false });

  function onEnd() {
    if (!_active) return;
    _active = false;
    trackEl.classList.remove("active");
    haptic(20);
    _navState.move_y = 0;
    thumbEl.style.transition = "top 0.20s ease";
    setThumb(0);
    _checkStopNav();
  }
  trackEl.addEventListener("touchend",    onEnd, { passive: true });
  trackEl.addEventListener("touchcancel", onEnd, { passive: true });
}

function _onDeviceOrientation(e) {
  if (!_gyroActive || e.alpha === null) return;
  let da = e.alpha - _gyroRef.alpha;
  if (da >  180) da -= 360;
  if (da < -180) da += 360;
  const db = e.beta - _gyroRef.beta;
  _navState.gyro       = true;
  _navState.gyro_yaw   = -(da * Math.PI / 180);
  _navState.gyro_pitch = Math.max(-1.30, Math.min(1.30, db * Math.PI / 180 * 0.5));
}

async function toggleGyro(btnEl) {
  const navStatusEl = document.getElementById("nav-status");
  if (_gyroActive) {
    _gyroActive = false;
    haptic(25);
    btnEl.classList.remove("active");
    _navState.gyro = false; _navState.gyro_yaw = null; _navState.gyro_pitch = null;
    if (navStatusEl) navStatusEl.textContent = "touch joysticks to navigate the viewer";
    _checkStopNav();
    return;
  }

  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== "granted") {
        haptic([30, 80, 30]);
        if (navStatusEl) navStatusEl.textContent = "gyroscope permission denied";
        return;
      }
    } catch {
      if (navStatusEl) navStatusEl.textContent = "could not access gyroscope";
      return;
    }
  }

  if (!_gyroListening) {
    window.addEventListener("deviceorientation", _onDeviceOrientation);
    _gyroListening = true;
  }
  window.addEventListener("deviceorientation", (e) => {
    if (e.alpha !== null) { _gyroRef.alpha = e.alpha; _gyroRef.beta = e.beta; }
  }, { once: true });

  _gyroActive = true;
  haptic([25, 60, 20]);
  btnEl.classList.add("active");
  if (navStatusEl) navStatusEl.textContent = "gyro active — move phone to look around";
  _startNavLoop();
}

// Wire navigate controls once DOM is ready
(function initNavigateTab() {
  const moveStickEl  = document.getElementById("move-stick");
  const moveKnobEl   = document.getElementById("move-knob");
  const lookStickEl  = document.getElementById("look-stick");
  const lookKnobEl   = document.getElementById("look-knob");
  const altTrackEl   = document.getElementById("alt-track");
  const altThumbEl   = document.getElementById("alt-thumb");
  const gyroBtnEl    = document.getElementById("gyro-btn");
  const navResetBtnEl = document.getElementById("nav-reset-btn");

  if (moveStickEl) initJoystick(moveStickEl, moveKnobEl, (nx, ny) => { _navState.move_x = nx; _navState.move_z = -ny; });
  if (lookStickEl) initJoystick(lookStickEl, lookKnobEl, (nx, ny) => { _navState.turn_x = nx; _navState.turn_y = ny; });
  if (altTrackEl)  initAltSlider(altTrackEl, altThumbEl);
  if (gyroBtnEl)   gyroBtnEl.addEventListener("click", () => toggleGyro(gyroBtnEl));

  if (navResetBtnEl) {
    navResetBtnEl.addEventListener("click", () => {
      haptic([20, 40, 20]);
      fetch("/api/reset-view", { method: "POST" }).catch(() => {});
    });
  }
})();

// Set initial bottom bar state
updateBottomBar();
