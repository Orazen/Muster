# Agent orientation hub — read this first (5 minutes)

You are working on **Muster**, an AI-agent workforce platform: Electron desktop
app + local server (`server/index.ts`) + React web UI (`src/`) + CLI
(`cli/muster.mjs`) + iOS/Watch/Android companions. Humans own a fleet of
persistent AI workers ("bots"); approvals stay human.

This file is the **map**. It tells you which document owns which question, what
the non-negotiable rules are, and how to land a slice end to end. It was built
so a new agent (or a parallel one) can orient in minutes instead of
re-deriving 800+ commits of context.

---

## 1. The read-order (stop exploring after this, go build)

1. **`docs/plans/current-state.md`** — the status of record. Latest loops at
   the top with verified numbers. If a doc contradicts it, this wins.
2. **`docs/guides/web-app-stability.md`** — the stability contract: keep
   `/app` + `/os` shells, the Flower mascot, selected conversation, saved
   choices, sessions. Layout redesigns are not audit work.
3. **`docs/plans/ceo-log.md`** (tail only) — append-only loop ledger. Every
   loop: what was claimed, what was measured, what remains. Read the last 2–3
   entries; never rewrite history.
4. **`AGENTS.md`** — the owner's standing rules (75 lines, read all of it).
5. **Your slice's plan doc** — find it in §3 below.

**Rule: the latest verified full-suite baseline in current-state.md is the
gate. If your work lowers a number, say so explicitly and explain why.**

## 2. The ranked work list — what to pick up next

`docs/plans/remaining-work-plan-2026-09-16.md` **§7** is the single ranked
list. Status vocabulary is strict — use it in your claims:

- **verified** — source + test evidence on this machine, numbers recorded.
- **acceptance-only** — artifact exists; browser/device acceptance open.
- **blocked** — only the owner can clear the gate (billing, certificates,
  SSH, Apple review). Do not burn loops retrying these.
- **proposed** — designed, not built. Cite the plan doc.

Before starting a slice, check §1 of this file's sibling —
`docs/plans/remaining-work-plan-2026-09-16.md` §7 — for what is already done
so you never repeat work.

## 3. The plan & research map (which doc owns which question)

| Question | Doc |
|---|---|
| **What is the product direction? (owner-locked 2026-09-18: cloud-relay flagship, BYOK free forever, Drive/Telegram-only storage)** | `docs/plans/cloud-relay-strategy-2026-09-18.md` |
| What is the mascot character system? (slices, contracts, ownership) | `docs/plans/mascot-character-system-plan-2026-09-18.md` |
| How should agents behave on this codebase? (per-slice rules) | `skills/mascot/SKILL.md`, this file |
| Where did the mascot references come from? (Novra GrokBot, botato, LaoA…) | `docs/research/mascot-character-study-2026-09-18.md` |
| Release process, mirror, signing, who is blocked on what | `docs/release-mirror.md`, remaining-work-plan §4/§8 |
| Backup/Drive boundary, what never gets claimed | `docs/plans/portable-backup-contract-2026-09-12.md` |
| OpenMausBot / Grok Bot competitive gaps | `docs/plans/competitive-landscape.md`, `docs/plans/landing-reference-study-2026-09-10.md` |
| What production serves right now (verified GET receipts) | ceo-log Loop116, current-state Loop116 |
| Untracked snapshots — preserve byte-identical, never commit | `docs/research/glm/*`, `www/templates.html` |

## 4. Non-negotiable rules (violate these and the loop fails review)

1. **Production is GET-only** from audit sessions. No credentials, no writes,
   no POST/DELETE, never touch port 8845 or the user's running services.
2. **Never claim security, deployment or release without verified bytes.** A
   push is not a deployment. A build is not a release. `spctl`/notarization
   receipts or GET receipts or it did not happen.
3. **Reproduce before fix.** Smallest touched surface. One slice = one commit.
4. **Isolation for anything that boots**: owned fixtures
   (`e2e/pairing-harness.ts`, `server/testing/`), probed free ports
   (`freePortBlock`), throwaway `HOME` + `OMB_DATA_DIR`, own temp dirs. Only
   ever delete what you created.
5. **Untracked snapshots stay byte-identical**: `docs/research/glm/*`,
   `www/templates.html`, `marketing-video/`, `.freebuff/`, `.zcode/`.
6. **Scoped commits.** `git status --short --untracked-files=all` before
   staging; stage explicit paths; pathless commit message; never `git add -A`.
7. **Docs are load-bearing.** A slice is not done until current-state.md, the
   relevant plan doc, and the ceo-log carry its verified numbers.

