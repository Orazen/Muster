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
| P1, contained in Loop74 (`175a88d`) | Newly advertised Drive consent is unreachable: hosted routes hit the existing global workspace denial; desktop Host values with ports fail. | Checked capability now replaces the misleading Connect control; configured installation Drive is preserved. Hosted global backup denial remains. Account consent is unavailable until its full ownership contract is ready. |
| P1, contained in Loop74 (`175a88d`) | Drive token exchange does not verify Google subject or granted scope and can combine one account's access token with another refresh token. | Account connect/callback/push/pull are disabled before token/state operations. Before re-enabling: verified identity/scope, coherent separate grant, one-use session-bound consent intent, actual route and SQLite tests. No hosted secret in desktop packages. |
| P1, repaired in Loop75 | Best-effort message insert failure can leave a missing predecessor in a later durable branch. | Required missing ancestors and the selected leaf now commit atomically. Exact paths/parents, real SQLite rollback and fresh-process restart pass. Already-lost memory is not recoverable. |
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


## Loop 71 — hosted Vault and briefing containment (12 September 2026)

Authenticated hosted accounts could reach the installation Vault routes. A second
owned reproduction found daily briefings exposing the other account's bot names and
the installation's Vault-empty status. Hosted requests now receive403 for the exact
Vault route family before body parsing/file operations; briefings filter bots through
existing ownership rules and return without reading Vault state. Local Vault status,
validation and installation Drive behavior remain supported. Only the server router
and its owned HTTP harness changed.

Final focused acceptance: **1 file / 87 passed / 0 failed / 0 skipped**,4.58s. Full
Vitest: **244 files / 3520 passed / 8 skipped / 0 failed**,355.21s (357.626s command).
Server typecheck passed12.197s; repository lint passed2.627s; rebuilt packaged server
passed **9 checks**,17.413s. The unchanged renderer's production build passed92.931s
before the server-only briefing amendment. All653 observed source inputs still match
the freeze. Each final owned HTTP fixture stopped both servers, closed four ports,
made zero outbound attempts and removed its temporary root.

Keep the failed evidence: four expected pre-fix Vault GET failures; the configured
Vault baseline could not open the absent native SQLite binding. Therefore the Vault
baseline proves route accessibility, not configured-data exfiltration or transfers.
The briefing reproduction separately proves actual synthetic other-account names and
Vault metadata disclosure (2 expected failures,2 local/auth passes). A mistaken test
name precondition was corrected using returned bot names, with that first failure
retained. The initial83-test and3516-pass full-suite results precede the amendment;
the87/3520 results above supersede them. No full security assessment is implied.

Evidence: `.omb-scratch/verification/loop71-vault-containment/` and
`.omb-scratch/verification/astra-onboarding-refresh-2026-09-12/loop71-final-*-result.json`.
Next: verify the prepared Flower onboarding frame; retain the12 shelved inherited
files unchanged. Account-linked Drive containment and portable v2 restore remain
required before any all-chats/files/session backup or automatic sync promise. The
current v1 bundle is partial and needs the original installation secret as well as
its passphrase. This removes a data-boundary defect; no revenue uplift was measured.
Push and production revision still require their own receipts.


## Loop 72 — guided onboarding and visible recovery (12 September 2026)

The seven-step setup now has a stable desktop frame and compact mobile guide using
Muster's canonical Flower mascot. Ordered, named progress and focused stage headings
make navigation/restoration explicit. Long failures reveal themselves above the form;
editing does not repeatedly steal focus. Escape in provider Settings closes Settings
without abandoning onboarding or discarding the account's draft. Existing semantic
steps, v2 draft ownership, checked finish/retry and explicit sending are preserved.

Verification: production build including frontend/server types passed **125.821s**;
final repository lint passed **2.679s**. Full Vitest **244 files / 3520 passed / 8 skipped /
0 failed**,407.76s (410.444s command). Final owned Playwright **15 passed / 0 failed /
0 skipped / 0 flaky**,177.727s, one worker and zero retries; test types/scoped lint also
passed. All932 observed source/build inputs stayed unchanged;172 observed owned
processes exited,57 ports closed and15 fixture roots were removed. The first browser
attempt retained14 passes/1 helper-precondition failure: normal CSS settled to an
identity matrix rather than the literal `none`. Only that expectation was corrected;
reduced-motion assertions remained. Product inputs were unchanged between attempts.

