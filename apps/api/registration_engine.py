"""Pairwise photo registration via mini-dust3r (a pip-installable, inference-only
package wrapping Naver's DUSt3R — see https://pypi.org/project/mini-dust3r/).

This answers the question SHARP alone cannot: given two photos that the
memory brain's image-similarity check flagged as likely showing the same
place, how do their two independently-reconstructed splats relate to each
other in 3D space? DUSt3R takes both raw photos (no camera calibration
needed) and returns a camera-to-world transform for each one, in a shared
coordinate frame it establishes itself. The relative transform between
those two derived poses is what lets us align one SHARP splat onto the
other's coordinate frame.

What this does NOT do: it does not replace SHARP, and it does not by
itself guarantee a correct merge — confidence is checked, and low-confidence
pairs are rejected rather than forced together (the gap stays a gap).

Checkpoint license: DUSt3R/croco weights are released by Naver Labs under
their research license (non-commercial) — see
https://github.com/naver/dust3r/blob/main/LICENSE before any commercial use.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

import numpy as np

LOGGER = logging.getLogger("memo-haus.registration")

DEFAULT_CHECKPOINT = "nielsr/DUSt3R_ViTLarge_BaseDecoder_512_dpt"

_patched = False


def _patch_mini_dust3r_type_bug() -> None:
    """mini-dust3r 0.1.2 has a genuine internal bug: `inferece_dust3r()` is
    typed (and documented) to take `min_conf_thr: float`, but it passes that
    value straight into `scene_to_results()`, whose own beartype-checked
    signature demands `min_conf_thr: int` — so no value satisfies both at
    once. We patch this here (not in site-packages, which would be wiped on
    reinstall) by wrapping `scene_to_results` to coerce the value to int
    right before it's beartype-checked — lossless for the round-number
    thresholds we use."""
    global _patched
    if _patched:
        return
    import mini_dust3r.api.inference as _mdi

    original = _mdi.scene_to_results

    def _coerced(scene, min_conf_thr):
        return original(scene, int(min_conf_thr))

    _mdi.scene_to_results = _coerced
    _patched = True


class RegistrationEngine:
    """Holds a warm DUSt3R model and estimates relative pose between photo pairs.

    Defaults to CPU: registration runs as an occasional background job (not
    on the user-facing upload path), and the laptop's 4GB GPU is already
    budgeted for SHARP during live uploads — sharing it would risk OOM-ing
    both models. Override via device= if you have VRAM to spare.
    """

    def __init__(self, device: str = "cpu", checkpoint: str = DEFAULT_CHECKPOINT):
        self.device = device
        self.checkpoint = checkpoint
        self._model = None
        self._lock = threading.Lock()

    def load(self) -> None:
        if self._model is not None:
            return
        from mini_dust3r.model import AsymmetricCroCo3DStereo

        _patch_mini_dust3r_type_bug()

        LOGGER.info("Loading DUSt3R checkpoint %s onto %s", self.checkpoint, self.device)
        # Already downloaded once and cached locally — try offline first so a
        # flaky/slow network never turns "load a cached model" into a hang.
        # Only hits the network if it's genuinely not cached yet.
        try:
            model = AsymmetricCroCo3DStereo.from_pretrained(self.checkpoint, local_files_only=True)
        except Exception:
            LOGGER.info("Not cached locally yet — falling back to a network fetch")
            model = AsymmetricCroCo3DStereo.from_pretrained(self.checkpoint)
        model = model.to(self.device)
        model.eval()
        self._model = model
        LOGGER.info("Registration engine ready on %s", self.device)

    @property
    def ready(self) -> bool:
        return self._model is not None

    def register_pair(
        self,
        image_a: Path,
        image_b: Path,
        min_confidence: float = 1.5,
    ) -> dict[str, Any] | None:
        """Estimate the rigid+scale transform that maps image_b's camera frame
        onto image_a's. Returns None if DUSt3R's own confidence for either
        view falls below `min_confidence` — caller should treat that pair as
        unregistered (leave the gap as a gap) rather than force a merge.
        """
        if self._model is None:
            raise RuntimeError("RegistrationEngine.load() must be called before use.")

        import os

        import torch
        from mini_dust3r.api import inferece_dust3r

        # PyTorch's CPU ops default to using every available core. Running
        # that inside a background thread still starves the main process of
        # CPU time at the OS scheduler level (this isn't a GIL issue — it's
        # literally all cores busy), which made the whole API stop accepting
        # connections while a registration was in flight. Capping threads
        # leaves headroom for the API to keep serving requests throughout.
        prev_threads = torch.get_num_threads()
        cpu_count = os.cpu_count() or 4
        torch.set_num_threads(max(1, cpu_count // 2))

        try:
            # mini_dust3r's loader calls .lower() on each path internally —
            # despite its own type hint accepting Path, it actually needs str.
            with self._lock:
                result = inferece_dust3r(
                    image_dir_or_list=[str(image_a), str(image_b)],
                    model=self._model,
                    device=self.device,
                    batch_size=1,
                    image_size=224,   # smaller/faster — adequate for pose estimation
                    niter=100,
                    schedule="linear",
                    min_conf_thr=10.0,
                )
        finally:
            torch.set_num_threads(prev_threads)

        confidences = [float(np.nanmean(c)) for c in result.conf_hw_list]
        confidence = min(confidences) if confidences else 0.0
        if confidence < min_confidence:
            LOGGER.info(
                "Registration rejected (confidence %.2f < %.2f): %s <-> %s",
                confidence, min_confidence, image_a.name, image_b.name,
            )
            return None

        # world_T_cam_b44[i] maps camera i's local frame -> DUSt3R's shared world frame.
        # b_to_a = inv(world_T_cam_a) @ world_T_cam_b maps B's frame onto A's frame.
        world_T_a = result.world_T_cam_b44[0]
        world_T_b = result.world_T_cam_b44[1]
        b_onto_a = np.linalg.inv(world_T_a) @ world_T_b

        return {
            # JSON-safe summary — this part gets persisted into memory_brain.json
            "transform_b_onto_a": b_onto_a.tolist(),
            "confidence": confidence,
            # Raw DUSt3R outputs for the scale-correction step in scene_stitcher.py
            # — NOT persisted, used immediately then discarded by the caller.
            "depth_a": result.depth_hw_list[0],
            "depth_b": result.depth_hw_list[1],
            "K_a": result.K_b33[0],
            "K_b": result.K_b33[1],
            "mask_a": result.masks_list[0],
            "mask_b": result.masks_list[1],
        }
