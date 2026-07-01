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
  resetAudioUI();

  form.querySelectorAll("input[type=text], textarea").forEach(el => (el.value = ""));
  [dotName, dotAuthor, dotYear, dotStory].forEach(d => d.classList.remove("filled"));
  charCounter.textContent = "0 / 280";
  charCounter.classList.remove("near-limit");
}
