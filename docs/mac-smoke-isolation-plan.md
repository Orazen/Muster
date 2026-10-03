# Revised macOS smoke setup — `~/Applications` isolation, and full test reconciliation

**Agent signature:** `AGENT-4 / native-Mac-release-docs-lane` · 2026-10-03
**Reviewed SHA:** `origin/main` @ `30670099582476ce31099038c852e022b5685fa9`
**Artifact:** `v1.23.3`, `Muster-1.23.3.dmg`, arm64, SHA-256 `0142fd22…`
**Status:** **PREPARED. Account NOT created — awaiting Tharun's explicit authorisation. All tests remain NOT RUN. The working installation was not touched.**

Supersedes `docs/mac-smoke-recommended-setup.md`, which proposed `/Applications` and understated the isolation argument.

---

## Part 1 — Test count reconciliation

**My earlier figure of "37 remaining tests" was wrong.** Counting the checklist from source gives the truth.

| | Count |
|---|---|
| Rows carrying a test ID | 63 |
| `B2.x` rows — these are **distribution blockers, not tests** | −8 |
| **Defined tests** | **55** |
| Already executed (`A1.1`–`A1.11`) | −11 |
| **Remaining NOT RUN** | **44** |

### Where "37" came from

| | |
|---|---|
| Old claim | 37 |
| `+ A2.1`–`A2.3` — install tests, which I tallied separately as "blocked" | +3 |
| `+ B1.1`–`B1.4` — Swift build/run tests, a different target I never counted | +4 |
| **Actual** | **44** |

So the previously "unexplained" remainder was **11, not 4**: three install tests and four Swift tests that I had silently excluded from the total.

### Every remaining test, with its environment

| # | Test | Environment required | Status |
|---|---|---|---|
| 1 | `A2.1` DMG mounts, shows drag-to-Applications layout | **Any Mac — read-only mount** | NOT RUN |
| 2 | `A2.2` Copy to a **user** Applications path | Test account, `~/Applications` | NOT RUN |
| 3 | `A2.3` Launch from mounted DMG vs installed copy | Test account | NOT RUN |
| 4–9 | `A3.1`–`A3.6` first launch + microphone / screen / accessibility / speech prompts + denial handling | **Test account — needs genuinely fresh TCC** | NOT RUN |
| 10–13 | `A4.1`–`A4.4` sign-in, wrong password, session persists, sign-out | Test account | NOT RUN |
| 14 | `A4.5` Google Sign-In unavailable on macOS today | **Documentation assertion — not a runtime test** | NOT RUN |
| 15–20 | `A5.1`–`A5.6` persistence, uninstall keeps data, reinstall preserves, reinstall restores session | Test account | NOT RUN |
| 21–24 | `A6.1`–`A6.4` update detected, applies, session survives, data survives | Test account + in-place update (modifies the install, reversible) | NOT RUN |
| 25 | `A6.7` manual DMG overwrite preserves user data | Test account | NOT RUN |
| 26–28 | `A7.1`–`A7.3` restore contract: own-account only, installation-scoped records not personal, exclusions disclosed | **Test account signed in + Google Drive — overlaps Cue/Buffy's lane** | NOT RUN |
| 29–30 | `A6.5`–`A6.6` interrupted update recovers, failed upgrade recovers | **Disposable VM — destructive** | NOT RUN |
| 31–33 | `A7.4`–`A7.6` retry after failed restore, interrupted restore preserves state, contract stable across versions | **Disposable VM — destructive** | NOT RUN |
| 34–36 | `A8.1`–`A8.3` remove app, Keychain after uninstall, reinstall first launch | Test account | NOT RUN |
| 37–40 | `A9.1`–`A9.4` token not world-readable, uninstall does not silently destroy a session, no provider-key readback, no plaintext fallback | Test account | NOT RUN |
| 41–44 | `B1.1`–`B1.4` Swift build, test, launch, sign-in lifecycle | **Any Mac with Xcode — NOT an installable release** | NOT RUN |

