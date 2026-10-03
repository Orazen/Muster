# macOS release runbook and verification checklist

Date: 2026-10-03 · Author: Agent 4 (native Mac) · Status: **documentation only**

## Scope, and what this document is not

This runbook **describes** how a macOS release candidate is built, signed, notarized, verified and published in this repository. It **does not perform any of those actions**.

**Not done here, and not authorised by this document:** no signing, no notarization, no stapling, no publishing, no uploading, no tag creation, no product code change.

**Evidence convention used throughout:**

| Marker | Meaning |
|---|---|
| **[VERIFIED]** | I read this in the repository at the stated commit. File and line where practical. |
| **[NOT EXECUTED]** | A documented step I did **not** run. Command text is transcribed from the repo, not from a run. |
| **[GAP]** | Something I checked for and did not find. |

> **I executed no build, packaging, signing, notarization or verification command while writing
> this.** My only actions were read-only inspection of git objects and GitHub metadata. Every
> command below is **[NOT EXECUTED]** unless explicitly marked otherwise. Nothing here is a
> test result.

**Reviewed against:** `origin/main` @ `3067009` (2026-10-03).

---

## 0. The most important thing in this document

**There are two different macOS artifacts in this repository, and only one of them ships.** [VERIFIED]

| Artifact | Source | Built in CI | Packaged `.app` | Signed | Notarized | Shipped |
|---|---|---|---|---|---|---|
| **A — Electron desktop app** | `electron/`, `src/`, `server/` | Yes | Yes | Yes | Yes | Yes |
| **B — Swift native app** | `macos/` (`MusterMac`, `MusterMacCore`) | Yes (`swift build`/`swift test`) | **[GAP] No** | **[GAP] No** | **[GAP] No** | **[GAP] No** |

**[VERIFIED]** `macos/` is built and tested in CI — `.github/workflows/ci.yml` job `macos-tests` on `macos-15` runs `swift build --package-path macos` and `swift test --package-path macos`.

**[VERIFIED]** Across all five workflows (`ci.yml`, `release.yml`, `autodeploy.yml`, `package-win.yml`, `bench.yml`) there is **no job that packages, signs, or notarizes the Swift app**. `release.yml`'s `macos` job is named *"macOS arm64 (sign, notarize, staple)"* and runs `pnpm package:mac:arm64` — that is the **Electron** app.

**[VERIFIED]** `macos/` has no `Info.plist`, no `.entitlements`, and no `.icns` of its own. The only macOS bundles with metadata in the tree are `electron/resources/speech-helper-Info.plist`, plus the iOS/iPadOS/Watch plists under `ios/`.

**Consequence:** the native Swift Mac app is currently a **developer/CI target, not a distributable product**. Every section below that concerns a signed `.app` applies to artifact **A** only. Anyone expecting to install a native `.app` today will not find one.

---

## 1. Prerequisites and supported architectures

### 1.1 Toolchain

| Requirement | Detail | Status |
|---|---|---|
| Node | `engines.node` requires `>=23.4` [VERIFIED, `package.json`] | Install a satisfying version; default `node` may be older |
| pnpm | Repo uses pnpm lockfile; CI pins `pnpm/action-setup` [VERIFIED, `release.yml`] | Use repo-pinned pnpm |
| Xcode / Command Line Tools | `swift build` for `macos/` and `ios/`; `xcrun notarytool`, `xcrun stapler`, `spctl`, `codesign`, `lipo` for release [VERIFIED, `release.yml`] | Full Xcode, not just CLT, for release work |
| Apple Developer ID certificate | Required for a signed build; absent → unsigned build [VERIFIED, `release.yml` header] | See §3 |

### 1.2 Architectures

| Artifact | arm64 (Apple silicon) | x64 (Intel) |
|---|---|---|
| **A — Electron** | **Built, signed, notarized and shipped by CI** [VERIFIED, `release.yml` job `macos`] | `pnpm package:mac:x64` **script exists** [VERIFIED, `package.json`] but **[GAP] no CI job builds, signs, notarizes or ships it** |
| **B — Swift** | Builds for the host/CI architecture (`macos-15` = arm64) [VERIFIED] | Not produced; no universal binary configured |

**[VERIFIED]** `electron-builder.yml`'s `mac:` block deliberately sets **no `arch`**, so the CLI flag (`--arm64` / `--x64`) is the only architecture source. The file comments that an explicit arch list previously caused both architectures to build and land on the **same** `Muster-${version}.dmg` filename, with the second silently overwriting the first. Any change here must preserve that property.

**Practical statement of support:** as the repository stands, **only Apple-silicon macOS has a release path.** Intel Macs have a local build script and no release artifact.

---

## 2. Build and validation commands

All **[NOT EXECUTED]**. Transcribed from `package.json` and the workflows.

