## Current owner acceptance directive — 6 October 2026, successor

Astra/root and its own subagents own this round; preserve shared work and use isolated branches/normal independently reviewed integration. Account-selected live restore scope is already approved and unattended boot apply excluded. Production live enablement still requires genuine pre-import/lifetime writer authority; production native enrollment stays disabled until recorded issuer/audience/registered macOS callback/protected-key bridge is reviewed and tested. Reuse existing protected custody; do not invent issuer from a public hostname or equate Google issuer/email/local IDs with enrollment identity. Latest source candidate `014ac84344eae08bcbfe6516e27e24add507e88c`, local full 518/8700/8+84; detailed actual results and NOT READY gates are in current-state and remaining-work register. This current directive supersedes conflicting historical coordination/scope statements below; historical receipts remain intact.

# AGENTS.md — Muster

## Current completion round — Astra and own subagents (2026-10-06)

Tharun’s latest direct instruction assigns this completion round to **Astra/root and its own subagents only**. Astra owns the execution queue, source corrections, independent nonauthor reviews and normal PR integration. Do not wait for Freebuff, Nova or OpenCode to relay or approve routine work in this round. Historical claims and review receipts remain evidence; copy only explicitly accepted files, preserve every unexpected change and never infer release from silence.

Use isolated task branches/worktrees; verify origin, current main, accepted paths and current PR receipts before editing. Freeze each candidate, independently review exact bytes and run meaningful focused checks plus the required final full gate. Reuse unchanged accepted evidence. Normal merge authority does not authorize an admin override, force push, deletion, check bypass, product release, signing, manual deployment, account login, purchase or destructive real-data test. Preserve demo8845, layout and existing sessions/data.

Keep source, local checks, hosted CI, served artifacts, installed apps and actual account/device acceptance separate. The current acceptance queue and owners are in [the remaining-work register](docs/plans/remaining-work-register-2026-10-06.md). Missing trust/callback and live-restore product decisions remain gates; no mandatory Drive or invented identity authority.

## Historical owner directive — Nova leads coordination (2026-10-03)

Tharun appoints **Nova (Cue/Nova)** as head coordinator, replacing Astra in the coordination role. Nova manages all PR triage, task assignments, accepted path claims, security issue triage, remediation ownership, review gates and audit handoffs. All agents, including Astra, Freebuff and OpenCode, report to Nova.

