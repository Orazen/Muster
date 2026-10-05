# Acceptance preparation — 5 October 2026 (lead integration agent)

This document separates what is **prepared and executable locally** from what
**requires external access** (billing, real Google accounts, signing
credentials, physical devices, product decisions). Every command below was
verified to exist in the repository at main `ca13ce7`; every blocked item
names its owner. It does not claim any acceptance that has not happened.

## 1. Hosted CI and deployment (blocked: Actions billing)

Latest final-main runs — CI
`https://github.com/Orazen/Muster/actions/runs/37352216635` and autodeploy
`https://github.com/Orazen/Muster/actions/runs/37352216475` — failed with
**zero executed steps**: 12 of 13 jobs failed with the billing annotation (the
13th, `build`, was skipped with none): "The job was not
started because recent account payments have failed or your spending limit
needs to be increased." This is a billing no-start, not a product failure.

Owner: **repo billing administrator** (Tharun). No agent may alter payment
methods or raise spending limits.

Once eligibility is restored, the re-verification sequence is:

1. Push nothing; re-run the two workflows on the exact final main SHA
   (`gh run rerun <id> --repo Orazen/Muster` requires no new push) or trigger
   a no-op-tagged run so the SHA under test is unambiguous.
2. Record per-job results of all 13 CI jobs (typecheck, lint,
   test-integrations, browser-tests, swift-tests, 4 test shards, e2e-typecheck,
   macos-tests, gitleaks, build). A pass with executed steps is the first
   hosted evidence since the billing block; local receipts remain separate.
3. Only after CI passes: verify autodeploy produced a real rollout with
   **GET-only** checks against the live site — compare served
   `/index.html`-referenced asset hashes and sizes to the exact main tree,
   and confirm the backend health endpoint reports the deployed version.
   Diagnostic GET 200s, source identity and attestation remain distinct.
4. If Actions remains blocked, do NOT present any other serving mechanism
   (Dokploy auto-deploy, manual VPS sync) as proof of the failed workflows.

### TestSprite "No tests detected"

The TestSprite GitHub App posts a **TestSprite Pre-Check** commit status
(last observed: `failure`, "No tests detected", on `fcba07c`, 2026-10-05).
The repository already contains five executable frontend plans in
`.testsprite/plan-{signin,signup,avatar,landing,download}.json` (project
`b06262d3-b9d1-4b82-af62-6f9fbfd69278`), and `scripts/testsprite-key.mjs`
rotates the CLI key stored at `~/.testsprite/credentials.json`. The plans
target `https://muster.orazen.online` pages.

Owner: **TestSprite project administrator** (repo owner's TestSprite
account). Preparation is complete; the unblock is external:

1. Open the TestSprite dashboard for project `b06262d3-…` and confirm the
   GitHub integration maps repo `Orazen/Muster` to this project (a repo/
   project mismatch presents exactly as "No tests detected").
2. From a checkout of main, run the TestSprite CLI once against the plans so
   the App re-discovers them (`TESTSPRITE_API_KEY` unset reads the rotated
   key from `~/.testsprite/credentials.json`).
3. Re-post the Pre-Check on a fresh commit SHA and record the status.
   "No tests detected" must never be reported as a pass.

## 2. Real Google Drive acceptance (blocked: authorized account/device access)

Integrated and locally proven (do not re-implement): dedicated `drive.file`
consent, deployment-key-derived credential protection, live signed
session/account membership fences, durable account-scoped readers, bounded
fixed-endpoint Google transport, immutable encrypted account projection
copies, guarded offline import on owned synthetic roots, first-dependency
startup refusal, optional Backups UI. Live HTTP apply is deliberately
**not exposed** (`apply: "unsupported"`); the new exclusive-restore boundary
(see PR from `lead/w2-boundary-and-exclusivity`) is its prerequisite, not a
license to enable it.

Synthetic gates that must stay green (run from a main checkout):

```bash
npx vitest run server/drive-visible-account-import.test.ts \
  server/drive-visible-account-restore-journal.test.ts \
  server/drive-visible-account-restore-process.test.ts \
  server/drive-visible-account-import-plan.test.ts \
  server/drive-visible-account-state.test.ts \
  server/drive-visible-account-archive.test.ts
npx vitest run server/drive-visible-startup-refusal.test.ts \
  server/drive-visible-startup-refusal-process.test.ts
npx vitest run server/restore-records-two-accounts.test.ts
npx vitest run server/drive-visible-restore.test.ts server/drive-visible-routes.test.ts \
  server/drive-visible-route-integration.test.ts
```