Browser acceptance covers all seven steps at320x568 and1440x900, long/expanded inputs,
keyboard progress/back/restore, provider Settings Escape, reduced motion, account
isolation, template prefill and failed-send recovery followed by an explicit successful
retry. Seventeen final screenshots were independently reviewed. A nonblocking existing
teal teammate-avatar edge is clipped in the desktop preview; cause remains unverified
and is queued separately. The tour's existing autoplay remains a subsequent slice.
Owned offline engine acceptance is not real Google consent, a production task, native
installation, full accessibility certification or measured conversion/revenue uplift.

Evidence: `.omb-scratch/verification/astra-onboarding-refresh-2026-09-12/`, especially
`shell-tests/attempt-2/summary.json`, `shell/visual-review.json`, and `loop72-*-result.json`.
The12 inherited native/research/template files remain separately preserved until the
verified commits finish. No native release is claimed; physical Watch/editor acceptance,
Intel runtime and Apple distribution signing remain open. The handoff will retain the
portable-backup and account-linked Drive acceptance gates.


## Loop 73 — durable installation and recovery handoff (12 September 2026)

Loop72 product is committed and pushed as **`e6bbf16`**. The native personal-testing
copy and research are now documented in three durable files:

- [Personal iPhone/Watch installation](../guides/personal-iphone-watch-install.md):
  prepared Xcode project, free Personal Team steps, separate phone/Watch schemes,
  seven-day renewal and physical acceptance limits.
- [OpenMaus onboarding decisions](openmaus-onboarding-study-2026-09-12.md): installed
  0.1.74 versus pinned source0.1.75,259 documentation-area files inventoried/30 selected
  files inspected, adopted frame and measurable next-slice acceptance.
- [Portable backup contract](portable-backup-contract-2026-09-12.md): exact v1 scope,
  original-secret dependency, account-linked Drive containment, and fresh-install v2
  recovery gates before automatic Drive/Telegram sync.

Personal-testing copy verification: XcodeGen passed0.204s; generic simulator Watch
build **passed56.211s**, iOS **passed57.394s**, signing disabled. All90 copy inputs,
86 checkout inputs,5 exact inherited overlays and26 existing simulator identities/
states unchanged; owned command groups exited. **Zero physical installations, signing
operations or runtime tests** in these compile gates. No Apple account or phone/Watch was
modified. The copied iPhone capability/entitlement omit Time Sensitive Notifications
for Personal Team compatibility; main application source is unchanged. The normal
linker ad-hoc signatures are not development/distribution signing.

This documentation-only slice adds **0 new runtime tests**; it preserves Loop72's
**244 files / 3520 passed / 8 skipped / 0 failed**,15/15 browser acceptance, successful
build/types/lint and source freeze. All5 intended local links in the three documents resolve; raw scratch evidence is explicitly local-only.
Evidence remains under `.omb-scratch/verification/astra-onboarding-refresh-2026-09-12/`.

Next product slice: contain the unchecked account-linked Drive flow while preserving
configured installation Drive; then user-paced Tour/readiness recovery and portable
file restore. The inherited five-file Watch composer migration still requires real
system-editor/lifecycle acceptance before committing. Real Google consent across
platforms, complete encrypted backup/restore, signed/notarized native distribution,
Intel runtime, the advertised CLI version and the full Mimosa rerun remain open.
Two distinct image-size high dependency alerts remain open. No comprehensive security,
all-data sync, new native release, revenue uplift or public-launch completion is claimed.


### Loop72 production observation — 12 September,16:42–16:43 UTC

GET now serves **`index-Wta1ET2F.js`** with all four new onboarding markers and
**`index-DSXB0S8I.css`** with the frame, Flower guide, progress and scroll rules.
Health/app/assets/download metadata return200; anonymous Vault status and briefing
return401. This supersedes the earlier old-bundle observations. The exact backend SHA
and authenticated production onboarding/provider flow remain unverified. Desktop
metadata stays **1.12.0 / `e241968`**.

GitHub records **4 billing-blocked jobs / 1 skipped build / 0 executed steps** for
`e6bbf16`; every failed job has the payment/spending-limit annotation. Those jobs did
not attest the observed rollout, whose successful path remains unestablished. Board
billing action is still needed for hosted CI; do not equate this with a stale web build.
Receipts: `loop72-public-get-initial.json`, `loop72-public-get-post-roll.json`,
`loop72-public-get-final.json`, `loop72-served-css.json`, `loop72-ci-annotations.json`
under the current local evidence root. No further product changes or test reruns.


