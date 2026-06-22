"""The memory brain — collective clustering and gap-tracking for scenes.

This is the piece that turns Memo-Haus from "one photo -> one isolated 3D
scene" into "many photos of the same place, across years and people -> a
shared, organized memory archive."

What it actually does, honestly:
  - Groups scenes into clusters by LOCATION (from the `name` field, e.g.
    "Hauptbahnhof") and ERA (a 10-year decade bucket derived from `year`).
  - For each location, tracks which decades have at least one contributing
    photo, and computes GAPS: decades that fall between the earliest and
    latest covered decade but currently have zero scenes.
  - When a fresh upload lands in a decade that was previously a gap, that
    gap closes automatically — this is the "stitch the new contribution into
    the correct gap" behaviour, at the metadata level.
  - Flags pairs of scenes within the same location as likely depicting the
    same subject, using perceptual image hashing (a coarse 2D similarity
    check) — cheap enough to run on every pair every reconcile pass.
  - For pairs flagged as likely overlapping, optionally attempts REAL 3D
    registration via `registration_engine.RegistrationEngine` (DUSt3R).
    This is gated behind `enable_registration` (off by default — it's a
    second heavy model competing for the same 4GB GPU as SHARP) and results
    are cached in the index across reconcile passes, since registration is
    far more expensive than the phash check that screens candidates for it.
    Low-confidence pairs are rejected, not force-merged — the gap stays a
    gap rather than getting a wrong stitch.
  - Runs continuously in the background (a daemon thread on a fixed
    interval), not just synchronously on upload, so the cluster/gap index
    stays correct even if records are edited externally.

What it still does NOT do:
  - It computes the alignment (a transform saying how to rotate/scale/move
    one splat onto another), but does not yet rewrite/merge the actual PLY
    files using that transform. `confirmed_overlaps` on each location holds
    the transform + confidence, ready for that next step.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any

from storage import Storage, _slugify

LOGGER = logging.getLogger("memo-haus.brain")

DECADE_SPAN = 10
SIMILARITY_THRESHOLD = 0.80   # hamming-derived similarity above which two photos are "likely overlap"
PHASH_SIZE = 8                # 8x8 -> 64-bit perceptual hash


def _decade_label(year_str: str) -> str:
    """'1987' -> '1980s'. Missing/unparseable years go in 'undated'."""
    match = re.search(r"\d{4}", year_str or "")
    if not match:
        return "undated"
    year = int(match.group())
    decade = (year // DECADE_SPAN) * DECADE_SPAN
    return f"{decade}s"


def _location_key(name: str) -> tuple[str, str]:
    """Derive a stable location slug + display label from the scene's title."""
    # Strip a trailing ", <year>" if present (e.g. "Rathaus, 1962" -> "Rathaus")
    label = re.sub(r",?\s*\d{4}\s*$", "", (name or "").strip()) or "Untitled"
    slug = _slugify(label, 40) or "untitled"
    return slug, label


def _phash(image_path: Path) -> str | None:
    """8x8 average-hash — cheap, dependency-free (Pillow only) visual fingerprint."""
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        img = Image.open(image_path).convert("L").resize((PHASH_SIZE, PHASH_SIZE))
    except Exception:
        return None
    pixels = list(img.getdata())
    avg = sum(pixels) / len(pixels)
    bits = "".join("1" if p > avg else "0" for p in pixels)
    return f"{int(bits, 2):016x}"


def _similarity(hash_a: str, hash_b: str) -> float:
    bits = PHASH_SIZE * PHASH_SIZE
    dist = bin(int(hash_a, 16) ^ int(hash_b, 16)).count("1")
    return 1.0 - (dist / bits)


