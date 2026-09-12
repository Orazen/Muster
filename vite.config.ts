import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { devBackendPreview } from "./scripts/dev-backend-guard";

const backend = devBackendPreview({
  OMB_PORT: process.env.OMB_PORT,
  OGB_PORT: process.env.OGB_PORT,
  MUSTER_DEV_SERVER_PID: process.env.MUSTER_DEV_SERVER_PID,
});

export default defineConfig({
  plugins: [backend.plugin, react(), tailwindcss()],
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "electron/**/*.test.mjs",
      "src/**/*.test.ts",
      "companion/**/*.test.ts",
    ],
    setupFiles: ["server/testing/setup.ts"],
    // the suite spawns fake provider CLIs and a real harness server;
    // parallel files introduce load-sensitive flakes for no win
    fileParallelism: false,
    testTimeout: 20_000,
    // Spawn-heavy e2e (fake ACP fleet, real harness server) starve on
    // slow/loaded runners and fail on timing, not logic. Retry those
    // flakes in CI only; locally keep the fast signal.
    retry: process.env.CI ? 2 : 0,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // IPv4 explicitly — a bare ::1 bind makes localhost a coin-flip for
    // clients that resolve IPv4 first
    host: "127.0.0.1",
    port: Number(process.env.OMB_UI_PORT) || 5199,
    strictPort: true,
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**", "**/.omb-scratch/**", "**/test-results/**", "**/playwright-report/**"],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    proxy: backend.proxy,
  },
  preview: { host: "127.0.0.1", strictPort: true, proxy: backend.proxy },
});
