# Astra audit of GLM's changes — 12 September 2026

The board confirmed that GLM stopped and Astra owns this checkout. This audit compares
`aac8fd3..97c2b563fbf22bff4437eed79a0e575c4f2d9129`: 66 committed files, plus the
14 inherited pending files preserved below. A green existing suite did not establish
the new Drive flow, usable mascot animation, or distributable desktop release.

## Evidence and ownership

Local receipts are under `.omb-scratch/verification/astra-glm-audit-2026-09-12/`:
`glm-changed-files.json`, `storage/audit.md`, `auth/report.md`, `ui/audit.md`, test
logs/results, and `release/`. These are local audit artifacts, not shipped product files.
The storage and auth reproductions use synthetic files/SQLite/fake provider responses;
the UI checks use actual component rendering and isolated Chromium. They do not prove
real Google consent or native distribution acceptance.

The inherited five Loop 50 native edits, two plan edits, six research files and
`www/templates.html` were copied and hashed in `inherited-state.json` and
`inherited-working-tree/` before an owned temporary stash. The original stash
`4d13860fa6cb858efc48713dba9fb4637c7101e7` is preserved. The owned stash receipt is
`inherited-stash.json`; inherited work must be restored and hash-checked before the
session handoff. Pending native code is not approved for release by this audit.

## Ranked findings and repair boundaries

The memory-retention repair is committed and pushed as `efcf629`. Subsequent
production GETs returned 200, but its CI/deploy jobs again failed before starting
because of billing/spending limits. The exact running backend revision remains
unestablished.

Loop 68 also clears all **44 inherited lint errors** without suppressing rules.
The **243-file suite passes 3431 tests, with 8 skipped and 0 failures** (297.50s),
and repository lint and TypeScript both pass. Valid-input behavior is preserved;
malformed organization IDs now fail validation, and mascot lookup ignores inherited
object properties. Five new face-lookup regression tests cover the latter. This does
not fix the separate mascot CSS-transform or Drive-flow defects below.

| Priority | Finding | Required acceptance / disposition |
| --- | --- | --- |
| P1 | History follows planted links and lets failed snapshots precede live overwrite. | First repair slice: reject linked paths/entries, retain exact old bytes before writes, propagate retention failure, bound reads and rollback. Filesystem tests include real permission failures. No claim of isolation against a hostile process continuously replacing path ancestors. |
| P1 | Memory history can lose a baseline edited before the next prompt, or prune a new snapshot after clock rollback. | Preserve both the displaced baseline and current live version; protect this operation's retained IDs during pruning. Include save and restore regressions. |
| P1 | Newly advertised Drive consent is unreachable: hosted routes hit the existing global workspace denial; desktop Host values with ports fail. | Preserve hosted installation-wide export/restore denial. Establish an honest deployment capability before advertising consent. A bridged desktop has neither a Google account token row nor the hosted OAuth secret. A Host-regex patch alone cannot fix it. |
| P1 | Drive token exchange does not verify Google subject or granted scope and can combine one account's access token with another refresh token. | Before enabling: verified identity/scope, coherent separate grant, one-use session-bound consent intent, actual route and SQLite tests. No hosted secret in desktop packages. |
| P1 | Best-effort message insert failure can leave a missing predecessor in a later durable branch. | Separate Store slice: restart tests must assert active transcript ancestry, not only SQLite row count. This predates GLM's change. |
| P2 | Strict seed writes can fail after bot creation was persisted/emitted. | Separate Store slice: one coherent bot-and-greeting creation boundary; failed creation/retry must not duplicate bots. |
| P2 | Strict message patch accepts a zero-row database update. | Separate Store slice: require durable target or explicitly repair it; test restart behavior. |
| P2 | New onboarding indexes 5/6 are rejected by the draft validator. Legacy index 4 has changed meaning. | Version/migrate drafts, retain final-step input through reload/sign-in, test all seven current steps. |
| P2 | Flower poses use SVG syntax in CSS transforms; Chromium discards them. | Correct applied transforms; browser assertions must check computed matrices and visual states, including reduced motion. |
| P2 | Shortcuts dialog sits inside `aria-hidden` and lacks focus ownership. | Use the existing dialog primitive; test keyboard focus/return and Escape interaction with onboarding. |
| P2 | Phone onboarding opens desktop account pairing instead of companion pairing. | Test the actual invitation producer/consumer; show supported companion setup prerequisites. |
| P2 | Pending memory restore can erase newly typed text; load-budget captions remain stale after mutations. | Serialize save/restore or preserve editor revisions; update usage from accepted content. Test delayed responses. |
| P2 | Historical-card ordinary resend lacks an immediate request lock and current-thread precondition. | Test double click, thread switch and lost acknowledgement. An explicit resend itself is a valid product choice. |
| P2 | Failed Drive restore still advances its success stamp; Telegram push stamps twice. | Stamp once after successful decrypt/restore/reload; failure tests must retain the previous stamp. |
| P2 | Public backup, privacy, native-beta and release claims exceed the implementation. | Align visible and machine-readable copy with installation backup limits and actual distribution evidence. |

Pending templates falsely report successful copy when clipboard access is unavailable
and describe installed packs while merely copying prompts. Keep this separate from
already published defects. Pending research has useful source/inference distinctions,
but “code complete” and developer-account-only TestFlight conclusions are unsupported.

