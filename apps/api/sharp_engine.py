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
        if self.device == "cuda":
            torch.cuda.empty_cache()
            free = torch.cuda.mem_get_info()[0] // 1024**2
            LOGGER.info("Model loaded — %.0f MB VRAM free", free)
        self._predictor = predictor
        LOGGER.info("SHARP predictor ready on device %s", self.device)

    @property
    def ready(self) -> bool:
        return self._predictor is not None

    def predict_to_ply(self, image_path: Path, output_ply: Path) -> None:
        """Run inference on `image_path` and write a Gaussian-splat PLY."""
        if self._predictor is None:
            raise RuntimeError("SharpEngine.load() must be called before inference.")

        import gc
        import torch
        from sharp.cli.predict import predict_image as _predict_image
        from sharp.utils import io
        from sharp.utils.gaussians import save_ply

        image, _, f_px = io.load_rgb(image_path)
        height, width = image.shape[:2]
        LOGGER.info("Input image: %dx%d  f_px=%s", width, height, f_px)

        with self._lock:
            # Decide whether to run on CUDA or go straight to CPU.
            # SHARP needs ~1 GB of activation headroom; if less is free, skip
            # the CUDA attempt entirely to avoid an OOM crash-and-retry cycle.
            infer_device = self.device
            if self.device == "cuda":
                gc.collect()
                torch.cuda.empty_cache()
                free_mb = torch.cuda.mem_get_info()[0] // 1024**2
                LOGGER.info("Pre-inference VRAM free: %d MB", free_mb)
                if free_mb < 1024:
                    LOGGER.warning(
                        "Only %d MB VRAM free — running inference on CPU to avoid OOM", free_mb
                    )
                    infer_device = "cpu"

            def _run_on(dev: str):
                if dev == "cpu":
                    self._predictor.float().cpu()
                with torch.inference_mode():
                    with torch.amp.autocast(device_type="cuda", enabled=(dev == "cuda")):
                        return _predict_image(
                            self._predictor, image, f_px, torch.device(dev)
                        )

            try:
                gaussians = _run_on(infer_device)
            except RuntimeError as exc:
                _msg = str(exc).lower()
                _cuda_fail = infer_device == "cuda" and (
                    "out of memory" in _msg or "cuda error" in _msg or "low precision" in _msg
                )
                if _cuda_fail:
                    LOGGER.warning("CUDA failed (%s) — retrying on CPU (2-4 min)…", exc)
                    gc.collect()
                    torch.cuda.empty_cache()
                    gaussians = _run_on("cpu")
                else:
                    raise
            finally:
                # Always restore model to CUDA after inference
                if self.device == "cuda" and next(self._predictor.parameters()).device.type == "cpu":
                    self._predictor.to(self.device)
                    torch.cuda.empty_cache()
                elif self.device == "cuda":
                    gc.collect()
                    torch.cuda.empty_cache()

        output_ply.parent.mkdir(parents=True, exist_ok=True)
        save_ply(gaussians, f_px, (height, width), output_ply)
