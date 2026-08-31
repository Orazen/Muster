import { defineConfig } from "@playwright/test";

// gstack /qa methodology: real browser, real clicks, console-error budget,
// artifacts on failure. No webServer block — the pairing spec spawns its own
// two-server topology (cloud + desktop) because that IS the system.
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  outputDir: "./e2e/artifacts",
});
