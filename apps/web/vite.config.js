import { defineConfig } from "vite";
import { resolve } from "node:path";

const API_TARGET = process.env.MEMO_API_URL || "http://127.0.0.1:8000";

export default defineConfig({
  server: {
    port: 5173,
    host: true, // expose on the LAN so phones (via QR code) can reach the upload page
    proxy: {
      "/api": API_TARGET,
      "/outputs": API_TARGET,
      "/uploads": API_TARGET,
    },
  },
  build: {
    rollupOptions: {
      input: {
        upload: resolve(__dirname, "index.html"),
        viewer: resolve(__dirname, "viewer.html"),
      },
    },
  },
});