### 2.1 Electron app (artifact A)

```
pnpm install --frozen-lockfile
pnpm package:mac:arm64     # → package:prepare && build:speech && CUA_TARGET_ARCH=arm64 build:cua && electron-builder --mac --arm64 --publish never
pnpm package:mac:x64       # same chain, --x64, with a distinct DMG artifactName
```

**[VERIFIED]** `package:prepare` = `pnpm build && pnpm build:server && pnpm build:companion && pnpm build:updater`. `build:cua` runs `scripts/prepare-cua.mjs`, which stages a **signed, architecture-matched** native binary — each architecture needs its own run, which is why the two must never be invoked together as a bare `--mac`.

**[VERIFIED]** `release.yml` deletes `dist dist-server dist-companion dist-native release` before building, with the reason recorded in the file: a stale `dist/` would be sealed into the app.

### 2.2 Swift packages (artifact B) — build and test only

```
swift build --package-path macos
swift test  --package-path macos
swift build --package-path ios
swift test  --package-path ios
```

**[VERIFIED]** These are exactly the `macos-tests` and `swift-tests` CI steps. They produce **no installable artifact**.

### 2.3 Validation gates present in the release pipeline

**[VERIFIED]** Named in `release.yml`, in this order, with the pipeline's own stated reasons:

1. **Clean generated output** — stale `dist/` would ride into the sealed app.
2. **codesign gate BEFORE notarization** — *"notarization ACCEPTS invalid signatures; verifying first is the only thing that catches them."*
3. **Packaged Electron storage and server** — *"index.js EXISTING ≠ index.js RUNNING."*
4. **Native load smoke** — `scripts/release-native-smoke.mjs`, plus `lipo -archs` asserting the staged `cua-driver` really is `arm64`.
5. **notarytool credential authentication** check.
6. **Gatekeeper gate after stapling** — `codesign --verify --deep --strict`, `xcrun stapler validate`, `spctl --assess --type exec -vv`.
7. **Staple, THEN checksums** — *"stapling rewrites bytes; hashes computed earlier describe files nobody ships."*
8. **Feed-vs-bytes verification** — a `latest*.yml` whose `sha512` does not match shipped bytes makes `electron-updater` reject every update.
9. **assemble-then-publish** — a partial platform set publishes as a **DRAFT** for human review.

**[NOT EXECUTED]** A local pre-flight for artifact A is `pnpm test:packaged-server` → `pnpm build:server && node scripts/smoke-packaged-server.mjs`.

---

## 3. Signing and notarization requirements

**[VERIFIED]** All values live as repository secrets. **Names only, no values:**

