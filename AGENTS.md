# AGENTS.md — Muster

You are working on **Muster** v1.10.4 — an AI-agent workforce platform (Electron desktop + server + web + CLI + iOS/Watch companions). Humans own a fleet of persistent AI workers ("bots"); approvals stay human via OptionCard/Apple Watch. Private repo (BSL 1.1), prod at muster.orazen.online.

## Read first (in this order — then stop exploring, go build)

1. `docs/plans/astra-gpt6-mvp-brief.md` — **your mission brief**: what's shipped (file-referenced capability table), the MVP, the 5-step eval, ranked next slices, hard constraints.
2. `docs/plans/competitive-landscape.md` — OpenMausBot / xAI Grok Bot / OpenClaw analysis, landscape patterns, ranked exposures.
3. `docs/plans/openmausbot-design-study.md` — competitor teardown incl. v0.1.69 corrections.
4. `docs/plans/muster-win-plan.md` + AGI master plan doc — the AGI-harness roadmap (why-journal, routine scorecards, plan rehearsal, Goal mode).

## Your mission (from the owner)

Advance the AGI harness beyond its current pass: turn provenance via-chips, Goal mode bounded autonomy, why-journal HYPOTHESIS/FINDINGS, routine scorecards are shipped — **plan rehearsal on cards is the queued next ARC slice**, then keep executing the ranked slices in the Astra brief. Beat OpenMausBot (github.com/milind-soni/OpenMausBot) on the benchmark defined in the brief. Build like a billion-dollar company is auditing every line.

## Repo map (do not re-derive this)

| Area | Path |
|---|---|
| Server API (one big file, ~8k lines) | `server/index.ts` |
| Contracts/wire shapes | `server/contracts.ts` |
| Fleet MCP server (6 bounded tools) | `server/fleet-mcp.ts` (+ `.test.ts`) |
| Engine drivers | `server/drivers/` |
| MCP client/proxies | `server/mcp-client.ts`, `server/*-proxy.ts` |
| Web UI (React) | `src/` |
| Electron desktop | `electron/`, `src/main*` |
| CLI | `cli/muster.mjs` |
| Companion (iOS/Watch/Android) | `companion/`, `ios/`, `android/` |
| Strategy docs | `docs/plans/` |
| Marketing/docs site | `www/`, served from `server/index.ts` |

## Commands

```bash
npx tsc --noEmit -p tsconfig.server.json   # server typecheck (never bare-file tsc)
npx vitest run server/<file>.test.ts       # fast loop while developing
npx vitest run                             # full suite — MUST pass before commit
npm run dev:server                         # local server
npm run lint                               # oxlint
```

Suite baseline: **172 files / 1689 passed / 8 skipped**. If you land below that, say so explicitly.

## Non-negotiable rules

- **Ownership**: Astra Ultra is the sole maintainer under the board's standing mandate. Before `git add -A`, review `git status --short` and the diff; keep each commit scoped to the verified slice. Preserve any unexpected edits and establish their origin before including them.
- Work on `main` only. Commit with `git add -A` and a **pathless commit message** (never name file paths in the message).
- **Never claim "done" without running the tests and reporting the real numbers.** Honest reporting over optimism; if something failed, show the output.
- Do not publish to npm (repo stays private). Never surface `npx muster` (squatter package) or any github.com link in user-facing UI.
- **No security claims.** The project's security scanner hasn't completed a full re-run; never assert the codebase is secure.
- Never stop or revoke sessions on the demo server already running on `127.0.0.1:8845`.
- Credentials come from env/secrets only — never commit literals.
- Prod auto-deploys on push (~2–3 min, Dokploy). Verify prod with **GET only** (HEAD returns 404 on static routes).

## Token discipline

- The docs above are the map — read them once, trust the paths, jump straight to code.
- During development run only the touched file's tests; run the full suite once before committing.
- Don't re-read files you've already read this session; don't re-run the typecheck after trivially orthogonal changes.
- Prefer small, verifiable slices with tests over large speculative refactors. A slice isn't done until typecheck + its tests pass.
