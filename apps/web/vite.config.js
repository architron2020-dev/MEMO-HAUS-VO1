import { defineConfig } from "vite";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const API_TARGET = process.env.MEMO_API_URL || "http://127.0.0.1:8000";

// Microphone access (getUserMedia) is blocked by browsers on any non-secure
// origin except localhost — that includes the LAN IP phones reach via the
// QR code. A self-signed dev cert (generate with scripts/make-dev-cert.sh)
// makes that origin a secure context too, so the mic permission prompt
// actually appears instead of silently failing with "permission denied".
const certPath = resolve(__dirname, ".cert/cert.pem");
const keyPath  = resolve(__dirname, ".cert/key.pem");
const httpsConfig =
  existsSync(certPath) && existsSync(keyPath)
    ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
    : undefined;

export default defineConfig({
  server: {
    port: 5173,
    host: true, // expose on the LAN so phones (via QR code) can reach the upload page
    https: httpsConfig,
    proxy: {
      "/api": API_TARGET,
      "/outputs": API_TARGET,
      "/uploads": API_TARGET,
      "/audio": API_TARGET,
    },
  },
  build: {
    rollupOptions: {
      input: {
        upload: resolve(__dirname, "index.html"),
        viewer: resolve(__dirname, "viewer.html"),
        memories: resolve(__dirname, "memories.html"),
      },
    },
  },
});
