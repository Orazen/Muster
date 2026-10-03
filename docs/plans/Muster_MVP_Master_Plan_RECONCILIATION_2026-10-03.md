# Muster MVP Master Plan — Reality Reconciliation

Date: 2026-10-03
Author: Buffy (Freebuff lane)
Reviewed SHA: **`3067009`** (`origin/main`) — re-checked at finalize time; **no commits since**, see §8
Claim: `docs/plans/agent-claims/2026-10-03-buffy-docs-reality-reconciliation.md`
Branch: `task/docs-reality-reconciliation`

## Purpose

`docs/plans/Muster_MVP_Master_Plan.md` describes an MVP that has not been built
and orders the work "Agent 2: Drive Storage Architecture" first. That
architecture exists in the repository, implemented and covered by tests.

This document reconciles plan against code **once**, so the next agent does not
rebuild finished work, and so nobody reads a well-written document as a shipped
product. It does **not** rewrite the master plan and does **not** change code.

Read the master plan for intent. Read this for current state.

## 1. Evidence labels

These are graded, and the grade is the point. A test file existing is **not**
evidence that anything works.

| Label | Meaning |
| --- | --- |
| **Code present** | Implementation exists on `origin/main`. Says nothing about behaviour. |
| **Tests present** | A test file exists alongside it. Says nothing about whether it passes. |
| **Tests run, passed** | I executed the tests here, with command and result below. |
| **Real-device verified** | Exercised on real hardware / real account / real Drive. |
| **Partial / blocked / unknown** | Some of it, or blocked, or I could not determine it. |

**No pillar in this repository is "Real-device verified."** Nothing below claims
otherwise.

## 2. Pillar status

Test command actually executed (this branch, `3067009`, node v24.20.0):

```bash
npx vitest run \
  server/auth.test.ts server/google-auth.test.ts server/desktop-auth.test.ts \
  server/drive-oauth.test.ts server/account-drive-consent.test.ts \
  server/account-drive-roundtrip.test.ts server/drive-access.test.ts \
  server/sync-chats.test.ts server/sync-memory.test.ts \
  server/memory-retrieval.test.ts server/memory-grants.test.ts \
  server/soul-md.test.ts server/restore-apply.test.ts \
  server/restore-catalog.test.ts server/task-engine.test.ts \
  --reporter=default
```

### Reproducible receipt

**Code SHA under test: `ba9c4fbe68028d902c7e71d129f319b88ca8e631`**
(`origin/main` = `3067009`)

The tested commit differs from `origin/main` only in documentation. This is
proven, not asserted — the `server/` tree object is byte-identical:

```
server/ tree at ba9c4fb : 5044ba6762e222d1c3a2c99bf192b6ce9ef017c4
server/ tree at 3067009 : 5044ba6762e222d1c3a2c99bf192b6ce9ef017c4   IDENTICAL
```

Environment: node `v24.20.0`, repo's own `vite.config.ts`, `node_modules`
symlinked from the shared checkout. Worktree `/tmp/recon`.

Exact command:

```bash
npx vitest run \
  server/auth.test.ts server/google-auth.test.ts server/desktop-auth.test.ts \
  server/drive-oauth.test.ts server/account-drive-consent.test.ts \
  server/account-drive-roundtrip.test.ts server/drive-access.test.ts \
  server/sync-chats.test.ts server/sync-memory.test.ts \
  server/memory-retrieval.test.ts server/memory-grants.test.ts \
  server/soul-md.test.ts server/restore-apply.test.ts \
  server/restore-catalog.test.ts server/task-engine.test.ts \
  --reporter=default
```

Result:

```
 Test Files  15 passed (15)
      Tests  277 passed (277)
   Duration  42.80s (tests 93%, setup 5%, transform 1%, import 1%)
exit code 0
```

**Run twice** (42.80s and 46.72s) with identical results — `15 passed / 277
passed / exit 0` both times. The variation is wall-clock only.