The role benchmark's saved six-scenario evidence is simulated. Its grader can assess
receipt consistency; it cannot independently establish live execution, provenance,
provider quality, AGI or ASI. One duration-beyond-capture consistency gap is queued.

## Release audit: v1.12.0 is published, distribution acceptance is incomplete

The published eight assets match local size/SHA256. Both Mac ZIPs match all 882 checked
archive entries in their corresponding local bundles, with zero mismatches. Thus the
following runtime/signing checks apply to the uploaded ZIP payload, not a different build.

| Check | Observed result |
| --- | --- |
| Apple Silicon packaged runtime | 9 checks passed: HTTP startup, seven packaged proxy paths, native database. Electron 43.4.0 / Node 24.18.1 / ABI 148. |
| Intel packaged runtime | Failed: native runtime probe timed out after 30 seconds. No passing runtime checks returned. Owned fixture/process cleanup completed. |
| Deep strict signature verification | Both Mac bundles passed, signed with Apple Development. This is not Developer ID distribution acceptance. |
| Gatekeeper assessment | Both bundles rejected, exit 3. |
| Stapled notarization ticket | Both missing, validation exit 65. |
| Available signing identity | Zero Developer ID Application identities; one Apple Development identity. No credential was exported or changed. |
| Advertised CLI | Identifies itself as **1.11.0**, SHA `106ef6e0169177417d161baeebff518b21ab8c83`, despite 1.12.0 download metadata. |
| Production GET | Six inspected health/download metadata requests returned 200; public release metadata reports 1.12.0 / `e241968`. This does not establish installation or authenticated flows. |
| GitHub CI / deploy trigger at audited HEAD | Four jobs never started. Check annotations explicitly report failed account payments or a spending limit. Build was skipped. |

Board prerequisites: resolve GitHub account billing/spending and provide an authorized
Developer ID/notarization path before claiming normal Mac distribution. Native
TestFlight/Watch release needs its own signed build and actual flow acceptance too.
Do not bypass Gatekeeper or treat artifact upload as proof of an installed update.

## Verification ledger

Fresh ancillary checks before shelving pending native work:

- Swift: **274 passed, 0 failed**. This includes the inherited Loop 50 composer edits;
  it is not the count of committed native source and not Watch UI acceptance.
- Broker: **1 file / 2 passed**.
- Updater: **14 passed / 0 failed / 0 skipped**.
- Electron syntax: **8 files checked**, exit 0; these are not unit tests.
- Audit reproductions: **7 storage defect observations**, **16 auth counterexamples**,
  **7 isolated UI checks**, and **8 grouped Chromium checks / 14 assertions**.
  These successful reproductions identify defects, not passing product acceptance.

First repair source is frozen and independently reviewed:

- Focused filesystem tests: **3 files / 41 passed / 0 failed / 0 skipped**.
- Production build, including frontend/server TypeScript: **passed**, 54.220 seconds.
- Current packaged server under standalone Node: **9 checks passed** (HTTP, seven
  proxy paths, native database), 14.685 seconds including the server build. This is
  distinct from testing the previously published Electron bundle above.
- Unmodified repository Playwright: **8 passed / 0 failed / 0 skipped / 0 flaky**,
  44.696 seconds, one worker, zero retries. Covers approval allow/deny, rehearsal
  history, desktop bridge/account pairing, message/reply reload and OAuth redirect
  construction. Google consent is not followed; engines/accounts are synthetic.
  All 929 observed source/dist hashes were unchanged, 69 observed owned processes
  exited, 28 observed ports closed, and eight fixture roots were removed.
- Repository lint: **failed, 44 errors across 13 files**, all byte-identical to the
  audited HEAD and outside the four-file memory repair. Scoped repair lint passed.
  These are tracked follow-up failures, not a green repository lint result.
- Full Vitest: **243 files / 3426 passed / 8 skipped / 0 failed** in 291.93 seconds
  (293.611-second command), up 16 passing cases from GLM's 3410 baseline.

Initial harness/path/browser availability failures are retained in the local evidence;
they are not silently replaced by successful reruns.

## Corrections to earlier ledger claims

- Loop 63's health and unauthenticated 401 checks did not verify signed-in Drive consent.
- Loop 65 source is committed (`59a8a2e`); its “UNCOMMITTED” label is historical and stale.
  Successful-restore timestamps were not yet correct at the audited HEAD.
- The v1.12.0 release paragraph does not prove the user's installed app updated.
- Loop 66's owned scratch accounts and Watch pairing screen do not verify real Google
  sign-in, Watch composer acceptance, every screen, or store distribution.
- Google's [official Drive scope table](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
  classifies `drive.appdata` as **non-sensitive**. Earlier restricted-scope/CASA assertions
  are incorrect. Basic sign-in plus separate backup consent remains a valid UX choice.
- No complete Mimosa rerun was available in this session. No security conclusion follows
  from this review, the portable tests, or the runtime smoke.

Continue with the ranked repairs above, one verified commit at a time. Preserve the
inherited native work, report actual failures, and distinguish browser fixture acceptance,
real provider consent, production deployment and native release.
