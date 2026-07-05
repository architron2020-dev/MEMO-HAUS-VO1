#!/usr/bin/env node
/**
 * Launches the FastAPI backend using the Python interpreter from the
 * ml-sharp virtualenv, so `npm run dev` works without manually activating it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const venv = resolve(repoRoot, "packages/ml-sharp/.venv");
const pythonPath =
  process.platform === "win32"
    ? resolve(venv, "Scripts", "python.exe")
    : resolve(venv, "bin", "python");

if (!existsSync(pythonPath)) {
  console.error(`\n[memo-haus] Python venv not found at:\n  ${pythonPath}\n`);
  console.error("Set up packages/ml-sharp/.venv first (see README.md).\n");
  process.exit(1);
}

const apiDir = resolve(repoRoot, "apps/api");
const port = process.env.MEMO_API_PORT || "8000";

const args = [
  "-m",
  "uvicorn",
  "main:app",
  "--host",
  "0.0.0.0",
  "--port",
  port,
  // NOTE: --reload was tried here but its WatchFiles supervisor/worker
  // process pair turned out to be a real source of instability (the worker
  // would silently stop accepting connections with no crash trace, likely
  // interacting badly with the heavy CPU work in registration_engine.py).
  // Manually restart `npm run dev` after editing apps/api/*.py instead —
  // less convenient, but far more reliable for this app's workload.
];

const child = spawn(pythonPath, args, {
  cwd: apiDir,
  stdio: "inherit",
  env: {
    ...process.env,
    // Defer CUDA module loading until first use — reduces DLLs scanned at import time
    CUDA_MODULE_LOADING: "LAZY",
    // Use expandable memory segments so the allocator can grow blocks without
    // fragmenting the heap — prevents OOM on sequential uploads even when total
    // VRAM used is well under the card's limit.
    PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True",
  },
});

child.on("exit", (code) => process.exit(code ?? 0));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