Scope limits, restated because they are easy to misread:
- This is **15 files**, not the full 473-file suite. **No full-suite result is
  claimed.**
- These are unit/integration tests in a dev environment. **No real Google
  account, no real Drive, no physical device, no installed app.**
- The last accepted product CI was 13/13 at `53b8072`; that is not re-asserted
  here as current.

| Pillar | Code present | Tests present | Tests run, passed | Real-device verified |
| --- | --- | --- | --- | --- |
| Login (email code + Google) | `server/auth.ts` (879), `server/google-auth.ts` (58), `server/desktop-auth.ts` (398) | yes | **yes — part of the 277** | **no** |
| Drive connect + storage | `server/drive-oauth.ts` (149), `server/account-drive.ts` (77), `server/drive-access.ts` (61), `server/drive-sync.ts` (363) | yes | **yes — part of the 277** | **no** |
| Chat | `server/sync-chats.ts` (221) | yes | **yes** | **no** |
| Memory | `server/memory-retrieval.ts` (449), `server/memory-grants.ts` (294), `server/sync-memory.ts` (137) | yes | **yes** | **no** |
| `soul.md` | `server/soul-md.ts` (122) | yes | **yes (7 tests)** | **no** |
| Sessions (chat) | `server/sync-chats.ts` | yes | **yes** | **no** |
| Tasks | `server/task-engine.ts` (1030) | yes | **yes (24 tests)** | **no** |
| Restore | `server/restore-apply.ts` (526), `server/restore-catalog.ts` (252), `server/workspace-bundle-v2.ts` (3256) | yes | **yes** | **no** |
| Bundle layout matches plan | — | — | — | **No — layout differs, see §3.2** |
| Fresh-device restore | — | — | — | **Unknown — procedure in §6, not run** |
| Beta cohort (5 testers x 3 days) | — | — | — | **Unknown — 0 evidenced tester-days** |

**"Tests run, passed" means the unit/integration suite passed in this
environment. It does not mean a real user, real device, or real Google Drive
account was involved.** Those are the open criteria in §6.

## 3. Divergences

### 3.1 Drive storage uses hidden `drive.appdata`, not a visible `Muster/` folder

```ts
// server/drive-oauth.ts:4
export const GOOGLE_DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
```

Per Google's documentation, the application data folder is "a special hidden
folder", "only accessible by your app", with contents "hidden from the user and
from other Google Drive apps", and it cannot be accessed through the Drive UI.
It is also **deleted when the user uninstalls the app**, and users can delete it
manually.

- Source: <https://developers.google.com/workspace/drive/api/guides/appdata>

The master plan section 3 specifies a visible `Muster/` folder. That is not what
the code does. §5 compares the options neutrally.

### 3.2 Bundle entries do not match the planned file names

```ts
// server/workspace-bundle-v2.ts:496
export const SUBSET_ROOT_FILES = new Set([
  "bots.json", "groups.json", "MEMORY.md",
  "routines.json", "goals.json", "decisions.json", "social.json",
]);
```

The plan lists `soul.md`, `memory.json`, `sessions.json`, `tasks.json`,
`settings.json`. The code stores `MEMORY.md` — Markdown, not JSON — and a
different file set. `memory.json` does not exist in the bundle. `soul.md` exists
as `server/soul-md.ts` but is not one of these entries.

**Consequence:** the plan's file table is aspirational naming. An agent
following it literally would build a second, parallel storage format.

### 3.3 Credentials are deliberately excluded from backups

`server/workspace-bundle-v2.ts:521-524` records that `auth.db` (sessions,
per-user Drive/Calendar grants, account rows), `auth.secret` (the installation
signing secret) and `config.json` (provider keys and every transport token) are
**excluded** from the backup subset.

Correct and security-relevant. It also means "restore everything" means
**restore workspace data**, never credentials.

### 3.4 `sessions.json` means chat history, not authentication sessions

