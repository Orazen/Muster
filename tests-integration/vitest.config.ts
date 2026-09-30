import { defineConfig } from "vitest/config";

// Integration-layer vitest config. These suites are NOT part of the ordinary
// sharded run (`pnpm exec vitest run`) and are excluded from its discovery by
// the root vite.config.ts include list. Each has its own pnpm script that
// prepares its real dependencies first; a missing native binary must fail the
// gate, never skip the test.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests-integration/**/*.test.ts"],
    setupFiles: [],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
