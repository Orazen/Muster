import { defineConfig } from "@playwright/test";

// gstack /qa methodology: real browser, real clicks, console-error budget,
// artifacts on failure. No webServer block — the pairing spec spawns its own
// two-server topology (cloud + desktop) because that IS the system.
export default defineConfig({
  testDir: "./e2e",
  // Vitest also owns unit tests in this directory. Collect only browser specs.
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // 13 minutes of real-browser work fails the whole job on a single timing
  // blip with no second reading. `e940fa59`'s job failed on a mascot-editor
  // assertion that passes 6/6 locally on the same commit, and the repo
  // already retries spawn-heavy specs in CI for exactly this reason
  // (vite.config.ts: `retry: process.env.CI ? 2 : 0`). Retrying is not
  // weakening: a test that passes only on a retry is still reported as flaky
  // in the run summary rather than being silently accepted.
  retries: process.env.CI ? 2 : 0,
  use: {
    headless: true,
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "./.omb-scratch/e2e",
});
