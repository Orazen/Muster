# Muster MVP Master Plan — Reality Reconciliation

Date: 2026-10-03
Author: Buffy (Freebuff lane)
Base: `origin/main` = `3067009`
Claim: `docs/plans/agent-claims/2026-10-03-buffy-docs-reality-reconciliation.md`
Branch: `task/docs-reality-reconciliation`

## Purpose

`docs/plans/Muster_MVP_Master_Plan.md` and
`docs/plans/Muster_Sub_Agent_Operating_Loop.md` describe an MVP that has not
been built yet, and order the work "Agent 2: Drive Storage Architecture" first.
The repository already contains that architecture, implemented and gated.

This document reconciles the plan against the code **once**, so the next agent
does not rebuild finished work or read a well-written document as a shipped
product. It does **not** rewrite the master plan, and it does **not** change any
code.

Read the master plan for intent. Read this for current state.

## How to read the status column

- **Implemented** — the capability exists in code on `origin/main` and has tests.
- **Partial** — exists, but a documented piece of the plan is missing or differs.
- **Unevidenced** — no evidence found that it works outside tests.

"Implemented" means *present and tested*. It does **not** mean shipped to a real
user, real device, or a real Google Drive account. Those gates are open.

## Pillar status

| Pillar | Status | Evidence on `origin/main` |
| --- | --- | --- |
| Login (email code + Google) | **Implemented** | `server/auth.ts` (879), `server/google-auth.ts` (58), `server/desktop-auth.ts` (398) + tests |
| Drive connect + storage | **Implemented, layout differs** | `server/drive-oauth.ts` (149), `server/account-drive.ts` (77), `server/drive-access.ts` (61), `server/drive-sync.ts` (363) |
| Chat | **Implemented** | `server/sync-chats.ts` (221) |
| Memory | **Implemented, format differs** | `server/memory-retrieval.ts` (449), `server/memory-grants.ts` (294), `server/sync-memory.ts` (137) |
| `soul.md` | **Partial** | `server/soul-md.ts` (122) exists; not a bundle entry (see divergence 2) |
| Sessions | **Implemented** | `server/sync-chats.ts`; auth sessions in `server/auth.db` |
| Tasks | **Implemented** | `server/task-engine.ts` (1030) |
| Restore | **Implemented, unevidenced on a fresh device** | `server/restore-apply.ts` (526), `server/restore-catalog.ts` (252), `server/workspace-bundle-v2.ts` (3256) |
| Real-device restore | **Unevidenced** | no device/real-Drive receipt on any branch |
| Beta cohort (5 testers x 3 days) | **Unevidenced** | 0 tester-day receipts |

Line counts were read with `git show origin/main:<path> | wc -l` at `3067009`.

## Divergences that matter

### 1. Drive storage is `drive.appdata`, not a visible `Muster/` folder

Master plan section 3 specifies a user-visible `Muster/` folder. The code does
not create one:

```ts
// server/drive-oauth.ts:4
export const GOOGLE_DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
```

`drive.appdata` is Drive's **hidden per-application private space**. This is
more private than a visible folder — other apps and the user's own file browser
cannot casually see it — and it is deliberate, not accidental:

```ts
// server/google-auth.ts:18
export const GOOGLE_SIGNIN_SCOPES = ["openid", "email", "profile"] as const;
```

Sign-in stays on basic scopes because `drive.appdata` is a **restricted** scope;
requesting it at login shows every new user Google's "unverified app"
interstitial. Drive is therefore a **separate opt-in connect**, not part of
login. `server/auth.ts:410-419` documents this tradeoff in code comments.

**Consequence for the plan:** "Automatic `Muster/` folder creation" (master plan
section 2) cannot be implemented as written without discarding the privacy and
onboarding benefits above. I did not change either side.

### 2. Bundle entries do not match the planned file names

```ts
// server/workspace-bundle-v2.ts:496
export const SUBSET_ROOT_FILES = new Set([
  "bots.json", "groups.json", "MEMORY.md",
  "routines.json", "goals.json", "decisions.json", "social.json",
]);
```

The plan lists `soul.md`, `memory.json`, `sessions.json`, `tasks.json`,
`settings.json`. The code stores `MEMORY.md` (Markdown, not JSON) and a
different file set. `memory.json` does not exist in the bundle.

**Consequence for the plan:** the plan's file table is aspirational naming, not a
specification of what is stored. An agent following it literally would create a
second, parallel storage format.

### 3. Credentials are deliberately excluded from backups

`server/workspace-bundle-v2.ts:521-524` records that `auth.db`, `auth.secret`
and `config.json` are **excluded** from the backup subset — they hold sessions,
Drive/Calendar grants, the installation signing secret, and every provider key
and transport token. A restore must not silently reintroduce them.

This is correct and security-relevant. It also means "restore everything" in the
master plan means **restore workspace data**, not credentials.

### 4. `sessions.json` means chat history, not authentication sessions

Master plan section 3 defines `sessions.json` as chat history (session id, date,
messages, responses). Authentication sessions and per-user Drive/Calendar grants
live separately in `server/auth.db`.

Conflating the two would be a security-design error. Flagged so no agent builds
on the conflation.

## Decisions needed from the owner

These are **not** mine to resolve and I did not act on any of them.

1. **Storage layout.** Keep the private `drive.appdata` design (privacy-first,
   consistent with the product direction) and update the master plan to match —
   or switch to a visible folder? The plan currently contradicts the code.
2. **"Optional local encryption."** Future roadmap section 5 lists local
   encryption as optional; accepted work in this lane treats encrypted backup
   and credential custody as a requirement. Confirm which is current.
3. **Repository visibility.** `AGENTS.md` line 20 says private (BSL 1.1); GitHub
   reports **public**; the new documents ask to make it private. Not changed by
   me.
4. **Beta gate.** The five-testers/three-days gate has 0 evidenced tester-days.

## Not claimed

- **No security claim.** The project's scanner has not completed a full re-run.
- **No beta-readiness claim.** This document measures code presence, not
  acceptance.
- **No real-device, real-Drive, or installed-app claim.** Unit and integration
  tests are not user acceptance.
- **No claim that the master plan is wrong.** Intent and naming are the owner's
  call; only the divergence is recorded.
- **No product code changed.** Verified with `git show --name-status`.

## Method and limits

Evidence came from `git cat-file -e`, `git ls-tree`, `git grep` and `git show`
against `origin/main` at `3067009`, plus GitHub's commit list for `main`, which
matches local `origin/main` exactly.

**Limit:** this is a static read of code presence and comments. I did not run the
test suite for this docs-only change, so "Implemented" means *a test file
exists alongside the implementation*, not that the suite is green right now. The
last accepted CI result for the product was 13/13 at `53b8072`.

**Staleness risk:** this document is a snapshot of `3067009`. If the file layout
changes, it is wrong. Re-verify the two constants before relying on it.