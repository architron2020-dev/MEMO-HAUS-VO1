"""Merges two independently-generated SHARP Gaussian splats into one PLY,
using the relative camera pose `registration_engine.py` estimated between
the two source photos (via DUSt3R).

Honest caveat — SCALE: SHARP estimates depth independently per photo with
no shared metric reference, so two splats' coordinate units don't actually
match each other, even though DUSt3R's *relative pose* between the same
two photos is internally scale-consistent (it reasons about both images
jointly, unlike SHARP). We bridge this with a heuristic: for each photo,
compare the spatial spread of DUSt3R's own per-image point cloud against
SHARP's per-image Gaussian point cloud, and rescale SHARP's points by that
ratio before applying DUSt3R's transform. This is a best-effort correction,
not an exact metric solve — it can be off, especially when the two photos
have very different focal lengths or only partial overlap.

Reuses SHARP's own `Gaussians3D` / `load_ply` / `save_ply` / `apply_transform`
so the merged file is byte-for-byte the same schema SHARP itself writes —
the viewer needs no changes to load it.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import numpy as np
import torch

from sharp.utils.gaussians import Gaussians3D, apply_transform, load_ply, save_ply

LOGGER = logging.getLogger("memo-haus.stitcher")


def _point_scale(points: np.ndarray) -> float:
    """Robust spatial-spread statistic: median distance from the median point.
    Used as a stand-in for 'how big is this point cloud, in its own units.'
    """
    if len(points) == 0:
        return 1.0
    centroid = np.median(points, axis=0)
    spread = float(np.median(np.linalg.norm(points - centroid, axis=1)))
    return spread if spread > 1e-6 else 1.0


def _unproject_depth(depth: np.ndarray, k_matrix: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Pinhole-unproject a depth map into that camera's own 3D frame —
    standard (x,y,z) = ((px-cx)*z/fx, (py-cy)*z/fy, z) per valid pixel."""
    ys, xs = np.where(mask)
    z = depth[ys, xs]
    fx, fy = k_matrix[0, 0], k_matrix[1, 1]
    cx, cy = k_matrix[0, 2], k_matrix[1, 2]
    x = (xs - cx) * z / fx
    y = (ys - cy) * z / fy
    return np.stack([x, y, z], axis=1)


def _rescale(gaussians: Gaussians3D, factor: float) -> Gaussians3D:
    """Uniformly scale positions and Gaussian extents — colors/opacity untouched."""
    return Gaussians3D(
        mean_vectors=gaussians.mean_vectors * factor,
        singular_values=gaussians.singular_values * factor,
        quaternions=gaussians.quaternions,
        colors=gaussians.colors,
        opacities=gaussians.opacities,
    )


def stitch_pair(
    ply_a: Path,
    ply_b: Path,
    registration: dict[str, Any],
    output_path: Path,
) -> None:
    """Combine two SHARP splats into one PLY, aligned via DUSt3R's pose
    estimate with a heuristic scale correction (see module docstring).

    `registration` is the dict returned by RegistrationEngine.register_pair
    — must still carry depth_a/depth_b/K_a/K_b/mask_a/mask_b (the raw,
    non-persisted fields), not just the JSON-safe summary.
    """
    gaussians_a, meta_a = load_ply(ply_a)
    gaussians_b, meta_b = load_ply(ply_b)

    sharp_scale_a = _point_scale(gaussians_a.mean_vectors[0].numpy())
    sharp_scale_b = _point_scale(gaussians_b.mean_vectors[0].numpy())

    dust3r_points_a = _unproject_depth(
        np.asarray(registration["depth_a"]), np.asarray(registration["K_a"]),
        np.asarray(registration["mask_a"]),
    )
    dust3r_points_b = _unproject_depth(
        np.asarray(registration["depth_b"]), np.asarray(registration["K_b"]),
        np.asarray(registration["mask_b"]),
    )
    dust3r_scale_a = _point_scale(dust3r_points_a)
    dust3r_scale_b = _point_scale(dust3r_points_b)

    # Rescale each splat into DUSt3R's shared unit system before posing it.
    gaussians_a = _rescale(gaussians_a, dust3r_scale_a / sharp_scale_a)
    gaussians_b = _rescale(gaussians_b, dust3r_scale_b / sharp_scale_b)

    transform = torch.tensor(registration["transform_b_onto_a"], dtype=torch.float32)[:3]
    gaussians_b_aligned = apply_transform(gaussians_b, transform)

    merged = Gaussians3D(
        mean_vectors=torch.cat([gaussians_a.mean_vectors, gaussians_b_aligned.mean_vectors], dim=1),
        singular_values=torch.cat(
            [gaussians_a.singular_values, gaussians_b_aligned.singular_values], dim=1
        ),
        quaternions=torch.cat([gaussians_a.quaternions, gaussians_b_aligned.quaternions], dim=1),
        colors=torch.cat([gaussians_a.colors, gaussians_b_aligned.colors], dim=1),
        opacities=torch.cat([gaussians_a.opacities, gaussians_b_aligned.opacities], dim=1),
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    width, height = meta_a.resolution_px
    save_ply(merged, meta_a.focal_length_px, (height, width), output_path)
    LOGGER.info(
        "Stitched %s + %s -> %s (%d gaussians)",
        ply_a.name, ply_b.name, output_path.name, merged.mean_vectors.shape[1],
    )
