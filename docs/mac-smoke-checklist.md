# macOS clean-install and upgrade smoke checklist

Date: 2026-10-03 · Author: Agent 4 (native Mac) · Status: **partially executed**
Companion to [`docs/mac-release.md`](./mac-release.md) — that document covers *how a release is built*; this one covers *how a received artifact is checked*.

## Why this is a separate document

`mac-release.md` is a build-and-publish runbook read by whoever cuts a release. This is an **execution record with results** read by whoever receives an artifact. They change at different times and have different owners, so they are kept apart and cross-linked rather than merged.

## Two targets, and they are not the same thing

| | **Target A — Shipped Electron installer** | **Target B — Swift development app** |
|---|---|---|
| What it is | The artifact a user downloads from a GitHub release | The `macos/` Swift package in this repository |
| Status | **Installable and released** | **NOT an installable release** |
| How it is obtained | DMG or ZIP from a tagged release | `swift build` / `swift run` from source |
| What is tested here | install, launch, permissions, login, persistence, upgrade, uninstall/reinstall, recovery | build and run checks only |
| Distribution blockers | see §A0 | see §B2 — it has **no** `.app`, **no** `Info.plist`, **no** entitlements, **no** signing, **no** notarization |

**Target B is not described as an installable release anywhere in this document.** It is a developer and CI target. Treating it as a product would be a category error.

## Evidence convention

| Marker | Meaning |
|---|---|
| **[RUN]** | I executed this on this machine and recorded the real result |
| **[NOT RUN]** | A defined test that has **not** been executed. No result is claimed |
| **[BLOCKER]** | A known obstacle that must be resolved before the test can run |

**Host used for the executed checks:** Apple silicon (`arm64`), macOS 26.5 (25F71). Artifact examined: `v1.23.3`.