class MemoryBrain:
    """Persistent, continuously-reconciled cluster/gap index over all scenes."""

    def __init__(self, storage: Storage, enable_registration: bool = False):
        self.storage = storage
        self.index_path = storage.root / "memory_brain.json"
        self._lock = threading.Lock()
        self.enable_registration = enable_registration
        self._registration_engine = None
        if not self.index_path.exists():
            self._write({"locations": {}, "updated_at": 0})

    def _get_registration_engine(self):
        if not self.enable_registration:
            return None
        if self._registration_engine is None:
            try:
                from registration_engine import RegistrationEngine
                engine = RegistrationEngine()
                engine.load()
                self._registration_engine = engine
            except Exception:
                LOGGER.exception(
                    "Could not load the registration engine — disabling for this session"
                )
                self.enable_registration = False
                return None
        return self._registration_engine

    # --- index I/O -------------------------------------------------------
    def _read(self) -> dict[str, Any]:
        try:
            return json.loads(self.index_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {"locations": {}, "updated_at": 0}

    def _write(self, data: dict[str, Any]) -> None:
        self.index_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    # --- public API --------------------------------------------------------
    def cluster_id_for(self, name: str, year: str) -> str:
        """Cluster a scene WILL belong to, computable at upload time before
        the full reconcile pass runs — so the API response is immediately
        accurate instead of waiting for the next background cycle."""
        slug, _ = _location_key(name)
        return f"{slug}__{_decade_label(year)}"

    def read(self) -> dict[str, Any]:
        return self._read()

    def reconcile(self) -> dict[str, Any]:
        """Full recompute pass: regroup every scene into location/decade
        clusters, recompute gaps, and re-run overlap detection. This is the
        brain's main loop body — safe to call as often as needed since the
        cheap parts (decades/gaps/likely_overlaps) always rebuild fresh from
        the scene index. Registration results are the one thing carried
        forward between passes, since re-running DUSt3R on every pair every
        30 seconds would be wasteful.
        """
        previous_locations = self._read().get("locations", {})
        scenes = self.storage.list_scenes()
        scenes_by_id = {s.id: s for s in scenes}
        locations: dict[str, dict[str, Any]] = {}

        for scene in scenes:
            slug, label = _location_key(scene.name)
            decade = _decade_label(scene.year)
            prev = previous_locations.get(slug, {})
            loc = locations.setdefault(slug, {
                "location_slug": slug,
                "location_label": label,
                "decades": {},
                "gaps": [],
                "likely_overlaps": [],
                "confirmed_overlaps": list(prev.get("confirmed_overlaps", [])),
                "rejected_overlaps": list(prev.get("rejected_overlaps", [])),
            })
            bucket = loc["decades"].setdefault(decade, {"scene_ids": [], "years": []})
            if scene.id not in bucket["scene_ids"]:
                bucket["scene_ids"].append(scene.id)
            if scene.year and scene.year not in bucket["years"]:
                bucket["years"].append(scene.year)

        for loc in locations.values():
            self._recompute_gaps(loc)

        self._compute_overlaps(locations, scenes)
        self._attempt_registrations(locations, scenes_by_id)

        data = {"locations": locations, "updated_at": time.time()}
        with self._lock:
            self._write(data)
        return data

    def start_background_loop(self, interval_s: float = 30.0) -> None:
        """The 'runs continuously in the background' requirement — a daemon
        thread that re-reconciles on a fixed cadence, independent of upload
        traffic."""
        def _loop() -> None:
            while True:
                try:
                    self.reconcile()
                except Exception:
                    LOGGER.exception("Memory brain reconcile pass failed")
                time.sleep(interval_s)

        threading.Thread(target=_loop, name="memory-brain", daemon=True).start()
        LOGGER.info("Memory brain background loop started (every %ss)", interval_s)

    # --- internals -----------------------------------------------------
    def _recompute_gaps(self, loc: dict[str, Any]) -> None:
        """A gap is a decade strictly within a location's covered span that
        currently has no contributing scene — the visible 'absence of
        memory' the timeline should be able to surface."""
        covered = sorted(
            int(d[:-1]) for d, bucket in loc["decades"].items()
            if d != "undated" and bucket["scene_ids"]
        )
        if len(covered) < 2:
            loc["gaps"] = []
            return
        lo, hi = covered[0], covered[-1]
        loc["gaps"] = [
            f"{d}s" for d in range(lo, hi + 1, DECADE_SPAN)
            if not loc["decades"].get(f"{d}s", {}).get("scene_ids")
        ]

    def _compute_overlaps(self, locations: dict[str, dict[str, Any]], scenes: list) -> None:
        """Best-effort 2D visual-similarity check within each location —
        NOT 3D geometric overlap (see module docstring). Flags candidate
        pairs a human curator (or a future registration pass) could merge.
        """
        scenes_by_id = {s.id: s for s in scenes}
        for loc in locations.values():
            scene_ids = [sid for bucket in loc["decades"].values() for sid in bucket["scene_ids"]]
            hashes: dict[str, str] = {}
            for sid in scene_ids:
                scene = scenes_by_id.get(sid)
                if not scene:
                    continue
                path = self.storage.uploads_dir / scene.image_file
                h = _phash(path)
                if h:
                    hashes[sid] = h

            # The phash check is a cheap pre-filter so we don't run expensive
            # registration on every pair in a location with hundreds of
            # scenes. For small locations that cost is trivial anyway, so
            # skip the filter entirely and let every pair through — a crude
            # 8x8 hash is easily fooled by a different angle/zoom of the
            # exact same place, and we'd rather let the real model (DUSt3R)
            # make that call than reject candidates before it even sees them.
            overlaps = []
            ids = list(hashes.keys())
            small_location = len(ids) <= 6
            for i, id_a in enumerate(ids):
                for id_b in ids[i + 1:]:
                    sim = _similarity(hashes[id_a], hashes[id_b])
                    if small_location or sim >= SIMILARITY_THRESHOLD:
                        overlaps.append({
                            "scene_a": id_a,
                            "scene_b": id_b,
                            "similarity": round(sim, 3),
                        })
            loc["likely_overlaps"] = overlaps

    def _attempt_registrations(
        self, locations: dict[str, dict[str, Any]], scenes_by_id: dict[str, Any]
    ) -> None:
        """For each likely-overlap pair not already attempted, run real
        pairwise registration (DUSt3R) and record the result. No-op unless
        enable_registration=True. Confidence is checked inside
        RegistrationEngine.register_pair — a rejected pair stays a gap.
        """
        engine = self._get_registration_engine()
        if engine is None:
            return

        for loc in locations.values():
            attempted = {
                (o["scene_a"], o["scene_b"])
                for o in loc["confirmed_overlaps"] + loc["rejected_overlaps"]
            }
            for pair in loc["likely_overlaps"]:
                key = (pair["scene_a"], pair["scene_b"])
                if key in attempted:
                    continue

                scene_a = scenes_by_id.get(pair["scene_a"])
                scene_b = scenes_by_id.get(pair["scene_b"])
                if not scene_a or not scene_b:
                    continue

                path_a = self.storage.uploads_dir / scene_a.image_file
                path_b = self.storage.uploads_dir / scene_b.image_file
                try:
                    result = engine.register_pair(path_a, path_b)
                except Exception:
                    LOGGER.exception(
                        "Registration failed for %s <-> %s", scene_a.id, scene_b.id
                    )
                    continue

                if result:
                    # result also carries depth/K/mask arrays (needed for the
                    # stitch's scale correction) — those must never reach
                    # json.dumps, so only the summary fields get persisted.
                    summary = {
                        "scene_a": scene_a.id,
                        "scene_b": scene_b.id,
                        "transform_b_onto_a": result["transform_b_onto_a"],
                        "confidence": result["confidence"],
                    }
                    stitched_name = self._stitch(loc["location_slug"], scene_a, scene_b, result)
                    if stitched_name:
                        summary["stitched_ply"] = stitched_name
                    loc["confirmed_overlaps"].append(summary)
                    LOGGER.info(
                        "Registered %s <-> %s (confidence %.2f, stitched=%s)",
                        scene_a.id, scene_b.id, result["confidence"], bool(stitched_name),
                    )
                else:
                    loc["rejected_overlaps"].append({
                        "scene_a": scene_a.id, "scene_b": scene_b.id,
                    })

    def _stitch(self, location_slug: str, scene_a, scene_b, registration: dict[str, Any]) -> str | None:
        """Merge the two splats using the confirmed registration. Returns the
        output filename on success, None if stitching itself fails (the
        registration is still recorded — only the visual merge is skipped)."""
        try:
            from scene_stitcher import stitch_pair
        except Exception:
            LOGGER.exception("scene_stitcher unavailable")
            return None

        output_name = f"{location_slug}_{scene_a.id}_{scene_b.id}.ply"
        output_path = self.storage.stitched_dir / output_name
        try:
            stitch_pair(
                ply_a=self.storage.splats_dir / scene_a.ply_file,
                ply_b=self.storage.splats_dir / scene_b.ply_file,
                registration=registration,
                output_path=output_path,
            )
            return output_name
        except Exception:
            LOGGER.exception("Stitching failed for %s <-> %s", scene_a.id, scene_b.id)
            return None
