import "./memories.css";
import { initThemeToggle, carryAccentToViewerLinks, initCursor, initTapSounds } from "./theme.js";

initThemeToggle();
carryAccentToViewerLinks();
initCursor();
initTapSounds();

const statusEl = document.getElementById("memories-status");
const listEl = document.getElementById("memories-list");
const stitchedStatusEl = document.getElementById("stitched-status");
const stitchedListEl = document.getElementById("stitched-list");
const pageBackBtn = document.getElementById("page-back");

pageBackBtn?.addEventListener("click", () => {
  if (window.history.length > 1) window.history.back();
  else window.location.href = "/index.html";
});

let activeCardEl = null;

// Tracks which memory IDs are already on screen per list, so re-rendering on
// each 15s poll only adds/removes what actually changed instead of nuking
// and rebuilding every card — that's what lets a genuinely new card (e.g. a
// stitched scene the memory brain just finished) play its tile-entrance
// animation, while everything already there stays put, undisturbed.
const renderedCards = { individual: new Map(), stitched: new Map() };

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
    }
  }
}

async function loadMemories() {
  try {
    const [scenesRes, stitchedRes] = await Promise.all([
      fetch("/api/scenes", { cache: "no-store" }),
      fetch("/api/stitched-scenes", { cache: "no-store" }).catch(() => null),
    ]);
    if (!scenesRes.ok) throw new Error(`HTTP ${scenesRes.status}`);

    const individual = await scenesRes.json();
    const stitched = stitchedRes && stitchedRes.ok ? await stitchedRes.json() : [];
    individual.sort((a, b) => b.created_at - a.created_at);

    renderStitched(stitched);
    renderIndividual(individual);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Could not reach the archive — try again shortly.";
    stitchedStatusEl.textContent = "";
  }
}

function renderStitched(memories) {
  stitchedStatusEl.textContent = memories.length
    ? `${memories.length} collective scene${memories.length > 1 ? "s" : ""} — built by aligning multiple people's photos of the same place:`
    : "";
  syncCardList(
    stitchedListEl,
    "stitched",
    memories,
    `<p class="gap-empty">None yet — once 2+ people upload photos of the same place, the memory brain's collective scenes will appear here.</p>`,
  );
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

  return card;
}

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
  const isStitched = memory.id.startsWith("stitched_");
  const target = isStitched ? stitchedStatusEl : statusEl;

  cardEl.classList.add("deleting");
  try {
    const res = await fetch(`/api/scenes/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    cardEl.remove();
    target.textContent = `Deleted "${memory.name}".`;
  } catch (err) {
    console.error(err);
    cardEl.classList.remove("deleting");
    target.textContent = `Could not delete "${memory.name}": ${err.message}`;
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

    statusEl.textContent = `Now showing "${memory.name}" on the viewer.`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Could not select that memory: ${err.message}`;
  }
}

loadMemories();
setInterval(loadMemories, 15_000);
