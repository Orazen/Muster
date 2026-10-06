# Remaining-work register — 6 October 2026

Owner-maintained register of every unfinished item after the 6 October
implementation round (PRs #81–#83 merged; main `1d8a254`). Behavior,
implementation gap, verification gap, owner, dependency and acceptance
evidence for each row. Supersedes no accepted scope; adds rows only. Items
moved to DONE this round are recorded at the bottom with their receipts.

## Open rows

| ID | Behavior required | Implementation gap | Verification gap | Owner | Dependency | Acceptance evidence required |
|---|---|---|---|---|---|---|
| GATE-HOSTED | CI and autodeploy execute and pass on the exact final main SHA | None (billing-side) | All hosted runs since 2026-10-05 failed before step 0 with the spending-limit annotation | Repo billing administrator (Tharun) | Actions billing/spending-limit restored | A green CI run (13 jobs, executed steps) on the final SHA; recorded per-job |
| GATE-TESTSPRITE | TestSprite discovers and executes the five plans in `.testsprite/` | GitHub App project mapping unconfirmed (plans + project id exist in-repo) | Pre-Check last posted "No tests detected" on `fcba07c`; no status on newer SHAs — absence is not a pass | TestSprite project administrator | Dashboard access for project `b06262d3-…` | Pre-Check success plus one executed plan run; never report "No tests detected" as a pass |
| LIVE-SCOPE | Owner decision defining the approved live existing-installation restore scope (HTTP consumer, account-scoped vs whole-installation, rollback policy) | Decision not recorded | n/a | Tharun | Restore authority + exclusivity now merged (#79, #81) | Recorded decision in the register or current-state |
| LIVE-HTTP | If LIVE-SCOPE authorizes it: wire the HTTP consumer behind `resolveAuthenticatedVisibleAccount`-grade authority with `assertCurrent()` at every commit boundary | Route not wired (`apply: "unsupported"` enforced) | Composed apply path tests (interruption, stale authority, concurrent sessions) | Backend owner | LIVE-SCOPE; AUTH-BOOT row | Real-path tests + independent review before any exposure |
| AUTH-BOOT | Boot-time apply authority: validate session/account before boot-commit, or document its exclusion from boot-path restores | Currently scoped to the running-server consumer (stated in `server/restore-authority.ts` header) | Boot-order invariants preserved (restore-first before auth/store) | Backend owner | LIVE-SCOPE | Either a boot-path authority implementation with tests, or an explicit recorded exclusion |
| NATIVE-INTEGRATE | Wire the native custody store into the separately-authorized enrollment integration; production enrollment stays off until custody/identity/lifecycle gates pass | Store merged unwired (`conformsToProtectedCustody = false`) | Two preconditions from review: single shared store instance per process; behavioral coverage for degraded-fence fail-closed and post-delete tombstone | Native owner (OpenCode lane) | W2 native mapping accepted (#82); enrollment enablement is an explicit code decision | Integration tests + review; production enrollment remains disabled until all gates pass |
| GOOGLE-REAL | Real Google acceptance: the 11-scenario matrix (consent, cancel, re-consent, session rotation, account switch, remote revocation, expiry/reconnect, ciphertext readback, tamper/wrong-key/ownership/size, fresh-device inspection, interrupted recovery) | None (implementation merged and gated) | All 11 rows unexecuted | Authorized Google/device operator (Tharun / consented QA) | Google account + device access | Dated evidence per row; inspection is never reported as apply |
| ANDROID-PHYSICAL | Physical-device standalone operation, install/upgrade, restart, pairing/unpairing, durability, approvals; production signing | None (debug/emulator evidence complete) | Physical + release-signing gates unexecuted | Android SDK owner + release owner | Device + signing credentials | Dated device evidence distinct from emulator receipts |
| MAC-INSTALL | Installed launch/upgrade, Developer ID signing, notarization, Gatekeeper | None (Swift 153/153 + compile evidence) | Installed/notarized gates unexecuted | Release owner | Apple Developer credentials | Notarized artifact verification per `docs/mac-release.md` |
| WIN-LINUX | Packaging, GUI/runtime, install/upgrade, lifecycle | None (parity docs merged) | No Windows/Linux host execution | Platform owner | Windows/Linux hosts | Dated host evidence |
| TOKEN-G4 | No raw session token material in `GET /api/auth/list-sessions` | better-auth 1.7.6 returns `session.token` (HMAC-protected, non-replayable, but raw) | Redacting-proxy or upstream hidden-field behavior untested | Auth owner / upstream better-auth | Upstream support or proxy route design | Focused test proving token absence from the response |
| TOKEN-G5 | Local disconnect for legacy appData Drive sync (like Telegram has) | Route addition touches `server/index.ts` routing — serialized | n/a | Routes owner | Serialized routing window | Route test + review; never weakens the three-consent separation |
| BETA-TESTERS | 15 actual tester-days (5 consenting testers × 3 distinct dates) | Not started | n/a | Tharun | Consented testers | Dated, consented session records; never fabricated |
| BETA-PRODUCT | Provider/model selection; AI allowance + reset policy; global spend cap; funding | Decisions not recorded | n/a | Tharun | None | Decisions recorded in current-state; no silent paid budget |

## DONE this round (receipts)

- Restore authority inside the exclusive window + launcher checks + reconciliation runbook — #81 `e125e75`, ACCEPT after one fix round.
- Native W2 custody store mapped from the reviewed seam table — #82 `d4f7f38`, ACCEPT round 1 (Swift 153/153).
- Credential at-rest audit + fixes (five driver files, auth.secret legacy repair, mode pins) — #83 `7874a7c`, ACCEPT after two fix rounds.
- Dependabot #73/#74 dismissed as `fix_started` with truthful comments (mitigation ≠ upstream fix; npm recheck 6 October: no patched release exists).