| Secret | Purpose |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` Developer ID certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `APPLE_TEAM_ID` | Apple team identifier, also used by notarization |
| `ASC_KEY_ID` | App Store Connect API key id |
| `ASC_ISSUER_ID` | App Store Connect issuer |
| `ASC_KEY_CONTENT` | The `.p8` private key contents |
| `APPLE_SIGNING_IDENTITY` | Full `Developer ID Application: NAME (TEAMID)` string |

### 3.1 Signing

**[VERIFIED]** The pipeline imports the certificate into a temporary keychain, sets a partition list for `apple-tool:,apple:,codesign:`, and deletes the keychain in an `always()` step. `CSC_IDENTITY_AUTO_DISCOVERY` is set from whether `APPLE_CERTIFICATE` is non-empty.

**[VERIFIED]** If **both** signing secrets are absent the pipeline forces a **clean unsigned** state rather than a half-signed one — users get the normal "unidentified developer" right-click-open flow. `build/after-pack-mac.mjs` re-seals the app with a consistent ad-hoc signature in that path.

**[VERIFIED]** `APPLE_SIGNING_IDENTITY` is deliberately **not** used as `CSC_NAME`: electron-builder rejects the `Developer ID Application:` prefix there and picks the identity from the imported keychain. The same secret is written by `afterPack` into the trusted-mac-updates marker, which is what unlocks in-place `Squirrel.Mac` updates.

### 3.2 Hardened runtime and entitlements

**[VERIFIED]** `electron-builder.yml` → `mac:`:
- `hardenedRuntime: true`
- `gatekeeperAssess: false`
- `entitlements: build/entitlements.mac.plist` and `entitlementsInherit:` the same file
- `icon: build/icon.icns`
- `notarize: false` — notarization is a **manual post-build step**, not electron-builder's

**[VERIFIED]** Declared usage strings in `extendInfo`: `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription` (*"transcribes your voice on-device"*), `NSAccessibilityUsageDescription`, `NSScreenCaptureUsageDescription`.

> **[GAP] Worth an owner's attention:** the Electron app declares microphone, speech-recognition, accessibility and screen-capture usage. The **native Swift app has no `Info.plist` at all**, so it has no usage declarations and no privacy strings. Any future native `.app` will need its own set before it can be distributed.

### 3.3 Notarization and stapling

**[VERIFIED]** `xcrun notarytool submit <file> --key … --key-id … --issuer … --wait` for each `release/*.dmg` and `release/*.zip`, then **only if output contains `status: Accepted`** does it continue. The `.p8` is written to `$RUNNER_TEMP`, never the workspace. Stapling runs **after** acceptance, for each `.dmg` and for `release/mac-arm64/Muster.app`.

---

## 4. Installer packaging and verification

**[VERIFIED]** `electron-builder.yml`:
- `appId: com.muster.app`, `productName: Muster`
- `directories.output: release`
- targets: **`dmg`** and **`zip`**
- `artifactName: Muster-${version}-${arch}.${ext}` (no arch placeholder in the DMG name — see §1.2)
- `asar: true`, `npmRebuild: false` (packaged SQLite is rebuilt in `afterPack`)
- `publish: provider: generic`, `url: https://muster.orazen.online/downloads` — **tokenless by design**, because the repo is private and a GitHub provider 404'd for unauthenticated update checks

**[VERIFIED]** After stapling the pipeline copies `release/Muster-${VERSION}.dmg` to `release/Muster.dmg` as a stable name for the README's `/releases/latest/download/Muster.dmg` link, and refuses to continue if the versioned DMG is absent.

**[VERIFIED]** The DMG's `.blockmap` is **deliberately excluded** from post-staple checksums, because stapling rewrites the DMG after the blockmap is cut; macOS deltas ride the ZIP channel, where pairing is exact.

### 4.1 Deliberate scope limit — do not "fix" this casually

**[VERIFIED]** Recorded in the `release.yml` header: the macOS **ZIP is never modified** after electron-builder writes `latest-mac.yml`. Re-stapling into the ZIP invalidates the feed hash and strands every installed Mac. `scripts/refresh-mac-feed.mjs` updates only post-staple DMG hashes and **rejects any ZIP byte change**; it never re-zips or silently rewrites a changed ZIP hash.

---

## 5. Version consistency and source-to-release traceability

**[VERIFIED]** `package.json` `version` is the single declared version, currently **`1.23.3`**.

**[VERIFIED]** `release.yml` job `prepare` ("Pin the release commit") produces a `sha` output; every platform job checks out `ref: ${{ needs.prepare.outputs.sha }}` with `persist-credentials: false`. That is the source-to-release link: platforms build the **same pinned commit**, not "whatever main was when the job started."

**[VERIFIED]** `dry_run` defaults to **ticked**, exercising the whole pipeline — every build and every gate — without release uploads or notarization submissions. It is unticked to release an existing version tag matching the selected commit. **Notarization is additionally gated on `dry_run == 'false'`.**

**[VERIFIED]** Concurrency group `muster-release` with `cancel-in-progress: false`, so a release run is not cancelled mid-flight.

### 5.1 [GAP] Verified: released version does not contain current source

I checked this rather than assuming it.

- Latest GitHub release: **`v1.23.3`, published 2026-09-30**. [VERIFIED via GitHub API]
- `package.json` `version` on `origin/main` @ `3067009`: **`1.23.3`**. [VERIFIED]
- **78 commits** on `main` after the `v1.23.3` tag. [VERIFIED via `git rev-list --count v1.23.3..origin/main`]

The version number has not been advanced despite 78 commits of source change, so **the published installer does not contain current `main`**. Anyone installing v1.23.3 is not running the code in this repository. This is a versioning/release-cadence finding, not a defect in the pipeline.

---

## 6. Clean-install and upgrade smoke tests

**[NOT EXECUTED]** — the following are the repository's own checks.

| Check | Command / artifact | Source |
|---|---|---|
| Packaged server boots and runs | `pnpm test:packaged-server` → `node scripts/smoke-packaged-server.mjs` | `package.json` [VERIFIED] |
| Native driver matches architecture | `lipo -archs release/…/cua-driver` must include `arm64` | `release.yml` [VERIFIED] |
| Native load smoke | `node scripts/release-native-smoke.mjs --platform darwin --arch arm64` | `release.yml` [VERIFIED] |
| Signature valid | `codesign --verify --deep --strict <app>` | `release.yml` [VERIFIED] |
| Staple valid | `xcrun stapler validate <app>` | `release.yml` [VERIFIED] |
| Gatekeeper accepts | `spctl --assess --type exec -vv <app>` | `release.yml` [VERIFIED] |
| Auto-update feed integrity | `latest-mac.yml` `sha512` must match shipped ZIP bytes | `release.yml` [VERIFIED] |
| Update feed refresh | `node scripts/refresh-mac-feed.mjs` (post-staple) | `release.yml` [VERIFIED] |

### 6.1 [GAP] No installed-app or upgrade smoke test exists

**[VERIFIED]** Every check above is either a build-artifact check or a static verification. **None installs the app on a Mac, launches it, signs in, or exercises an in-place upgrade.** The auto-update path is verified by comparing feed hashes, not by performing an update.

**[GAP]** Consequently these remain unproven by any automated check in this repository:
- clean install on a real Mac, on both architectures;
- first-run experience and **Keychain access prompts** on a real machine;
- session survival across an in-place update (`Squirrel.Mac` replacing the app under a running user);
- the **installed multi-window behaviour** that headless CI cannot reach.

A release candidate should be considered **not** fully verified until someone runs it on physical hardware. **[NOT EXECUTED] — I have no physical Mac access.**

---

## 7. Rollback and recovery

**[VERIFIED]** What the pipeline actually provides:

- **Partial platform set publishes as a DRAFT**, never silently. A human reviews before it goes live.
- **`dry_run` ticked** exercises the entire pipeline with no uploads and no notarization submissions — the safe way to rehearse a release.
- **Temporary keychain is deleted in an `always()` step**, so a failed run does not leave signing material behind on the runner.
- **Concurrency group with `cancel-in-progress: false`** prevents a half-cancelled release.
- **The macOS ZIP is immutable post-build** (§4.1), so a bad ZIP cannot be silently replaced under a shipped feed hash.

**[GAP]** What the pipeline does **not** provide, and a release owner should know:

- **No documented rollback procedure.** Nothing in `release.yml` describes reverting a published release, restoring a previous DMG, or rolling users back.
- **No `latest-mac.yml` retraction path.** If a bad build reaches the feed, there is no documented way to un-publish it other than publishing a fixed version.
- **Signed-and-notarized artifacts are effectively immutable.** A withdrawn build cannot be re-signed; recovery means a new version.

**Recommendation for a release owner:** before the first real release from this pipeline, agree a written rollback procedure — which is out of scope for this documentation task and needs the release owner's decision.

---

## 8. Publishing steps and required credentials

**[NOT EXECUTED] — no publishing step below was run.**

**[VERIFIED]** The pipeline's own ordering, with its stated rationale: *clean → codesign gate → packaged smoke → notarize → staple → checksums → assemble → publish → feed verify.*

- **Assemble then publish.** All platform artifacts are assembled first; publication happens only from the assembled set.
- **Update feed** is refreshed by `scripts/refresh-mac-feed.mjs` **after** stapling, so the feed describes shipped bytes.
- **Download mirror** is `https://muster.orazen.online/downloads`, referenced by `publish: provider: generic` so user machines need no token.
- **Release identity** for the beta's GET-verification requirement is `https://muster.today/api/build-identity` and the mirror host's equivalent.

### Credentials referenced by name only

**[VERIFIED]** From `release.yml`: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_CONTENT`, `APPLE_SIGNING_IDENTITY`.

**[NOT EXECUTED]** No credential value was read, requested, or displayed. The pipeline's own note is that absent-secret behaviour is defined per group "so unsigned forks still get artifacts".

---

## 9. Summary of verified gaps

| # | Gap | Evidence |
|---|---|---|
| 1 | **Swift native app is not a distributable artifact** — no `.app`, no signing, no notarization, no packaging job | `ci.yml` builds/tests it; 0 packaging hits across all 5 workflows [VERIFIED] |
| 2 | **Swift app has no `Info.plist` or entitlements** — no privacy usage strings | Only `electron/resources/speech-helper-Info.plist` and `ios/**` plists exist [VERIFIED] |
| 3 | **Intel (x64) macOS has no release artifact** | Script exists; no CI job [VERIFIED] |
| 4 | **Released v1.23.3 does not contain current source** | 78 commits since tag; version not bumped [VERIFIED] |
| 5 | **No installed-app or upgrade smoke test** | All checks are artifact/static [VERIFIED] |
| 6 | **No documented rollback procedure** | Absent from `release.yml` [VERIFIED] |

**Gap 3 has a second-order effect worth stating:** `electron-builder.yml` sets no `arch`, precisely so the CLI flag decides. If an x64 job were added, it must produce a **distinct** DMG filename — `artifactName` has no arch placeholder, and the file's own comment records that a previous attempt built both architectures onto the same name and silently overwrote one.

---

## 10. What this document deliberately does not do

- No signing, notarization, stapling, publishing, uploading or tagging.
- No product code, build script, workflow or configuration change.
- No release executed. **Every command here is `[NOT EXECUTED]`.**
- No security claim about the shipped app.
- No decision about the gaps in §9 — those need the release owner's input, not a documentation task.