The plan defines `sessions.json` as chat history. Authentication sessions and
per-user grants live separately in `server/auth.db`. Conflating them would be a
security-design error.

## 4. Correction: the code comment about `drive.appdata` is factually wrong

The comment at `server/auth.ts:410-419` says:

> "Sign-in stays basic-scope on purpose … `drive.appdata` is a RESTRICTED scope,
> and requesting it at login makes Google show every new user the 'Google hasn't
> verified this app' interstitial (scope verification is separate from branding —
> restricted scopes need a security assessment)."

**Two problems:**

1. **The classification is wrong.** Google lists `drive.appdata` under
   **non-sensitive** scopes: "View and manage the app's own configuration data in
   your Google Drive", alongside `drive.appfolder`, `drive.install` and
   `drive.file`. Restricted scopes are a different list (`drive`, `drive.readonly`,
   `drive.metadata`, …). Non-sensitive scopes "only require basic OAuth App
   Verification".
   Source: <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>

2. **The consequence is therefore overstated.** The unverified-app screen appears
   when "your app uses sensitive or restricted scopes and you haven't configured
   them in your OAuth consent screen configuration page and requested
   verification". Since `drive.appdata` is non-sensitive, that specific screen
   would not be triggered by this scope alone.
   Source: <https://support.google.com/cloud/answer/7454865>

**The decision itself is still defensible** — keeping sign-in on
`openid email profile` and making Drive a separate opt-in step is a reasonable
onboarding choice. **The stated reason is not.** A future agent reasoning from
this comment could wrongly conclude that `drive.appdata` triggers verification
requirements, and make worse decisions because of it.

**I have not edited the code comment** — `server/**` is outside my claim, and a
comment fix should accompany a decision on §5, not precede it. Raised as finding
F1 below.

### F1 — recommended, not done

Correct the comment in `server/auth.ts` to state that `drive.appdata` is
non-sensitive, and give the real reason for separating Drive connect from
sign-in (onboarding simplicity, not a restricted-scope interstitial). One file,
one comment, plus a test asserting the documented scope list if one does not
already exist.

## 5. Storage decision — presented neutrally

Three real options. **No implementation change is proposed or made here.**

| | **A. Hidden `appDataFolder`** (current) | **B. Visible user folder** | **C. Hidden + user-controlled export** |
| --- | --- | --- | --- |
| **Google scope** | `drive.appdata` — **non-sensitive** | `drive.file` — non-sensitive, or `drive` — **restricted** | `drive.appdata` + a second user-initiated export step |
| **Verification burden** | Basic OAuth verification | `drive.file`: basic. Full `drive`: restricted-scope verification + possible security assessment | Basic, plus export UX |
| **Permission surface** | Smallest. Only the app's own config data | `drive.file` is per-file (user picks files) — still narrow. Full `drive` sees **all** files | Same as A, opt-in extra write at export time |
| **User access** | **None.** Hidden from user and other apps; not visible in Drive UI | **Full.** User sees, edits, deletes, shares at will | **None by default**; user gets copies only when they export |
| **Backup/restore** | Automatic; survives device change **while the app stays installed**. **Deleted if the user uninstalls the app** | Automatic; survives uninstall; user can also copy it themselves | Restore depends on export existing; appData copy is the primary |
| **Migration** | None today | Requires a copy migration from appDataFolder. Google **permits** reading appDataFolder and creating files elsewhere, so migration is achievable; see §5.1 | Adds an export format + versioning to maintain |
| **Encryption** | App-controlled already (bundle is encrypted; keys/credentials excluded) | Same, but **user-visible files invite manual editing**, which can corrupt manifests | Same as A |
| **Failure mode** | User cannot inspect, back up by hand, or recover if they uninstall | User may edit/delete files and break restore; larger blast radius | Most moving parts; export staleness risk |
| **Fits "user-owned data"?** | Partly — owned but **not accessible**. Google can delete it on uninstall | **Most literally** — visible and self-serviceable | Owned, accessible on demand, at the cost of complexity |

