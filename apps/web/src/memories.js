import "./memories.css";
import { initThemeToggle, carryAccentToViewerLinks, initCursor, initTapSounds, initFullscreenToggle, initFullscreenPersistence } from "./theme.js";

initThemeToggle();
carryAccentToViewerLinks();
initCursor();
initTapSounds();
initFullscreenToggle();
initFullscreenPersistence();

const statusEl = document.getElementById("memories-status");
const listEl = document.getElementById("memories-list");
const pageBackBtn = document.getElementById("page-back");

pageBackBtn?.addEventListener("click", () => {
  if (window.history.length > 1) window.history.back();
  else window.location.href = "/index.html";
});

let activeCardEl = null;

const renderedCards = { individual: new Map() };

function syncCardList(container, listKey, memories, emptyHtml) {
  const map = renderedCards[listKey];

  if (!memories.length) {
    container.innerHTML = emptyHtml;
    map.clear();
    return;
  }
  // First real render for this list — clear the "loading"/empty placeholder
  if (!map.size && container.querySelector(".gap-empty")) {
    container.innerHTML = "";
  }

  const seen = new Set();
  for (const memory of memories) {
    seen.add(memory.id);
    if (map.has(memory.id)) continue; // already on screen — leave it alone
    const card = buildMemoryCard(memory);
    card.classList.add("entering");
    card.addEventListener("animationend", () => card.classList.remove("entering"), { once: true });
    container.appendChild(card);
    map.set(memory.id, card);
  }

  for (const [id, card] of map) {
    if (!seen.has(id)) {
      card.remove();
      map.delete(id);
      // A selected memory disappearing (deleted, etc.) shouldn't leave a
      // stale entry pointing at a detached card.
      if (verseSelection.has(id)) {
        verseSelection.delete(id);
        syncWorldSelectBar();
      }
    }
  }
}

async function loadMemories() {
  try {
    const res = await fetch("/api/scenes", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const individual = await res.json();
    individual.sort((a, b) => b.created_at - a.created_at);
    renderIndividual(individual);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Could not reach the archive — try again shortly.";
  }
}

function renderIndividual(memories) {
  statusEl.textContent = memories.length
    ? `${memories.length} memor${memories.length > 1 ? "ies" : "y"} in the archive — tap one to show it on the viewer:`
    : "";
  syncCardList(
    listEl,
    "individual",
    memories,
    `<p class="gap-empty">No memories yet — be the first to share one from the main page.</p>`,
  );
}

function buildMemoryCard(memory) {
  const card = document.createElement("div");
  card.className = "memory-card";

  const frame = memory.image_url
    ? `<div class="memory-card-frame" style="background-image:url('${memory.image_url}')"></div>`
    : `<div class="memory-card-frame placeholder">3D</div>`;

  card.innerHTML = `
    ${frame}
    <div class="memory-card-overlay">
      <span class="memory-card-name">${escapeHtml(memory.name)}</span>
      <span class="memory-card-meta">${escapeHtml(memory.author)}${memory.year ? " · " + escapeHtml(memory.year) : ""}</span>
    </div>
    <button type="button" class="memory-verse-toggle" aria-label="Add to Memory Verse selection"></button>
    <button type="button" class="memory-card-show">Show</button>
    <button type="button" class="memory-delete" aria-label="Delete this memory">Delete</button>
  `;

  // First tap on the card just reveals the eye button (and un-reveals any
  // other card) — actually sending it to the viewer is a deliberate second
  // tap, on the eye itself, so flicking through the stack never accidentally
  // jumps the live viewer to the wrong memory.
  card.addEventListener("click", () => {
    if (card.classList.contains("revealed")) return;
    document.querySelectorAll(".memory-card.revealed").forEach(el => el.classList.remove("revealed"));
    card.classList.add("revealed");
  });

  const showBtn = card.querySelector(".memory-card-show");
  showBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    selectMemory(memory, card);
  });

  const deleteBtn = card.querySelector(".memory-delete");
  deleteBtn.addEventListener("click", (event) => {
    event.stopPropagation(); // don't also trigger the reveal via the card click
    handleDeleteClick(memory, card, deleteBtn);
  });

  const verseToggleBtn = card.querySelector(".memory-verse-toggle");
  verseToggleBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleVerseSelection(memory.id, card, verseToggleBtn);
  });

  return card;
}

// ── Memory Verse multi-select ───────────────────────────────────────────
// Picking which memories go into Memory Verse, then sending that set to
// whichever viewer is open — independent of the existing single-select
// "Show" flow above, which still always means "this one, right now".

const worldSelectBarEl   = document.getElementById("world-select-bar");
const worldSelectCountEl = document.getElementById("world-select-count");
const worldSelectClearBtn = document.getElementById("world-select-clear");
const worldSelectEnterBtn = document.getElementById("world-select-enter");

const verseSelection = new Map(); // memory id -> { card, toggleBtn }

