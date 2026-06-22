"""On-disk storage for uploaded images and generated Gaussian-splat scenes.

A scene is a JSON record plus a `.ply` file. All records live in a single
`scenes.json` index, newest last. The viewer asks for the latest record and
streams the corresponding PLY from the `/outputs` static mount.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path


def _slugify(text: str, max_len: int) -> str:
    """Lowercase, hyphenate, and truncate text for safe use in a filename."""
    text = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower())
    return text.strip("-")[:max_len].strip("-")


def _build_slug(name: str, year: str, story: str) -> str:
    """Human-readable scene slug: <location>_<year>_<short-memory>_<uid>."""
    parts = [p for p in (_slugify(name, 24), _slugify(year, 8), _slugify(story, 24)) if p]
    base = "_".join(parts) or "memory"
    return f"{base}_{uuid.uuid4().hex[:6]}"


@dataclass
class Scene:
    id: str
    name: str
    author: str
    ply_file: str          # filename inside the splats dir, e.g. "<id>.ply"
    image_file: str        # filename inside the uploads dir
    created_at: float      # unix seconds
    year: str = ""
    story: str = ""
    cluster_id: str = ""   # "<location-slug>__<decade>", assigned by the memory brain

    @property
    def ply_url(self) -> str:
        return f"/outputs/{self.ply_file}"

    @property
    def image_url(self) -> str:
        return f"/uploads/{self.image_file}"


class Storage:
    """Filesystem-backed scene store. Thread-safe for concurrent requests."""

    def __init__(self, root: Path):
        self.root = root
        self.uploads_dir = root / "Memo-album"
        self.splats_dir = root / "Memo-splatted"
        self.stitched_dir = root / "Memo-stitched"
        self.index_path = root / "scenes.json"
        self._lock = threading.Lock()

        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self.splats_dir.mkdir(parents=True, exist_ok=True)
        self.stitched_dir.mkdir(parents=True, exist_ok=True)
        if not self.index_path.exists():
            self._write_index([])

    # --- index helpers -------------------------------------------------
    def _read_index(self) -> list[dict]:
        try:
            return json.loads(self.index_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return []

    def _write_index(self, records: list[dict]) -> None:
        self.index_path.write_text(json.dumps(records, indent=2), encoding="utf-8")

    # --- public API ----------------------------------------------------
    def new_scene_paths(
        self, suffix: str, name: str = "", year: str = "", story: str = ""
    ) -> tuple[str, Path, Path]:
        """Reserve a human-readable scene id and return (id, upload_path, ply_path).

        The id doubles as the filename stem for both the uploaded image and
        the generated PLY, e.g. "rathaus_1987_first-bike-ride_4f9a2c", so the
        Memo-album and Memo-splatted folders stay self-describing.
        """
        scene_id = _build_slug(name, year, story)
        upload_path = self.uploads_dir / f"{scene_id}{suffix}"
        ply_path = self.splats_dir / f"{scene_id}.ply"
        return scene_id, upload_path, ply_path

    def add_scene(self, scene: Scene) -> Scene:
        with self._lock:
            records = self._read_index()
            records.append(asdict(scene))
            self._write_index(records)
        return scene

    def list_scenes(self) -> list[Scene]:
        records = self._read_index()
        return [Scene(**r) for r in records]

    def latest(self) -> Scene | None:
        records = self._read_index()
        return Scene(**records[-1]) if records else None


def now() -> float:
    return time.time()