### Recommendation: **B via `drive.file`, not full `drive`**

Evidence-based reasoning:

1. **`drive.appdata` conflicts with the product direction.** Muster is
   "user-owned data" and "privacy-first". Google's exact wording is that the
   folder "is deleted when a user uninstalls your app **from their My Drive**",
   and users can also delete it manually.

   **Precise scope of that risk — corrected.** It is *not* triggered by deleting
   the local desktop app, and *not* by reinstalling on a new machine; the folder
   lives in Drive, and reinstall is exactly what it is designed to survive. It
   **is** triggered when a user removes Muster's Drive access from My Drive
   (connected-apps settings) or manually deletes the folder. The real hazard is
   therefore sharper than "uninstall": an **ordinary account-cleanup gesture**
   silently destroys the user's memory and sessions, and the user has never seen
   the folder to know what was in it. The exposure window is the whole time the
   app is connected, not a rare edge case.
2. **Privacy is not actually lost by moving to `drive.file`.** `drive.file` is a
   **non-sensitive** scope granting access only to files the user opens with the
   app or shares via the Picker. Google recommends it over restricted scopes
   precisely for this reason. A visible `Muster/` folder the app creates is
   covered by `drive.file` — the app does **not** need full `drive`.
   Source: <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
3. **Option B with `drive.file` keeps the narrow-permission story** while fixing
   the access-revocation data-loss and user-invisibility problems.
4. **Cost, stated honestly:** this is a real migration with real risk, and it needs
   its own gated slice with a migration path for existing appDataFolder content.
   Full proposal, with verification and rollback gates:
   `docs/plans/2026-10-03-drive-visible-folder-migration-proposal.md`.

**Option C is rejected for now** as premature: it carries option A's hidden
storage plus a second format to version, before the MVP has a single real-device
restore. Revisit if a user reports they want manual export.

**This is a recommendation, not a decision.** It is the owner's call, and it is
the highest-value decision on the board, because §3.1 means the current master
plan instructs the next agent to build something that contradicts both the code
and the privacy direction.

### 5.1 What "cannot interoperate" actually means — corrected

I previously wrote that the two locations "cannot interoperate." That conflated a
**Google API limitation** with a limitation in **our own implementation**. Only
the first is a platform fact:

- **Google API limits (not our choice):** you cannot **move** files out of
  `appDataFolder` between storage locations, and cannot trash or share files
  inside it (`notSupportedForAppDataFolderFiles`).
- **What the API allows:** **reading** every appDataFolder file normally, and
  **creating** files in an ordinary visible folder. So migration is
  technically achievable — copy, not move.
- **Our limitation (fixable):** Muster has **no code today** to write or read the
  bundle from a visible folder. The bundle is encrypted and manifest-backed with
  `SUBSET_ROOT_FILES` and a manifest digest, and restore currently discovers
  entries from the appData folder by id. A visible-folder read/write path must be
  built.

Stated accurately: *Google permits read-and-copy; Muster lacks the visible-folder
code path and would need manifest/id addressing to work in both locations during
migration.* That is build work, not a platform impossibility.

## 6. Fresh-device restore — OPEN, with a reproducible procedure

**Status: not verified. No evidence exists.** This is the one MVP success
criterion (master plan §10) with nothing behind it, and it cannot be closed by
code review.

### Preconditions

- A **real Google account** not used for development, with Drive available.
- A **fresh device or clean install**: no existing app data, no prior login.
- Production-like build of the current `main` (`3067009`) — not a dev server.
- The account under test must be a **different** account from any used in
  development, so stored grants cannot be inherited.

### Procedure

1. On device **A**, sign in. Connect Drive (the opt-in step). Confirm the
   connection succeeds and record the exact scope shown on the consent screen.
2. Create content that must survive: at least one memory, one chat session with
   a recognisable string, one task, and `soul.md` content.
