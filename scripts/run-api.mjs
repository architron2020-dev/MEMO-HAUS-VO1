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
  "127.0.0.1",
  "--port",
  port,
  // NOTE: uvicorn --reload watches this cwd (apps/api). Generated uploads/splats
  // live in the repo-root `storage/` dir (see main.py), which is outside this
  // tree, so writing a new memory never triggers a model-reloading restart.
];

const child = spawn(pythonPath, args, {
  cwd: apiDir,
  stdio: "inherit",
  env: {
    ...process.env,
    // Defer CUDA module loading until first use — reduces DLLs scanned at import time
    CUDA_MODULE_LOADING: "LAZY",
  },
});

child.on("exit", (code) => process.exit(code ?? 0));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
