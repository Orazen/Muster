# macOS release-risk summary (consolidated)

**Agent signature:** `AGENT-4 / native-Mac-release-docs-lane` · 2026-10-03
**Reviewed SHA:** `origin/main` @ `30670099582476ce31099038c852e022b5685fa9`
**Purpose:** one place for a reviewer to see every release risk I have found across PRs #37, #40, #42 and #43, including the ones I got wrong and withdrew.

## Status

| PR | Subject | State |
|---|---|---|
| #37 | Charm hardware research | open, unmerged |
| #40 | macOS release runbook | open, unmerged |
| #42 | macOS install/upgrade smoke checklist | open, unmerged |
| #43 | Windows/Linux packaging parity | open, unmerged |

## Risks, most severe first

### R1 — An unsigned macOS build can be fully published and auto-updated · **HIGH**

Missing Apple signing credentials skip the signature gate, notarization, stapling and the Gatekeeper gate, while the build assertion only checks that two files exist. `release-policy.mjs` then decides draft-vs-publish purely from job status, and `release-payload.mjs` performs **no** signature verification. The artifact reaches the tokenless mirror `electron-updater` reads, with every step green.

Full chain, exact line references, and the proposed minimal gate: **PR #38 comment, "RELEASE RISK 1"**. Owner: release owner / Freebuff. **Not implemented by me.**

### R2 — No rollback path for an immutable artifact · **HIGH**

Signed and notarized macOS artifacts cannot be re-signed. `release.yml` contains no documented rollback, no `latest-mac.yml` retraction, and no recovery path for a bad published build. A withdrawn release can only be superseded by a new version. Owner: release owner.

### R3 — macOS never launches the packaged app · **MEDIUM**

macOS gates are entirely static. **Linux already launches the packaged app** (`dbus-run-session -- xvfb-run -a node scripts/smoke-linux-package.mjs`), so the technique exists in-repo. Consequence: first-launch TCC prompts, Keychain on first use, `Squirrel.Mac` in-place update, and multi-window behaviour are unverified on the platform where users meet them first. Detail: PR #43.

### R4 — Released v1.23.3 does not contain current source · **MEDIUM**

Latest release `v1.23.3` published 2026-09-30; `package.json` on main is still `1.23.3`; **78 commits** on main since the tag. Verified. Owner: release owner.

### R5 — Intel macOS signature-gated less often than arm64 · **MEDIUM**

The arm64 signature gate runs whenever a certificate exists, including dry runs. The Intel job's gate additionally requires a real release and the full App Store Connect key set. In the "certificate present, ASC key absent" case a real release could ship an x64 build whose signature was never checked. Detail: PR #43.

### R6 — The Swift native app is not a distributable artifact · **MEDIUM**

Built and tested in CI, but **no `.app`, no `Info.plist`, no entitlements, no signing, no notarization, no updater channel**, and no packaging job in any workflow. It must not be described as installable. Owner: product decision.

### R7 — Windows ships unsigned by design · **LOW / accepted**

SmartScreen shows "unknown publisher". This is a **documented product decision**, not a defect, and is not presented as one. Recorded so release notes do not imply macOS and Windows trust are equivalent.

## Withdrawn — errors I made and corrected

Recording these because each was plausible enough to have become a false release defect.

| Withdrawn claim | Where | Why it was wrong |
|---|---|---|
| "Intel macOS has no release artifact" | #40 | `release.yml` has a *macOS x64 / Intel* job on `macos-15-intel`, and the x64 DMG ships in v1.23.3. I had read only the first macOS job. Withdrawn in `c06702b`. |
| "electron-updater would accept the delta" | #42 | A `sha512` match proves **artifact integrity only**. Update behaviour is NOT RUN. |
| "Windows and Linux have no checksum manifests" | #43 | Both ship `SHA256SUMS-*.txt` and both jobs generate them. |
| "The DMG is the stapled path" (asserted untested) | #42 | Now verified — DMG `stapler validate` exits 0. But my first test validated the *mounted app* and gave a false exit 65; the image is the correct target. |
| A quoted `publisherName` warning presented as literal | #43 | It is split across three comment lines with `#` prefixes; not a literal substring. Now stated. |

**Pattern worth noting:** four of five errors came from reading a workflow or config file *partially* — one job, one line, one line-wrapped sentence. Each was caught only by re-reading with an explicit assertion rather than a plausible pattern match.

## What is verified working

Not everything here is a problem. Verified on the real published `v1.23.3` arm64 artifact:

- SHA-256 matches the published manifest; `sha512` matches the shipped `latest-mac.yml`.
- Binary is `arm64`; bundle id `com.muster.app`.
- Developer ID signature verifies; chains to Apple Root CA.
- Gatekeeper reports `Notarized Developer ID`.
- **DMG carries a stapled ticket** (`stapler validate` exit 0); the ZIP channel does not, matching the documented scope limit.
- All four privacy usage strings ship with real text.
- Update channel is the tokenless generic provider.

## Not claimed

No release, install, launch, signing, notarization, or publish was performed. The **37 behavioural tests remain NOT RUN** — running the app would touch the user's Keychain and `~/Library`, and overriding `HOME` does not isolate either. Nothing here asserts any artifact is fit to ship.

## Next owner

**Release owner / Freebuff:** R1 gate, R2 rollback, R4 version cadence.
**Tharun:** R6 product decision; the four Charm questions in #37 §11.
**Agent 5:** review the shipped entitlements (`disable-library-validation`, `allow-unsigned-executable-memory`) — referred, not decided.
**Astra:** acknowledge R1 and the W2 handoff. See the signature convention in the #38 thread; comment authorship cannot identify an agent on this shared account.
