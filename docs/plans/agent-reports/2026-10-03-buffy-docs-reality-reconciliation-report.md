# AGENT COMPLETION REPORT — Buffy — 2026-10-03 (rev 2)

```txt
Agent: Buffy / Freebuff lane (sole shared-main Git integration captain)
Task: Docs-vs-code reality reconciliation of the MVP pillars

Repository:  https://github.com/Orazen/Muster
Checkout:    /Users/ramagiritharun/muster-audit  (shared — left untouched)
Worktree:    /tmp/recon  (isolated)
Reviewed SHA: origin/main = 3067009  (re-verified unchanged at finalize)
Branch:      task/docs-reality-reconciliation
```

## 1. Links

| | |
| --- | --- |
| **Branch URL** | <https://github.com/Orazen/Muster/tree/task/docs-reality-reconciliation> |
| **Final commit SHA** | see §6 — verified on remote via `git ls-remote` |
| **PR URL** | opened against `main`, **not merged** — see §6 |
| Claim doc | `docs/plans/agent-claims/2026-10-03-buffy-docs-reality-reconciliation.md` |

## 2. Shared checkout untouched

`main` at `4736e55`, still 5 ahead / 44 behind `origin/main`, with the same 10
uncommitted tracked modifications from other agents. No fetch-merge into it, no
stash/reset/checkout over it, no staging of its files. All work in `/tmp/recon`.

## 3. Verified findings

**F1 — The `drive.appdata` classification in our own code is wrong.**
`server/auth.ts:410-419` states `drive.appdata` is a "RESTRICTED scope" that makes
Google show every new user an unverified-app interstitial. Google's official
documentation classifies `drive.appdata` under **non-sensitive** scopes, requiring
only basic OAuth App Verification; the unverified-app screen applies to
**sensitive or restricted** scopes.
Sources: <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>,
<https://support.google.com/cloud/answer/7454865>

The *decision* to separate Drive connect from sign-in is still defensible. The
*stated reason* is not, and it would mislead any future agent reasoning from it.
**Not edited** — `server/**` is outside my claim; raised as a recommendation.

**F2 — `drive.appdata` creates a data-loss path against our own product promise.**
Google documents that the application data folder is hidden from the user and
**"deleted when a user uninstalls your app"**, and users can delete it manually.
A user who uninstalls and reinstalls Muster can permanently lose memory and
sessions — in a product whose stated direction is "user-owned data".
Source: <https://developers.google.com/workspace/drive/api/guides/appdata>

**F3 — The master plan's build order is overtaken by the code.** All five MVP
pillars have implementations with tests. "Agent 2: Drive Storage Architecture" is
not an available greenfield task.

**F4 — Bundle layout differs from the plan.** `SUBSET_ROOT_FILES` stores
`MEMORY.md` (Markdown), `bots.json`, `groups.json`, `routines.json`, `goals.json`,
`decisions.json`, `social.json` — not the planned `memory.json` / `sessions.json` /
`tasks.json` / `settings.json`. An agent following the plan literally would build a
second parallel storage format.

**F5 — Credentials are correctly excluded from backups.** `auth.db`,
`auth.secret`, `config.json` are outside the restore subset
(`server/workspace-bundle-v2.ts:521-524`). Correct, and it means "restore
everything" means workspace data, never credentials.

**F6 — `sessions.json` means chat history, not auth sessions.** Confusing them
would be a security-design error.

## 4. Evidence labels (corrected per review)

Original labels said "Implemented" based on a test file existing. **That was
overstated and is fixed.** The reconciliation now grades every row on:
Code present / Tests present / Tests run, passed / Real-device verified /
Partial-blocked-unknown.

Tests actually executed for this review (15 files):

```bash
npx vitest run server/auth.test.ts server/google-auth.test.ts \
  server/desktop-auth.test.ts server/drive-oauth.test.ts \
  server/account-drive-consent.test.ts server/account-drive-roundtrip.test.ts \
  server/drive-access.test.ts server/sync-chats.test.ts server/sync-memory.test.ts \
  server/memory-retrieval.test.ts server/memory-grants.test.ts server/soul-md.test.ts \
  server/restore-apply.test.ts server/restore-catalog.test.ts server/task-engine.test.ts \
  --reporter=default
```

**`Test Files 15 passed (15)` · `Tests 277 passed (277)` · 46.72s · exit `0`.**

- **No pillar is "Real-device verified."** Not one.
- The 277 tests are unit/integration in a dev environment — **not** real Drive,
  real device, or installed-app acceptance.
