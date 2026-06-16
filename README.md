# Memo-House

Scan a QR code → upload an old photo of Wolfsburg → it is turned into a 3D
**Gaussian splat** by Apple's [SHARP](https://github.com/apple/ml-sharp) model →
a live viewer automatically shows the most recently generated scene.

## Structure

```
memo-house/
├── apps/
│   ├── web/                 # Vite frontend
│   │   ├── index.html       #   upload page  (what the QR code points to)
│   │   └── viewer.html      #   live viewer  (kiosk / big screen)
│   └── api/                 # FastAPI backend (runs SHARP inference)
│       ├── main.py          #   HTTP API: /api/predict, /api/latest, /outputs
│       ├── sharp_engine.py  #   warm SHARP predictor wrapper
│       └── storage.py       #   on-disk scene store
├── packages/
│   └── ml-sharp/            # Apple SHARP — external dep, NOT committed (see below)
├── storage/                 # generated splats + uploads (gitignored, runtime only)
└── scripts/
    ├── run-api.mjs          # launches the backend with the venv's Python
    └── setup-ml-sharp.mjs   # clones SHARP + builds its venv
```

## Quick start

```bash
npm install                          # installs web + tooling deps
npm run setup:ml-sharp               # clones Apple SHARP + builds its Python venv
# On an RTX 50-series (Blackwell) GPU instead run:
#   npm run setup:ml-sharp -- --blackwell
npm run dev                          # starts BOTH the backend and the frontend
```

> **Why a setup step?** [Apple SHARP](https://github.com/apple/ml-sharp) is an
> external dependency with its own license and model weights, so it is **not**
> vendored into this repo (`packages/ml-sharp/` is gitignored). The setup script
> clones it at the pinned commit `1eaa046` and installs the backend deps into its
> virtualenv. The SHARP model checkpoint is downloaded automatically on first run.

Then open:

- **Upload page** – http://localhost:5173/ (point your QR code here; it is also
  exposed on the LAN so phones can reach it)
- **Live viewer** – http://localhost:5173/viewer.html

The first upload may take a while: the backend downloads the SHARP checkpoint on
startup (it warms up in the background) and inference takes up to ~a minute.

## How it works

1. The upload page (`index.html`) sends the photo, a name and an author to
   `POST /api/predict` as multipart form data.
2. The backend saves the upload, runs SHARP inference (model kept warm in
   memory), and writes a `.ply` Gaussian splat into `storage/splats/`. The scene
   is appended to `storage/scenes.json`. (`storage/` sits at the repo root, on
   purpose: it is outside the backend's `--reload` watch path so a new upload
   never triggers a model-reloading restart.)
3. The viewer (`viewer.html`) polls `GET /api/scenes` every few seconds. It plays
   all stored memories in a continuous loop and, when a newly uploaded scene
   appears, cinematically transitions to it and folds it into the rotation. PLYs
   are streamed from `/outputs/<id>.ply`.

## The Python backend / venv

The backend reuses the `ml-sharp` virtualenv at `packages/ml-sharp/.venv`
(Python 3.13). `scripts/run-api.mjs` finds the venv's Python automatically, so
`npm run dev` needs no manual activation.

`npm run setup:ml-sharp` builds this venv for you (clone + venv + deps). The
equivalent manual steps:

```bash
git clone https://github.com/apple/ml-sharp.git packages/ml-sharp
git -C packages/ml-sharp checkout 1eaa046834b81852261262b41b0919f5c1efdd2e
cd packages/ml-sharp
python -m venv .venv
.venv/Scripts/python -m pip install -e . --no-build-isolation
.venv/Scripts/python -m pip install fastapi "uvicorn[standard]" python-multipart
# RTX 50-series (Blackwell) needs the cu128 nightly torch:
.venv/Scripts/python -m pip install --pre torch torchvision \
  --index-url https://download.pytorch.org/whl/nightly/cu128 --force-reinstall --no-deps
```

### Configuration (env vars)

| Variable             | Default                        | Purpose                                  |
| -------------------- | ------------------------------ | ---------------------------------------- |
| `MEMO_API_PORT`      | `8000`                         | Backend port                             |
| `MEMO_API_URL`       | `http://127.0.0.1:8000`        | Vite proxy target for `/api` & `/outputs`|
| `MEMO_STORAGE_DIR`   | `storage/` (repo root)         | Where uploads & splats are stored        |
| `MEMO_DEVICE`        | `default` (cuda→mps→cpu)       | Inference device                         |
| `MEMO_CHECKPOINT`    | _(auto-download)_              | Path to a local SHARP `.pt` checkpoint   |
