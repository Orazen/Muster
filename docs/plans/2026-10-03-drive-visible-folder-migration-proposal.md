# Migration proposal — visible Drive folder via `drive.file`

Date: 2026-10-03
Author: Buffy (Freebuff lane)
Preferred direction: **visible, user-owned Drive storage** (owner-stated)
Status: **PROPOSAL. Nothing implemented. No code changed.**
Reviewed SHA: `origin/main` = `3067009`
Related: PR #39, `docs/plans/Muster_MVP_Master_Plan_RECONCILIATION_2026-10-03.md`

## Scope and hard limits

This document proposes moving Muster's Drive storage from the hidden
`appDataFolder` to a **visible user-owned folder** using the `drive.file` scope.

**Non-negotiable limits, stated up front:**

- **Existing appData backups are NEVER deleted.** Not by the migration, not by
  rollback, not by cleanup. They are the user's only copy of their memory and
  sessions until the new location is independently verified.
- Migration is **copy-then-verify**, never move-then-hope.
- Acceptance depends on **migration and recovery evidence**, not on the code
  landing.
- This is a **proposal**. No file under `server/**` is touched here.

## 1. Corrected finding — what "uninstall" actually means

My earlier wording in PR #39 said a user "who uninstalls and reinstalls Muster
can permanently lose memory and sessions." **That was imprecise and I am
correcting it**, because the imprecision points at the wrong risk.

Google's exact words:

> "The application data folder is deleted when a user uninstalls your app **from
> their My Drive**. Users can also delete your app's data folder manually."
> — <https://developers.google.com/workspace/drive/api/guides/appdata>

Precisely distinguished:

| Event | Deletes the appData folder? |
| --- | --- |
| User deletes the local Muster desktop app / clears local data | **No.** The folder lives in their Drive, not on disk. |
| User reinstalls Muster on a new machine | **No.** This is exactly the case the folder is *for*. |
| User re-authenticates the same Google account | **No.** |
| User **removes Muster's Drive access from My Drive** (Drive settings → connected apps), or "uninstalls" from My Drive | **Yes — Google deletes the folder.** |
| User manually deletes the folder, if they can find it | **Yes.** |

**So the real risk is not reinstall, and not a local uninstall.** It is that the
user, in a normal Google-account-cleanup gesture, revokes Muster's Drive access
and takes their memory and sessions with it — **without ever intending to
delete data**, and without ever having seen the folder to know what was in it.

That is the sharper version of the risk, and it is the one worth acting on: the
loss is triggered by an *ordinary* account action and is *invisible* at the
moment it happens. It also means the exposure window is the entire time the app
is connected — not a rare edge case.

## 2. Corrected finding — what "cannot interoperate" actually means

I previously wrote that "the two storage locations cannot interoperate." That
conflated a Google API limitation with a limitation in **our own code**. The
distinction matters because only one of them is a hard blocker.

**Google API limitations (not our choice):**

- You cannot **move** files out of `appDataFolder` between storage locations —
  returns `notSupportedForAppDataFolderFiles`.
- You cannot **trash** or **share** files inside it — same error family.

**What we CAN do via the API (so migration is possible):**

- **Read** every file in `appDataFolder` normally.
- **Create** new files in an ordinary user-visible folder.

Therefore: **migration is technically achievable** — download each file from
appDataFolder and write a copy into the visible folder. Nothing in Google's API
prevents it.

**The real limitation is in Muster's current implementation, and it is ours to
fix:**

- The bundle is an **encrypted, manifest-backed** structure
  (`server/workspace-bundle-v2.ts`), with `SUBSET_ROOT_FILES` as its entry set and
  a manifest digest that must match. Writing the same bytes into a new folder
  does not by itself produce a valid, restorable bundle in that folder: the code
  currently addresses appData by file id, and restore discovers entries from that
  folder. **A visible-folder path does not exist yet.**
- So the correct statement is: *"Google permits read-and-copy; Muster currently
  has no code to write or read the bundle from a visible folder, and the
  manifest/id addressing would need to work in both locations during
  migration."*

This is a **build** statement, not a platform impossibility — which is good news,
because it means the work is bounded and testable.

## 3. Target permissions — `drive.file`, never full `drive`

| | Scope | Sensitivity | Access granted |
| --- | --- | --- | --- |
| Current | `drive.appdata` | non-sensitive | Only the app's own hidden config data |
| **Proposed** | **`drive.file`** | **non-sensitive** | Only files the **user** opens with the app or shares via the Picker |
| Rejected | `drive` | **restricted** | **All** the user's Drive files |

`drive.file` is sufficient because Muster creates and owns its own folder: the
user selects/shares that folder with the app, and the app then operates only on
files within it. Full `drive` would grant access to every file the user has ever
stored and would pull Muster into restricted-scope verification.

Sources: <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>

**Consent-screen consequence:** with `drive.file` the user sees a file picker, not
an "access all your Drive" warning. That is a materially better first impression
and is part of the privacy-first case for the change.

## 4. Discovery on a fresh device

The hardest operational problem, and the one most likely to be underestimated.

A visible folder is easy to find **if the user knows to look**. On a fresh device:

