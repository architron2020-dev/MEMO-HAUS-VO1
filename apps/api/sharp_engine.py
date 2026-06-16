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

LOGGER = logging.getLogger("memo-haus.sharp")


class SharpEngine:
    """Holds a warm SHARP predictor and turns images into Gaussian-splat PLYs."""

    def __init__(self, device: str = "default", checkpoint_path: Path | None = None):
        self._requested_device = device
        self.device = device  # resolved later inside load() once torch is imported
        self.checkpoint_path = checkpoint_path
        self._predictor = None
        self._lock = threading.Lock()

    def load(self) -> None:
        """Download/load the checkpoint and move the model onto the device."""
        if self._predictor is not None:
            return

        # Heavy imports deferred here so uvicorn can bind before torch DLLs load
        import torch
        from sharp.cli.predict import DEFAULT_MODEL_URL, predict_image  # noqa: F401
        from sharp.models import PredictorParams, create_predictor
        from sharp.utils.gaussians import save_ply  # noqa: F401

        # Resolve device now that torch is available
        req = self._requested_device
        if req == "default":
            if torch.cuda.is_available():
                self.device = "cuda"
            elif torch.backends.mps.is_available():
                self.device = "mps"
            else:
                self.device = "cpu"
        else:
            self.device = req

        LOGGER.info("torch %s | CUDA available: %s | device: %s",
                    torch.__version__, torch.cuda.is_available(), self.device)

        if self.checkpoint_path is not None:
            LOGGER.info("Loading checkpoint from %s", self.checkpoint_path)
            state_dict = torch.load(self.checkpoint_path, weights_only=True)
        else:
            from sharp.cli.predict import DEFAULT_MODEL_URL
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

        import torch
        from sharp.cli.predict import predict_image
        from sharp.utils import io
        from sharp.utils.gaussians import save_ply

        image, _, f_px = io.load_rgb(image_path)
        height, width = image.shape[:2]

        with self._lock:
            gaussians = predict_image(
                self._predictor, image, f_px, torch.device(self.device)
            )

        output_ply.parent.mkdir(parents=True, exist_ok=True)
        save_ply(gaussians, f_px, (height, width), output_ply)
