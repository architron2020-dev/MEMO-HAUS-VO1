"""One-off (safe to re-run) cleanup: delete any file in Memo-album,
Memo-splatted, or Memo-audio that doesn't belong to a scene still in
scenes.json.

Needed because delete_scene() only started cleaning up decimated PLY
variants (proxy.py's get_or_build_lite_ply cache, "<id>.k40.ply" etc.) partway
through this app's life — deletes made before that fix, or made while an
older server process was still running, left those files (and possibly
others) behind. Run this once to catch up; new deletes clean up after
themselves already.

Usage (from apps/api, with the ml-sharp venv active):
    python prune_orphans.py
"""

from __future__ import annotations

import os
from pathlib import Path

from storage import Storage

_DEFAULT_STORAGE = Path(__file__).resolve().parent.parent.parent / "storage"
STORAGE_DIR = Path(os.environ.get("MEMO_STORAGE_DIR", _DEFAULT_STORAGE)).resolve()


def main() -> None:
    storage = Storage(STORAGE_DIR)
    print(f"Scanning {STORAGE_DIR} for files with no matching scene record...")
    removed = storage.prune_orphaned_files()
    total = sum(len(v) for v in removed.values())
    if not total:
        print("Nothing to clean up — every file on disk matches a live scene.")
        return
    for category, names in removed.items():
        if not names:
            continue
        print(f"\n{category} ({len(names)}):")
        for name in names:
            print(f"  - {name}")
    print(f"\nRemoved {total} orphaned file(s).")


if __name__ == "__main__":
    main()
