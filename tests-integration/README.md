# tests-integration

Suites that need REAL dependencies built for the executing runtime. They are
deliberately outside the ordinary vitest shard discovery
(`vite.config.ts` includes only `server/`, `electron/`, `cli/`, `src/`,
`companion/`, `scripts/`, `e2e/` patterns) because a fresh `pnpm install`
cannot provide what they verify: pnpm's install-script policy builds native
modules only for Electron and esbuild.

Every suite here has a pnpm script that prepares its fixture first and fails
fatally when the fixture cannot be produced — a missing native binary is an
environment failure, never a skipped or passing test.

## native-load

Verifies the packaged-server native vendoring guard
(`scripts/native-vendor.mjs`) against the real better-sqlite3 package:
open → query → close in the executing runtime, corruption/missing-binary
refusals, recovery paths, and loud failure instead of silent ship.

```sh
pnpm test:native-load
```

This run is wired into `pnpm test`, CI's `test-integrations` job, and the
release workflow's prepare stage. The ordinary sharded suite and the
release's packaged-executable smoke remain separate, distinct evidence: the
Node-side receipt here never substitutes for the Electron-runtime smoke.