## Loop 74 — checked Drive capability and contained account backup (12 September 2026)

Settings now reports backup availability from a strict versioned capability. Hosted
accounts see the local-only explanation without installation credentials, account-token
state or backup timestamps. Local Drive controls use the separately configured
installation transport; Google sign-in is explicitly not a backup connection. Loading,
failed and malformed status keep writes disabled with an explicit retry. Four unchecked
account-linked connect/callback/push/pull routes return501 locally before reading bodies
or changing state; authenticated hosted family denial remains403 and anonymous status401.
Existing installation Drive/file/Telegram behavior is preserved.

The card retires requests when its session or mounted instance changes, validates
success bodies and guards after asynchronous reads before writes/downloads/reloads.
Pure helper tests cover retirement and duplicate-operation prevention; the browser
covers Settings close/reopen retirement, not a mounted account-switch flow. No stale
backup timestamp or unchecked Connect link remains. Eleven screenshots were reviewed
at320px and1440px with no blocking layout finding. A nonblocking follow-up is to make
mobile success confirmation easier to notice below the scroll boundary.

Verification on the final source: full Vitest **245 files / 3609 passed / 8 skipped /
0 failed**,296.13s (297.28s command); build including frontend/server types **passed
53.078s**; repository lint passed1.488s and final test annotation types/scoped lint
passed6.825s/0.298s. Packaged server **9/9 passed**,11.295s, Node22.22.3 arm64.
Focused owned HTTP **139/139**,8.97s; UI helpers **37/37**; existing transport **73/73**.
Browser **4 passed / 0 failed / 0 skipped / 0 flaky**,19.467s, one worker and zero retries.
The browser observed957 source inputs,334 build inputs and3 ignored metadata files
unchanged; all23 observed processes exited,8 ports closed and4 fixture roots removed.
The final HTTP fixtures exited all10 servers, closed20 ports and removed their roots.
Root final verification found all957 frozen source inputs unchanged.

The route harness uses real owned auth SQLite rows, HTTP, encryption/decryption and
same-install memory restoration with synthetic Google responses inside the child only.
Distinct synthetic Google login and installation credentials prove transport separation.
It exercises configured/unconfigured/blank readiness, all contained routes, failed
refresh/list/upload/download/decrypt/restore and held connection replacement. All sync
stamp files are compared, not only the local stamp. No real Google account, token,
provider traffic, demo8845, existing simulator or native app was used.

Failure history is retained: first HTTP run134/135 because Node fetch ignored the
supplied Host header; a wire probe confirmed the cause and the test now uses node:http
for the actual invalid Host. Later135/135 runs preceded four extra configured-route
checks. The initial integrated build failed with12 TypeScript diagnostics from recursive
inferred fixture types; explicit test-only annotations fixed it. Final build and full
suite above verify that source. No failure was hidden or expectation weakened.

Evidence is local-only under `.omb-scratch/verification/loop74-drive-capability/`:
`final-verification.json`, build/full-vitest/packaged-server result files, server-tests,
UI and browser receipts. The refreshed [backup contract](portable-backup-contract-2026-09-12.md)
keeps v1 partial scope and original-secret dependency explicit. This slice does not
establish portable recovery, real OAuth, transactional restore, native distribution,
whole-codebase security or revenue improvement. Two image-size high alerts remain open.

Next bounded correctness slice: recover Store conversation ancestry after a best-effort
SQLite insert fails. The reproduced A→B, failed C, durable D chain loses A/B from the
active path on restart. Persist missing ancestors and the new leaf atomically; verify
exact paths and parents across restart, rollback, repeated recovery and explicit branch
selection. Do not mask missing ancestry by concatenating unrelated rows. Separate
remaining work includes Watch editor/lifecycle acceptance, user-paced onboarding Tour,
portable v2 file restore and native signing/runtime gates. Twelve inherited native,
research and template files remain preserved outside this commit; restore from this
loop's owned receipt after publication, retaining the original stash.


### Loop74 publication receipt — 12 September 2026

