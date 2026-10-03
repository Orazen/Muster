# Recommended isolated setup for the macOS smoke tests — ONE option

**Agent signature:** `AGENT-4 / native-Mac-release-docs-lane` · 2026-10-03
**Reviewed SHA:** `origin/main` @ `30670099582476ce31099038c852e022b5685fa9`
**Artifact under test:** `v1.23.3`, `Muster-1.23.3.dmg`, arm64
**Status:** **PREPARED. Nothing executed. All 37 tests remain NOT RUN. The working installation was not touched.**

## The single recommendation

**A separate, non-admin macOS local account (`muster-smoke`), installing from the published DMG.**

One option, not three. It is the cheapest thing that makes permission tests meaningful, and it is the only option that gives genuinely fresh TCC prompts without a VM.

### Why this and not the alternatives

| Option | Why not chosen |
|---|---|
| Run the app as the owning user | Violates the constraint directly — real Keychain and `~/Library`. |
| `HOME=<temp>` override | **Looks safe and is not.** `HOME` redirects neither the login Keychain (per-login-session) nor TCC grants (per-user, under `/Library/Application Support/com.apple.TCC`). It would write real state while appearing isolated. |
| Disposable VM | Correct for the 5 destructive tests, but the runtime image is not present and obtaining it is a download plus an install — out of scope for this authorisation. Kept as a documented follow-up, not the recommendation. |

## Exact steps

### 0. Prerequisites (no privileges needed)

```sh
mkdir -p ~/muster-smoke-artifacts && cd ~/muster-smoke-artifacts
gh release download v1.23.3 --repo Orazen/Muster --pattern Muster-1.23.3.dmg --dir .
gh release download v1.23.3 --repo Orazen/Muster --pattern SHA256SUMS-macos-arm64.txt --dir .
shasum -a 256 Muster-1.23.3.dmg        # must equal 0142fd22b84e1f3093212d9c3f5d4e6e12ec728bf5242422cc0cb04bca9f7d94
```

**Download size: 177 MB** (the DMG; the checksum manifest is 350 bytes). Free space required: **< 1 GB**; 138 GiB is free on this machine.

### 1. Create the account — **this is the only step needing privileges**

Either ask an administrator, or run once with elevation:

```sh
sudo sysadminctl -addUser muster-smoke
# then set a password interactively (never record it in the repository):
sudo passwd muster-smoke
```

**Privileges required: administrator, once, to create the account.** The account itself needs **no admin rights** — a non-admin user still receives its own Keychain, its own TCC store, and its own home directory, which is exactly the isolation this plan needs. Least privilege is deliberate: an admin test account would be able to reach the real user's data, defeating the purpose.

### 2. Initialise the account

Log in to the GUI as `muster-smoke` **once** so that its login Keychain, TCC store and `~/Library/Application Support` are created. Skip the setup screens. No network account, no iCloud, no migration assistant.

### 3. Install from the DMG

As `muster-smoke`:

```sh
hdiutil attach ~/muster-smoke-artifacts/Muster-1.23.3.dmg -nobrowse -readonly
cp /Volumes/Muster/Muster.app /Applications/     # or drag in Finder
hdiutil detach /Volumes/Muster
```

### 4. Record identity before first launch

```sh
sw_vers; uname -m
codesign --verify --deep --strict /Applications/Muster.app && echo "signature ok"
```

### 5. Run the checklist as that user

Work through `docs/mac-smoke-checklist.md` §A2–§A9 in the `muster-smoke` session. **A3 (permissions) is the reason for this account** — those prompts are genuinely first-time there, which they cannot be as the owning user.

### 6. Cleanup

```sh
# from the muster-smoke session
rm -rf ~/Library/Application\ Support/Muster ~/Library/Preferences/com.muster.app.plist
# from an admin session
sudo sysadminctl -deleteUser muster-smoke
rm -rf ~/muster-smoke-artifacts
```

Verify nothing was left behind in the owning user's state:

```sh
ls /Applications/Muster.app                                  # the ORIGINAL must still be present and untouched
shasum -a 256 ~/muster-smoke-artifacts/Muster-1.23.3.dmg 2>/dev/null || echo "artifacts removed"
```

## What this unblocks

| Tests | Count | Notes |
|---|---|---|
| A2 install · A3 permissions (all 6) · A4 login · A5 persistence · A8 uninstall/reinstall · A9 credential protection | **26** | Permission prompts are genuinely fresh — the whole point |
| A6.1–A6.4 in-place update | 4 | See limitation below; still needs authorisation |
| A6.5–A6.6 failed-upgrade recovery · A7.4–A7.6 restore compatibility | **7** | **Not unblocked.** Destructive; needs a disposable VM |

## Limitations — stated, not glossed

1. **The 7 destructive tests remain blocked.** A6.5/A6.6 (failed upgrade) and A7.4–A7.6 (restore) must be able to destroy state and start over. A second account on the same machine cannot safely do that repeatedly, because the first destructive run contaminates the machine for the next. A disposable VM with a snapshot is the correct tool; it is a documented follow-up, not part of this recommendation.
2. **A6.1–A6.4 needs its own authorisation.** It does not delete anything, but it *modifies* an installed copy. Do it on the `muster-smoke` install, never on the owning user's.
3. **This does not make macOS parity with Linux.** Linux launches the packaged app automatically in CI; nothing here does. The physical gate stays open until someone runs it.
4. **Account creation is a real system change.** It needs administrator rights, it will appear in the user list, and it must be deleted afterwards. If that is unacceptable, the VM route is the alternative and it costs a multi-GB download.
5. **The owning user's data is never touched by design, not by luck.** Nothing in these steps writes outside the `muster-smoke` home directory or `/Applications/Muster.app` — and installing to `/Applications` from a non-admin account may require the app to be copied by an admin, which is a step to confirm before starting.

## Decision requested

**Authorise the `muster-smoke` account creation (one administrator action)?** On approval: 26 of the 37 blocked tests become executable, and the 7 destructive ones remain explicitly queued for the VM.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