### Roll-up by environment

| Environment | Tests | Unblocked by |
|---|---|---|
| Any Mac, read-only, no account | **1** (`A2.1`) | authorisation only |
| Any Mac with Xcode, no account | **4** (`B1.1`–`B1.4`) | authorisation only |
| Documentation assertion | **1** (`A4.5`) | a decision, not a run |
| **Test account, non-destructive** | **25** | **account authorisation** |
| Test account + in-place update | **5** (`A6.1`–`A6.4`, `A6.7`) | account authorisation |
| Test account + Google Drive | **3** (`A7.1`–`A7.3`) | account **and** Cue/Buffy coordination |
| **Disposable VM — destructive** | **5** (`A6.5`, `A6.6`, `A7.4`–`A7.6`) | VM provisioning |
| **Total** | **44** | |

**Corrected claim:** a test account plus authorisation makes **30** of 44 executable (25 non-destructive + 5 update). Add the 5 that need only a Mac and the 1 read-only mount, and **36 of 44** need no VM. **5 remain VM-only. 3 need Drive coordination.**

---

## Part 2 — Isolation verification (this is not proven by a separate account alone)

A separate account gives a fresh Keychain and fresh TCC grants. It does **not** by itself stop the app from writing outside that account. I inspected the actual write paths at the reviewed SHA.

### What the code writes, and where

| Path | Root | Per-user? |
|---|---|---|
| `credentials.bin` — `path.join(app.getPath("userData"), "credentials.bin")` (`main.mjs:212`) | `~/Library/Application Support/…` | ✅ yes |
| `config.json` — `process.env.OMB_DATA_DIR \|\| path.join(app.getPath("home"), ".muster")` (`main.mjs:237`) | `~` | ✅ yes |
| Credential encryption | `safeStorage.encryptStringAsync` — login-Keychain backed, file mode `0o600` | ✅ yes |
| `Muster Speech.app` helper | ships inside `Contents/Resources/` (`electron-builder.yml` `extraResources`) | ✅ travels with the install |
| CUA driver / SDK | `Contents/Resources/cua-driver`, `cua-sdk` | ✅ travels with the install |
| Companion sidecar | spawned via `utilityProcess` / `fork` from Resources | ✅ travels with the install |

**Verified:** a whole-file search for write calls targeting an absolute root path (`writeFileSync|writeFile|mkdirSync|mkdir|createWriteStream` with a `'/…'` literal) returns **no matches**. Every write is rooted at `app.getPath("userData")` or `app.getPath("home")`.

### The updater — the component that could reach outside

`electron/updater.mjs` contains **no `/Applications` reference and no absolute-path write**. Its install target derives from `process.execPath` (`:33`) — the running binary's own location.

**Consequence:** a copy installed in the test account's `~/Applications` updates **itself**. And because the account is non-admin, it **cannot write `/Applications` at all**, so it cannot replace the owning user's install even if it tried. That is the structural guarantee, not merely a convention.

### Three caveats I will not paper over

1. **A non-admin account can still *read* `/Applications/Muster.app`.** If the test account accidentally launches the owning user's copy, it would use its *own* Keychain and userData but run *different code*. **Every run must first confirm which binary is executing** (see step 5). Without that check the results are worthless, and this is the one way the isolation can silently fail.
2. **`OMB_DATA_DIR` overrides the data root.** If that variable is set in the environment, `~/.muster` is bypassed. Step 3 checks it is unset.
3. **Verification is static.** I read the code paths; I did not trace them at runtime. Runtime confirmation is exactly what the tests are for.

### Why `~/Applications` and not `/Applications`

A non-admin user cannot write `/Applications`, so `~/Applications` is the only location that works without elevating — and elevating is exactly what would weaken isolation, because an admin session can reach the owning user's data. **Least privilege and strongest isolation coincide here**, which is why this is the recommended setup.

---

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