Verified product commit **175a88d** is pushed. At17:19:55UTC, GET positively serves
`index-DCAkTz04.js` with all four new backup markers: configured-computer Drive,
explicit status retry, account-Drive-unavailable code and installation push route.
This supersedes the old-bundle observations through17:18:33UTC. Health/app/assets/
download metadata return200 and anonymous workspace status401. That401 does not
establish the backend revision or authenticated production acceptance. Desktop metadata
remains1.12.0 / `e241968`; no native release. GitHub records4 billing-blocked jobs,
1 skipped build and0 executed steps for this SHA; all four failures carry the payment/
spending-limit annotation. Board billing action remains required. Those jobs did not
attest the observed web rollout, whose successful path remains unestablished.

This receipt adds0 runtime tests; the verified product suite remains245 files/3609
passed/8 skipped, browser4/4 and packaged server9/9. The two local links in the updated
backup contract resolve2/2. Current allowance is53%used/47%remaining; reported reset
19September2026,16:43Europe/Rome;0 available reset credits and none consumed. The
existing hourly CEO heartbeat retains its cadence, quiet reporting and2%handoff/1%pause
rules, with Store ancestry recovery next. Do not create another automation.

Local receipts: `.omb-scratch/verification/loop74-drive-capability/public-get-*.json`,
`ci-annotations.json`, `allowance.json` and `contract-links.json`. After this receipt's
commit, restore only the12 inherited paths from this loop's preservation receipt and
verify all12 SHA256 values. Keep original stash4d13860fa6cb858efc48713dba9fb4637c7101e7;
consult the restoration receipt before any later stash action.

Store implementation map for the next owner: `ThreadState` tracks unpersisted IDs;
collect only the selected parent chain. Extend MessageDB's existing append transaction
with a narrow batch-and-leaf operation, inserting required ancestors before the new
row and active leaf. Avoid nested transactions and blind INSERT OR REPLACE of existing
rows. Append uses its resolved parent; `branchMessage` uses the source's parent,
not an unrelated volatile tail; `setActiveLeaf` repairs the selected newest descendant's
ancestry. Publish strict updates only after commit and preserve seed-answer semantics.
Extend persist-failure-store, store and message-db tests with real SQLite rejection,
exact parent/path/leaf assertions and a bounded fresh-child restart. Detailed anchors
remain in the local `next-Store-slice.md`; this map was read-only, with0 new tests.


## Loop75 — durable conversation ancestry (12 September 2026)

Store now tracks rows missing after best-effort inserts. Before a durable descendant,
branch replacement or selection of an unsaved leaf, it persists only the required
parent chain and new head in one SQLite transaction. Failure rolls back every row and
retains pending markers for retry; strict changes emit no success event. Recovery uses
the latest in-memory message, including subsequent patches, and never replaces a
conflicting durable row. Existing seed-answer compare-and-swap behavior is unchanged.
The normal append path avoids a history scan even if another branch is still pending.

Verification: **245 files / 3633 passed / 8 skipped / 0 failed**,284.33s (285.442s
command). Focused **149/149 across4 files**,3.45s; final server types passed7.75s,
lint1.823s; rebuilt packaged server **9/9**,10.637s, Node22.22.3 arm64. All957 source
inputs remained frozen. Added24 cases:18 database cases and6 Store cases; the original
recovery test now compares exact messages/parents/leaf rather than only row counts.
A fresh process with an8s bound reopens actual owned SQLite, asserts exact transcript/
active path/leaf, zero network attempts and exit0. Owned DB closure/data-removal
assertions pass. Console receipts were not emitted by this runner even with silent
output disabled; no independent process inventory is claimed.

Baseline regression was **4 passed / 1 failed**: durable D referenced the omitted
memory-only C. Initial typechecking found one nullable-variable annotation error;
that type-only correction preceded the final typecheck/full suite. The final review
found no further blocker. Evidence: local `.omb-scratch/verification/loop75-store-ancestry/`,
including baseline, suite-verification, source-freeze-final and review-final receipts.
No real provider, demo8845, existing native app or simulator was used.

This repairs missing inserts while their data remains in memory. It does not recover
RAM already lost in an earlier process crash, replay failed patches of existing rows,
or provide portable backup. Delayed insertion of an older branch can change global
row order; equal-timestamp sibling reselection is a separate P2 acceptance follow-up.
No browser/layout or physical-device acceptance is claimed for this server-only slice.