**Safety constraints observed.** Nothing was installed. `/Applications/Muster.app` (the user's working app) was **not** opened, moved, replaced or inspected. No user data was read or written. No hardware was purchased. Nothing was published. The artifact was downloaded to a temporary directory, extracted with `ditto`, inspected statically, and no application code was executed.

---

# Target A — Shipped Electron installer

## A0. Artifact under test

| Field | Value |
|---|---|
| Release | `v1.23.3`, published 2026-09-30 |
| Artifacts examined | `Muster-1.23.3-arm64.zip` (185,958,712 bytes) and `Muster-1.23.3.dmg` (186,187,768 bytes) |
| Architecture | `arm64` — verified, see A1.3 |
| Bundle identifier | `com.muster.app` — verified, see A1.4 |
| `CFBundleVersion` | `1.23.3` — verified |
| `LSMinimumSystemVersion` | `13.0` |
| Update channel | `provider: generic`, `https://muster.orazen.online/downloads` — verified in-bundle |

### macOS asset inventory for `v1.23.3` **[RUN]**

| Asset | Present | Note |
|---|---|---|
| `Muster-1.23.3.dmg` | ✅ | `dmg.artifactName` has **no** arch placeholder |
| `Muster.dmg` | ✅ | stable-named copy; **identical SHA-256** to the versioned DMG |
| `Muster-1.23.3-arm64.zip` + `.blockmap` | ✅ | auto-update channel (`path:` in `latest-mac.yml`) |
| `Muster-1.23.3-x64.zip` + `.blockmap` | ✅ | |
| `Muster-1.23.3-intel.dmg` / `Muster-intel.dmg` | ✅ | x64 DMG, renamed to avoid colliding with the arm64 name |
| `SHA256SUMS-macos-arm64.txt` / `-x64.txt` | ✅ | |
| arm64-suffixed `.dmg` | ❌ | **By design, not a defect** — the DMG name carries no arch |

> **Correction I made to myself:** I first read the absence of `Muster-1.23.3-arm64.dmg` as a missing arm64 installer. It is not. `dmg.artifactName: Muster-${version}.dmg` omits the arch, so the arm64 DMG ships as `Muster-1.23.3.dmg` / `Muster.dmg`, and the published arm64 checksum manifest lists both with the same digest. Recorded here because the wrong reading would have produced a false release defect.

---

## A1. Artifact integrity and signature — **[RUN]**

These are static checks on the extracted bundle. No install, no launch.

| # | Test | Prerequisite | Expected | **Actual** | Evidence |
|---|---|---|---|---|---|
| A1.1 | SHA-256 of the arm64 ZIP vs published manifest | Download `SHA256SUMS-macos-arm64.txt` + the ZIP | Digests match | ✅ **PASS** — `bf7aae61…a3690` both sides | `shasum -a 256` vs manifest line |
| A1.2 | `sha512` of the ZIP vs `latest-mac.yml` | Download the feed | Feed digest matches the shipped bytes | ✅ **PASS** — base64 digest identical. **This proves artifact integrity only. Whether the updater would actually apply the delta is NOT RUN (see A6.1).** | `openssl dgst -sha512` vs feed |
| A1.3 | Architecture of the shipped binary | Extracted bundle | `arm64` on Apple silicon | ✅ **PASS** — `lipo -archs` → `arm64` | `lipo -archs Muster.app/Contents/MacOS/Muster` |
| A1.4 | Bundle identity | Extracted bundle | Matches `appId` in `electron-builder.yml` | ✅ **PASS** — `com.muster.app`; `Format=app bundle with Mach-O thin (arm64)` | `codesign -dv`, `PlistBuddy` |
| A1.5 | Code signature valid before trust | Extracted bundle | `codesign --verify --deep --strict` exits 0 | ✅ **PASS** — **exit 0** | recorded |
| A1.6 | Signature chains to a Developer ID | Extracted bundle | Developer ID → Developer ID CA → Apple Root CA | ✅ **PASS** — `Developer ID Application: THARUN RAMAGIRI (7375K23WFU)`, `TeamIdentifier=7375K23WFU` | `codesign -dv --verbose=2` |
| A1.7 | Gatekeeper accepts the app | Extracted bundle | `spctl --assess --type exec` accepts | ✅ **PASS** — **exit 0**, `source=Notarized Developer ID` | recorded |
| A1.8 | Stapled ticket on the **ZIP-delivered app** | Extracted bundle | Ticket stapled | ❌ **NOT STAPLED** — `xcrun stapler validate` **exit 65** | recorded |
| A1.8b | Stapled ticket on the **DMG file** | Download `Muster-1.23.3.dmg` | `stapler validate` on the DMG succeeds | ✅ **PASS — exit 0**, *"The validate action worked!"*; `spctl -a -t open --context context:primary-signature` → `accepted`, `source=Notarized Developer ID` | recorded |
| A1.9 | Hardened runtime / entitlements | Extracted bundle | Matches `hardenedRuntime: true` | ⚠️ **OBSERVED** — entitlements include `allow-jyld-environment-variables`, `allow-unsigned-executable-memory`, **`disable-library-validation`**, `device.audio-input` | `codesign -d --entitlements -` |
| A1.10 | Privacy usage strings shipped | Extracted bundle | All four declared strings present | ✅ **PASS** — microphone, speech recognition, accessibility, screen capture all present with real text | `PlistBuddy` |
| A1.11 | Update channel wired in-bundle | Extracted bundle | Generic provider, tokenless mirror | ✅ **PASS** — `provider: generic`, `url: https://muster.orazen.online/downloads`, `updaterCacheDirName: muster-updater` | `Contents/Resources/app-update.yml` |

### A1 findings

1. **A1.8 / A1.8b — now verified rather than asserted.** In revision 1 of this document I wrote that "the DMG is the stapled path" **without having tested it**. I have now tested it.

   - **DMG channel is stapled.** `xcrun stapler validate Muster-1.23.3.dmg` → **exit 0, "The validate action worked!"** ✅
   - **ZIP channel is not.** The app extracted from the ZIP → `stapler validate` **exit 65** ❌

   This matches the documented scope limit in `release.yml`: the ZIP is never modified after electron-builder writes `latest-mac.yml`, because restapling into the ZIP would invalidate the feed hash and strand every installed Mac. The stapled artifact is the DMG.

   **Methodology correction worth recording:** my first DMG test validated the **app inside** the mounted DMG and reported exit 65 — which would have been a *false* finding. The correct check for a stapled disk image is `stapler validate` on the **DMG file**, because the ticket is attached to the container. Anyone re-running this should validate the image, not the mounted bundle.

   **Consequence for a tester:** installing from the ZIP may require a Gatekeeper network round trip; installing from the DMG does not. This is a packaging characteristic, **not** a defect.
2. **A1.9 is an observation for the security reviewer, not a verdict from me.** `disable-library-validation` and `allow-unsigned-executable-memory` are hardening relaxations. They are common in Electron apps (JIT needs `allow-jit`), but `disable-library-validation` in particular widens what can be loaded. **Flagged to Agent 5; I am not calling this a defect and I am not claiming it is safe.**

---

## A2. Installation — **[NOT RUN]**

> Requires installing to a location that is not the user's working app.

| # | Test | Prerequisite | Expected | Actual | Evidence |
|---|---|---|---|---|---|
| A2.1 | DMG mounts and shows drag-to-Applications layout | Mount `Muster-1.23.3.dmg` | `Muster.app` + `/Applications` link, per `dmg.contents` | *NOT RUN* | — |
| A2.2 | Copy to a **test** Applications path | Isolated test profile | App copies without error | *NOT RUN* | — |
| A2.3 | Launch from the DMG vs from `/Applications` | — | Same behaviour; no first-run difference | *NOT RUN* | — |

**[BLOCKER] A2.2** — I will not install over or alongside the user's working app without explicit authorisation. A safe route is a separate macOS user account or a disposable VM.

## A3. First launch and permissions — **[NOT RUN]**

| # | Test | Expected | Actual | Evidence |
|---|---|---|---|---|
| A3.1 | First launch completes without a Gatekeeper block | App opens | *NOT RUN* | — |
| A3.2 | Microphone permission prompt appears and is honoured | Prompt on first dictation; denial degrades gracefully | *NOT RUN* | — |
| A3.3 | Screen Recording prompt appears and is honoured | Prompt on first bot screen access | *NOT RUN* | — |
| A3.4 | Accessibility prompt appears and is honoured | Prompt on first bot control | *NOT RUN* | — |
| A3.5 | Speech recognition prompt | Prompt if the on-device path is used | *NOT RUN* | — |
| A3.6 | Denial of each permission does not crash or wedge the app | App stays usable | *NOT RUN* | — |

**[NOT RUN]** All of A3. These are the prompts declared in A1.10; the strings being present does not prove the prompts behave.

## A4. Login — **[NOT RUN]**

| # | Test | Expected | Actual | Evidence |
|---|---|---|---|---|
| A4.1 | Email + password sign-in succeeds against production | Session established | *NOT RUN* | — |
| A4.2 | Wrong password shows an error and does not establish a session | Error surfaced | *NOT RUN* | — |
| A4.3 | Session persists across an app restart | Session restored without re-login | *NOT RUN* | — |
| A4.4 | Sign-out clears the session | Signed out; next launch shows sign-in | *NOT RUN* | — |
| A4.5 | **Google Sign-In is unavailable on macOS today** | Documented, not tested | See §A7 | — |

> **A4.5 is a known product gap, recorded so it is not mistaken for a smoke failure.** The native Swift Mac path has no OAuth callback seam at all, and the Electron desktop path's Google/OTP support is a separate open item. A tester should not expect Google sign-in to work on macOS v1.23.3.

## A5. Persistence and user-data preservation — **[NOT RUN]**

| # | Test | Expected | Actual | Evidence |
|---|---|---|---|---|
| A5.1 | Session credential survives quit/relaunch | Reopens signed in | *NOT RUN* | — |
| A5.2 | Conversation history survives restart | History intact | *NOT RUN* | — |
| A5.3 | Settings survive restart | Settings intact | *NOT RUN* | — |
| A5.4 | **Uninstall does not delete user data** | Removing the app leaves recoverable data | *NOT RUN* | — |
| A5.5 | Reinstall over an existing install preserves data | No data loss | *NOT RUN* | — |
| A5.6 | Uninstall then reinstall restores the previous session | Session recovered | *NOT RUN* | — |

**A5.4–A5.6 are the highest-value uninstalled tests in this document** and the ones most likely to be skipped. Deleting an app and losing a user's history is the most common release regression on this platform.

## A6. Upgrade, failed-upgrade recovery — **[NOT RUN]**

| # | Test | Expected | Actual | Evidence |
|---|---|---|---|---|
| A6.1 | Auto-update detects `latest-mac.yml` | Update offered | *NOT RUN* | — |
| A6.2 | Update applies and relaunches | New version running | *NOT RUN* | — |
| A6.3 | Session survives the update | Still signed in | *NOT RUN* | — |
| A6.4 | User data survives the update | History/settings intact | *NOT RUN* | — |
| A6.5 | Interrupted update leaves the app recoverable | App still launches or offers repair | *NOT RUN* | — |
| A6.6 | **Failed upgrade recovers** | Prior version still usable; no data loss | *NOT RUN* | — |
| A6.7 | Manual DMG overwrite preserves user data | No data loss | *NOT RUN* | — |

**[NOT RUN] A6.6 is the critical one.** An updater that half-applies and leaves a broken app with a Keychain entry is the worst realistic outcome of this pipeline. Nothing in `release.yml` covers recovery from an interrupted update, and §9 of `mac-release.md` records that **no rollback procedure exists**.

**Only two real versions exist to test with** (`v1.23.2` and `v1.23.3`, published ~6 hours apart on 2026-09-30). A2→A1 upgrade testing is therefore feasible today without any new release. **[NOT RUN]** — not executed.

## A7. Compatibility with the current backup/restore contract — **[NOT RUN]**

The macOS client must not contradict the server-side restore contract. These are the contract facts a tester must hold in mind, read from `main` @ `3067009`.

**[VERIFIED] `server/restore-catalog.ts`** states, in its own header:
- the catalog is **account-scoped** and read-only, and **will not answer for an account other than the one it was handed**;
- **only `google-account` records are catalogued**, because the installation Drive record, the Telegram record and on-disk files belong to the *installation*, not a person — listing them per-account would misstate ownership;
- **credential and grant exclusions are visible up front**, not hidden inside a sealed payload.

**[VERIFIED] `server/restore-apply-wedge.test.ts`** documents a failure mode already found and fixed: the backup directory was named from a stamp derived from `pending.createdAt`, byte-identical on every boot, so **one attempt that died after creating the directory left every later boot hitting the same refusal forever**. The property must be tested **across attempts**, not within one.

| # | Test | Expected against the contract | Actual | Evidence |
|---|---|---|---|---|
| A7.1 | A user sees only their own account's restorable records | No cross-account listing | *NOT RUN* | — |
| A7.2 | Installation-scoped records are not presented as personal | Matches `restore-catalog` scope | *NOT RUN* | — |
| A7.3 | Excluded credential/grant items are disclosed, not silently dropped | Visible before decrypt | *NOT RUN* | — |
| A7.4 | **A restore that fails once can be retried** | Second attempt is not wedged | *NOT RUN* | — |
| A7.5 | Interrupted restore does not destroy the current state | Pre-restore state intact | *NOT RUN* | — |
| A7.6 | Upgrading the app does not change what is restorable | Contract stable across versions | *NOT RUN* | — |

## A8. Uninstall / reinstall — **[NOT RUN]**

| # | Test | Expected | Actual | Evidence |
|---|---|---|---|---|
| A8.1 | Remove `Muster.app` | App gone; data retained | *NOT RUN* | — |
| A8.2 | Keychain entries after uninstall | Documented behaviour — see A9 | *NOT RUN* | — |
| A8.3 | Reinstall and first launch | Clean state or recovered state, per A5.6 | *NOT RUN* | — |

## A9. Credential protection — **[NOT RUN]**

| # | Test | Expected | Actual | Evidence |
|---|---|---|---|---|
| A9.1 | Session token is not stored in a world-readable file | Keychain or protected store only | *NOT RUN* | — |
| A9.2 | Uninstalling does **not** silently destroy a recoverable session | Either documented retention or documented loss | *NOT RUN* | — |
| A9.3 | No provider key is readable from the UI | BYOK keys never returned to the renderer | *NOT RUN* | — |
| A9.4 | No plaintext fallback for provider secrets | Refusal, not degradation | *NOT RUN* | — |

**A9.3 and A9.4 mirror an accepted server-side invariant** ("no provider-key readback to renderer, plaintext fallback or any-error hosted fallback"). The macOS client must not reintroduce it. **[NOT RUN]** — unverified on macOS.

---

# Target B — Swift development app (build/run only)

## B1. Build and run checks — **[NOT RUN]** in this session

This package **is** built and tested in CI — `ci.yml` job `macos-tests` on `macos-15` runs `swift build --package-path macos` and `swift test --package-path macos`. **[VERIFIED]**

| # | Test | Prerequisite | Expected | Actual | Evidence |
|---|---|---|---|---|---|
| B1.1 | `swift build --package-path macos` | Xcode toolchain | Exit 0 | *NOT RUN* | CI does this |
| B1.2 | `swift test --package-path macos` | — | Exit 0 | *NOT RUN* | CI does this |
| B1.3 | Launch the Swift app for manual inspection | Built binary | Window appears, sign-in renders | *NOT RUN* | — |
| B1.4 | Sign-in lifecycle behaves in the running app | — | Matches K1a/K1d intent | *NOT RUN* | — |

**[NOT RUN] all of B1.** This session executed no Swift build or test. The numbers above are CI's responsibility, not mine.

## B2. Distribution blockers — explicit

**The Swift development app cannot be distributed.** This is stated so it is never mistaken for a slow release rather than a blocked one.

| # | Blocker | Evidence |
|---|---|---|
| B2.1 | **No `.app` bundle assembly** | No packaging job exists in any workflow; `release.yml`'s `macos` job builds the **Electron** app **[VERIFIED]** |
| B2.2 | **No `Info.plist`** | No `Info.plist` under `macos/` on `main` **[VERIFIED]** |
| B2.3 | **No entitlements** | No `.entitlements` for the Swift app; only `ios/**` and `electron/resources/speech-helper-Info.plist` exist **[VERIFIED]** |
| B2.4 | **No privacy usage strings** | Follows from B2.2 — no declared microphone/screen/accessibility strings **[VERIFIED]** |
| B2.5 | **No code signing** | No signing step for this target **[VERIFIED]** |
| B2.6 | **No notarization** | Not submitted, not stapled **[VERIFIED]** |
| B2.7 | **No icon** | No `.icns` for it; `mac.icon` points at `build/icon.icns`, which belongs to the Electron app **[VERIFIED]** |
| B2.8 | **No updater channel** | No `app-update.yml` equivalent **[VERIFIED]** |

**Consequence:** the Swift app is a developer and CI target only. Until B2.1–B2.8 are addressed it must not be described as installable, shippable, or part of a release, and none of Target A's tests apply to it.

---

---

# Reproducible artifact-check receipt

Every **[RUN]** result above is reproducible from a clean machine. These are the exact commands, the artifact they were run against, and what was observed.

## Environment

| Field | Value |
|---|---|
| Host architecture | `arm64` (Apple silicon) |
| macOS | 26.5 (build 25F71) |
| Release under test | `v1.23.3`, published 2026-09-30 |
| Working directory | a temporary directory, since removed |

## Reproduce

```sh
D=$(mktemp -d)
gh release download v1.23.3 --repo Orazen/Muster --pattern Muster-1.23.3-arm64.zip --dir "$D"
gh release download v1.23.3 --repo Orazen/Muster --pattern SHA256SUMS-macos-arm64.txt --dir "$D"
gh release download v1.23.3 --repo Orazen/Muster --pattern latest-mac.yml --dir "$D"
gh release download v1.23.3 --repo Orazen/Muster --pattern Muster-1.23.3.dmg --dir "$D"

# A1.1  SHA-256 vs published manifest
shasum -a 256 "$D/Muster-1.23.3-arm64.zip"
grep 'arm64.zip$' "$D/SHA256SUMS-macos-arm64.txt"
# observed: bf7aae611506197c042aae6dc11b36cc4b95f5b839c908b6dc465cdce53a3690  (both sides)

# A1.2  sha512 vs the shipped auto-update feed  (integrity only, not update behaviour)
openssl dgst -sha512 -binary "$D/Muster-1.23.3-arm64.zip" | openssl base64 -A
grep -A2 'arm64.zip' "$D/latest-mac.yml" | grep sha512 | head -1
# observed: YnMvSg5xx1LFcIP/1nZNt29VAYnDZm4BtVN3fqG71mCOr7Yb/foaQdYOOY8rIxM5ljdxPMwnqdQ7CDVf4AOPoA==  (both sides)

# A1.3-A1.7, A1.10, A1.11  extract and verify statically (nothing installed, nothing launched)
ditto -x -k "$D/Muster-1.23.3-arm64.zip" "$D/extract"
APP="$D/extract/Muster.app"
lipo -archs "$APP/Contents/MacOS/Muster"                       # arm64
codesign --verify --deep --strict "$APP"; echo $?               # 0
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E 'Identifier|Authority|TeamIdentifier'
spctl --assess --type exec -vv "$APP"; echo $?                 # 0, Notarized Developer ID
xcrun stapler validate "$APP"; echo $?                          # 65  (ZIP channel: not stapled)
for k in NSMicrophoneUsageDescription NSSpeechRecognitionUsageDescription \
         NSAccessibilityUsageDescription NSScreenCaptureUsageDescription; do
  /usr/libexec/PlistBuddy -c "Print $k" "$APP/Contents/Info.plist"
done
cat "$APP/Contents/Resources/app-update.yml"                   # provider: generic

# A1.8b  DMG channel stapling — validate the IMAGE, not the mounted app
shasum -a 256 "$D/Muster-1.23.3.dmg"                            # 0142fd22... matches manifest
xcrun stapler validate "$D/Muster-1.23.3.dmg"; echo $?          # 0, "The validate action worked!"
hdiutil attach "$D/Muster-1.23.3.dmg" -nobrowse -readonly -mountpoint "$D/mnt"
lipo -archs "$D/mnt/Muster.app/Contents/MacOS/Muster"           # arm64
spctl --assess --type exec -vv "$D/mnt/Muster.app"             # accepted, Notarized Developer ID
hdiutil detach "$D/mnt"

rm -rf "$D"
```

**Safety properties of these commands:** no `cp` into `/Applications`, no `open`, no launch, no writes outside the temporary directory, and the DMG is mounted `-readonly -nobrowse`. `/Applications/Muster.app` was never read or modified.

## Digests observed

| Artifact | SHA-256 | Source |
|---|---|---|
| `Muster-1.23.3-arm64.zip` | `bf7aae611506197c042aae6dc11b36cc4b95f5b839c908b6dc465cdce53a3690` | matches `SHA256SUMS-macos-arm64.txt` |
| `Muster-1.23.3.dmg` | `0142fd22b84e1f3093212d9c3f5d4e6e12ec728bf5242422cc0cb04bca9f7d94` | matches `SHA256SUMS-macos-arm64.txt` |
| `Muster.dmg` | published with the **same** digest as `Muster-1.23.3.dmg` | stable-named copy |

---

# Isolated testing — investigated, and why it is still blocked

The 37 behavioural tests need the app to actually **run**. Running it would touch the user's real environment, so I investigated what isolation is actually available rather than assuming.

| Option | Isolates? | Verdict |
|---|---|---|
| Run the extracted app in place | **No** | Would use the user's login Keychain and `~/Library`. **Unacceptable.** |
| Run with `HOME=<temp>` | **No** | `HOME` does not redirect the login Keychain (keychain access is per-login-session, not per-`HOME`), and TCC privacy grants are stored system-wide per user. This would **not** isolate anything that matters and would risk polluting real state. **Unacceptable.** |
| Copy to a second `/Applications` entry | Partially | Avoids replacing the existing app, but shares the user's Keychain, `~/Library/Application Support`, and TCC grants. **Still touches real user data.** |
| **Separate macOS user account** | **Yes**, largely | A fresh login gets its own Keychain and its own TCC grant set. This is the cheapest legitimate isolation. **Requires authorisation to create the account, and a password the tester knows.** |
| **Disposable macOS VM** | **Yes**, fully | Strongest isolation, and the only option that can test a genuine *first* launch — fresh TCC prompts, empty Keychain, no prior state. Heaviest: needs a macOS runtime image and hours of setup. |

**Conclusion and honest blocker.** The 37 tests stay **NOT RUN**. Nothing I can do from this session executes them safely, and I will not run the app against the user's real environment to make the checklist look complete.

**The two things that would unblock them, in order of cost:**

1. **Authorise a separate macOS user account** for testing. Unblocks install, first launch, permissions, login, persistence, uninstall/reinstall and credential tests. TCC prompts will be genuinely fresh for that account.
2. **Stand up a disposable macOS VM.** Unblocks the same set **plus** failed-upgrade recovery and cross-account data-isolation tests, because a VM can be destroyed and rebuilt between attempts — which is what a destructive restore/upgrade test actually needs.

**Partial workaround available today, with no isolation:** the **upgrade test (A6) does not require deleting or reinstalling anything.** `v1.23.2` and `v1.23.3` are both published. In-place update testing exercises the real updater against a real install — which does touch the working installation, so it still needs authorisation, but it is a single reversible step rather than a destructive test.

---

# Coordination

## With Buffy's fresh-device restore procedure

Buffy's lane covers fresh-device Drive recovery. Overlap with this checklist is narrow and worth stating precisely:

- **Shared:** A7.4 and A7.5 (a restore that fails once must be retryable; an interrupted restore must not destroy current state) overlap the wedge failure mode that `restore-apply-wedge.test.ts` documents. **A fresh-device test on a Mac should exercise the same retry-after-failure property**, so the two lanes agree on the property rather than each inventing one.
- **Not shared:** discovering archives through registered app-data clients, unlocking on a fresh native profile, and owner-operated real Drive acceptance are Buffy's and Cue's. This checklist does not attempt them.
- **Requested of Buffy:** when a fresh-device restore is run on macOS, please record (a) macOS version, (b) whether the restore was a first attempt or a retry after a failure, and (c) the app-data locations observed before and after. Those three facts are what would close A7.4/A7.5 from the server side.

## With Astra / the release owner

- §A1.9 (entitlements) is referred to **Agent 5** for security review, not decided here.
- A1.8 (no stapled ticket in the ZIP) is a **documented scope limit**, not a defect to fix.
- §B2 is a **product decision** about whether the Swift app ever gets a release path.
- The missing rollback procedure (`mac-release.md` §7) is the **release owner's** to write.

---

# Summary

| Target | Tests | PASS | NOT RUN | Blocked |
|---|---|---|---|---|
| A — shipped Electron installer | 11 integrity + 6 install/launch + 5 login + 6 persistence + 7 upgrade + 6 restore-compat + 3 uninstall + 4 credential | **11** (A1, minus A1.8/A1.9 observations) | **37** | 2 (A2.2, A3 all) |
| B — Swift development app | 4 build/run | 0 | **4** | 8 distribution blockers (by design) |

**Nothing was installed. Nothing was launched. No user data or working app was touched.** The executed checks are entirely static: digest comparison, `lipo`, `codesign`, `spctl`, `stapler`, `PlistBuddy`, and reading the in-bundle update channel.

**The largest remaining risk is A5.4–A5.6 and A6.6**: uninstall/reinstall data preservation and failed-upgrade recovery. Both are unproven, both are the kind of regression users notice immediately, and neither is covered by any automated gate in this repository.