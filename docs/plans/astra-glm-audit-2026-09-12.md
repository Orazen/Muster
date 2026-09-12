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
| P1, repaired in `efcf629` | History follows planted links and lets failed snapshots precede live overwrite. | Reject linked paths/entries, retain exact old bytes before writes, propagate retention failure, bound reads and rollback. Filesystem tests include real permission failures. No claim of isolation against a hostile process continuously replacing path ancestors. |
| P1, repaired in `efcf629` | Memory history can lose a baseline edited before the next prompt, or prune a new snapshot after clock rollback. | Preserve both the displaced baseline and current live version; protect this operation's retained IDs during pruning. Save and restore regressions pass. |
| P1 | Newly advertised Drive consent is unreachable: hosted routes hit the existing global workspace denial; desktop Host values with ports fail. | Preserve hosted installation-wide export/restore denial. Establish an honest deployment capability before advertising consent. A bridged desktop has neither a Google account token row nor the hosted OAuth secret. A Host-regex patch alone cannot fix it. |
| P1 | Drive token exchange does not verify Google subject or granted scope and can combine one account's access token with another refresh token. | Before enabling: verified identity/scope, coherent separate grant, one-use session-bound consent intent, actual route and SQLite tests. No hosted secret in desktop packages. |
| P1 | Best-effort message insert failure can leave a missing predecessor in a later durable branch. | Separate Store slice: restart tests must assert active transcript ancestry, not only SQLite row count. This predates GLM's change. |
| P2 | Strict seed writes can fail after bot creation was persisted/emitted. | Separate Store slice: one coherent bot-and-greeting creation boundary; failed creation/retry must not duplicate bots. |
| P2 | Strict message patch accepts a zero-row database update. | Separate Store slice: require durable target or explicitly repair it; test restart behavior. |
| P1, repaired in Loop 69 | Default Flower and picker Blob were accepted by the client but rejected by the server, blocking first-task submission before any message request. | Found by the new real-browser recovery test. One browser-safe character contract now drives both picker and API membership, preserving legacy Lottie storage without exposing it in the picker or PATCH. Browser acceptance retains the default Flower. |
| P2, repaired in Loop 69 | New onboarding indexes 5/6 are rejected by the draft validator. Legacy index 4 has changed meaning. | Version-2 semantic step IDs are shared by persistence and the seven-step UI. Valid legacy drafts retain every field and reopen Welcome because old numeric layouts are ambiguous. Failed migration writes preserve the legacy copy; a v2 value suppresses stale legacy resurrection. Browser and full-suite receipts follow below. |
| P2, repaired in Loop 70 | Flower poses use SVG syntax in CSS transforms; Chromium discards them. | CSS length/angle units and comma separators now apply the intended body and eye transforms. All 15 poses and reduced motion pass computed-matrix and visual browser checks. |
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

Additional platform gates, run separately from the root suite:

- Android companion: **11 Jest suites / 555 passed / 0 skipped**, package TypeScript
  and lint passed, toolchain **15/15**, Metro assets **29/29**, autolinking **19/19**.
  All six commands passed once. The 53 source/config/asset inputs and 14 selected
  installed dependency inputs stayed unchanged; owned process groups exited. These
  are portable gates, not emulator/device installation or Android distribution.
- Local VM: the already-present, source-matching CUA 0.20.0 image passed the actual
  repository MCP smoke: **60 tools discovered**, PNG capture, app listing and pointer
  movement inside a disposable guest. Runtime/ownership checks **10/10**, cleanup
  **7/7** and four owned workspaces removed **4/4**. The nine pre-existing containers
  and 17 image records remained unchanged. Three earlier setup assertion failures
  were retained, each with **7/7** cleanup. No image pull/build or real bot/provider
  job ran. This used an internal network and guest Unix socket; live viewer, internet
  browsing and automatic product setup remain unverified. Evidence: `vm/README.md`.

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
- GLM's recommendation to dismiss the two image-size alerts as dev-only is unsupported.
  Fresh review confirms two separate high advisories: JXL/HEIF
  [CVE-2025-71329](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) and ICNS
  [CVE-2025-71330](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr). Both reach
  image-size 1.2.1 through Android Metro; no patched release was available. A forced
  2.0.2 upgrade remains affected and breaks Metro's callable CommonJS interface.
  Preserve the existing parent/worker parser mitigation and both open alerts. Its
  three runtime files match the retained Loop 37 actual-export evidence; that older
  export evidence was not rerun by this read-only review. A reviewed compatible
  parser backport or coordinated fixed toolchain is a future repair, with malformed
  input and actual worker-export gates. See `security/dependency-review.md`.

## Loop 69: recoverable onboarding and one mascot character contract

Onboarding now saves all seven stages using semantic version-2 step IDs. Legacy drafts
retain their exact profile, teammate, personality and task values and reopen Welcome;
the old numeric stage cannot be mapped safely across two wizard layouts. Current drafts
take precedence even when malformed, and failed migration writes retain the old copy.
Clearing a draft cannot expose an older version when storage removal fails. Storage
remains best effort; fields that the old validator never saved cannot be recovered.