- I ran the 15 pillar files, **not** the full 473-file suite. No full-suite result
  is claimed. Last accepted product CI was 13/13 at `53b8072`.

## 5. Storage decision — neutral comparison, recommendation, unresolved

Full matrix in the reconciliation §5 across permissions, user access,
backup/restore, migration, encryption and failure modes for three options:
hidden `appDataFolder` (current), visible user folder, hidden + user-controlled
export.

**Recommendation: visible folder via `drive.file`, not full `drive`.** Evidence:
`drive.appdata` is hidden from the user and deleted on uninstall (F2), which
conflicts with user-owned data; `drive.file` is **non-sensitive** and grants only
per-file access to files the user shares with the app, so privacy is largely
preserved without the data-loss path.

**This is a recommendation, not a decision, and I made no code change.** Cost
stated honestly: real migration, two storage locations cannot interoperate, needs
its own gated slice. Option C rejected as premature.

## 6. Recheck at finalize

- `origin/main` = **`3067009`** — `git log 3067009..origin/main` → **no commits**.
  Reviewed SHA is current.
- **Two new PRs** since my earlier check: **#37** (`agent4-charm-hardware-research`
  → `docs/plans/muster-charm-hardware-research.md`) and **#38**
  (`codex/agent-repository-preflight` →
  `docs/plans/agent-claims/2026-10-03-astra-repository-preflight.md`). **Neither
  overlaps my paths.** #38 confirms `docs/plans/agent-claims/` is the emerging
  shared convention, which my claim already follows.
- Untouched: **#32** (Cue), **#33–#36** (Dependabot).

## 7. Communication protocol — confirmed, and its real limit

`docs/AGENT_COMMUNICATION.md` §2 prefers PR comments → issue comments → commit
messages → repo docs → report to CTO. **GitHub Issues are disabled** on this repo,
so issue comments are impossible. PR descriptions are in active use.

**Confirmed limit, stated plainly:** my claim is a document on a task branch. That
records my work but **does not establish shared ownership across agents** —
nothing forces another agent to read it, it does not prevent two agents claiming
the same paths, and it does not update when work completes. A discoverable claims
channel is proposed in `docs/plans/2026-10-03-agent-claims-channel-proposal.md`
(index now, CI-enforced path claims later). I did **not** create the index or edit
`docs/AGENT_COMMUNICATION.md` — that path is claimed by Astra in #38, and editing
it would be exactly the collision the proposal exists to prevent.

## 8. Risks and blockers

Unchanged by me: PRs #33/#34/#36 hold; Dependabot #73 (node-forge, high) open;
local `main` 5 ahead/44 behind with 10 uncommitted files (unmade decision, not
mine to take); repo visibility conflict (`AGENTS.md` private vs GitHub public).

Newly surfaced: **F1** (wrong scope classification in code), **F2** (uninstall
data-loss path).

## 9. Fresh-device restore — remains OPEN

Not verified. No real Drive account or fresh device was used. The reconciliation
§6 carries a reproducible procedure: preconditions, 7 steps, and six pass
criteria (P1 restore completes; P2 memory/chat/task byte-equal; P3 `soul.md`
restored **and behaviourally observed**; P4 credential absence **verified, not
assumed**; P5 no inherited device state; P6 safe degradation without Drive) plus
explicit fail criteria.

**Do not record this criterion as met until a run produces evidence.**

## 10. Tomorrow's audit

**Proposed owner: Astra (review lane). Due: 2026-10-04.**

**Astra has NOT acknowledged this.** It is a **proposed** owner, not a scheduled
or accepted assignment, and this environment has no scheduler — nothing is
arranged and nothing is claimed as scheduled. If Astra declines, the audit is
unowned and must be reassigned explicitly.

Audit questions: does hidden storage serve *user-owned data* or become
paternalistic (F2)? Is F1 corrected without a decision being smuggled in? Does
the reconciliation still match Muster's vision, or is it redundant internal
hygiene earning nothing? Do its citations still resolve at then-current `main`?
Has any agent meanwhile claimed a Drive-storage task and duplicated it?

## 11. Next handoff

1. **Owner decides the storage question (§5)** — recommend visible folder via
   `drive.file`. Everything else is downstream.
2. **Owner decides F1** — correct the comment in `server/auth.ts` (one file,
   one comment); a separate small claim.
3. **Whoever has real-device + real-Drive access runs §6** and produces evidence.
4. **Astra or owner picks a claims-channel option.**
5. **Do not** take "Drive Storage Architecture" as greenfield.