function toggleVerseSelection(memoryId, card, toggleBtn) {
  if (verseSelection.has(memoryId)) {
    verseSelection.delete(memoryId);
    card.classList.remove("verse-selected");
    toggleBtn.classList.remove("selected");
  } else {
    verseSelection.set(memoryId, { card, toggleBtn });
    card.classList.add("verse-selected");
    toggleBtn.classList.add("selected");
  }
  syncWorldSelectBar();
}

function syncWorldSelectBar() {
  const count = verseSelection.size;
  worldSelectBarEl.classList.toggle("hidden", count === 0);
  worldSelectCountEl.textContent = `${count} selected`;
}

worldSelectClearBtn.addEventListener("click", () => {
  for (const { card, toggleBtn } of verseSelection.values()) {
    card.classList.remove("verse-selected");
    toggleBtn.classList.remove("selected");
  }
  verseSelection.clear();
  syncWorldSelectBar();
});

worldSelectEnterBtn.addEventListener("click", async () => {
  const sceneIds = Array.from(verseSelection.keys());
  if (sceneIds.length === 0) return;
  worldSelectEnterBtn.disabled = true;
  worldSelectEnterBtn.textContent = "Sending…";
  try {
    const res = await fetch("/api/world-selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene_ids: sceneIds }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    worldSelectEnterBtn.textContent = "Sent to viewer ✓";
    setTimeout(() => { worldSelectEnterBtn.textContent = "Enter Memory Verse"; }, 2000);
  } catch (err) {
    console.error(err);
    worldSelectEnterBtn.textContent = "Failed — try again";
    setTimeout(() => { worldSelectEnterBtn.textContent = "Enter Memory Verse"; }, 2000);
  } finally {
    worldSelectEnterBtn.disabled = false;
  }
});

// Two-step inline confirm — no native confirm() dialog, matches the rest of
// this app's custom UI. First click arms it; a second click within 3s
// actually deletes; otherwise it quietly reverts.
function handleDeleteClick(memory, cardEl, btnEl) {
  if (btnEl.dataset.confirming === "1") {
    deleteMemory(memory, cardEl);
    return;
  }
  btnEl.dataset.confirming = "1";
  btnEl.textContent = "Confirm?";
  btnEl.classList.add("confirming");
  btnEl._revertTimer = setTimeout(() => {
    btnEl.dataset.confirming = "0";
    btnEl.textContent = "Delete";
    btnEl.classList.remove("confirming");
  }, 3000);
}

async function deleteMemory(memory, cardEl) {
  cardEl.classList.add("deleting");
  try {
    const res = await fetch(`/api/scenes/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cardEl.remove();
    statusEl.textContent = `Deleted "${memory.name}".`;
  } catch (err) {
    console.error(err);
    cardEl.classList.remove("deleting");
    statusEl.textContent = `Could not delete "${memory.name}": ${err.message}`;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

async function selectMemory(memory, cardEl) {
  statusEl.textContent = `Sending "${memory.name}" to the viewer…`;
  try {
    const res = await fetch("/api/select-scene", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene_id: memory.id }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (activeCardEl) activeCardEl.classList.remove("active");
    cardEl.classList.add("active");
    activeCardEl = cardEl;
    // Optimistic: the viewer will confirm this via its own camera-state POST
    // in a moment, but marking it here too means pollFocusedMemory() below
    // doesn't see stale state and flicker the highlight back during that
    // brief window.
    _lastPolledFocusId = memory.id;

    statusEl.textContent = `Now showing "${memory.name}" on the viewer.`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Could not select that memory: ${err.message}`;
  }
}

// Mirrors whichever memory the viewer is currently focused on, however that
// focus came about — tapping "Show" on a card here is one way, but the
// viewer ALSO auto-focuses a memory just by navigating up to one and
// stopping (dwell-to-focus), which never touches this page's own
// selectMemory() at all. Reuses the camera-state the viewer already posts a
// few times a second for the map's "you are here" marker. Purely visual —
// never re-POSTs /api/select-scene, so it can't loop back into re-flying the
// viewer's camera every poll tick.
let _lastPolledFocusId; // undefined = not polled yet, distinct from null = polled, nothing focused

async function pollFocusedMemory() {
  try {
    const r = await fetch("/api/camera-state", { cache: "no-store" });
    if (!r.ok) return;
    const { focused_scene_id } = await r.json();
    if (focused_scene_id === _lastPolledFocusId) return;
    _lastPolledFocusId = focused_scene_id;
    if (activeCardEl) activeCardEl.classList.remove("active");
    activeCardEl = focused_scene_id ? (renderedCards.individual.get(focused_scene_id) || null) : null;
    if (activeCardEl) activeCardEl.classList.add("active");
  } catch {}
}

loadMemories();
setInterval(loadMemories, 15_000);
pollFocusedMemory();
setInterval(pollFocusedMemory, 1000);