## 5. The verification gate (run before claiming done)

```bash
npx tsc --noEmit -p tsconfig.server.json   # server types (never bare tsc)
npx tsc -b                                 # project types
npx oxlint .                               # expect 0 warnings 0 errors
npx vitest run <touched>.test.ts           # focused first
npx vitest run                             # full suite — compare to baseline
npm run build && npx playwright test       # e2e (dist must be fresh or the
                                           # tests miss src fixes)
```

Electron changes: add `node --check electron/main.mjs && node --check
electron/preload.cjs`. iOS/Watch: `cd ios && swift test`, then
`xcodebuild build` (see Loop112 in the ceo-log for the signing traps).

**Baselines live at the top of current-state.md.** As of Loop117:
292 files / 4320 passed / 8 skipped / 0 failed; e2e 26/26.

## 6. Parallel-agent etiquette (how not to collide)

- **Claim your slice by file ownership.** The mascot plan's §File-ownership
  map is the model: list the exact files you will touch in the ceo-log entry
  where you announce the loop.
- Do not edit another open loop's files. If a merge conflict would be
  unavoidable, the second agent picks a different slice.
- **Ledger etiquette:** append, never reorder, cite file:line, keep claims
  and receipts in the same entry.
- Push after commit; if the push is rejected, `git fetch` + `git rebase
  origin/main` (never merge-commit the ledger) and re-push. Another agent
  may have landed first — re-run the focused tests before pushing.

## 7. Known owner gates (do not spend loops here)

| Gate | Why |
|---|---|
| Windows/Linux 1.12.3 release legs | GitHub Actions billing |
| macOS notarized release leg | `APPLE_CERTIFICATE` (Developer ID) secret |
| Web mirror promotion of 1.12.3 + HEAD-fix redeploy | VPS SSH via the repo's `VPS_HOST` secret (address not written in docs) + deploy trigger |
| TestFlight iOS review | Apple |
| Full Mimosa security re-run | Owner-directed; no security claims before it |
| Physical-device widget/Live-Activity acceptance | Needs hardware |

## 8. One-command slices that already exist

| Command | What it does |
|---|---|
| `pnpm bench:roles` | Per-role benchmark capture + grade over a real booted server (harness: `server/role-eval-harness.test.ts`) |
| `node scripts/owned-ios-acceptance.mjs` | Full iOS acceptance rig: pair → identity → walkie on a disposable simulator |
| `pnpm test:updater`, `pnpm check:electron` | Updater unit tests; Electron syntax sweep |
| `npm run dev:server` + `npm run dev` | Owned dev stack (explicit `OMB_PORT`/`OMB_DATA_DIR` required) |

## 9. When you are unsure

- The stability contract outranks ambition.
- The ceo-log's last entry outranks your memory of it.
- Measured numbers outrank plausible claims.
- If a reported defect cannot be located in the tree (see the "router
  metrics NaN" entry, Loop116), record it **unverifiable** — never invent a
  fix for a defect you could not reproduce.

## 10. Repository protections (read before pushing — 2026-09-19)

`main` carries a branch ruleset (`main-protected`, active):

- **Blocked for everyone:** force-pushes and branch deletion.
- **Required checks are deliberately NOT set, and must stay unset:** the
  autodeploy chain (workflow bumps `.deploy-trigger` → `github-actions[bot]`
  commit → Dokploy webhook) is the *only* deploy mechanism — Dokploy rejects
  external webhook calls, so the trigger-file commit cannot be replaced with
  anything else. On 2026-09-19 both a classic required-checks policy and a
  branch ruleset with required checks broke that chain (GH006/GH013 push
  rejections, autodeploy failures) because the bot cannot satisfy push-time
  required checks on a user-owned repo, and repo-level rulesets cannot grant
  the `Integration` bypass that would exempt it. CI still runs on every push
  and PR (lint/typecheck/test/build) and is the quality signal — it is just
  not push-enforcing. **If you ever re-add required checks, prove the bot
  chain with a real push cycle first or you will silently break deploys.**
- Historical red check-rollups on merged PRs #8–#13 are stale Sept-17
  branch-head checks under the old platform-refused policy — do not
  "fix" them; judge main's CI runs only.
- Security posture: secret scanning + push protection on, Dependabot
  alerts + automated fixes on, private vulnerability reporting on
  (SECURITY.md), alerts zero-open. Fixture-shaped tokens in tests must
  stay split-string (`["xoxb-", …].join("")`) so scanners never flag
  them.
