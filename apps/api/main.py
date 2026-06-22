"""Memo-House backend.

Accepts photo uploads, turns each into a Gaussian-splat PLY using the SHARP
model, stores the result, and exposes the latest scene to the viewer.

Run via:  uvicorn main:app   (with the ml-sharp venv active)
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from memory_brain import MemoryBrain
from sharp_engine import SharpEngine
from storage import Scene, Storage, now

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
LOGGER = logging.getLogger("memo-haus.api")

# --- configuration -----------------------------------------------------
# Storage lives at the repo root (outside apps/api) so generated files never
# trip uvicorn's --reload watcher, which would otherwise reload the model.
_DEFAULT_STORAGE = Path(__file__).resolve().parent.parent.parent / "storage"
STORAGE_DIR = Path(os.environ.get("MEMO_STORAGE_DIR", _DEFAULT_STORAGE)).resolve()
DEVICE = os.environ.get("MEMO_DEVICE", "default")
CHECKPOINT = os.environ.get("MEMO_CHECKPOINT")
WARMUP_TIMEOUT = float(os.environ.get("MEMO_WARMUP_TIMEOUT", "900"))
# Off by default: pairwise DUSt3R registration is a second heavy model
# competing for the same 4GB GPU as SHARP. Set MEMO_ENABLE_REGISTRATION=1
# to let the memory brain attempt real 3D alignment on likely-overlap pairs.
ENABLE_REGISTRATION = os.environ.get("MEMO_ENABLE_REGISTRATION", "0") == "1"

# Populated lazily on first upload (deferred to avoid importing torch at startup)
SUPPORTED_EXTENSIONS: set[str] = set()

storage = Storage(STORAGE_DIR)
engine = SharpEngine(device=DEVICE, checkpoint_path=Path(CHECKPOINT) if CHECKPOINT else None)
brain = MemoryBrain(storage, enable_registration=ENABLE_REGISTRATION)

_ready = threading.Event()        # set once model is loaded
_processing = threading.Event()   # set while a prediction is running

# Lets the mobile app tell the viewer "show this specific memory now" without
# touching the viewer's own polling/rotation logic at all — the viewer just
# additionally checks this and calls its existing goToIndex() when it changes.
_selection_lock = threading.Lock()
_selected_scene_id: str | None = None
_selected_at: float = 0.0


class SelectScenePayload(BaseModel):
    scene_id: str

app = FastAPI(title="Memo-House API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _warmup() -> None:
    try:
        engine.load()
        _ready.set()
    except Exception:  # pragma: no cover - surfaced via /api/health
        LOGGER.exception("Failed to load SHARP model during warmup")


@app.on_event("startup")
def on_startup() -> None:
    LOGGER.info("Storage at %s", STORAGE_DIR)
    LOGGER.info("Warming up SHARP model in the background (device=%s)...", engine.device)
    LOGGER.info("Memory brain registration: %s", "ENABLED" if ENABLE_REGISTRATION else "disabled")
    threading.Thread(target=_warmup, name="sharp-warmup", daemon=True).start()
    # Deliberately NOT calling brain.reconcile() synchronously here: when
    # registration is enabled it can run slow (or hang on a flaky network
    # call inside DUSt3R's checkpoint loader) CPU-bound work per candidate
    # pair, and a blocking call in the startup handler would mean the whole
    # API — including plain scene browsing — never finishes starting until
    # every pair is processed. The background loop below picks everything
    # up within its own first cycle instead, without blocking readiness.
    brain.start_background_loop()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "model_ready": engine.ready, "device": engine.device, "processing": _processing.is_set()}


@app.get("/api/latest")
def latest() -> JSONResponse:
    scene = storage.latest()
    return JSONResponse(_serialize(scene) if scene else None)


@app.get("/api/scenes")
def scenes() -> list[dict]:
    return [_serialize(s) for s in storage.list_scenes()]


@app.get("/api/clusters")
def clusters() -> dict:
    """The memory brain's current view: locations, decade coverage, gaps,
    and likely-overlap pairs (2D visual similarity, not 3D registration)."""
    return brain.read()


@app.post("/api/select-scene")
def select_scene(payload: SelectScenePayload) -> dict:
    """Mobile app calls this when the user picks a memory to view. The
    viewer polls GET /api/select-scene and jumps to it via its normal,
    unchanged goToIndex() — this only decides *which* scene, not how the
    viewer shows it."""
    global _selected_scene_id, _selected_at
    with _selection_lock:
        _selected_scene_id = payload.scene_id
        _selected_at = now()
        return {"scene_id": _selected_scene_id, "selected_at": _selected_at}


@app.get("/api/select-scene")
def get_selected_scene() -> dict:
    with _selection_lock:
        return {"scene_id": _selected_scene_id, "selected_at": _selected_at}


@app.get("/api/stitched-scenes")
def stitched_scenes() -> list[dict]:
    """Collective scenes the brain successfully merged from 2+ confirmed,
    registered photos of the same place. Shaped like /api/scenes so the
    viewer can drop these straight into its normal rotation."""
    data = brain.read()
    out = []
    for loc in data.get("locations", {}).values():
        for overlap in loc.get("confirmed_overlaps", []):
            stitched_name = overlap.get("stitched_ply")
            if not stitched_name:
                continue
            out.append({
                "id": f"stitched_{overlap['scene_a']}_{overlap['scene_b']}",
                "name": f"{loc['location_label']} (collective)",
                "author": "Collective memory",
                "year": "",
                "story": "Combined from multiple people's photos of this place.",
                "cluster_id": "",
                "ply_url": f"/stitched/{stitched_name}",
                "image_url": None,
                "created_at": 0,
                "stitch_confidence": overlap.get("confidence"),
            })
    return out


@app.post("/api/predict")
def predict(
    image: UploadFile = File(...),
    name: str = Form(""),
    author: str = Form(""),
    year: str = Form(""),
    story: str = Form(""),
) -> dict:
    suffix = Path(image.filename or "").suffix.lower()
    # Populate supported extensions on first upload (torch must be loaded by then)
    if not SUPPORTED_EXTENSIONS:
        from sharp.utils import io as sharp_io
        SUPPORTED_EXTENSIONS.update(ext.lower() for ext in sharp_io.get_supported_image_extensions())
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported image type '{suffix or image.filename}'.",
        )

    # Block until the model is loaded (first run may download the checkpoint).
    if not _ready.wait(timeout=WARMUP_TIMEOUT):
        raise HTTPException(status_code=503, detail="Model is still warming up. Try again shortly.")

    scene_id, upload_path, ply_path = storage.new_scene_paths(
        suffix, name=name, year=year, story=story
    )

    with upload_path.open("wb") as f:
        f.write(image.file.read())

    LOGGER.info("Running SHARP inference for scene %s (%s)", scene_id, upload_path.name)
    _processing.set()
    try:
        engine.predict_to_ply(upload_path, ply_path)
    except Exception as exc:
        LOGGER.exception("Inference failed for scene %s", scene_id)
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc
    finally:
        _processing.clear()

    scene = storage.add_scene(
        Scene(
            id=scene_id,
            name=name.strip() or "Untitled",
            author=author.strip() or "Anonymous",
            ply_file=ply_path.name,
            image_file=upload_path.name,
            created_at=now(),
            year=year.strip(),
            story=story.strip(),
            cluster_id=brain.cluster_id_for(name, year),
        )
    )
    LOGGER.info("Scene %s ready -> %s (cluster %s)", scene_id, scene.ply_url, scene.cluster_id)
    # Deliberately NOT spawning a fresh reconcile thread here: a new thread
    # touching torch/CUDA right after SHARP's own GPU inference call is the
    # kind of multi-threaded CUDA contention that produces cuDNN stream
    # errors. The brain's existing 30s background loop (start_background_loop)
    # picks this scene up on its own within half a minute.
    return _serialize(scene)


def _serialize(scene: Scene) -> dict:
    return {
        "id": scene.id,
        "name": scene.name,
        "author": scene.author,
        "year": scene.year,
        "story": scene.story,
        "cluster_id": scene.cluster_id,
        "ply_url": scene.ply_url,
        "image_url": scene.image_url,
        "created_at": scene.created_at,
    }


# Serve generated PLYs, source uploads, and stitched collective scenes.
app.mount("/outputs", StaticFiles(directory=str(storage.splats_dir)), name="outputs")
app.mount("/uploads", StaticFiles(directory=str(storage.uploads_dir)), name="uploads")
app.mount("/stitched", StaticFiles(directory=str(storage.stitched_dir)), name="stitched")
