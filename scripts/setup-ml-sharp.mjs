#!/usr/bin/env node
/**
 * One-shot setup for the SHARP dependency.
 *
 * SHARP is Apple's model and is NOT vendored into this repo. This script clones
 * it at a pinned commit into packages/ml-sharp, creates a Python venv, and
 * installs the backend dependencies. It is safe to re-run (it skips steps that
 * are already done).
 *
 *   node scripts/setup-ml-sharp.mjs        (or: npm run setup:ml-sharp)
 *
 * RTX 50-series (Blackwell) GPUs additionally need the cu128 nightly build of
 * torch — pass --blackwell to install it (see packages/ml-sharp/NOTES.md).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO = "https://github.com/apple/ml-sharp.git";
const PINNED_COMMIT = "1eaa046834b81852261262b41b0919f5c1efdd2e";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const dir = resolve(repoRoot, "packages/ml-sharp");
const isWin = process.platform === "win32";
const venvPython = resolve(dir, isWin ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const blackwell = process.argv.includes("--blackwell");

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`\n[setup] command failed (${r.status ?? r.error}).`);
    process.exit(r.status ?? 1);
  }
}

// 1. Clone Apple's SHARP at the pinned commit.
if (!existsSync(dir)) {
  run("git", ["clone", REPO, dir]);
  run("git", ["-C", dir, "checkout", PINNED_COMMIT]);
} else {
  console.log(`[setup] ${dir} already exists — skipping clone.`);
}

// 2. Create the venv.
if (!existsSync(venvPython)) {
  run("python", ["-m", "venv", resolve(dir, ".venv")]);
} else {
  console.log("[setup] venv already exists — skipping creation.");
}

// 3. Install SHARP (editable) + the FastAPI backend deps.
run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
run(venvPython, ["-m", "pip", "install", "-e", dir, "--no-build-isolation"]);
run(venvPython, ["-m", "pip", "install", "fastapi", "uvicorn[standard]", "python-multipart"]);

// 4. Optional: cu128 nightly torch for Blackwell (RTX 50-series).
if (blackwell) {
  run(venvPython, [
    "-m", "pip", "install", "--pre", "torch", "torchvision",
    "--index-url", "https://download.pytorch.org/whl/nightly/cu128",
    "--force-reinstall", "--no-deps",
  ]);
}

console.log("\n[setup] Done. Run `npm run dev` to start the app.");
if (!blackwell) {
  console.log("[setup] On an RTX 50-series GPU, re-run with --blackwell for the cu128 nightly torch.");
}
