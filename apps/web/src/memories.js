import "./memories.css";

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
  if (!memories.length) {
    stitchedStatusEl.textContent = "";
    stitchedListEl.innerHTML =
      `<p class="gap-empty">None yet — once 2+ people upload photos of the same place, the memory brain's collective scenes will appear here.</p>`;
    return;
  }

  stitchedStatusEl.textContent =
    `${memories.length} collective scene${memories.length > 1 ? "s" : ""} — built by aligning multiple people's photos of the same place:`;

  stitchedListEl.innerHTML = "";
  for (const memory of memories) {
    stitchedListEl.appendChild(buildMemoryCard(memory));
  }
}

function renderIndividual(memories) {
  if (!memories.length) {
    statusEl.textContent = "";
    listEl.innerHTML = `<p class="gap-empty">No memories yet — be the first to share one from the main page.</p>`;
    return;
  }

  statusEl.textContent =
    `${memories.length} memor${memories.length > 1 ? "ies" : "y"} in the archive — tap one to show it on the viewer:`;

  listEl.innerHTML = "";
  for (const memory of memories) {
    listEl.appendChild(buildMemoryCard(memory));
  }
}

function buildMemoryCard(memory) {
  const card = document.createElement("div");
  card.className = "memory-card";

  const thumb = memory.image_url
    ? `<img class="memory-thumb" src="${memory.image_url}" alt="" />`
    : `<div class="memory-thumb placeholder">3D</div>`;

  card.innerHTML = `
    ${thumb}
    <div class="memory-info">
      <p class="memory-name">${escapeHtml(memory.name)}</p>
      <p class="memory-meta">${escapeHtml(memory.author)}${memory.year ? " · " + escapeHtml(memory.year) : ""}</p>
    </div>
    <button type="button" class="memory-go">Show</button>
    <button type="button" class="memory-delete" aria-label="Delete this memory">🗑</button>
  `;

  card.addEventListener("click", () => selectMemory(memory, card));

  const deleteBtn = card.querySelector(".memory-delete");
  deleteBtn.addEventListener("click", (event) => {
    event.stopPropagation(); // don't also trigger selectMemory via the card click
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
    btnEl.textContent = "🗑";
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
