# Revised macOS smoke setup — `~/Applications` isolation, and full test reconciliation

**Agent signature:** `AGENT-4 / native-Mac-release-docs-lane` · 2026-10-03
**Reviewed SHA:** `origin/main` @ `30670099582476ce31099038c852e022b5685fa9`
**Artifact:** `v1.23.3`, `Muster-1.23.3.dmg`, arm64, SHA-256 `0142fd22…`
**Status:** **PREPARED. Account NOT created — awaiting Tharun's explicit authorisation. All tests remain NOT RUN. The working installation was not touched.**

Supersedes `docs/mac-smoke-recommended-setup.md`, which proposed `/Applications` and understated the isolation argument.

---

## Part 1 — Inventory: single source of truth

The authoritative inventory is the per-test table in `docs/mac-smoke-checklist.md`
(**PR #42**), where every total is derived from the rows rather than asserted. That table lists,
for each test ID, its target, required environment, execution status and blocker.

**The figures previously stated in this document were wrong and are withdrawn:**

| Withdrawn claim | Problem | Corrected |
|---|---|---|
| "37 remaining tests" | Excluded the three install tests (`A2.1`–`A2.3`) and the four `B1` Swift rows | Derived NOT RUN count is **44** |
| "44" | The category buckets summed to 43 | Buckets now sum to 44 |
| "36 need no VM" + 5 VM-only = 41 | Does not total the stated 44 | **39 need no VM** + **5 VM-only** = 44 |

### Environment roll-up — derived from the per-test rows

| Environment required | NOT RUN tests |
|---|---|
| Any Mac, read-only mount, no account (`A2.1`) | 1 |
| Any Mac with Xcode, no account (`B1`) | 4 |
| Disposable macOS user, non-destructive | 27 |
| Disposable macOS user + explicit old→new artifacts | 4 |
| Disposable macOS user + isolated Drive backend | 3 |
| **Disposable VM — UNAUTHORISED** | **5** |
| **NOT RUN total** | **44** |

A disposable macOS account makes **36** of the 44 executable (1 + 4 + 27 + 4 require only an
account or no account; the 3 Drive tests additionally need a named backend and an assigned
executor). **5 remain VM-only. 3 need Drive coordination.**

**None of these have been run. Account creation and VM provisioning are both unauthorised.**

## Part 2 — Isolation: SOURCE-REVIEWED, NOT PROVEN

> **Status of this section.** Everything below is a **source review at a fixed SHA**. It is *not* a
> proof of isolation. I read the code; I did not execute the app, observe a filesystem, or watch an
> updater run. Three of my earlier phrasings here overstated what a source review can establish, and
> are corrected below. Isolation must be **observed at runtime** in the authorised environment before
> any test result is trusted.

### What the source review actually found

| Path | Root as written | Per-user by construction? |
|---|---|---|
| `credentials.bin` — `path.join(app.getPath("userData"), "credentials.bin")` (`electron/main.mjs:212`) | `app.getPath("userData")` | yes |
| `config.json` — `process.env.OMB_DATA_DIR \|\| path.join(app.getPath("home"), ".muster")` | home, unless the env var is set | yes, unless overridden |
| Credential encryption | `safeStorage.encryptStringAsync`, file mode `0o600` | yes (login-Keychain backed) |
| `Muster Speech.app`, CUA driver/SDK, companion sidecar | shipped in `Contents/Resources/` via `extraResources` | travels with the install |

A whole-file search of `electron/main.mjs` for write calls taking an absolute root-path literal
(`writeFileSync|writeFile|mkdirSync|mkdir|createWriteStream` with a `'/…'` argument) returns no
matches.

### Correction 1 — a negative search is not a behavioural guarantee

I previously wrote that "no `/Applications` literal exists, therefore the updater cannot touch the
owning user's install". That inference does not hold. **The absence of a string in the source says
something about the source, not about runtime behaviour.** The updater's target is chosen by
electron-updater and Squirrel.Mac at run time, not by a literal in our code. Recorded as
"source-reviewed, unverified".

### Correction 2 — the updater has an explicit macOS path I had not read

`electron/updater.mjs` defines `macUpdatesTrusted()`: on `darwin` it looks for a marker resource at
`Contents/Resources/trusted-mac-updates`, and only then permits Squirrel.Mac's **in-place swap**.
Ad-hoc builds fail or hang on apply, so the renderer falls back to a direct download
(`src/components/UpdateBanner.tsx`).

So the macOS update mechanism is: *marker present → in-place swap of the bundle at the running
binary's directory; marker absent → direct download.* **For the signed v1.23.3 release the marker is
expected to be present**, which makes the in-place swap the live path and therefore the thing most
worth observing. I had asserted the target from `process.execPath` without reading this gate.

Related, and flagged rather than resolved: the comment above that function states Muster's builds are
"only ad-hoc signed (no paid Apple Developer certificate)". The **released** `v1.23.3` artifact I
verified in A1 is Developer ID signed (`THARUN RAMAGIRI (7375K23WFU)`) and notarized. That comment
appears stale relative to the release; I am not asserting which is correct for current `main` builds,
only that the two disagree and a reader would be misled.

### Correction 3 — a privilege-escalation helper exists in the vendored updater

`electron/vendor/electron-updater.cjs` contains `runCommandWithSudoIfNeeded` and the strings
`"Running as root, no need to use sudo"` / `"Running as non-root user, using sudo to install"`. My
earlier statement that there was no privilege surface was based on searching our own source and
missing vendored code.

Precisely what I did and did not establish:

- The helper is defined in the **shared base class `_AppUpdater`** (single call site), not in a
  platform-specific file.
- The `_MacUpdater` class body contains **no** `sudo` reference.
- **I have not traced whether any macOS code path reaches the base-class helper.** I am not claiming
  it is unreachable, and I am not claiming it is reachable.

### No privileged helper in our own source — also only a source-level negative

Searched `electron/`, `macos/`, `scripts/`, `electron-builder.yml` for `SMJobBless`, `SMAppService`,
`AuthorizationExecuteWithPrivileges`, `AuthorizationCreate`, `SMLoginItemSetEnabled`, `launchd`,
`LaunchDaemon`, `LaunchAgent`, `mach_service`, `SMPrivilegeExecutables`, `setuid`: **no matches.**
(`XPC` matched only as a substring of `reRegExpChar` in vendored code — a false positive.)

This is evidence about *our* repository. It is not evidence about the **installed** bundle, which may
carry entitlements or helper binaries the source does not show.

### Runtime verification required — none of this is established yet

Run in the authorised environment, before trusting any result:

| # | Verify | Why source review cannot answer it |
|---|---|---|
| V1 | **The running binary is the test copy.** Record `ps` path / About screen for the running process. | A non-admin account can still *read* `/Applications/Muster.app`. If it launched that copy it would use its own Keychain and userData but different code — silent, total invalidation of every result. **This is the single most important check.** |
| V2 | `~/Applications` is writable; `/Applications` is **not** writable by the test user. Attempt the write and record the denial. | Filesystem permissions are an OS/runtime fact I never tested. My "cannot write `/Applications` at all" was an assumption. |
| V3 | Does `Contents/Resources/trusted-mac-updates` exist in the installed copy? | Determines whether the in-place swap or the direct-download fallback runs. |
| V4 | Perform a real update and record where the new bundle lands. | The actual install target is chosen by Squirrel.Mac at run time. |
| V5 | **Watch for any sudo/authorization prompt during install, update, helper launch and uninstall.** | The vendored sudo helper's reachability from the macOS path is unresolved. |
| V6 | Inspect the *installed* bundle for privilege surface: `codesign -d --entitlements -`, `ls -l` for setuid bits, `launchctl list` for installed jobs. | Source-level absence does not describe the installed artifact. |
| V7 | Confirm `OMB_DATA_DIR` is unset before launch. | If set, the data root bypasses `~/.muster` entirely. |
| V8 | Confirm no helper (`Muster Speech.app`) writes outside `~/`. | Helper is in-bundle, but its runtime behaviour is unobserved. |

Until V1–V8 are recorded, the correct statement is: *isolation is designed for and consistent with
the source, and is unproven.*

### Why `~/Applications` regardless

A non-admin user is expected to be unable to write `/Applications`, so `~/Applications` is the only
location that works without elevating — and elevating is what would weaken isolation, since an admin
session can reach the owning user's data. Least privilege and strongest isolation coincide. **V2
confirms the premise; it is not assumed.**

## Part 3 — Exact plan

### Step 0 — Prepare artifacts (no privileges)

```sh
mkdir -p ~/muster-smoke-artifacts && cd ~/muster-smoke-artifacts
gh release download v1.23.3 --repo Orazen/Muster --pattern Muster-1.23.3.dmg --dir .
gh release download v1.23.3 --repo Orazen/Muster --pattern SHA256SUMS-macos-arm64.txt --dir .
shasum -a 256 Muster-1.23.3.dmg
```

**Download: 177 MB.** Verify against `SHA256SUMS-macos-arm64.txt` before use. Space needed < 1 GB.

### Step 1 — Account creation — **AWAITING THARUN'S AUTHORISATION**

The account is **not** created. When authorised, the creation step needs one administrator action and **no password appears in any command, log, or repository file**:

1. **Choose the account name in the thread, not on a command line** — proposed `muster-smoke`.
2. Administrator creates the local account with their system tool of choice (System Settings ▸ Users & Sharing, or `sysadminctl`), **entering the password interactively in the GUI prompt**.
3. **The account is standard/non-admin.** Do not grant administrator rights — an admin session can read the owning user's data and would defeat the isolation this plan exists to provide.
4. **The password is never written down, never passed as an argument, and never committed.** It exists only in the operator's password manager. If the account needs to be re-created, generate a new one.
5. Record in the coordination thread **only**: the account name, that it was created, its privilege level, and the date. **No password, ever.**

Commands deliberately omitted: any `dscl`/`useradd` form taking a password argument, and anything that would place a secret in shell history.

### Step 2 — First login

Log in to the GUI as the test account **once** so its login Keychain, TCC store and home directory are initialised. Decline iCloud, do not migrate anything, do not sign in to any account.

### Step 3 — Verify the environment is clean

As the test account:

```sh
echo "OMB_DATA_DIR=[${OMB_DATA_DIR:-unset}]"     # must be unset, or data root is redirected
mkdir -p ~/Applications
echo "HOME=$HOME"; whoami; sw_vers; uname -m
```

### Step 4 — Install into `~/Applications`

As the test account:

```sh
hdiutil attach ~/muster-smoke-artifacts/Muster-1.23.3.dmg -nobrowse -readonly
mkdir -p ~/Applications
ditto /Volumes/Muster/Muster.app ~/Applications/Muster.app
hdiutil detach /Volumes/Muster
codesign --verify --deep --strict ~/Applications/Muster.app && echo "signature ok"
```

**No `/Applications` write occurs, and none is attempted.**

### Step 5 — Confirm the right binary before any test

```sh
ls -l ~/Applications/Muster.app/Contents/MacOS/Muster
# in the app's About / process listing, confirm the running path is under ~/Applications
```

**If this shows anything under `/Applications`, stop.** Every result would otherwise describe the owning user's install.

### Step 6 — Run the checklist

Work `docs/mac-smoke-checklist.md` §A2–§A9 in the test account, recording for each: operator, date, machine, artifact version and architecture, steps, expected, **actual**, evidence.

### Step 7 — Cleanup

As the test account:

```sh
rm -rf ~/Applications/Muster.app
rm -rf ~/Library/Application\ Support/Muster ~/.muster
```

Administrator removes the account and its home directory with their system tool, **interactively**.

Then verify the owning user's state is untouched:

```sh
ls -d /Applications/Muster.app                                   # must still exist
ls -d ~/Library/Application\ Support/Muster 2>/dev/null || echo "owning user has no app data — or it predates us"
rm -rf ~/muster-smoke-artifacts
```

## Limitations

1. **The 5 destructive tests stay blocked.** `A6.5`, `A6.6`, `A7.4`–`A7.6` must destroy state and start over; a second account cannot be destroyed repeatedly on one machine. A disposable VM with a snapshot is the correct tool and is a separate authorisation.
2. **`A6.1`–`A6.4` modify an install.** Do them on the test account's copy, never the owning user's.
3. **`A7.1`–`A7.3` need Google Drive** and overlap Cue/Buffy's fresh-device lane; coordinate rather than duplicate.
4. **Static verification only.** Write paths were read, not traced at runtime.
5. **Physical multi-window and installed-app gates stay open** until someone runs this.
6. **This does not achieve Linux's CI parity.** Linux launches the packaged app automatically; nothing here does.

## Decisions requested

1. **Tharun:** authorise the test account (Step 1)? It is one interactive administrator action, no password in any command or file.
2. **Tharun:** authorise VM provisioning for the 5 destructive tests?
3. **Cue/Buffy:** confirm who runs `A7.1`–`A7.3`, so the restore contract is asserted once.
4. **Release owner:** the owning user's `/Applications/Muster.app` was never touched by this work and must stay that way during testing.