1. User signs in with the same Google account.
2. App requests `drive.file`; user selects the existing `Muster` folder.
3. App must **detect** an existing bundle rather than assuming a blank install.

Required behaviour:

- **Discovery by a stable, documented marker** — a recognizable file name and a
  manifest with a version field — not by a hard-coded file id, since ids differ
  per folder and per account.
- **If the folder exists but no bundle is found:** do **not** silently create a
  new empty one. Surface "an existing Muster folder was found but no readable
  backup was found" and offer to inspect it. A silent empty state presented as
  "restored" is the failure mode that erodes trust permanently.
- **If the appData folder still has content** and the visible folder is empty,
  offer the migration (§6) rather than starting fresh.

## 5. Encrypted backup handling

Keep current behaviour; do not weaken it. The bundle stays encrypted with the
existing KDF/cipher (`scrypt` N=131072, `aes-256-gcm`), and credentials stay
**excluded** — `auth.db`, `auth.secret`, `config.json` must never enter a
migrated folder either.

**What changes:** only *where* the encrypted bundle is stored. The plaintext
never lands in Drive in either design, so moving to a visible folder does not
weaken encryption. The visible folder will contain **ciphertext plus a manifest**
— the manifest must therefore leak as little as possible (file names, sizes,
count). If the current manifest exposes meaningful plaintext names, that is a
pre-existing concern worth a separate look, not something this migration creates.

**Do not** treat "local encryption optional" (future roadmap §5) as licence to
skip this. Accepted work treats encrypted custody as a requirement, and moving
user data into a place the user can see and share makes encryption *more*
important, not less.

## 6. Migration — copy-then-verify, with recovery

**Direction: appDataFolder → visible folder. Never destructive.**

Phases, each independently restartable:

| Phase | Action | Gate to proceed |
| --- | --- | --- |
| M0 | Read and inventory every appData entry; record ids, sizes, manifest digest | Inventory complete and digest recorded |
| M1 | **Copy** (not move) every entry into the new folder | Byte-equal copies verified by hash |
| M2 | Read back from the new folder; re-derive manifest digest | Digest matches M0 |
| M3 | **Restore rehearsal** from the new folder into a scratch data dir | Restore succeeds; content matches |
| M4 | Switch the app's read path to the visible folder (appData still untouched) | Fresh-device restore passes §7 |
| M5 | Only after M4 evidence: leave appData in place, **read-only, never deleted** | — |

**Interrupted-migration recovery.** Each phase is idempotent and keyed on the
manifest digest, so a migration interrupted at any point resumes from the last
verified phase rather than restarting. Writes go to temp names and are renamed
only after verification, so a crash mid-write cannot leave a half-written entry
that looks complete. The user is never shown a partially-migrated state as
finished; the UI shows which phase completed.

**Rollback.** Rollback is **switching the read path back to appDataFolder**,
because appData is never modified. Rollback is therefore cheap, fast, and
lossless by construction — which is the main reason the migration must be
copy-only. If any verification gate fails, stop at that phase and stay on
appData; do not attempt a partial forward fix.

**Never delete.** If the user later wants appData removed, that is a separate,
explicit, user-initiated action with its own confirmation — never a cleanup step
in this migration.

## 7. Migration verification — evidence required

Acceptance is **evidence-based**. All of the following must be produced and
recorded before this is called done:

- **V1** Inventory of appData entries with pre-migration manifest digest.
- **V2** Post-copy hash comparison: every entry byte-equal.
- **V3** Post-migration manifest digest equals V1.
- **V4** Restore rehearsal from the new folder succeeds and content matches.
- **V5** Credential exclusion re-verified on the migrated folder
  (`auth.db`, `auth.secret`, `config.json` absent).
- **V6** **Fresh-device, real Drive** restore using the visible folder — this is
  the criterion that is currently OPEN in the reconciliation §6, and it must be
  run for real, not simulated.
- **V7** Rollback rehearsal: switch back to appData, confirm the original data is
  still intact and readable.
- **V8** Interrupted-migration test: kill the process mid-migration, restart,
  confirm it resumes from the last verified phase with no corrupt state.

**Until V6 and V7 exist with real-account evidence, this migration is not
accepted**, regardless of how many unit tests pass.

## 8. Blockers before implementation

1. **Owner decision** on the direction (stated preference: visible/user-owned —
   this proposal assumes it, and changes if it does not).
2. **A separate claim** for the implementation. This PR #39 is documentation
   only and must not absorb `server/**` changes.
3. **OAuth consent-screen configuration** must be updated to declare
   `drive.file` — scopes in code and in the Cloud console must match, or users
   see an unverified-app screen
   (<https://support.google.com/cloud/answer/7454865>).
4. **No visible-folder read/write path exists in Muster today** (§2). This is
   the bulk of the build.
5. **Fresh-device + real-Drive access** for V6. Without it, the migration cannot
   be accepted, only tested.

## 9. Explicit non-claims

- Not implemented. Not tested. No code changed.
- Not a security review; no security claim is made.
- No claim that migration is safe — §7 lists what must be proven first.
- No claim about existing users' data beyond: **it is untouched by this
  proposal.**
- Fresh-device restore remains **OPEN** and unevidenced.