The canonical live claims register remains [PR #38](https://github.com/Orazen/Muster/pull/38#issuecomment-5969823410). Nova maintains it from this directive onward. Historical Astra acknowledgements and accepted reservations remain evidence; do not rewrite them or treat this role change as automatic release of implementation paths. Astra hands over pending reviews, blockers and audit obligations to Nova and may continue assigned work.

Nova must arrange independent review of Nova's own U34 changes; coordinator authority is not self-approval. Preserve existing scope, offline-test holds and verification requirements until an explicit evidence-backed disposition. Freebuff remains the shared-main integrator under Nova's coordination. No existing merge, deployment, purchase, account-creation or real-data testing hold is lifted by this appointment.

Claims and completion reports must identify agent role, exact paths, branch/PR, reviewed/tested SHA, commands/results, risks and next owner. Shared GitHub login is not agent identity. Silence or elapsed time never releases a claim. Work in isolated task branches/worktrees; preserve others' changes. Nova escalates product/budget decisions to Tharun and reports security findings precisely, without claiming the whole codebase secure.


## Current owner priority: keep the web app stable

Read [current state](docs/plans/current-state.md),
[the web app stability contract](docs/guides/web-app-stability.md), and the
**latest entry at the end** of the handoff ledger before historical roadmaps.
**New agent? Start with the 5-minute orientation hub:**
[docs/AGENT-ORIENTATION.md](docs/AGENT-ORIENTATION.md) — doc map, ranked work
list, verification gate, parallel-agent etiquette, owner gates.
Preserve the current layout, mascot, route shells, saved choices and user sessions.
Audits should fix reproduced defects; do not use them to redesign the app again.
Use isolated data, explicit ports and owned browser contexts. Never point a
preview at an unidentified backend or restart an existing user service. Treat
local preview, production and installed apps as distinct versions. A push is not
proof of deployment — verify against the release receipts in
`docs/release-mirror.md` before claiming any release or mirror state.


You are working on **Muster** (source version: `package.json`; installed/live versions require verification) — an AI-agent workforce platform (Electron desktop + server + web + CLI + iOS/Watch companions). Humans own a fleet of persistent AI workers ("bots"); approvals stay human via OptionCard/Apple Watch. Private repo (BSL 1.1), prod at muster.today.

## Read first (in this order — then stop exploring, go build)

1. `docs/plans/astra-gpt6-mvp-brief.md` — **your mission brief**: what's shipped (file-referenced capability table), the MVP, the 5-step eval, ranked next slices, hard constraints.
2. `docs/plans/competitive-landscape.md` — OpenMausBot / xAI Grok Bot / OpenClaw analysis, landscape patterns, ranked exposures.
3. `docs/plans/openmausbot-design-study.md` — competitor teardown incl. v0.1.69 corrections.
4. `docs/plans/muster-win-plan.md` + AGI master plan doc — the AGI-harness roadmap (why-journal, routine scorecards, plan rehearsal, Goal mode).

## Your mission (from the owner)

Advance the AGI harness beyond its current pass: turn provenance via-chips, Goal mode bounded autonomy, why-journal HYPOTHESIS/FINDINGS, routine scorecards and **plan rehearsal on approval cards** are shipped, then keep executing the ranked slices in the Astra brief. Beat OpenMausBot (github.com/milind-soni/OpenMausBot) on the benchmark defined in the brief. Build like a billion-dollar company is auditing every line.

## Repo map (do not re-derive this)

| Area | Path |
|---|---|
| Server API (one big file, ~8k lines) | `server/index.ts` |
| Contracts/wire shapes | `server/contracts.ts` |
| Fleet MCP server (11 bounded tools; `send_task` writes) | `server/fleet-mcp.ts` (+ `.test.ts`) |
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

Use the **latest verified full-suite baseline at the end of the handoff ledger**.
The historical 172 files / 1689 passed / 8 skipped count is not the current gate.
Report any decrease from the latest accepted baseline explicitly.

## Non-negotiable rules

- **Ownership**: Astra/root owns the current completion round under Tharun's latest instruction, with independent nonauthor review by its own subagents. Before `git add -A`, review `git status --short` and the diff; keep each commit scoped to the verified slice. Preserve any unexpected edits and establish their origin before including them.
- Use isolated task branches/worktrees and stage only your accepted paths. Astra integrates independently reviewed candidates through normal repository policy; preserve shared checkouts and all unexpected edits.
- **Never claim "done" without running the tests and reporting the real numbers.** Honest reporting over optimism; if something failed, show the output.
- Do not publish to npm (repo stays private). Never surface `npx muster` (squatter package) or any github.com link in user-facing UI.
- **No security claims.** The project's security scanner hasn't completed a full re-run; never assert the codebase is secure.
- Never stop or revoke sessions on the demo server already running on `127.0.0.1:8845`.
- Credentials come from env/secrets only — never commit literals.
- Production uses Dokploy, but pushes are **not deployment receipts**. Actions billing can block the automatic trigger. Follow the stability contract, verify the actual served files with **GET only**, and keep an unverified rollout explicit (HEAD returns 404 on static routes).

## Token discipline

- The docs above are the map — read them once, trust the paths, jump straight to code.
- During development run only the touched file's tests; run the full suite once before committing.
- Don't re-read files you've already read this session; don't re-run the typecheck after trivially orthogonal changes.
- Prefer small, verifiable slices with tests over large speculative refactors. A slice isn't done until typecheck + its tests pass.