The new browser recovery case found a second real defect: the default Flower and picker
Blob were absent from the server's accepted character list. The resulting PATCH 400
prevented any first-task message request. A browser-safe shared module now supplies the
client and server with the same ordered picker list. Existing Lottie values remain
persistable but hidden and rejected by character PATCH, as before.

Focused tests: draft **1 file / 54 passed**; character/store **2 files / 53 passed**,
all with zero failures/skips. Final full Vitest: **244 files / 3468 passed / 8 skipped /
0 failed**, 285.75s (287.886s command). Repository lint passed in 2.667s; production
build including frontend/server TypeScript passed in 50.781s; packaged-server smoke
passed **9 checks** in 13.971s including its server build. Independent review found no
material blocker in migration, the shared contract, or the narrowly scoped fixture 503.

Browser attempt 1 retained **11 passed / 1 failed**: the genuine default-Flower rejection
above. Attempt 2, after the product fix, retained **12 passed / 1 failed**: the final
reply-text locator also matched the sidebar and completion notification. The trace
confirmed actual 503 recovery followed by a 202 send and persisted user/reply rows.
Only the test locator was narrowed to the transcript row for the final browser run.
All owned resources from both failed runs were removed and observed inputs unchanged.

Final repository Playwright: **13 passed / 0 failed / 0 skipped / 0 flaky**, 69.557s
(70.557s command), one worker and zero retries. It covers the original approval/pairing
cases plus seven-step draft reload at 320px/1280px, legacy migration, A→B→A account
isolation in one tab, explicit template submission, pre-forward 503 recovery followed
by a real fixture-server 202 and one persisted user/reply, and accepted/rejected mascot
PATCH readback. All 932 observed source/build/harness hashes stayed unchanged; all 108
observed owned process identities exited, 48 ports refused connections, and 13 fixture
roots were removed. Settled wizard screenshots were visually inspected. No live Google
consent, real provider task, native installation or production revision is implied.
Evidence: `onboarding-e2e/attempt-3/`; the final locator-only adjustment did not change
any product input used by the successful full Vitest/build/package checks.

Loop 69 is pushed as `f40e9d7`. Its CI and autodeploy runs again contain **4 jobs blocked
by billing, 1 skipped build and 0 executed steps**. Production GETs returned 200,
but the served `index-CT_q0_0R.js` still contains the old literal v1 onboarding draft
key. Desktop metadata remains 1.12.0 / `e241968`. No exact backend revision or new
installed release is established. Receipts: `release/loop69-*.json`.

## Loop 70: Flower expressions render in Chromium

Only the two applied CSS transform strings changed: lengths now use px, angles deg,
and multi-argument functions use commas. Canonical paths, poses, gaze math, eye
anchors and motion policy are unchanged. Actual component/CSS rendering in owned
Chromium passed **30/30 grouped checks**, zero failures, on the first run: all 15
poses, both eyes, five gaze samples, four animation/spin combinations, fixed-time
animation matrices and reduced motion. Screenshots at 1280px and 320px were inspected;
there were no external resource requests or page errors, and the browser closed.
This is component browser acceptance, distinct from the full-app tests in Loop 69.

Full Vitest: **244 files / 3468 passed / 8 skipped / 0 failed**, 301.67s (303.221s
command). Repository lint passed in 2.081s and production build including frontend/
server TypeScript passed in 53.144s. Source hashes remained frozen. Evidence:
`flower-repair/completion.json`, `flower-full-vitest-result.json`, build/lint receipts.

The five inherited Loop 50 edits also now pass actual **watchOS and iOS simulator
builds**, 27.674s and 27.414s, with signing disabled and no developer identity. A frozen
snapshot overlaid exactly those five preserved files; XcodeGen passed. All 86 checkout
iOS source hashes and 26 original simulator identities/states stayed unchanged; all
three command groups exited. No device was created, booted or installed. This closes
the missing compile gate, but **Watch interaction acceptance is still zero for this
pending migration**; do not commit its five product files yet. Evidence:
`native-unsigned/summary.json`. The simulator linker may emit its normal ad hoc
Mach-O signature; this is not distribution signing or notarization.

### Post-roll observation — 12 September, 15:49–15:50 UTC

Loop70 is pushed as `2acc705`. **204 seconds after its push workflow started**, GET
health/app/downloads returned200 and the app served a new `index-DvR35QXt.js` bundle.
GET inspection positively confirms the semantic seven-step list, v2-first draft read
with legacy fallback, and corrected Flower px transform. This supersedes the earlier
old-bundle observation. Health now reports process7, but provides no backend commit;
an authenticated production first-task flow and exact server SHA remain unverified.

Its GitHub jobs still show **4 billing-blocked jobs,1 skipped build,0 executed steps**.
The observed web rollout therefore must not be attributed to those jobs or described
as blocked solely by them. The actual successful deployment path was not established.
Desktop download metadata remains1.12.0 / `e241968`; native release limitations stand.
Receipts: `release/loop70-post-roll.json`, `loop70-served-markers.json`, `loop70-ci.json`.
All12 pending native/research/template files were restored and matched their original
hashes; the original stash remains. Final restoration receipts document temporary
publication-only preservation. This documentation update changes no tested product.

Continue with the ranked repairs above, one verified commit at a time. Preserve the
inherited native work, report actual failures, and distinguish browser fixture acceptance,
real provider consent, production deployment and native release.
