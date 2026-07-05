"""Memo-House backend.

Accepts photo uploads, turns each into a Gaussian-splat PLY using the SHARP
model, stores the result, and exposes the latest scene to the viewer.

Run via:  uvicorn main:app   (with the ml-sharp venv active)
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path

import requests
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from sharp_engine import SharpEngine
from storage import Scene, Storage, now

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
LOGGER = logging.getLogger("memo-haus.api")

# --- configuration -----------------------------------------------------
_DEFAULT_STORAGE = Path(__file__).resolve().parent.parent.parent / "storage"
STORAGE_DIR = Path(os.environ.get("MEMO_STORAGE_DIR", _DEFAULT_STORAGE)).resolve()
DEVICE = os.environ.get("MEMO_DEVICE", "default")
CHECKPOINT = os.environ.get("MEMO_CHECKPOINT")
WARMUP_TIMEOUT = float(os.environ.get("MEMO_WARMUP_TIMEOUT", "900"))

# Populated lazily on first upload (deferred to avoid importing torch at startup)
SUPPORTED_EXTENSIONS: set[str] = set()

storage = Storage(STORAGE_DIR)
engine = SharpEngine(device=DEVICE, checkpoint_path=Path(CHECKPOINT) if CHECKPOINT else None)

_ready = threading.Event()        # set once model is loaded
_processing = threading.Event()   # set while a prediction is running

# Lets the mobile app tell the viewer "show this specific memory now" without
# touching the viewer's own polling/rotation logic at all — the viewer just
# additionally checks this and calls its existing goToIndex() when it changes.
_selection_lock = threading.Lock()
_selected_scene_id: str | None = None
_selected_at: float = 0.0

# Same idea, but for Memory Verse: a curated list of ids instead of one, so
# the world only ever loads scenes the visitor actually picked — keeps it
# fast and avoids placing dozens of scenes (and giant stitched merges) at
# once, which is what made it laggy and prone to clashing.
_world_selected_ids: list[str] = []
_world_selected_at: float = 0.0

_nav_lock = threading.Lock()
_nav_state: dict = {"move_x":0,"move_z":0,"move_y":0,"turn_x":0,"turn_y":0,"gyro":False,"gyro_yaw":None,"gyro_pitch":None,"ts":0}
_reset_ts: float = 0.0


class SelectScenePayload(BaseModel):
    scene_id: str


class WorldSelectionPayload(BaseModel):
    scene_ids: list[str]


class NavPayload(BaseModel):
    move_x: float = 0
    move_z: float = 0
    move_y: float = 0
    turn_x: float = 0
    turn_y: float = 0
    gyro: bool = False
    gyro_yaw: float | None = None
    gyro_pitch: float | None = None
    ts: float = 0

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
    return {"status": "ok", "model_ready": engine.ready, "device": engine.device, "processing": _processing.is_set()}


@app.get("/api/latest")
def latest() -> JSONResponse:
    scene = storage.latest()
    return JSONResponse(_serialize(scene) if scene else None)


@app.get("/api/scenes")
def scenes() -> list[dict]:
    return [_serialize(s) for s in storage.list_scenes()]


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


@app.post("/api/world-selection")
def set_world_selection(payload: WorldSelectionPayload) -> dict:
    """Mobile app calls this after multi-selecting memories to place in
    Memory Verse. Mirrors /api/select-scene's pattern exactly, just for a
    list instead of one id — the viewer polls GET and enters the world with
    exactly this set, leaving everything else about it unchanged."""
    global _world_selected_ids, _world_selected_at
    with _selection_lock:
        _world_selected_ids = payload.scene_ids
        _world_selected_at = now()
        return {"scene_ids": _world_selected_ids, "selected_at": _world_selected_at}


@app.get("/api/world-selection")
def get_world_selection() -> dict:
    with _selection_lock:
        return {"scene_ids": _world_selected_ids, "selected_at": _world_selected_at}


@app.post("/api/navigate")
def set_navigate(payload: NavPayload) -> dict:
    global _nav_state
    data = payload.model_dump()
    data["ts"] = time.time() * 1000  # server-side timestamp avoids mobile/desktop clock skew
    with _nav_lock:
        _nav_state = data
    return {"ok": True}


@app.get("/api/navigate")
def get_navigate() -> dict:
    with _nav_lock:
        return dict(_nav_state)


@app.post("/api/reset-view")
def post_reset_view() -> dict:
    global _reset_ts
    _reset_ts = time.time() * 1000
    return {"ok": True, "ts": _reset_ts}


@app.get("/api/reset-view")
def get_reset_view() -> dict:
    return {"ts": _reset_ts}


@app.delete("/api/scenes/{scene_id}")
def delete_scene(scene_id: str) -> dict:
    scene = storage.delete_scene(scene_id)
    if scene is None:
        raise HTTPException(status_code=404, detail="Scene not found")
    LOGGER.info("Deleted scene %s (and its files)", scene_id)
    return {"deleted": scene_id}


@app.get("/api/music/search")
def music_search(q: str) -> list[dict]:
    """Proxies Openverse's free, keyless audio search (Creative Commons /
    openly-licensed tracks) — the mobile app's "Browse Music" picker calls
    this directly, no API key needed on either side."""
    if not q.strip():
        return []
    try:
        resp = requests.get(
            "https://api.openverse.org/v1/audio/",
            params={"q": q, "page_size": 12},
            timeout=8,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Music search failed: {exc}") from exc

    return [
        {
            "id": item.get("id"),
            "title": item.get("title") or "Untitled",
            "creator": item.get("creator") or "Unknown artist",
            "audio_url": item.get("url"),
            "duration_ms": item.get("duration"),
            "license": item.get("license"),
        }
        for item in data.get("results", [])
        if item.get("url")
    ]


@app.get("/api/music/fetch")
def music_fetch(url: str) -> StreamingResponse:
    """Streams a third-party track through our own origin. The mobile app's
    crop UI needs to decode the audio with the Web Audio API, which fails on
    cross-origin media unless the third-party host sends CORS headers (most
    don't) — fetching same-origin through here sidesteps that entirely."""
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid url")
    try:
        upstream = requests.get(url, stream=True, timeout=15)
        upstream.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not fetch track: {exc}") from exc
    content_type = upstream.headers.get("Content-Type", "audio/mpeg")
    return StreamingResponse(upstream.iter_content(chunk_size=8192), media_type=content_type)


@app.post("/api/predict")
def predict(
    image: UploadFile = File(...),
    name: str = Form(""),
    author: str = Form(""),
    year: str = Form(""),
    story: str = Form(""),
    audio: UploadFile | None = File(None),
) -> dict:
    # Populate supported extensions on first upload (torch must be loaded by then)
    if not SUPPORTED_EXTENSIONS:
        from sharp.utils import io as sharp_io
        SUPPORTED_EXTENSIONS.update(ext.lower() for ext in sharp_io.get_supported_image_extensions())

    suffix = Path(image.filename or "").suffix.lower()

    # Some mobile browsers (especially Android) don't include an extension in
    # the uploaded filename. Fall back to guessing from the MIME type.
    if not suffix and image.content_type:
        import mimetypes
        guessed = mimetypes.guess_extension(image.content_type)
        # guess_extension returns things like '.jpe' / '.jpeg' — normalise to common forms
        _mime_map = {
            ".jpe": ".jpg", ".jpeg": ".jpg", ".jfif": ".jpg",
            ".tiff": ".tif", ".heic": ".heic", ".heif": ".heif",
        }
        if guessed:
            suffix = _mime_map.get(guessed, guessed)
        LOGGER.info("No extension in filename; inferred '%s' from content-type '%s'", suffix, image.content_type)

    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported image type '{suffix or image.content_type or image.filename}'. "
                   f"Please upload a JPEG, PNG, or WebP photo.",
        )

    # Block until the model is loaded (first run may download the checkpoint).
    if not _ready.wait(timeout=WARMUP_TIMEOUT):
        raise HTTPException(status_code=503, detail="Model is still warming up. Try again shortly.")

    scene_id, upload_path, ply_path = storage.new_scene_paths(
        suffix, name=name, year=year, story=story
    )

    with upload_path.open("wb") as f:
        f.write(image.file.read())

    # Save the optional voice note / cropped music clip under the same
    # filename stem as the photo and splat — same "tagging" scheme as the
    # image, just in Memo-audio instead of Memo-album.
    audio_filename = ""
    if audio is not None and audio.filename:
        audio_suffix = Path(audio.filename).suffix.lower() or ".webm"
        audio_path = storage.audio_path_for(scene_id, audio_suffix)
        with audio_path.open("wb") as f:
            f.write(audio.file.read())
        audio_filename = audio_path.name
        LOGGER.info("Saved audio for scene %s -> %s", scene_id, audio_filename)

    LOGGER.info("Running SHARP inference for scene %s (%s)", scene_id, upload_path.name)
    _processing.set()
    try:
        engine.predict_to_ply(upload_path, ply_path)
    except Exception as exc:
        LOGGER.exception("Inference failed for scene %s", scene_id)
        msg = str(exc)
        if "out of memory" in msg.lower() or "cuda error" in msg.lower():
            detail = (
                "GPU out of memory. Please restart the API server — "
                "the updated code loads the model in fp16 (half memory) and "
                "automatically falls back to CPU if needed."
            )
        else:
            detail = f"Inference failed: {exc}"
        raise HTTPException(status_code=500, detail=detail) from exc
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
            cluster_id="",
            audio_file=audio_filename,
        )
    )
    LOGGER.info("Scene %s ready -> %s", scene_id, scene.ply_url)
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
        "audio_url": scene.audio_url,
        "created_at": scene.created_at,
    }


app.mount("/outputs", StaticFiles(directory=str(storage.splats_dir)), name="outputs")
app.mount("/uploads", StaticFiles(directory=str(storage.uploads_dir)), name="uploads")
app.mount("/audio", StaticFiles(directory=str(storage.audio_dir)), name="audio")
