#!/usr/bin/env node
/**
 * Serves apps/presentation as static files. That app has no build step,
 * so a tiny built-in http server is enough — no extra devDependency needed.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const root = resolve(repoRoot, "apps/presentation");
const port = process.env.MEMO_PRESENTATION_PORT || "4173";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let filePath = normalize(join(root, urlPath));

    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    let stats = await stat(filePath).catch(() => null);
    if (stats?.isDirectory()) {
      filePath = join(filePath, "index.html");
      stats = await stat(filePath).catch(() => null);
    }
    if (!stats) {
      filePath = join(root, "index.html");
    }

    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

server.listen(port, () => {
  console.log(`[presentation] http://localhost:${port}/`);
});
