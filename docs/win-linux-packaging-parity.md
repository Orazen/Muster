# Windows and Linux packaging parity review

Date: 2026-10-03 · Author: Agent 4 · Status: **read-only review, no change made**
Companion to [`mac-release.md`](./mac-release.md) (macOS) and [`mac-smoke-checklist.md`](./mac-smoke-checklist.md).

## What this is

The macOS runbook prompted a fair question: **do Windows and Linux get the same release rigor?** This reviews that. It changed nothing — no code, config, workflow, or secret.

**Evidence convention:** **[VERIFIED]** = read at the stated commit. **[NOT RUN]** = documented but not executed. Nothing here is a test result.

**Reviewed against:** `origin/main` @ `3067009`.

## Two corrections I had to make first

I carried assumptions into this review that turned out to be false. Both are recorded because the wrong versions were plausible enough to have become a false release defect.

1. **"Windows and Linux have no checksum manifests."** False. `v1.23.3` ships `SHA256SUMS-windows-x64.txt` and `SHA256SUMS-linux-x64.txt` alongside the macOS ones, and both jobs generate them (`sha256sum *.exe *.exe.blockmap`, and the Linux equivalent).
2. **"Intel macOS has no release job."** False, and I had already published that error in PR #40. `release.yml` contains a *macOS x64 / Intel* job on `macos-15-intel` with its own native-load gate. Corrected in `c06702b`.

**[VERIFIED] The release workflow has four platform jobs**, not one:

| Job | Runner | Signing | Native-load gate |
|---|---|---|---|
| macOS arm64 (sign, notarize, staple) | `macos-latest` | Apple Developer ID + notarization | `--platform darwin --arch arm64` |
| macOS x64 / Intel | `macos-15-intel` | Apple Developer ID + notarization | `--platform darwin --arch x64` |
| Windows x64 (NSIS) | `windows-latest` | **Optional**, via `CSC_LINK` | `--platform win32 --arch x64` |
| Linux x64 (deb + AppImage) | `ubuntu-24.04` | **None** (no signing concept) | `--platform linux --arch x64` |

So parity is **not** about existence — all four platforms build and ship. It is about **verification depth**, and that differs sharply and in both directions.

## Where each platform is stronger

### Linux has the deepest verification — including a real launch **[VERIFIED]**

The Linux job runs:

```
node scripts/verify-linux-package.mjs
node scripts/release-native-smoke.mjs --platform linux --arch x64
dbus-run-session -- xvfb-run -a node scripts/smoke-linux-package.mjs
```

That last line is the important one: **Linux actually launches the packaged application end to end** under a virtual display and a session bus, and asserts it comes up.

**macOS has no equivalent.** Its gates are all static: `codesign --verify`, `stapler validate`, `spctl --assess`, `lipo -archs`, and a packaged-tree inspection. The app is never launched.

This is the same gap `mac-release.md` §6.1 records from the macOS side, and this review confirms it from the other direction: **the technique already exists in this repository, on Linux.** That materially lowers the cost of closing it on macOS — it is a port, not an invention.

### macOS has the strongest cryptographic verification **[VERIFIED]**

Only macOS has a real trust chain: Developer ID signature, notarization submitted to Apple, acceptance asserted on `status: Accepted`, stapling, and a Gatekeeper gate that runs `spctl --assess`. I verified end-to-end on the real `v1.23.3` artifact — signature verifies, Gatekeeper reports `Notarized Developer ID`, and the DMG carries a stapled ticket (`stapler validate` exit 0).

## Where the real gaps are

### Gap A — macOS never launches the packaged app **[VERIFIED]**

Linux launches it; macOS does not. macOS-only behaviour that only appears at runtime — first-launch TCC permission prompts, Keychain access on first use, `Squirrel.Mac` in-place update replacing the app under a running user, multi-window behaviour — is therefore **unverified on the only platform where it cannot be automated cheaply and is most visible to users**.

