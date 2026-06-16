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

# Populated lazily on first upload (deferred to avoid importing torch at startup)
SUPPORTED_EXTENSIONS: set[str] = set()

storage = Storage(STORAGE_DIR)
engine = SharpEngine(device=DEVICE, checkpoint_path=Path(CHECKPOINT) if CHECKPOINT else None)

# Set once the model has finished loading in the background warmup thread.
_ready = threading.Event()

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
    threading.Thread(target=_warmup, name="sharp-warmup", daemon=True).start()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "model_ready": engine.ready, "device": engine.device}


@app.get("/api/latest")
def latest() -> JSONResponse:
    scene = storage.latest()
    return JSONResponse(_serialize(scene) if scene else None)


@app.get("/api/scenes")
def scenes() -> list[dict]:
    return [_serialize(s) for s in storage.list_scenes()]


@app.post("/api/predict")
def predict(
    image: UploadFile = File(...),
    name: str = Form(""),
    author: str = Form(""),
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

    scene_id, upload_path, ply_path = storage.new_scene_paths(suffix)

    with upload_path.open("wb") as f:
        f.write(image.file.read())

    LOGGER.info("Running SHARP inference for scene %s (%s)", scene_id, upload_path.name)
    try:
        engine.predict_to_ply(upload_path, ply_path)
    except Exception as exc:
        LOGGER.exception("Inference failed for scene %s", scene_id)
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc

    scene = storage.add_scene(
        Scene(
            id=scene_id,
            name=name.strip() or "Untitled",
            author=author.strip() or "Anonymous",
            ply_file=ply_path.name,
            image_file=upload_path.name,
            created_at=now(),
        )
    )
    LOGGER.info("Scene %s ready -> %s", scene_id, scene.ply_url)
    return _serialize(scene)


def _serialize(scene: Scene) -> dict:
    return {
        "id": scene.id,
        "name": scene.name,
        "author": scene.author,
        "ply_url": scene.ply_url,
        "created_at": scene.created_at,
    }


# Serve generated PLYs (and let the viewer fetch them).
app.mount("/outputs", StaticFiles(directory=str(storage.splats_dir)), name="outputs")