Next P2: make first-bot creation recoverable across bots.json and SQLite so a seed-write
failure cannot leave an error response and a duplicate on retry. Prepare both seed IDs
and a creation intent, use the owner-file replacement as an explicit commit point, and
reconcile interrupted preparation on startup. Test real insert/file failures, forced
process exits before/after commit, HTTP retry/readback and owner-before-message events.
A memory rollback alone is insufficient across both stores. See local next-create-slice.md;
no implementation or new creation tests are claimed yet. Drive P1 findings are contained
by Loop74; provider consent, portable recovery, native release and full scanner gates remain.


**Loop75 publication receipt (2026-09-12T17:39:18.595002+00:00):** product **c51c577** is pushed.
GET health/app/assets/download metadata200; anonymous workspace status401. Served
frontend remains `/assets/index-DCAkTz04.js` with Loop74 backup markers, as expected for a
server-only slice. These checks establish availability, **not the exact deployed
backend revision or authenticated recovery behavior**. Desktop metadata remains1.12.0.
GitHub records4 billing-blocked jobs,1 skipped build and0 steps for this SHA; board
billing action is still required. No additional runtime tests in this receipt: full
245 files/3633 passed/8 skipped, focused149/149 and packaged server9/9 remain the gates.
The existing heartbeat is verified ACTIVE with its original cadence and next creation
slice;42% allowance remains, reported reset19September2026,16:43Europe/Rome, no reset
consumed. Consult this loop's preservation/restoration JSON before touching pending
files or stashes; all12 inherited paths must be restored byte-for-byte before stopping.


## Loop76 — authenticated team owner boundaries (12 September 2026)

**Fixed P1 paths:** `PATCH /api/groups/:id` accepted another owner's bot;
`POST /api/teams/export` exposed foreign profiles; replace import archived foreign
bots and returned them; `GET /api/security-scan` disclosed foreign identifiers and
findings. The session gate alone did not protect member IDs or whole-roster handlers.
All four now apply owner scoping, including primary-versus-other-owner behavior and
legacy unowned records. Invalid room membership aborts accompanying field changes
with a generic400. Valid lists deduplicate while preserving order. Secondary default
export names use their own account profile.

Old mixed-owner rooms remain on disk, but new messages return409 before user echo/
SQLite head changes. Dispatch validates the whole current roster before claiming a
bot and after connector setup, including cached member membership. Tests use actual
hosted sign-up sessions for primary/Alice/Bob, a legacy foreign-owner fixture and a
local server; distinct names/descriptions are persisted through the real edit route.
They verify private export content, foreign records unchanged on import, exact
SQLite/roster/file stability on refusal, and valid local/owned behavior. No real
provider or account is used; owned child cleanup/no-outbound assertions pass.

Final full **246 files / 3657 passed / 8 skipped / 0 failed**,406.35s
(407.610s command); new ownership harness24/24 in6.84s; prior combined56/56 in17.64s.
Server types17.319s, lint4.672s, build77.174s, packaged server9/9 in17.325s,
broker2/2 in0.416s, updater14/14, Electron syntax pass. Runtime Node22.22.3/arm64/macOS
and pnpm10.33.0: this is local verification, not Ubuntu/Node24 Actions or native
Electron launch acceptance. Build retains large-chunk and ignored-override warnings.
All956 final source inputs match; hash-pinned review found no blocker.

Retained failures: baseline5passed/17failed included real route regressions and
test-authoring defects; malformed table cases were corrected. First fixed run54/56
failed only on public ownerId assertions; wire omission is intentional, so assertions
now check persisted rows. Four lint errors were corrected. A passing earlier full
run began before corrections and is superseded by the frozen final run. Evidence:
`.omb-scratch/verification/loop76-network-direction/`, especially `verified-source.json`,
`owner-boundaries-review-final.json`, command logs and team-ownership-tests receipts.

**Open P1:** internal peer tools still share an installation bearer; see the
[scoped-capability next slice](peer-capability-next-slice-2026-09-12.md). Historical
foreign data in already-mirrored rooms is not retroactively removed. Post-await and
queued-dispatch branches are source-reviewed, not held-transport runtime acceptance.
These limits prevent a comprehensive isolation/security or public-launch claim.
Native signing/runtime, full portable backup, real Google consent, VM execution,
Mimosa and two high dependency alerts remain separate gates. The current scheduler
was observed PAUSED; old ACTIVE/hourly entries are historical.