Real-outcome matrix requiring an authorized Google account + device
(owner: **Tharun / consented QA**):

| # | Scenario | What evidence must show |
|---|---|---|
| 1 | Consent with an existing grant | `drive.file` scope only; no broad scope request; status card reflects connected state |
| 2 | Cancel mid-consent | grant unchanged; no orphaned tokens; UI returns to prior state |
| 3 | Re-consent after explicit disconnect | local grant revoked; new consent reuses the existing Google grant without re-prompting unrelated scopes |
| 4 | Session rotation during an async request | in-flight operation ends with the fence refusal, never a cross-session write |
| 5 | Account/workspace switch mid-request | same as 4, with the older account's data untouched |
| 6 | Remote Google revocation | server-side expiry detected; reconnect path offered; no silent retry loops |
| 7 | Expired grant + reconnect | bounded transport returns the expiry reason; reconnect restores readers |
| 8 | Encrypted copy creation + ciphertext readback | immutable archive bytes identical across two reads; keys never logged |
| 9 | Tamper / wrong key / ownership mismatch / oversize | inert inspection refuses each, with distinct reasons |
| 10 | Fresh-device restore (inspection) | account inventory matches source; `apply:"unsupported"` still enforced |
| 11 | Interrupted recovery + rollback | journal replay leaves prior state intact; ambiguous states refuse |

Constraints that remain binding: narrow scopes only; never enumerate unrelated
files, delete backups, persist or log secrets. The cross-origin Google popup
cannot be auto-closed after its opener is severed — the UI's manual-close
notice is a truthful accepted limitation; do not weaken opener protection.

## 3. Platform acceptance (blocked: credentials, devices, other OS hosts)

- **Android** (Expo 52 / RN 0.76.7): debug/emulator evidence is complete
  (577 focused tests; offline debug APK/AAB; 17/17 paired-emulator assertions).
  Remaining: physical-device install/upgrade/restart/pairing/message
  durability/engine-approval behavior on hardware, and production signing —
  distinct gates. Owner: Android SDK owner with a device.
- **Mac** (Swift 133/133, ARM/Intel compile): install/upgrade/launch per
  `docs/mac-smoke-checklist.md`; Developer ID signing, notarization and
  Gatekeeper per `docs/mac-release.md` — requires Apple Developer credentials.
  Owner: release owner with Apple Developer credentials. Compilation alone
  never implies installed acceptance.
- **Windows/Linux**: packaging parity requirements in
  `docs/win-linux-packaging-parity.md`; actual GUI/runtime/install/upgrade
  checks need Windows and Linux hosts. Owner: platform owner with those
  hosts. Until then, record the limitation.

## 4. Beta and product decisions (owner: Tharun)

Blocked items needing only the owner's decision — options prepared so a
decision unblocks dependent work immediately:

1. **15 tester-days** (5 consenting testers × 3 distinct dates): recruit from
   the existing beta list; each tester-day = one dated recorded session with
   consent. No participation may be fabricated.
2. **Provider/model selection**: choose the default provider per bot class
   from the currently wired drivers; record the decision in
   `docs/plans/current-state.md`.
3. **Included AI allowance + reset policy + global budget**: pick allowance
   size, reset cadence (monthly recommended), and a hard global spend cap.
   Never silently select a paid budget.
4. **Funding**: decisions above imply the monthly budget envelope.

## 5. Exclusive-restore boundary status (new this round)

`server/data-dir-exclusivity.ts` (integrated after this document's base via
PR #79; see that PR for the module) provides: a crash-safe exclusive-restore
claim bound to the named directory,
a writer barrier (mode freeze + rename swap) that defeats non-cooperating
same-user writers, kernel-visible quarantine of freeze-window writes, and a
boot guard that recovers provable crash states and refuses ambiguous ones.
Independently reviewed (three rounds, receipts recorded in PR #79) and covered
by 100 focused tests across the boundary suites and their five adjacent suites
(the new suites contribute 31), including real
SIGKILL crash recovery and a non-cooperating writer child. **This is the
exclusivity prerequisite for live existing-installation restore — it does not
enable it.** Remaining before live apply can be exposed: separately claimed
current-authority validation inside the window, parent-launch-path claim
checks (Docker entrypoint, Electron main, CLI parent writes), and a restore
runbook for the manual-reconciliation states. No route is wired to it.
