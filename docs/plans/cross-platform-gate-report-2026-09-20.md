# Cross-platform gate report — released tip `3c9ec0d` (20 September 2026)

**Audience: every agent working on Muster.** This is the verified state of all
shipped surfaces after the 2026-09-19/20 dependency sweep (PRs #14, #16, #17,
#18, #19, #22 merged) and the zod-cap fix (`d3b0494`). Every number below was
produced on this machine against the exact merge commit `3c9ec0d` in an
isolated worktree — no parallel-agent WIP was touched.

## 1. Verified receipts, per platform

| Surface | Gate | Result |
|---|---|---|
| Webapp (src/ + server/) | `tsc -p tsconfig.server.json` | exit 0 |
| | `tsc -b` (web) | exit 0 |
| | `pnpm lint` (891 files) | 0 warnings / 0 errors |
| | `vitest run` | **321 files / 4830 passed / 8 skipped / 0 failed** |
| | `npm run build` | exit 0 (vite ✓) |
| | `playwright test` | **41 passed / 0 failed** |
| iOS (ios/) | `swift test` | **390 tests, 0 failures** |
| | xcodebuild MusterCompanion (phone) | BUILD SUCCEEDED |
| | xcodebuild MusterWatchOwnedAcceptance | BUILD SUCCEEDED |
| | xcodebuild MusterFleetWidget | BUILD SUCCEEDED |
| Desktop (electron/) | `pnpm check:electron` (syntax sweep) | exit 0 |
| | `pnpm test:updater` | 0 failed / 0 skipped |
| Production (GET-only probe) | muster.today `/`, `/api/health`, `/sign-in`, `/os`, `/marketplace` | all **200** |
| | health body | `{"app":"muster","pid":8,"static":true,...}` |
| | headers | HSTS + nosniff present |
| Release channel | GitHub releases/latest | `v1.12.3`, 14 assets, published 2026-09-16 |

CI on the tip: **success** (run on `3c9ec0d`), autodeploy **success**, and the
bot deploy chain proven live post-ruleset (see AGENT-ORIENTATION.md §10).

### Environment notes for reproducing (not product defects)

- Playwright bumped to 1.63 in the sweep needs the new browser build:
  run `npx playwright install chromium` once per machine before e2e, or the
  whole suite fails on `Executable doesn't exist … chromium_headless_shell-1243`.
- The iOS `.xcodeproj` is generated: `cd ios && xcodegen generate` before any
  xcodebuild (it is gitignored).
- vitest 4 dropped worker-count CLI flags; use `--no-file-parallelism` to
  bound load on a busy machine (this Mac ran at load 10–16 during the sweep).

## 2. Dependency-sweep findings every agent should know

1. **better-auth 1.7.5 dropped its `better-sqlite3` peer declaration.** pnpm
   then removed the native module from the graph and `vaultgram` (git-tarball
   dep) died with `ERR_MODULE_NOT_FOUND` — 38 harness tests failed. Fixed
   structurally by declaring `better-sqlite3 ^12.11.1` in root dependencies
   (shipped with PR #22). Do not remove it because it looks unused.
2. **zod 4.6.5 changed `string.max()` to count codepoints, not UTF-16 units.**
   A 4001-unit draft (2000 emoji + 1 char) passed `max(4000)`. The onboarding
   draft caps mirror the server's PATCH limits, so this was a real overflow
   path. Fixed with explicit `.length` refinements (`d3b0494`); if you add new
   length caps that mirror server limits, use the same `maxUtf16` helper.
3. **lucide-react 1.x removed brand icons.** `Github` now lives as an inline
   SVG (`GithubMark`) in `src/components/TeamLibraryPanel.tsx`.

## 3. Remaining work — agent-actionable, priority order (from §7, re-verified)

1. **Benchmark CI + scorecard trending** — pipeline exists and runs on demand
   (`pnpm bench:roles`); missing scheduled run + stored baselines.
2. **Memory history + rollback UI** — brain stores chains/withdrawal
   (`server/workspace-brain.ts`); no browse/rollback surface. Prereq for any
   self-proposal slice touching memory.
3. **Skills-creation API** — largest server gap; build behind the route-table
   pattern (see the structure note in `docs/plans/current-state.md`).
4. **Pairing redeem web surface** — `/api/pair/claim` exists
   (`cli/muster.mjs:637`); `/pair#CODE` carry-display verified; the signed-in
   web redemption UI is the smallest shippable slice.
5. **OpenMausBot parity** — channels UI in /app (not started); Engines
   Add-account flow (readiness list ships, no flow); tour pacing acceptance.
6. **Agent social S5–S10 / GAIA G2–G5** — proposed tracks in their plan docs.
7. **Voice W4 barge-in** — device-gated (needs real hardware).

**Owner-gated (do not claim, do not attempt):** Windows/Linux release legs
(Actions billing), macOS notarization (`APPLE_CERTIFICATE` Developer ID),
mirror promotion (VPS SSH via `VPS_HOST` secret), TestFlight review, Xcode
Cloud authorization, full Mimosa re-run before any security claim, Droid
subscription for a fully green real-turn send.

## 4. Rules of engagement (unchanged)

Read `docs/AGENT-ORIENTATION.md` first. Reproduce before fixing, smallest
touched surface, isolated worktree for dependency/experimental work, scoped
pathless commits on main, full gate before claiming done, real numbers only.
Coordinate file ownership in the ceo-log before spawning parallel agents.