3. Read back what was written: confirm the bundle manifest lists the expected
   entries and that `SUBSET_ROOT_FILES` contents are present.
4. **Confirm the negative case:** verify that credentials did **not** enter the
   backup — `auth.db`, `auth.secret` and `config.json` must be absent from the
   backup subset.
5. Uninstall Muster from device **A**, then install it on a **fresh device B**.
6. On **B**, sign in with the **same** account and reconnect Drive.
7. Trigger restore. Compare against step 3.

### Pass criteria (all must hold)

- **P1** Restore completes without manual file intervention.
- **P2** The memory, chat string and task from step 2 are present and byte-equal
  after round-trip.
- **P3** `soul.md` content is restored and actually influences assistant
  behaviour (observable response difference, not just file presence).
- **P4** No credential material was restored. Absence is verified, not assumed.
- **P5** Credentials from device **A** are **not** required for device **B** to
  function — the user re-authenticates; nothing is silently inherited.
- **P6** With Drive **not** connected, the app degrades safely and does not
  present an empty or partial state as "restored".

### Fail criteria

Any of: data present but altered; restore silently partial; credentials present
in backup; app unusable without inherited device state; a "restored" label shown
over an empty state.

### Current status

**NOT RUN.** No real Drive account and no fresh device were used. This
procedure is a proposal for whoever has that access. **Do not record this
criterion as met until a run produces evidence.**

## 7. Decisions needed from the owner

1. **Storage layout (§5)** — recommend B with `drive.file`. Highest value; the
   current plan contradicts the code and the privacy direction.
2. **Correct the `drive.appdata` classification (§4, F1)** — recommend yes; the
   current comment is wrong and will mislead future agents.
3. **"Optional local encryption"** — future roadmap §5 lists it as optional;
   accepted work treats encrypted custody as a requirement. Confirm which stands.
4. **Repository visibility** — `AGENTS.md` says private (BSL 1.1); GitHub reports
   **public**. Not changed by me.
5. **Beta gate** — 0 evidenced tester-days against a 5-tester/3-day requirement.

## 8. Method, recheck, and limits

**Rechecked at finalize time (2026-10-03, after §1–§7 were drafted):**

- `origin/main` = **`3067009`**, **unchanged** — `git log 3067009..origin/main`
  returned **no commits**. Reviewed SHA is current.
- Open PRs re-listed. Two appeared since my earlier check: **#37**
  (`agent4-charm-hardware-research`, adds
  `docs/plans/muster-charm-hardware-research.md`) and **#38**
  (`codex/agent-repository-preflight`, adds
  `docs/plans/agent-claims/2026-10-03-astra-repository-preflight.md`).
  Neither overlaps my paths. **#38 confirms `docs/plans/agent-claims/` is the
  shared claim convention**, which my claim already follows.
- Still open and untouched by me: **#32** (Cue), **#33–#36** (Dependabot).

**Evidence method:** `git cat-file -e`, `git ls-tree`, `git grep` and `git show`
against `origin/main` at `3067009`; the 15-file vitest run above; and Google's
official Drive documentation, cited inline.

**Limits:**

- The 277 tests are unit/integration, run in a dev environment. They are **not**
  real-Drive, real-device or installed-app acceptance.
- I ran the 15 pillar files, **not** the full 473-file suite. A full-suite result
  is not claimed here. The last accepted CI for the product was 13/13 at
  `53b8072`.
- No security claim is made. The project's scanner has not completed a full
  re-run.
- **Staleness:** this is a snapshot of `3067009`. If `SUBSET_ROOT_FILES` or the
  Drive scope changes, §3 and §5 are wrong. Re-verify those two constants
  before relying on this.

## 9. Communication channel — see separate note

My claim is a document on my task branch. That records my work but does **not**
establish shared ownership across agents: nothing forces another agent to read
it, and no agent has acknowledged it. A discoverable claims channel is proposed
in `docs/plans/2026-10-03-agent-claims-channel-proposal.md`.