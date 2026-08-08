# Deploy — Memo-House on ki-pc

Same self-hosted shape as the `special-memory` project (which this box previously
ran): everything **same-origin** behind **Caddy/HTTPS** on the ki-pc GPU box —

- **Backend**: FastAPI (`apps/api/`) running SHARP inference on the RTX PRO 6000,
  launched with the `packages/ml-sharp/.venv` Python. Binds `127.0.0.1:8001` only.
- **Frontend**: the Vite static build (`apps/web/dist/`), served by Caddy.
- **Caddy**: TLS (Let's Encrypt), the COOP/COEP headers the Spark splat renderer
  needs, and a reverse proxy for `/api /outputs /uploads /audio /stitched` → the backend.

It **reuses the same domain and cert** as special-memory:
`https://ki-pc.architektur.uni-weimar.de`. Only one Caddy can hold ports 80/443 on
this box, so **starting the Memo-House stack takes the domain over from
special-memory** — `restart-stack.cmd` stops special-memory's loops first.

The **projector/kiosk** is a browser at the domain (`/viewer`); **phones** open the
upload page (`/`) via the QR code. HTTPS is required — the upload page records a
voice note (`getUserMedia`), which browsers only allow in a secure context.

## Prerequisites (already true on ki-pc)

- `packages/ml-sharp/.venv` exists (junctioned to the short-path venv `D:\mh_venv` to
  dodge Windows MAX_PATH) with the cu128 torch build — see the run-setup memory. The
  ~2.6 GB SHARP checkpoint is cached under `C:\Users\Yegor\.cache\torch\hub\`.
- `caddy.exe` at `C:\Users\Yegor\bin\caddy.exe` (installed by the special-memory deploy).
- The Let's Encrypt cert for `ki-pc.architektur.uni-weimar.de` is already in Caddy's
  data dir (same Windows user → reused, no re-issue needed) and 80/443 are open.
- `MEMO_API_PORT=8001` / `MEMO_API_URL=http://127.0.0.1:8001` are set persistently
  (`setx`). The prod backend launcher sets the port explicitly anyway.

## Build the static frontend

`apps/web/dist/` is git-ignored, so a frontend change is only live after a rebuild.

```powershell
cd "D:\Yegor\Github\MEMO-HAUS SUMMAERY-PARTHA\MEMO-HAUS-VO1"
npm install          # first time only
npm run build        # -> apps/web/dist/   (Vite multi-page: index/viewer/memories/contribute)
```

No API URL is baked in: the frontend fetches relative `/api/...` paths, which Caddy
proxies to the backend same-origin — identical to how it works in dev via the Vite proxy.

## Run / restart the whole stack

```powershell
deploy\restart-stack.cmd    # stops any old Caddy + backend loops (both projects), then starts fresh
```

⚠️ Do **not** just double-click `autostart.cmd` while something is already running —
the old self-restart loops keep holding 80/443/8001 and the new ones fail to bind.
Use `restart-stack.cmd` for a clean (re)start; use `autostart.cmd` only from a cold box.

Individual launchers (each self-restarts in its own minimized window):
`deploy\start-backend.cmd` (uvicorn on 127.0.0.1:8001) and `deploy\start-caddy.cmd`
(HTTPS on 80/443).

**Auto-start on login:** drop a shortcut to `deploy\autostart.cmd` in
`…\Start Menu\Programs\Startup\`. Remove special-memory's autostart shortcut so the two
don't fight over 80/443.

## What needs a restart after a change

- **Backend** (`apps\api\**`): yes — no `--reload` in prod. `restart-stack.cmd`
  (or just restart the backend window).
- **Frontend** (`apps\web\**`): no process restart — Caddy serves `apps\web\dist`
  from disk, so rebuild (`npm run build`) and hard-refresh the browser (Ctrl+F5).
- **`deploy\Caddyfile`**: restart Caddy — `restart-stack.cmd`
  (or `caddy reload --config deploy\Caddyfile`).

## Verify

```powershell
# backend up (local):
curl http://127.0.0.1:8001/api/health
# through Caddy over HTTPS (has the isolation headers the viewer needs):
curl -I https://ki-pc.architektur.uni-weimar.de/            # 200 + Cross-Origin-* headers
curl    https://ki-pc.architektur.uni-weimar.de/api/scenes  # JSON scene list
```

Then open `https://ki-pc.architektur.uni-weimar.de/viewer` on the kiosk and
`https://ki-pc.architektur.uni-weimar.de/` on a phone; upload a photo and confirm the
splat appears in the viewer within ~a minute.

## Phone entry / QR code

Point the QR at the upload page:

```
https://ki-pc.architektur.uni-weimar.de/
```

```powershell
npx qrcode "https://ki-pc.architektur.uni-weimar.de/" -o deploy\memo-haus-qr.png
```

## Local dev (unchanged)

```powershell
npm run dev   # backend (8001) + Vite frontend (5173, proxies /api etc. to the backend)
```
