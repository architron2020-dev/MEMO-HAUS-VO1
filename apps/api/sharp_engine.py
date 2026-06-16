"""Thin wrapper around the SHARP model.

Loads the Gaussian predictor once and keeps it warm so each request only pays
for inference, not for re-loading the (large) checkpoint. The heavy lifting is
reused from `sharp.cli.predict`.

For licensing of the underlying model see packages/ml-sharp/LICENSE_MODEL.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

import torch

from sharp.cli.predict import DEFAULT_MODEL_URL, predict_image
from sharp.models import PredictorParams, create_predictor
from sharp.utils import io
from sharp.utils.gaussians import save_ply

LOGGER = logging.getLogger("memo-house.sharp")


def _resolve_device(requested: str) -> str:
    if requested != "default":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class SharpEngine:
    """Holds a warm SHARP predictor and turns images into Gaussian-splat PLYs."""

    def __init__(self, device: str = "default", checkpoint_path: Path | None = None):
        self.device = _resolve_device(device)
        self.checkpoint_path = checkpoint_path
        self._predictor = None
        # The model + GPU can only run one inference at a time safely.
        self._lock = threading.Lock()

    def load(self) -> None:
        """Download/load the checkpoint and move the model onto the device."""
        if self._predictor is not None:
            return

        if self.checkpoint_path is not None:
            LOGGER.info("Loading checkpoint from %s", self.checkpoint_path)
            state_dict = torch.load(self.checkpoint_path, weights_only=True)
        else:
            LOGGER.info("Loading default SHARP checkpoint from %s", DEFAULT_MODEL_URL)
            state_dict = torch.hub.load_state_dict_from_url(DEFAULT_MODEL_URL, progress=True)

        predictor = create_predictor(PredictorParams())
        predictor.load_state_dict(state_dict)
        predictor.eval()
        predictor.to(self.device)
        self._predictor = predictor
        LOGGER.info("SHARP predictor ready on device %s", self.device)

    @property
    def ready(self) -> bool:
        return self._predictor is not None

    def predict_to_ply(self, image_path: Path, output_ply: Path) -> None:
        """Run inference on `image_path` and write a Gaussian-splat PLY."""
        if self._predictor is None:
            raise RuntimeError("SharpEngine.load() must be called before inference.")

        image, _, f_px = io.load_rgb(image_path)
        height, width = image.shape[:2]

        # Serialize GPU access: one inference at a time.
        with self._lock:
            gaussians = predict_image(
                self._predictor, image, f_px, torch.device(self.device)
            )

        output_ply.parent.mkdir(parents=True, exist_ok=True)
        save_ply(gaussians, f_px, (height, width), output_ply)