**[NOT RUN]** Nothing in this review launches anything.

### Gap B — signing is optional on macOS **and** the absence fails no gate **[VERIFIED]**

This is the finding that most deserves attention, and it emerged from correcting my own error.

The macOS signature and hardened-runtime gate is:

```yaml
- name: "Gate: signature must verify BEFORE notarization"
  if: ${{ env.APPLE_CERTIFICATE != '' }}
```

If the Apple secrets are unset, **the entire gate is skipped** and no later step fails. The notarization step is likewise gated on the ASC secrets. The pipeline's stated intent is that absent secrets yield "a clean unsigned state" rather than a broken half-signed one — which is good engineering — but it means:

> **An unsigned, un-notarized macOS build can be published with a fully green workflow.**

Windows has a related but *different* guard, and it is a good one. Its gate runs **unconditionally** and checks consistency in both directions:

- signed build whose `app-update.yml` lacks `publisherName` → error (*"electron-updater would trust nothing"*)
- `app-update.yml` carrying `publisherName` on an **unsigned** build → error

So Windows permits unsigned builds too, but it refuses to ship one that lies about it. **macOS has no equivalent consistency check.**

The Windows hazard is documented in `electron-builder.yml` and is worth repeating because it is easy to trip: *"Do NOT set publisherName without actually signing, or every update is rejected as untrusted."* That is a silent, total auto-update failure — the app stops updating for every user, with no error at build time.

### Gap C — Windows ships unsigned, by design **[VERIFIED]**

`electron-builder.yml` documents the Windows installer as unsigned, with SmartScreen showing "unknown publisher" on first run. This is a deliberate, documented product decision, **not a defect**, and I am not relabelling it as one. But it is a real asymmetry: a macOS user gets a silently trusted, notarized app, and a Windows user gets a warning dialog. Both are acceptable; they are not equivalent, and release notes should not imply they are.

### Gap D — no post-release verification parity **[VERIFIED]**

macOS has a GET-based delivery identity check (`/api/build-identity` on both domains) used in the beta receipts. There is no equivalent automated "the thing users downloaded is the thing we built" check for Windows or Linux — the checksum manifests exist, but nothing consumes them automatically after publication.

**[NOT RUN]** No post-release verification was performed for any platform in this review.

## Summary table

| Capability | macOS | Windows | Linux |
|---|---|---|---|
| Builds in release pipeline | ✅ arm64 + x64 | ✅ x64 | ✅ x64 |
| Code signing | ✅ Developer ID (**optional**, silently degrades) | ⚠️ optional, **consistency-gated** | ❌ none |
| Notarization / equivalent | ✅ Apple notarization | n/a | n/a |
| Stapling | ✅ DMG (verified exit 0) | n/a | n/a |
| Package integrity manifests | ✅ per-arch | ✅ | ✅ |
| Native-load smoke | ✅ both arches | ✅ | ✅ |
| **Packaged app actually launched** | ❌ **none** | ❌ none | ✅ **`smoke-linux-package.mjs`** |
| Auto-update feed | ✅ `latest-mac.yml` | ✅ `latest.yml` | ✅ `latest-linux.yml` |

**The headline is not that macOS is behind.** macOS leads on trust verification and is the only platform with notarization. **Linux leads on behavioural verification** because it is the only one that launches the app. **The one gap worth closing first is macOS's missing launch test**, because the technique already exists in-repo on Linux and the macOS-only runtime risks (TCC prompts, Keychain, in-place update) are the ones users actually hit.

## What this review does not claim

- No release performed, no artifact launched, no signing or notarization attempted.
- No claim that any platform's artifact is fit to ship.
- **[NOT RUN]** every runtime behaviour; this review read workflow definitions and, for macOS only, inspected a published artifact statically.
- Gap C is a documented product decision and is **not** presented as a defect.
- Whether to close Gap A, and how, is a **decision for the release owner** — not a change this review made or should make unilaterally.