# Verified slice log

## 2026-09-09 — AGI harness sequence

Full-suite results below are actual Vitest runs before each slice's commit.
Each run had eight skipped tests. Server typecheck passed for each slice.

| Slice | Commit | Full-suite files passed | Tests passed |
| --- | --- | ---: | ---: |
| Ordered plan evidence on approval cards | `c917461` | 174 | 1703 |
| Offline fleet evaluation and durable scorecards | `bd07727` | 175 | 1717 |
| Bounded why-journal and scorecard MCP reads | `5ba9217` | 176 | 1728 |
| Delegation with authenticated receipt context | `8b3a54f` | 177 | 1737 |
| Previous-run why evidence on companion approvals | `527e082` | 178 | 1743 |

Shipped areas: approval cards and thread evidence; fleet evaluation and CLI
bundle; fleet MCP evidence reads and delegation; companion models and iOS/Watch
approval views. Detailed scope and limits are in `plan-rehearsal-v1.md`,
`fleet-eval-playbook.md`, `fleet-evidence-tools.md`,
`fleet-receipt-delegation.md`, and `watch-approval-history.md`.

Companion verification: 91 Swift tests passed, zero failures; unsigned iOS and
Watch simulator builds succeeded. Web and server typechecks passed. Scoped lint
passed; the repository-wide lint run still reported pre-existing failures.

Evidence limits: rehearsal checks ordered tool names from successful prior
runtime evidence, not arguments or current screen state. The evaluator grades
supplied captures and does not independently attest provenance or task quality.
Watch evidence is explicitly from the previous run; this slice adds no new
background push delivery. No live five-step competitor benchmark was performed.

Commercial implication: these slices make fleet behavior inspectable by an
operator and produce repeatable evaluation records. They establish product
capabilities, not evidence of customer demand or measured revenue.

## Loop 1 — 2026-09-09 — Mistral Vibe verification and ownership handoff

Slice: register the eleventh CLI/ACP engine with confirmed session model and
approval mode, and retain prior tool metadata for sparse permission callbacks.
Implementation was included in concurrent commit `6de16e8`; this follow-up adds
the regression tests, config precedence correction, and verification record.
The board assigned sole ownership to Astra. The inherited coordination-rule
edit is reconciled in `AGENTS.md` and `astra-ceo-mandate.md`; there is no longer
an active ZCode handoff dependency.

Shipped files: `server/drivers/acp/vibe.ts`, `tool-context.ts`, `core.ts`,
`vibe.test.ts`, `server/drivers/builtIn.ts`, `server/config.ts`,
`server/config.test.ts`, `server/testing/fake-acp-cli.ts`, and
`docs/plans/engine-parity-vibe.md`.

Verification: 76 focused tests passed across three files; server typecheck and
scoped lint passed. Full suite: 179 files passed, 1757 tests passed, eight skipped,
zero failures (204.25 seconds). This adds 14 tests to the preceding slice.
Production GET checks returned 200 for `/` and 401 for `/api/instances` without
credentials. This confirms public reachability only; the authenticated engine
catalog and a live Vibe turn remain unverified.

Commercial implication: Vibe users can retain their configured model while
joining the same fleet approval workflow. Eleven registered engines is an
inventory count, not live task-quality parity. No paid provider turn was run.

Next pick: audit the end-to-end harness against the five-step evaluation and
record concrete failures; live evaluation remains outstanding.

## Loop 2 — 2026-09-09 — Preserve approval and liveness states in fleet waits

Audit findings: **P1** `wait_for_conversation` returned `working` for real human
approvals because the store derives `busy: true` for `waiting-on-you`. **P2** the
same ordering hid `no-signal` as `working`. Both were reproduced through the MCP
protocol; the previous approval fixture covered an idle bot only.

Fix: prioritize explicit dead, waiting, and no-signal states before the generic
busy fallback. A pending approval returns `needs-user` on the first observation,
even when its card falls outside the transcript excerpt; no-signal returns
`stalled`. Existing idle-card and actively-working behavior remains covered.

Shipped files: `server/fleet-mcp.ts`, `server/fleet-mcp.test.ts`, and this log.
Four new regressions cover store-generated busy states, missing card excerpts,
and a working-to-waiting transition. No approval is answered by the waiter.
Before the fix: four targeted failures (`working` instead of `needs-user` or
`stalled`). Final scoped run: 24 tests passed, zero failures. Server typecheck
passed. Full suite: 179 files passed, 1761 tests passed, eight skipped, zero
failures (175.76 seconds). Independent diff review found no actionable issues.

Open **P3** audit item: scoped oxlint reports 18 pre-existing findings in the
fleet MCP module and its tests (unparsed boundary types, unchecked assertions,
and object-construction rules). The reported lines are outside this state-order
change; lint is not recorded as passing. The broader lint debt remains open.

Commercial implication: external fleet operators can surface human approvals
and liveness interruptions promptly instead of spending the full wait window
polling. This is a correctness improvement, not measured revenue uplift.

Next pick, confirmed **P2**: `scoreFleetCapture` checks receipt start time but
ignores its duration. A capture ending at 10:01 with a receipt starting at
10:00:01 and lasting one hour incorrectly passes and exposes receipt metrics.
The next slice must reject a derived receipt end after the capture (including
non-finite sums) and retain the exact-end boundary. This is internal timing
consistency, separate from the documented limits on provenance.

Hourly continuation is active in the current task under the standing mandate;
paid activation and other board-level actions remain gated.

## Loop 3 — 2026-09-10 — Use and improve the account entry experience

The board requested hands-on use of the live app and a UI improvement. The live
landing-to-app flow reached sign-in; the existing Google tab still awaited user
authentication. This slice covers sign-in, signup, and recovery. Authenticated
fleet use remains unverified; no production account or provider session was changed.

Findings fixed: **P2** the auth surface could clip content on short screens
because the surrounding app disables body scrolling; **P2** signup advertised
eight characters while the server requires twelve; **P2** desktop OAuth support
was dropped while loading capabilities. Also restored the capability-gated
password recovery link, persistent input labels, readable account/error text,
password visibility controls, and keyboard submission of the separate pairing
form. Return destinations now remain local after URL normalization, including
the dot-segment edge case caught during review.

The visual update uses a warm two-column workspace introduction on desktop and
a focused single-column form on mobile. The illustration is decorative and
contains no invented activity, customer metrics, or benchmark results. Operator
environment-variable instructions were removed from customer-facing entry forms.

Shipped areas: `AuthShell.tsx`, scoped `auth.css`, `AuthPasswordField.tsx`, the
four auth pages, `src/lib/auth.tsx`, `auth-navigation.ts`, and two regression test
files. Google account selection, referral redemption, and approval ownership
retain their existing behavior.

Verification: 13 hands-on browser checks passed against a disposable local API
fixture: show/hide password, Enter-to-sign-in with error feedback, recovery
confirmation, 390px layout, short-password rejection, 320px scrolling, desktop
capability hydration, unavailable recovery, Enter-to-pair, missing-token
recovery, mismatched reset passwords, and keyboard reset submission with error
feedback. Fixture logs contain method/path only; no real email or account was
created. Focused tests: **2 files / 27 passed / 0 skipped**. Final full suite:
**181 files / 1788 passed / 8 skipped**, 183.62 seconds, after the final redirect
correction. This exceeds the handbook baseline of 172 files / 1689 passed / 8 skipped.
Both typechecks, scoped lint, and the Vite production build passed. Vite still
reports large chunks; this slice makes no bundle-size improvement claim.

Commercial implication: account entry now explains the product, keeps controls
readable and reachable on phones, and exposes available recovery paths. No
conversion improvement is claimed without usage data.

Next pick: resume the confirmed receipt-timing audit defect from Loop 2; review
the authenticated fleet UI when a user session is available. The board's UI
request took priority for this cycle.

Release follow-up: UI commit `3ee3a9d` was pushed. GitHub CI and autodeploy
failed before running any steps; their annotations report failed account
payments or a spending limit. The local test numbers above remain the verified
results. Board action is needed to restore hosted Actions billing. Used the
existing `.deploy-trigger` mechanism documented in the autodeploy workflow to
request the same release through Dokploy's GitHub App webhook. Production was
still serving the previous UI when the fallback trigger was requested; live
rollout confirmation remains pending. No billing settings were changed.

## Loop 4 — 2026-09-10 — Responsive conversations and receipt evidence

The board expanded the UI request to Gaia components, all-page browser testing,
and mobile/desktop parity. Rechecked Gaia UI at `14e20153` and OpenMausBot
v0.1.70 at `67336fb2`. Corrected outdated competitor claims: current source
includes fleets, mobile companions, approvals, and receipts. This research ran
**0 competitor executable tests / 0 competitor runtime checks**; no comparative
performance or product-superiority claim follows from it.

Fixed reproduced conversation defects: overlapping phone header actions,
off-screen task/model menus, hidden reactions and provenance squeezing message
bodies, and the floating fleet indicator covering Send. Controls now respond to
the conversation column; task/model remain primary, secondary actions live in
Tools, and Stop remains directly available. Fleet status occupies a compact
footer, with a bounded keyboard-accessible attention menu. Waiting bots appear
once rather than again under Working. OS navigation moved into the sidebar;
account sign-out remains in Settings. Notifications fit narrow viewports.

Integrated the actual MIT Gaia StatRow source using Muster tokens and Lucide,
with the complete license shipped in public third-party notices, also covering
the existing Gaia message-bubble adaptation. Job receipts use a scrolling Radix
dialog with focus restoration. Metrics and copied text come from one server
snapshot; missing usage is explained, missing legacy costs remain unknown,
reported zero costs remain zero. Receipt sharing retains the published URL and
offers manual copying if clipboard access fails instead of claiming it copied.

Verification: **26 distinct hands-on browser checks passed** using real isolated
email authentication, onboarding, session persistence, task selection, message
sending, receipt copying, Deny/Allow once, repeated approval, Stop, and Inspector
cancellation evidence. Layouts checked at **320×568, 390×844, 768×1024, and
1440×900**, including a 660px conversation beside Inspector. The 320px Send
button had 31px clearance from the fleet footer. These are browser-driven
checks, not 26 checked-in Playwright tests. The engine was the local scripted ACP
fixture; no real provider response, Google login success, native app, microphone,
payment, or external integration is counted as verified.

Focused tests: **2 files / 16 passed / 0 skipped**. Final full suite:
**182 files / 1799 passed / 8 skipped**, **207.62 seconds**. Both typechecks,
scoped lint, diff checks, and Vite build passed (3032 modules; 8.05 seconds).
Large-chunk warnings remain. This exceeds both the handbook baseline and Loop 3.

The expanded settings sweep opened/read **14 of 15 available sections**; Usage
blanked the app. Independent reproduction traced this to InviteSection fetching
and updating state during render: **25 stub fetch attempts**, then React's
too-many-renders error, with **0 external requests**. Mobile Settings also leaves
roughly 100px for content beside its fixed navigation. These are the next bounded
slice, documented with the remaining route/native inventory in
`docs/plans/ui-e2e-program.md`; the complete product is not yet E2E-certified.

Production follow-up: GET and a fresh browser visit now confirm the earlier
account-entry redesign is deployed (`index-CpkiQPaW.js`, auth shell and password
controls). The current conversation slice still needs its own rollout check.
Hosted Actions billing remains a board item; no billing setting was changed.

Commercial implication: users can act on approvals and inspect real work from
a phone without composer obstruction. No conversion or revenue lift is claimed.


## Loop 5 — 2026-09-10 — Usable Settings and reliable saved drafts

Resolved the Usage crash found in Loop 4. Invitation loading now runs in an
abortable mount effect with visible retry; it no longer fetches or updates
state during render. Copy failures retain a selectable link and honest error
feedback. Wrapped clipboard retries reuse the existing link. Referral reward
values, prices, and payment behavior are unchanged.

Reworked Settings for phones: a native section selector replaces the fixed
sidebar, the header and close action stay reachable, and section content
scrolls independently within the viewport. Desktop navigation scrolls and
retains search. Fixed initial keyboard focus trapping, textarea/select and
native-disclosure navigation, Escape propagation in credential help, and
mobile selection after desktop filtering. Engine paths and credential controls
wrap; provider metrics use labeled summaries on phones. Profile fields have
persistent labels. Credential help links point to the self-hosting guide.

Browser testing exposed two Brain persistence hazards: the initial read could
arrive during typing, and overlapping saves could finish out of order. Brain
now loads the stored brief before enabling edits, offers separate load/save
retries, serializes blurred drafts, and only lets the current draft update
Saved/error feedback. Eleven delayed-response regression tests cover readiness,
write ordering, stale failures, retries, deduplication, and unmount behavior.

Verification: **45 Settings render/layout checks passed** — all **15 sections**
at **320×568, 390×844, and 1280×900** — plus **12 focused hands-on browser
checks**. The latter cover engine/help/provider fit, keyboard trapping and
native disclosure, Brain save/reload, Usage totals and provider history,
invitation copy, search/Escape/focus return, mobile selection after filtering,
and appearance persistence. Initial phone engine/provider defects were fixed
and checked again. Usage showed **6 fixture turns / 75 tokens**, and invitation
copy wrote the expected local URL. Atelier persisted after reload; Midnight
was restored. These are hands-on browser checks, not checked-in Playwright
case counts or proof of every Settings action.

The temporary test environment reset during the final pass. Rebuilt only the
owned isolated server and browser fixture, then repeated the final Brain exact
save/reload and Usage loading checks successfully; browser console errors
were **0** in that final tab. No demo sessions on port 8845 were stopped or
revoked. All test accounts and briefs were synthetic; external model/OAuth,
payments, native clients, and provider connections were not exercised.

Focused automated tests: **4 files / 33 passed / 0 skipped**, **1.13 seconds**.
Final full suite after the last code changes: **185 files / 1829 passed /
8 skipped**, **179.76 seconds**. This exceeds the handbook baseline and Loop 4.
UI and server typechecks, scoped lint, diff checks, and Vite build passed
(**5.70 seconds**). Large-chunk warnings remain. No security or comparative
performance claim follows from these checks.

Production GET follow-up confirms Loop 4 conversation assets are now served
as `index-DsorEPai.js`, including the new conversation controls and receipt
copy text. This is asset rollout evidence, not authenticated production E2E.
The Settings release needs its own post-push GET check.

Commercial implication: people can open Usage without losing the app, use
Settings on phones, copy their invitation reliably, and save a team brief
without silent stale writes. No conversion or revenue improvement is claimed.

Next pick: the public-route/copy audit, then the remaining auth recovery,
workspace, work-lifecycle, and native client checks in
`docs/plans/ui-e2e-program.md`. A static review of fourteen public HTML files
found a missing Docker anchor and unsupported network/backup/license/competitor
claims. Correct those in a separate slice without changing live pricing.
Hosted Actions billing remains a previously reported board item.


## Loop 6 — 2026-09-10 — Readable public pages and accurate handoffs

Audited all fourteen public HTML pages. The first 320px sweep found five
horizontal overflow failures: homepage 409px, Install 704px, Quick start
381px, For agents 813px, and Self-hosting 737px. The homepage now keeps the
brand, primary Download action and Menu reachable; secondary navigation sits
inside a bounded scrolling menu with Escape/focus return. Nine reference
tables sit in labeled keyboard-focusable scroll regions. Inline code and
callouts wrap without widening the guide; focus styles and reduced-motion
handling apply across the docs.

Corrected unsupported network/storage, complete-Google-backup, receipt-cost,
license and exclusive-capability claims. The comparison identifies its
August README snapshot and explains missing evidence. Removed unverified
blanket competitor characterizations and historical competitor price claims
from Switch; published Muster pricing is unchanged. Restored the actual
Docker anchor. These are selected claim corrections, not certification of
every remaining marketing statement. No pricing, billing or payment wiring
was activated or changed.

Verification: **42 public-page render/layout checks passed** (14 pages at
**320×568, 390×844 and 1440×900**), with **0 broken images detected** after
load. **9 focused hands-on browser interactions passed:** keyboard table
scrolling, bounded mobile menu/Escape/focus, mobile menu-to-docs, setup-prompt
copy, install-command copy, Docker guide anchor, FAQ disclosure, guide
navigation, and missing-document recovery. These are browser-driven checks,
not automated Playwright case counts. Installer execution, live catalog
imports, external integrations, and all auth/native workflows remain separate.

Static inspection of **14 HTML files / 284 internal links / 38 known-page
fragments / 2 inline scripts** found **0 detected fragment, duplicate-ID or
script-parse failures**. Those are static checks, not 284 runtime navigations.
The homepage pricing section matches the preceding commit exactly. GET
checks of the six published desktop/CLI artifact URLs returned **6 HTTP 200
responses with non-HTML content**, reading only the first 64 bytes. This is
reachability evidence only: no installation, full download, checksum,
current-source freshness or signing result is claimed.

Focused routing tests: **1 file / 6 passed / 0 skipped**, **5.13 seconds**.
Final full Vitest suite: **185 files / 1829 passed / 8 skipped**,
**169.01 seconds**. Both typechecks and diff checks passed. Two inline scripts
parsed successfully. Marketing HTML/CSS are served directly; the unchanged
application bundle already passed the preceding slice's Vite build.

The native toolchain inventory ran **0 tests / 0 builds / 0 native UI checks**.
iOS/Watch simulator toolchains are available. Android references missing
assets and an absent test preset; development Electron lacks its binary.
Installed native applications have unverified source freshness. These are
next-slice prerequisites, recorded in `docs/plans/ui-e2e-program.md`.

Commercial implication: phone visitors can reach navigation, read setup
instructions, and follow a working installation handoff. Corrected claims
set more accurate expectations. No conversion or revenue lift is claimed.

Next pick: auth recovery/pair/claim states, repair the misleading transcript
E2E case, then native simulator verification and the remaining workspace
matrix one bounded slice at a time. GET verification of the Settings/public
releases remains pending; do not create duplicate deployment triggers while
hosted Actions billing is blocked.


## Loop 7 — 2026-09-10 — Reliable self-host device-link recovery

Reproduced a blank application from `/claim#%`: `decodeURIComponent` threw
`URIError` during both development effect passes. The original effect also
cleared the fragment before re-subscription, showing a false missing-code
error during a valid request, and its success timer could navigate after
leaving the page. The claim flow now parses the link without throwing, keeps
one single-use submission through cleanup/re-subscription, validates server
confirmation and offers explicit retry only for transport/server failures.
It removes malformed fragments too, preserves query/router state, detaches
late UI updates, and cancels the redirect on departure.

Reused the responsive auth layout for loading, connected and recovery states.
Open console performs a full reload so it can recover an already-created
session after a lost or malformed confirmation. Browser testing caught a
WebKit fetch-receiver issue in the first implementation; the default transport
now calls fetch without binding it to the controller, with a regression test.
Read-only peer review identified the session-refresh recovery link before
commit. Both findings were corrected and exercised again.

**10 focused hands-on browser checks passed:** malformed-link recovery;
missing-link recovery after reload; anonymous console gate; a fresh lowercase
claim leading to the authenticated app; consumed-code rejection; alternate
sign-in navigation; explicit 503 retry to confirmation; leaving a confirmed
claim before its timer; leaving during a pending request; and recovering a
real session cookie after deliberately corrupted confirmation. **10 layout
checks passed:** missing, malformed and consumed states at **320×568,
390×844 and 1440×900**, plus retry at **320×568**. No horizontal page overflow
was detected in these checks. These are browser-driven checks, not automated
Playwright case counts.

The local server used disposable synthetic account data on port 18861,
with Vite on 15199. A temporary proxy on 18863 returned controlled 503/delayed
responses, then separately forwarded a real local redemption cookie while
corrupting its JSON confirmation. Logged request counts were one for the
pending flow and two only after an explicit retry; the recovery proxy saw
HTTP 200 with one session cookie. Both proxy processes and their tabs were
closed. The existing demo on 8845 was untouched. Physical camera scanning,
production redemption, native clients and real Google login were not tested.

Focused tests: **2 files / 37 passed / 0 skipped**, **576 ms**, including
**29 new claim-flow regressions** and eight existing server claim tests.
After test-only lint corrections, the 29-test file passed again in **351 ms**.
Both typechecks, scoped oxlint and diff checks passed. The final Vite build
completed in **5.46 seconds**, with the existing large-chunk warning.
Final full Vitest suite after the recovery-link correction: **186 files /
1858 passed / 8 skipped**, **174.45 seconds**. The earlier full pass was
also 186 files / 1858 passed / 8 skipped, in 176.30 seconds; it was repeated
because peer review required that functional correction. These results are
above the handbook baseline of 172 files / 1689 passed / 8 skipped.

Commercial implication: a broken or interrupted setup link now has a usable
recovery path, and a successful claim survives development remounts without
confusing failure feedback. No activation, conversion or revenue lift is
claimed. No pricing or identity provider wiring changed.

Next pick: preserve the missing state cookie in the existing desktop OAuth
redirect wrapper and add a route regression. A separate read-only audit ran
**2 local HTTP checks** with dummy OAuth settings: direct social start emitted
one state cookie, while desktop start emitted zero. **0 external redirects**
were followed. The `/pair` retry/copy/rotation inconsistencies and misleading
transcript E2E case remain separately queued in the audit matrix. Native
verification remains outstanding. Previously reported hosted Actions billing
is unchanged; do not create duplicate deploy triggers or board notices.


## Loop 8 — 2026-09-10 — Preserve desktop OAuth state cookies

P1: the existing desktop sign-in wrapper dropped Better Auth's `Set-Cookie`
headers when converting its social-start response to a Google redirect.
A production GET reproduced HTTP 302 with **0 cookies**, following **0
external redirects**. The five-line repair in `server/index.ts` forwards
all cookie headers separately. `server/desktop-auth-route.test.ts` verifies
that the returned signed cookie satisfies the real local callback state
check; missing/mismatched cookies continue to fail. No provider configuration
or credentials changed.

New focused suite: **1 file / 12 passed / 0 skipped**, **11.86 seconds**.
Existing handoff lifecycle suite: **1 file / 8 passed / 0 skipped**, **307 ms**.
The first new-suite attempt was **8 passed / 4 failed** because shared fixture
requests hit real sign-in rate limits; separate processes fixed the fixture
without disabling throttling. Cases cover cookie/signature preservation,
fresh starts, simulated provider cancellation, missing/mismatched cookies,
five invalid redirects, anonymous finish, and unavailable configuration.
Random dummy keys and temporary data are confined to owned local processes;
outbound fetch/TCP is blocked and redirects are manual. **0 browser UI tests,
0 native tests, and 0 real Google logins** ran in this server-only slice.
Server typecheck, scoped lint and diff checks passed. Final full Vitest:
**187 files / 1870 passed / 8 skipped**, **178.66 seconds**. This exceeds
the handbook baseline of 172 files / 1689 passed / 8 skipped.

Commercial implication: the desktop entry point retains the state required
to return from Google, removing a reproduced sign-in failure. No successful
real-provider login or conversion lift is claimed. The earlier Settings and
public-page releases are now visible by production GET; the device-claim
release was still pending at this loop's opening check. Hosted Actions billing
remains the previously reported board item; no duplicate trigger was created.

P2 follow-up: upstream sign-in throttling is currently reported as generic
HTTP 500, as seen in the first fixture run. Audit the internal request's
missing client-IP context and distinct-client rate buckets, then preserve
rate-limit status/retry guidance without disabling throttles. After that,
continue `/pair` recovery/copy/rotation, truthful transcript E2E and native checks.
The route/state/device matrix remains the record of unverified workflows.


## Loop 9 — 2026-09-10 — Desktop sign-in limits and usable retry guidance

P2 fixed in `server/index.ts` and `server/desktop-auth.ts`: preserve the
complete original X-Forwarded-For header when calling Better Auth, matching
the direct auth endpoint. Keep its IP validation, chain handling and all
throttles enabled. Accepted single-IP clients now retain their own auth
bucket; missing, malformed and multi-value headers still share the fallback.
Production proxy topology remains unverified. Upstream 429 now stays 429,
with validated Retry-After seconds, no-store and a responsive recovery page.
The outer ten-attempt gate keeps its limit and gives one-minute guidance.

Focused route tests: **1 file / 20 passed / 0 skipped**, **15.09 seconds**,
including eight new cases for client isolation, shared direct/desktop budgets,
unresolved-IP fallback, retry metadata and the outer gate. Helper/lifecycle
suite: **1 file / 22 passed / 0 skipped**, **308 ms**, including fourteen new
retry parsing cases. Server typecheck, scoped lint and diff checks passed.

Four browser-driven checks exercised the actual upstream and outer throttle
responses, then verified pointer and keyboard recovery. Three final layout
checks passed at **320×568,
390×844 and 1440×900** with no horizontal overflow and a **44px-high** recovery
link. The initial inline link wrapped awkwardly and its automation click
missed; it became a separate action and both input methods passed again.
One initial outer-limit fixture navigation unexpectedly followed an external
Google authorization redirect and ended at invalid_client. No login completed.
It was repeated successfully through a local proxy blocking external redirects.
Automated HTTP tests followed **0 external redirects**. Local server fixtures
used random dummy OAuth settings and blocked outbound fetch/TCP; their owned
processes/tabs were closed. The demo on 8845 was untouched. **0 real Google
logins and 0 native UI tests** ran.

The first full suite passed **187 files / 1892 passed / 8 skipped** in
**187.77 seconds**. Final full verification after the recovery-link change:
**187 files / 1892 passed / 8 skipped**, **186.14 seconds**. Read-only review
found no blocking regressions. The handbook baseline is 172 / 1689 / 8.

Commercial implication: simultaneous desktop sign-ins retain the same client
limits as web sign-in where the deployment supplies a resolvable IP, and
throttled users get a clear recovery action instead of a false provider error.
No conversion improvement is claimed. A production GET now confirms the
preceding cookie fix with HTTP 302 and **1 state cookie**, without following
Google. This slice's production throttle behavior still needs verification.

Next pick: `/pair` recovery, clipboard failure and truthful code-refresh
behavior, then transcript E2E correction and the native client matrix. Keep
unresolved proxy topology and all real-provider/native outcomes explicit.


## Loop 10 — 2026-09-10 — Pairing recovery and truthful refresh

P2 fixed: `/pair` previously hid its only retry after an error, coerced
malformed codes, copied expired values and left clipboard rejection unhandled.
`src/pages/PairPage.tsx` now uses the shared responsive AuthShell with a
selectable code field, persistent recovery, accurate expiry and 46px actions.
Refresh keeps a live code and its original deadline; replacement follows
expiry or consumption. The stale rotation comment in `server/pairing.ts`
was corrected without changing the endpoint's behavior.

`src/lib/pairing-flow.ts` validates responses, deduplicates initial/refresh
requests, isolates each account's page state, detaches updates and clears
copy feedback. Clipboard denial selects the code for manual copying; stale
completion after refresh, departure or expiry cannot confirm a copy. A
network failure gives connection/retry guidance. Read-only review caught
low-contrast dark-theme text and missing spacing in the first AuthShell
pass; both were corrected and visually rechecked before full verification.

Focused tests: **2 files / 54 passed / 0 skipped**, **553 ms**: 42 new client
cases and 12 server cases, including five new refresh semantics tests.
Both UI and server typechecks and scoped lint passed. Vite production build
passed in **5.72 seconds**, retaining the existing large-chunk warning.
Full Vitest: **188 files / 1939 passed / 8 skipped**, **189.13 seconds**.
This adds 47 passing tests over the preceding 187 / 1892 / 8 result and
exceeds the handbook baseline of 172 / 1689 / 8.

**13 hands-on browser checks** passed: real local generation/countdown,
settled clipboard contents, stable refresh, stable reload, replacement after
consumption, initial 503 recovery with disabled busy controls, failed refresh,
malformed response recovery, clipboard-policy denial/manual selection,
keyboard traversal and refresh, expiry, fresh-code recovery, and return to
the signed-in workspace. Separately, **2 local HTTP checks** accepted the
owned code once (200, expected synthetic account) and rejected reuse (400).
The first immediate clipboard read was stale; a settled repeat returned the
exact displayed value. The anonymous-gate attempt reused an existing fixture
session and is not counted as an anonymous check.

**10 final layout checks** passed: ready/error/expired at **320×568,
390×844 and 1440×900**, plus manual-copy fallback at **320×568**. No
horizontal overflow; both actions are 46px high. Real local API mechanics
use only the owned account/server on 18861 and current-source Vite on 15199.
A temporary local proxy supplies 503, malformed and short-expiry responses
and a Permissions-Policy clipboard denial. Those fixtures do not establish
production failures or a complete cloud-to-desktop session bridge. **0 real
Google logins and 0 native UI tests** ran; the demo on 8845 was untouched.

Commercial implication: a recoverable connection or clipboard failure no
longer strands a user trying to connect their desktop, and the refresh label
matches the actual code lifetime. No conversion lift is claimed. Pre-push
production GET returned 200 for `/pair` and its existing assets; this slice's
asset marker was absent. Deployment verification follows the push.

Next pick: repair the misleading transcript E2E case, then continue the
workspace, native-client and AGI harness matrix. Anonymous pairing access,
the actual cloud-to-desktop bridge, real Google login and native outcomes
remain unverified here. Hosted Actions billing and production OAuth proxy
topology retain their previously recorded status; no duplicate trigger.


## Loop 11 — 2026-09-10 — A transcript E2E that checks the transcript

P2 fixed: the pairing test named for rendered messages previously stopped
after login/onboarding. `e2e/pairing.e2e.spec.ts` now signs in through visible
controls, reads the displayed cloud code, pairs the exact synthetic account,
quick-starts a bot and sends a unique message. It requires exactly one user
row and one deterministic fake-engine reply, their actual text visibly
rendered inside `[data-mid]`, and both still present after reload. It also
checks anonymous access, consumed-code denial and a null session. Redemption
setup uses POST. OAuth coverage constructs a redirect with a state cookie
and follows zero external redirects; it is not a completed Google login.

`e2e/pairing-harness.ts` replaces fixed ports, ambient provider settings and
literal fixture credentials with four available ports, explicit child
environment, random credentials, isolated homes/data and a temporary fake
ACP wrapper. Readiness requires that child's exact startup log before a
health check can pass. Guards block external browser/server requests; the
desktop's server guard permits only the exact local cloud verification
endpoint. Cleanup awaits owned servers and fake engines, including engine
process groups, and removes owned data after partial startup failure.
`server/pairing-harness.test.ts` exercises these contracts. The tests exposed
an intermittent EPERM from probing a stopped process group; cleanup now
awaits child close events instead. The initial failing run was **8 passed /
1 failed**; final focused verification is **1 file / 9 passed / 0 skipped**,
**5.57 seconds**. The final browser fixture also shut down and removed its
data successfully; its temporary credential metadata was removed.

`tsconfig.e2e.json` typechecks the pairing suite and fixture. The server
and E2E typechecks, scoped lint and diff checks passed. Fresh Vite build:
**5.58 seconds**, with the existing large-chunk warning. Playwright config
now retains failure traces/screenshots in ignored `.omb-scratch/e2e`.
Read-only review checked the installed runner's manual-context artifact
support and found no remaining blockers. **5 Playwright cases discovered,
0 runner cases executed**: current computer-use instructions require CUA
for UI actions. Test discovery is not a browser test result.
Full Vitest: **189 files / 1948 passed / 8 skipped**, **177.34 seconds**.
This adds nine passing tests over Loop 10 and exceeds the handbook baseline
of 172 files / 1689 passed / 8 skipped.

**9 hands-on CUA browser checks passed at 1280×720:** anonymous cloud `/pair`
redirect, email login returning to the displayed code, desktop bridge
controls, code-to-app handoff, Quick start, visible unique user/reply rows,
reload persistence, exact account in Settings, and consumed-code rejection
with `/app` still gated. Both browser tabs reported **0 console errors**.
Separately, **1 local HTTP OAuth check** returned 302 to Google with a client
ID and **1 state cookie**, following **0 external redirects**. The cloud and
desktop are actual isolated local servers; model output is the fake ACP
fixture. **0 real Google logins, 0 native UI tests, and 0 new mobile layout
checks** ran. The demo on 8845 was untouched.

Commercial implication: pairing-to-first-reply now has observable regression
evidence instead of a passing test that never sends work. No conversion
lift, real model completion or production-account success is claimed. A
production GET at this loop's start confirmed Loop 10 pairing UI live in
`/assets/index-Cd59czyZ.js`, including the truthful refresh marker (both
route and asset returned 200). This slice changes test infrastructure only.

Next pick: bring the remaining approval-card E2E fixture under the same
isolation, owned lifecycle and meaningful error assertions, then continue
approval/rehearsal, workspace and native-client coverage. Do not execute the
whole existing browser suite while that approval fixture still inherits
ambient provider settings. Production proxy topology and real-provider
login remain separate gaps. Hosted Actions billing remains the existing
board item; avoid duplicate trigger commits or unchanged billing notices.


## Loop 12 — 2026-09-10 — Approval tests that wait for approval

P2 fixed: the old approval E2E could pass on a successful fake-engine reply
emitted before the permission request. `server/testing/fake-acp-cli.ts` now
has an opt-in `permission-gated` mode: no final reply before a decision,
success only for exact `selected / allow-once`, and a distinct denied reply
for rejection. It records the actual ACP outcome. Existing modes remain
compatible. `e2e/pairing-harness.ts` exposes this mode and its evidence file.

`e2e/browser-fixtures.ts` shares owned cloud/desktop servers, random accounts,
ports, explicit environment, browser error assertions and awaited cleanup.
Both specs use it; API checks follow zero redirects. The rewritten
`e2e/approval-card.e2e.spec.ts` verifies Allow once and Deny, no premature
reply, the exact card before/after pending reload, settled card/reply/idle
state, actual ACP choice and completed reload. `tsconfig.e2e.json` now
includes all E2E files. `server/approval-harness.test.ts` adds three real local
HTTP cases for Allow, Deny and isolation between two pending threads,
including actual engine choices and per-bot decision records.

Focused verification: **46 passed / 0 skipped across 3 files**: new approval
cases **3 in 7.43s**, pairing harness **9 in 5.00s**, ACP compatibility
**34 in 13.19s**. Server/E2E typechecks, scoped lint and diff checks pass.
Read-only review found no remaining blockers. Full Vitest: **190 files /
1951 passed / 8 skipped**, **195.45 seconds**. This adds three passing tests
over Loop 11 and exceeds the handbook baseline of 172 files / 1689 passed /
8 skipped.

**10 hands-on CUA browser checks passed**: pairing/Quick start, blocked
pending state, pending reload, decision/result and completed reload for
each of Allow and Deny. **2 separate outcome-file assertions** confirmed
actual `allow-once` and `reject`; four tabs reported **0 captured console
errors**. Both local fixture pairs, owned data, metadata and tabs were
cleaned up. The browser window changed during verification (final measured
**566×817**); **0 new device-layout matrix checks** are claimed. Current
source UI was unchanged from the preceding build. **7 Playwright cases
discovered/typechecked, 0 runner cases executed** under current CUA-only
UI instructions. Real servers used a fake ACP engine; **0 real Google
logins and 0 native UI checks** ran. Demo sessions on 8845 were untouched.

Commercial implication: the approval regression test now proves the human
decision reaches the engine, supporting reliable decision history. No
conversion lift or real-model completion is claimed. This slice changes
test infrastructure only; no new production UI marker is expected.

Next P2: tool approvals render `ApprovalCard`, which omits persisted
rehearsal/why/history evidence already shown by `OptionCard` and the pending
composer. Restore that evidence after a decision and reload in one bounded
UI slice. Track this in `docs/plans/ui-e2e-program.md`. Production OAuth
topology, real-provider/native checks and the existing hosted Actions billing
board item remain separate gaps; no duplicate trigger or billing notice.


## Loop 13 — 2026-09-10 — Approval evidence survives the decision

P2 fixed in `src/components/ApprovalCard.tsx`: the actual permission
transcript omitted the stored rehearsal, approval history and previous-run
why data. These now remain under **Evidence when requested** after Allow or
Deny, with the existing expandable why details. The label distinguishes the
frozen snapshot from the decision just made. Settled cards retain normal
text opacity; long labels and evidence wrap within the card.

Added `src/components/ApprovalCard.test.ts` (11 rendering regressions),
`server/approval-rehearsal-harness.test.ts` (2 local HTTP integration cases)
and `e2e/approval-rehearsal.e2e.spec.ts`. The shared harness and fake ACP CLI
add opt-in `rehearsal-gated`: an explicit assistant plan precedes permission;
Allow produces two ordered successful tool events and WHY/DECISIONS/
HYPOTHESIS/FINDINGS; Deny produces no tool events. Tests read actual runtime
records and persisted SQLite cards. First approval: **0/2 steps, 0 matching
runs, 0 reviewed**. After Allow, next approval: **2/2, 1 matching, 1 reviewed**.
A completed denied turn can be reviewed but contributes zero matching tools.
No journal or approval evidence is injected.

Focused results: component **11 passed / 0 skipped in 0.49s**; final rehearsal
HTTP **2 passed / 0 skipped in 6.54s**. Earlier compatibility run: rehearsal
and approval HTTP **5 passed / 0 skipped in 14.71s**. Frontend/server/E2E
typechecks, scoped lint and diff checks pass. Final Vite build **7.01s**, with
the existing large-chunk warning. Review strengthened the E2E history and
expanded why-body assertions. Full Vitest: **192 files / 1964 passed /
8 skipped**, **199.09s** — thirteen additional passes over Loop 12 and above
the handbook baseline of 172 files / 1689 passed / 8 skipped.

**8 final evidence browser checks passed**: zero-history card, first Allow
and stored snapshot, second-turn matching evidence, pending reload, Deny,
completed reload with both original snapshots, visible previous-run body,
and keyboard disclosure. **6 layout checks passed**: matched pending and
expanded settled evidence at **320×568, 390×844, 1440×900**. No horizontal
overflow; pending decisions stayed reachable and long expanded content
remained scrollable. Both tabs reported **0 captured console errors**.
**8 Playwright cases discovered/typechecked in 3 files; 0 runner cases
executed** under CUA-only UI instructions. Local servers and storage are
real; tool results and rationale are fake-engine fixtures. **0 real model,
Google-login or native UI checks** ran. Owned fixture processes, data,
metadata and tabs were removed; viewport reset and demo 8845 untouched.

**Separate P2 found:** switching from Quick-start-created Mochi to Basil,
then reloading, restores Mochi. An initial exact-card locator timed out
because the conversation changed; it is not counted as a passing navigation
check. Evidence checks explicitly reselect Basil after reload. Selection
lives only in reducer memory; initial hydration chooses `bots[0]` in
`src/state/store.tsx`, and bot creation prepends the roster. No approval data
was lost. Next slice: restore selected bot/group per account and tab, with
stale-ID, account-switch, reconnect and unavailable-storage checks.

Commercial implication: decision history remains reviewable after work
continues, instead of disappearing with the approval composer. No conversion
lift is claimed. Production marker to verify after push: **Evidence when
requested**. Hosted Actions billing remains the existing board item; no
unchanged escalation or duplicate deployment trigger.

## Loop 14 — 2026-09-10 — One mascot and usable small-screen onboarding

The board's new request prioritizes its supplied orange mascot, interactive
onboarding/landing, computer setup, `/os` and native acceptance. Two parallel
research passes produced `landing-reference-study-2026-09-10.md` and
`computer-os-native-roadmap-2026-09-10.md`; the live GLM 5.3 Flash execution
handoff is `glm-handoff-2026-09-10.md`. References are dated and source-pinned;
competitor marketing is not runtime evidence. The browser control boolean
does not establish agent pause; guided Local VM and native execution remain
explicit gaps. Read-only inventory found Colima stopped; no VM launched.

This bounded product slice shares the existing five-lobed body through
`MusterMascot`. Bloom, static brand marks and the default star avatar now use
that geometry, flat orange and offwhite capsule eyes. Explicit alternative
characters and custom teammate colors remain available. Happy/sleeping eye
families and larger working/thinking poses remain distinct. Static marks no
longer run JavaScript animation loops; optional animation uses CSS. The
interactive mascot is a native **Wave to Muster** button with a status greeting.
Reduced-motion rules suppress float, blink and wave; no runtime setting was
changed to test the OS preference, so that leg remains source-reviewed only.
Upstream mascot code attribution is retained in third-party notices.

Onboarding replaces drifting blurred glows with a brief, non-intercepting
mascot entrance, then a still background. Its constrained card scrolls on
short screens; four form inputs have explicit accessible names and duplicate
Back links are removed. No engine installation, provider connection or
permission request is introduced by these visual changes.

Focused component verification: **1 file / 12 passed / 0 skipped in 0.573s**.
Frontend and server typechecks, scoped lint and final diff check pass. Final
Vite build **6.49s** with the existing large-chunk warning. Read-only review
found no blockers. Full Vitest: **193 files / 1976 passed / 8 skipped**,
**239.35s**. This adds twelve passes over Loop 13 and remains above the
handbook baseline of 172 files / 1689 passed / 8 skipped.

**7 functional browser checks passed:** cloud-to-desktop fixture pairing,
keyboard mascot greeting, preserved blue teammate choice, navigation through
all five setup steps with permissions skipped, explicit first-task reply,
reply persistence after reload, and Back navigation in the final build.
**7 final layout checks passed:** Welcome at **320×568, 768×1024, 1440×900**;
Engines, Permissions and First task at **320×568**; Teammate at **390×844**.
No horizontal overflow; long steps have a reachable internal scroll area.
The final cloud tab had **0 captured console errors**. A hydration read and
subsequent missing-wave wait failed because the cloud fixture had redirected
to sign-in after the same-host desktop cookie changed; explicit sign-in
recovered it. Those attempts are not passing checks. A viewport command
initially affected another tab; only measured target dimensions count above.

The root additionally opened all five landing references and verified five
small UI interactions; one mascot-demo color interaction passed. These are
reference checks, not product acceptance. **0 Playwright runner cases, real
Google logins, real model tasks, native UI tests or VM runtime tests** ran.
The first-task reply used a deterministic fake ACP engine with real local
servers and storage. All Loop 14 fixture processes/data and owned tabs were
removed; viewport reset and demo 8845 untouched.

Commercial implication: a consistent identity and reachable setup support
first use; conversion improvement is unmeasured. Public/native icon exports
and the separately served `www/` landing remain queued. A renamed new bot's
seed greeting still used its generated name during the fixture; retain that
as part of the first-task reliability slice. Usage fell from 24% to 19%
remaining during research/build; the existing heartbeat now checks usage,
maintains the GLM handoff and pauses at the board's 1% threshold.

Native OpenMausBot reference inspection was attempted through CUA, but app
access reported pending Accessibility/Screen Recording permissions. No native
UI state was returned or settings changed; this is not a passing check.

## Loop 15 — 2026-09-10 — Reliable and truthful browser previews

Audit reproduced three browser defects: the takeover banner claimed an
agent pause without an attached agent transport, invalid CDP frame
acknowledgements froze the page image, and reopening a saved profile could
select a background tab that never produced frames. Navigation failures also
looked successful. The panel now calls itself an address-driven preview,
explains its actual limits, and reports failed navigation while retaining
the last confirmed address for recovery. Shared agent/page input remains a
separate roadmap slice.

CDP commands and frame acknowledgements receive distinct numeric IDs;
successful and failed commands clear their timers/listeners. Navigation
validates the returned frame ID, error and download result. The selected
page is brought to the foreground before capture, including restored tabs.
The existing browser launch policy and profile storage are unchanged.

The UI serializes actions, rejects stale polling replies, clears the prior
bot's draft/image on selection changes, and does not restart a profile after
a failed stop. Reload uses the confirmed address independently of the draft.
Narrow screens use the existing Radix dialog focus scope; desktop keeps a
420px side panel. Keyboard focus enters the overlay, wraps in both directions,
Escape closes it, and the connected launcher receives focus again. Resizing
preserves session state and the address draft.

Final local browser evidence uses installed Brave, fresh temporary profiles,
a synthetic account and an owned server. Seven functional workflows passed:
first navigation to a real Example Domain image; stop/reopen of the same
profile with a fresh image; switching bots without leaked image/draft;
empty-draft reload; DNS failure followed by recovery; bot/guest switching and
stop; and mobile keyboard open/focus wrapping/Escape/focus return. A reload
of Muster retained the running server session. Four final layout checks
passed: running and idle at 320×568, running at 390×844 and 1440×900. No
horizontal overflow; desktop panel measured 420px. Phone-to-desktop resize
retained the unsent draft. Final tab captured 0 console errors or warnings.

The earlier same-profile reopen check failed before activation was added;
it is not counted as a pass. A volatile roster label caused one locator
timeout during the final runtime pass; reading its current label recovered
the selection check. The initial full suite passed 2007 tests but preceded
the reproduced reopen/focus fixes, so a final full run is required below.
No Playwright runner, real model/Google login, VM or native UI execution is
claimed. All owned Loop 15 fixture servers, profiles, helper and tabs were
removed; viewport reset and demo 8845 untouched.

Commercial implication: usable preview/recovery can reduce confusion during
setup; conversion impact is unmeasured. The GLM handoff retains the separate
browser-control, VM, OS, native and exported-brand acceptance contracts.

Final verification: **195 files / 2013 passed / 8 skipped in 205.47s**.
Focused server CDP checks: **22 passed / 0 skipped in 2.82s**. Focused UI
and lifecycle checks: **30 passed / 0 skipped across 2 files in 0.804s**.
Frontend/server typechecks and scoped lint pass. Final Vite build **5.17s**
with the existing large-chunk warning; diff check passes. Read-only review
found no remaining blocker after the mobile focus correction. Latest usage
snapshot: **6% remaining**. The existing CEO heartbeat was found **PAUSED**;
its state is preserved, with no duplicate automation created.

## Loop 16 — 2026-09-10 — Restore the selected conversation

Reproduced on the previous build: select non-first Miso, reload, and Comet
becomes selected. The authenticated app and OS now pass the existing account
ID through a keyed store wrapper. One versioned selection is saved per
account in sessionStorage, so each tab owns its choice. Initialization reads
it once; later hydration preserves a newer valid live selection. Missing or
hidden targets fall back to a visible bot, then a room, then no selection.
Corrupt/blocked storage leaves in-memory navigation usable. Account changes
remount the store; existing cleanup fences late prior-provider hydration.

**196 files / 2027 passed / 8 skipped in 214.36s**. Focused storage/reducer
verification: **2 files / 18 passed / 0 skipped in 0.889s**, including 14 new
cases. Frontend typecheck, scoped lint and diff check pass. Vite build
**6.52s**, with the existing large-chunk warning. Read-only review found no
blockers. Unit tests do not mount-switch React identities with an outstanding
request; that race remains source-reviewed, not an executed browser case.

**6 browser workflows passed:** non-first bot reload, room reload, two tabs
retaining different selections, Alpha → Beta → Alpha sign-in preserving each
account's choice, app → OS → app preserving the room, and archived-bot
fallback after reload. The owned local-server fixture shares its workspace
roster between these synthetic accounts; this tests selection namespacing,
not hosted tenant isolation. A 320px phone reload also retained the room.
The final main tab captured **0 console errors/warnings**. No real provider,
Google OAuth, native app, VM or Playwright runner was executed.

**Separate P2, next slice:** the room at 320×568 overflows to **450px**.
`GroupView.tsx` places the Default responder select at x219.7 with width171,
ending at x390.7, followed by member avatars. Mobile restoration passes;
the room layout does not. Keep this explicit in the handoff. The room-create
button changed its label after member selection, causing one locator timeout;
a fresh label recovered it. Two initial settings clicks targeted the closed
mobile sidebar; opening the visible desktop layout recovered the check.
These attempts are not additional passing checks.

All owned Loop 16 processes/data/helper scripts and both tabs were removed,
viewport reset, and demo 8845 untouched. Loop 15 was pushed as **6e092b7**.
Production GET at **08:53:48 UTC** still served `/assets/index-Cd59czyZ.js`
with HTTP200 and no Loop13/14/15 markers; deployment remains unconfirmed.
Usage is **2% remaining** at the latest snapshot; finalize the GLM handoff
without starting another code slice. Existing automation remains PAUSED.
Commercial implication: people return to the work they selected; no retention
or conversion lift is claimed.

## Loop 17 — 2026-09-10 — Canonical brand exports from one geometry source

The brand surfaces had drifted: both served favicon marks still showed the
retired gradient-star "network of agents" design, several PWA icon files the
manifest references did not exist on disk (so the service worker's precache
install could never succeed), the manifest was never linked from the landing
head at all, and the desktop exports (icns, ico, Electron window PNG)
predated the canonical five-lobed mark chosen in Loop 14. One pure-JS
generator now reads the canonical body path, eye shapes and colors straight
out of the shared mascot component — generation fails loudly if that source
changes shape — and emits every web and desktop asset from it: transparent
favicon SVGs for both served roots, nine full-bleed PWA PNGs (72–512 plus
180 for apple-touch), the rounded dark desktop tile as scalable SVG, a
1024px PNG and a complete 12-file iconset assembled into the macOS icns by
iconutil, a seven-size Windows ICO with embedded PNGs, and the 512px
Electron window PNG. Stale manifest colors were replaced (dark tile
background, brand orange theme color), and the manifest, theme color and
apple-touch icon are linked from the landing head for the first time. The
mac/win/linux packaging icon paths are unchanged, so packaging picks the
canonical art up with no config change. No upstream notice obligations
apply: the generator is original code over our own component geometry, and
the MIT-licensed reference informed behavior ports, not asset content.

Verification: favicon legibility checked in a real browser at 16/32/48px on
white and near-black, plus the 30px dark-header lockup, the desktop tile and
the 192px PWA icon — all from the served SVG and generated PNGs, light and
dark. Frontend typecheck passes; Vite build **5.03s** with the existing
large-chunk warning. Full suite: first run **1 failed / 2026 passed /
8 skipped**, second run 4 timeouts (approval-harness, comms ×2,
organization) — all known load-flake signatures; those three files rerun in
isolation pass **25/25 in 27.29s**. No test exercises icon bytes; the
service-worker precache resolution is verified by file presence against its
URL list. Not claimed: packaged-app inspection, iOS and Android catalogs
(explicitly separate slices, still on the previous design), any deployment.
The landing is static HTML; no React route or test data was touched. Demo
8845 untouched; no owned processes remain. Commercial implication: the
chosen identity is now consistent at every surface a visitor or installer
sees first; conversion impact unmeasured.

## Loop 18 — 2026-09-10 — The landing walks visitors through an approval

The landing claimed "Approvals that hold" but only as static copy; a visitor
had to install the app to understand what an approval actually feels like.
The landing now has an `#approvals` section that runs the loop on sample
data: an explicit "Simulation — sample data only. Nothing real runs, no
model is called, nothing leaves this page" badge sits above a card where the
visitor picks one of three tasks — an inbox reply, a file move, and a
deliberately destructive delete — watches the bot report its two simulated
steps, reviews the proposed action with its scope and blast radius, then
Allow or Deny. Allow produces a simulated receipt (task, decision, result,
turn/token usage with cost honestly marked "not reported") plus the exact
evidence artifact — the draft email text, the mv command list, the rm
command. Deny produces a receipt whose outcome reads "No action taken" and
a note saying the task stopped at the gate; the evidence block is never
rendered on Deny, so the simulation cannot claim completed work. Reset
returns to the task picker. The whole thing is one static HTML file with
vanilla JS over hardcoded strings — a request listener confirmed zero
network calls and no model traffic during the flows.

Verification: **35/35 Playwright checks pass** in a real browser — all
three flows end to end, deny-truthfulness, reset; keyboard-only walkthrough
(Tab to task, Enter, focus lands on Allow, Enter, focus lands on reset);
no horizontal overflow at 320/390/768/1440 in any of the three states;
44px minimum touch targets at 320; `prefers-reduced-motion: reduce`
renders with `animationName: none` before and after interaction; zero
console errors. Frontend typecheck passes; full suite **196 files /
2027 passed / 8 skipped with no flakes**. Not claimed: no production
surface touched (`www/` only), no real approval path exercised, no
deployment. Demo 8845 untouched; no owned processes remain. Commercial
implication: a visitor can now feel the product's core trust loop before
installing; conversion impact unmeasured.

## Loop 19 — 2026-09-10 — The room overflow was already wrapped; re-proven live

Loop 16 recorded a P2: the room at 320×568 forced the document to 450px, with
the Default responder select ending at x390.7. Reaching for that slice found
the fix had already landed on main in **1a80066** ("Wrap room header controls
at narrow widths") — the header name truncates and the controls row wraps
below md — but the P2 had never been re-verified against current main, so the
handoff still carried it as an open slice. This loop closed it with fresh
browser evidence rather than re-fixing working code.

An isolated harness (fresh `OMB_DATA_DIR`, server on 8793, vite on 5198) got
a 3-member room including a deliberately long bot name, the room was renamed
to "Quarterly Launch War Room — Q4 Cross-Team Coordination Epic", and a long
pinned working-folder chip was set through `PATCH /api/groups/:id` (the
server validates the folder exists, so a real long path under /tmp was used).
**5/5 PASS, zero horizontal overflow, zero console errors**: the room view at
320/390/768/1440 with the worst-case long name and long folder chip, plus the
find bar open with a typed query at 320. In every case the responder select
is visible and fits inside the viewport, the composer stays reachable, and
the header controls wrap onto their own lines instead of widening the
document. The 320px screenshot was reviewed directly: name truncates with an
ellipsis, the folder chip and responder select share a wrapped row, member
avatars render. Typecheck passes. No code change was made; no jsdom test
claims to cover pixel overflow — browser evidence is the proof.

Not claimed: packaged app, native apps, deployment. The rig (server, vite,
data dir, cookie jar, helper scripts) was removed after verification; demo
8845 untouched. Commercial implication: none directly — this restores
usability of rooms on the narrowest supported phones, which mobile visitors
were previously locked out of.

## Loop 20 — 2026-09-10 — The native catalogs catch up to the mascot

Loop 17 unified every web and desktop surface but left the native catalogs
explicitly on the old design, and the gap was worse than styling: the iOS
App Store icon was still the retired Aug 31 network-of-agents mark,
`android-companion/app.json` referenced `assets/icon.png`,
`assets/adaptive-icon.png` and `assets/splash.png` from a directory that did
not exist (any Expo prebuild/EAS run would fail or silently fall back), and
the Muster+ app (`mobile/`) declared no icon at all. The one geometry source
now covers all of it: `make-brand-icons.mjs` additionally emits the iOS
1024px App Store icon as a full-bleed square (iOS applies its own corner
mask, so the desktop tile's pre-rounded corners would be double-masked), the
three android-companion assets its config already names, and the two Muster+
assets with the matching `icon` and `android.adaptiveIcon` keys added to
`mobile/app.json` (brand tile background #0a0a0a). Android adaptive layers
are 108dp with the outer 18dp maskable each side, so the foregrounds render
the mark at scale 3.2 — span 214–809px of the 1024 canvas, radius ≈297px,
comfortably inside the central-66% safe-zone circle of ≈338px — on
transparent, over each app's configured background color. Splash art is the
transparent mark, so it composites over any splash background unchanged.

Verification: all six PNGs confirmed 1024×1024 RGBA by `file` and decoded
pixel-by-pixel in a real browser canvas — adaptive corners fully transparent
[0,0,0,0], legacy/icon corners exactly #0a0a0a opaque, mark center pixels
brand orange #f08a24, and both adaptive copies byte-identical. The mascot
and eyes match the canonical component because they are rasterised from its
exported path constants, which the generator refuses to run without. The
regenerated web/desktop outputs were byte-identical to the committed ones,
which independently confirms the generator stayed deterministic. Frontend
typecheck passes; full suite **196 files / 2027 passed / 8 skipped with no
flakes in 203.45s**. Not claimed: no iOS/Android simulator or device build,
no EAS/packaging run, Watch views and `AgentAvatar.swift` untouched (their
in-app avatar semantics were deliberately out of scope), no deployment. Demo
8845 untouched; rig helper scripts removed. Commercial implication: the
first brand a new phone owner sees on the home screen now matches what the
landing promised; install-conversion impact unmeasured.

## Loop 21 — 2026-09-10 — First-task onboarding recovers without losing work

Astra resumed from GLM's uncommitted row 6 at `8729aa6`; initial pull was
up to date. The inherited implementation was not ready to ship: sending was
fire-and-forget, SSE connection did not prove roster hydration, inherited
template keys were accepted, and late completion could outlive its account.

Shipped scope: `Onboarding.tsx`, the new `onboarding-draft`,
`teammate-setup`, and `onboarding-finish` modules/tests, two store reducer
regressions, and `e2e/onboarding-harness.ts`. Finish now reads an authoritative
roster, reuses only an idle unused teammate with complete current history
and compatible task metadata, validates PATCH identity/thread, awaits task
acceptance and account completion, and retains the chosen bot for retries.
All controls and Escape are locked during the transaction; disposal fences
stop follow-on actions from an unmounted wizard. Acknowledged tasks are
cached for completion retries within that mounted wizard. Account drafts
restore welcome fields, identity, step and task; saved choices and explicit
empty fields take precedence over allowlisted templates. Completion
analytics records a boolean first-task flag, not the task's text.

The browser exposed a further reducer defect: replaying the acknowledged
user message after a failed completion-save rewound the active conversation
and hid the bot's reply. Duplicate message receipts now leave the active
branch and mascot state unchanged. Final source review also excluded
established teammates with an empty new task, active work, incomplete
history and observed task switches from fresh reuse.

Verification: final full Vitest **199 files / 2086 passed / 8 skipped in
214.59s**, exit 0; **59 more passing tests than the takeover baseline**.
The run includes all 22 setup, 12 finish-lifecycle, 23 draft and 6 store
tests. The earlier complete run was 199 / 2075 / 8 in 213.47s; the rerun was
required by the additional eligibility regressions. Frontend, server and
E2E typechecks, scoped lint, and production Vite build pass. The existing
large-chunk advisory remains; no build error occurred.

**12 manual CUA browser scenarios passed**, using four isolated synthetic
accounts, real local server endpoints and a fake ACP engine:

1. Allowlisted template prefill waits for an explicit finish action.
2. A real sign-in round trip after injected 401 restores step, teammate and edited task.
3. Delayed PATCH 503 locks controls, then shows the error with inputs intact.
4. Rejected task POST 503 keeps setup open and retries the same teammate.
5. Accepted task followed by gate 503 retries with only gate 200: no second send, reply stays visible.
6. `template=constructor` is ignored without crashing or sending.
7. A saved suggestion survives reload through a different valid template link.
8. Real Free-tier creation returns 402 with its exact message and preserved task.
9. Welcome name/email survive reload; email was confirmed visually because the DOM/AX read omitted its value.
10. Quick-start double click plus Escape during saving produces one accepted task, zero duplicate bots.
11. Completion and the bot reply survive reload.
12. A bot with a completed prior task and empty new thread is left intact; onboarding creates one separate teammate.

Recovery has no horizontal overflow at 320/390/768/1440; the real cap alert
also fits at 320. The last two fixtures report zero captured console errors.
Faults are injected before forwarding: they do **not** prove behavior when
the server accepts work but its response is lost. The final observed-thread
guard has a deterministic regression; send-time atomicity needs a server
contract. Fixture control requests bypass injection and carry separate
record attribution. Cleanup was verified: all owned servers, fake engines,
data and tabs removed, viewport reset; demo 8845 untouched. A stdin cleanup
smoke also exits 0. Logs: `/tmp/muster-loop21-vitest-final.log`,
`/tmp/muster-loop21-build-final.log`, `/tmp/muster-loop21-server-types.log`,
`/tmp/muster-loop21-e2e-types.log`, `/tmp/muster-loop21-fixture-cleanup.log`.

Commercial implication: rejected setup no longer silently discards a new
user's first task or consumes an unnecessary Free teammate slot. Activation
or revenue lift has not been measured. Next bounded audit: explicit
send/skip semantics and server-owned first-task idempotency/thread binding,
then the existing Local VM guided-setup queue. Native apps, real provider
execution and Mimosa's full scan remain unverified; no security claim.

Operational continuity: the board restored Astra ownership with Pro usage
available. The obsolete September 16 handover audit was deleted. The CEO
heartbeat is to resume after this slice's push using this ledger. The
preexisting docs-only release stash was identified and preserved, not
blindly applied over GLM's newer log. Production GET at 18:30–18:32 UTC
served `/assets/index-_h_ora_i.js` with prior mascot/preview markers, replacing
the older absent-marker evidence; this does not identify the exact commit.
Source was committed and pushed as **c6eb22e** after a clean rebase. At
19:09:51 UTC, five production GETs returned 200, but `/app` still referenced
`index-_h_ora_i.js`; both new onboarding markers were absent and it did not
match local `index-C6wV6z6U.js`. **Loop 21 is not deployed.** Exact-SHA CI
34518411854 and autodeploy 34518411951 failed before their jobs started for
the unchanged GitHub billing/spending restriction, not an executed test
failure. Public updater metadata remains 1.10.4. The existing CEO heartbeat
is confirmed ACTIVE; the obsolete post-reset audit is removed. This
documentation-only closeout uses the same verified code and test counts.

## Loop 22 — 2026-09-10 — Contain hosted workspace backups before portable sync

The board requested a Today/Warmwind-informed OS, Google sign-in across
clients, and Drive/Telegram recovery. The first audit found that the v1
backup routes build the entire installation even when the transport uses
one account's Google token. Restore and Telegram configuration also bypassed
the normal record ownership boundary. The bundle key additionally depends
on the installation secret; conversation history is not exported. The old
UI's cross-install, whole-history and browser-only encryption promises were
incorrect.

`server/index.ts` now rejects the complete `/api/workspace` route family on
SELF_HOSTED deployments after authentication and before body parsing or
provider calls. Both primary and secondary accounts receive 403 with code
`WORKSPACE_BACKUP_UNAVAILABLE`. Operator access is not an exception: an
operator's personal backup must not include other accounts. Local desktop
export and same-install restore remain available. This is containment,
not account-scoped portable backup or a completed security audit.

The backup card now describes its actual contents and recovery limits,
uses manual backup labels, exposes rejection as an accessible alert, and
disables file selection while busy. Removed the incomplete manual Drive
connection control: it asked for an authorization code but provided no code
field or completion path. No provider configuration or stored data migrated.

Verification: **200 files / 2121 passed / 8 skipped in 246.61s**, exit 0;
**35 additional passing tests** over Loop 21. The new real HTTP harness is
**35/35** (focused run 3.10s): two actual account roles, all 12 method/path
pairs, bare/future route-family paths, anonymous rejection, malformed-body
ordering, unchanged account rosters/configuration/memory, no outbound
attempts, and a genuine local export followed by memory restoration.
Frontend/server typechecks and scoped lint pass. Vite build passes in
16.02s; its existing large-chunk advisory remains.

**3 manual CUA backup checks** passed on an isolated synthetic hosted
account: export denial, Drive denial, and optional Telegram form layout.
Document width equals viewport at **320 and 1440 pixels**; the exact hosted
message is exposed through one alert. Zero captured console errors. The
browser checks did not call a live storage provider. Owned fixture/server,
data and audit tabs were removed; viewport reset; demo 8845 untouched.
Test logs: `/tmp/muster-loop22-vitest.log`,
`/tmp/muster-loop22-frontend-types.log`, `/tmp/muster-loop22-ui-lint.log`,
and `/tmp/muster-loop22-build.log`.

Separately, **one real production Google web sign-in** returned to `/app`
and `/os` using the existing account and previously granted scopes. No
password was handled and no new scope, task or backup was submitted.
Today login and Warmwind homepage/login were inspected publicly; zero
competitor accounts or authenticated workflows were exercised. Native
Google login, mobile/Watch execution, VM execution and Mimosa remain
unverified. OS research and the ranked implementation plan follow in the
next slice. Priority defects now include a portable validated account
schema, Drive grant/recovery behavior, Android initial/reconnect hydration,
and Loop 21's durable first-task receipt and explicit send/skip semantics.

Commercial implication: prevent another account's workspace from reaching
personal backup storage and stop promising recovery the current format
cannot provide. Activation, retention and revenue effects are unmeasured.
The verified source is ready for deployment. This push also updates the
existing `.deploy-trigger` watched by Dokploy, because the hosted Actions
runner remains blocked. Verify production with GET; no new release or
deployment success is claimed before observing the result.

Loop 22 release follow-up: committed/pushed **66846c6**. Production now
serves `/assets/index-D-RsCfsG.js`, containing both the backup availability
message and Loop 21's onboarding draft marker. App, health, updater and
bundle GETs returned 200; updater remains 1.10.4. This supersedes the old
absent-marker observation. CUA blocked the authenticated workspace GET with
`net::ERR_BLOCKED_BY_CLIENT`; no live backend guard response was inspected.
UI markers do not establish that missing API check or an exact deployed SHA.

## Loop 23 — 2026-09-10 — A workspace organized around real work

OS Home now shows decisions, active work and new replies beside the team.
The canonical orange mascot accompanies the overview and each worker.
Active-branch questions outrank busy; seed greetings never become results;
unread replies are called replies rather than successful outcomes.
Disconnected workers keep last-known details without a working animation.
Home waits for actual roster hydration, including an empty roster.

Summary cards open the exact conversation through a validated route target
consumed after account hydration. Unrelated query/hash state survives;
invalid/hidden/foreign IDs cannot select another record. The audit caught
OS acknowledging the persisted selected bot as read while no conversation
was visible. Its provider now preserves bot/group unread state; ordinary
chat selection keeps its read behavior. Window reveal and dock-toggle
intents resolve against the latest stack. Minimized windows reveal Home;
repeated show does not duplicate windows; bot/app IDs have separate scopes.

Phones prioritize populated sections, retain a direct app exit, wrap long
names and display one contained focused window. Wider clients retain their
stack. Window bounds adapt to the viewport; drags start from rendered
geometry. Stop remains available. Reduced-motion CSS removes animation;
the machine's motion preference was not changed for a separate runtime test.

Verification before the continuation environment changed: **203 files /
2178 passed / 8 skipped in 228.47s**, exit 0; **57 additional passing
tests** over Loop 22. Focused selector 27/27, route/store 31/31, window
intent 5/5. Frontend/server typechecks, scoped lint and Vite build passed.
The final mobile CSS refinements were rebuilt and browser-checked; final
build took 7.89s with the existing large-chunk advisory. The subsequent
continuation changed Node to 22.22.3, removed the temporary logs and no
longer exposed CUA. Fresh verification on Node 22.22.3 passed **203 files /
2178 tests / 8 skipped in 214.13s**, exit 0, plus frontend typecheck exit 0.
Durable local evidence: `.omb-scratch/verification/loop23-node22-vitest.log`
and `loop23-node22-types.log`.

**12 manual CUA scenarios passed** on one isolated synthetic account,
two bots and fake ACP modes (happy, permission-gated, hang):

1. Seed-only roster shows zero tasks/results with both teammates available.
2. Non-first agent Open chat selects its exact bot; valid route targeting is consumed and selection survives reload.
3. Invalid target is consumed without changing chat; template/tag/hash survive.
4. Explicit command submission returns 202 and surfaces the pending request only in the decision section.
5. Decision opens the correct approval; Allow once produces the fake reply and clears the request.
6. The selected bot's reply remains unread on OS through reload/window use until its conversation opens.
7. Minimize reveals Home; dock windows retain identities, with only the focused one shown on phones.
8. Long unbroken names and agent/Rooms windows fit at 320/390/768/1440; measured document width equals viewport and visible window content does not overflow.
9. A synthetic hanging task appears as Working; the OS stop control returns it to idle.
10. A populated reply section appears before empty sections at 320px.
11. Mascot wave announces a response; Command-K opens the console and Escape dismisses it without sending.
12. Owned-server shutdown retains last-known state, disables task submission and removes working dots; the mobile app exit was exercised before shutdown.

One task was submitted through the browser; two later sends were fixture
control setup, not browser sends. Zero captured console errors before the
deliberate shutdown. Owned processes, data and tabs were removed; viewport
reset; demo 8845 untouched. Temporary browser/test logs are no longer on
disk after continuation; the executed tool results above remain the evidence.

Independent native verification: `swift test --package-path ios` passed
**8 suites / 91 tests / 0 failures / 0 skipped**, command 8.56s. This is
macOS-hosted CompanionCore, not simulator UI, Watch execution or native
Google login. No tracked iOS changes were made. Preflight found Electron
43.4.0 runtime missing despite cached archives; Xcode 26.6 and 16 available
Apple simulators; Android tooling with incomplete native/test setup; and
stopped Colima. Subsequent unsigned simulator builds passed: **iOS 52.15s,
Watch 23.71s**, both exit 0, zero compiler errors and zero signing steps.
Both produced arm64/x86_64 executables, version 1.0.0. These are two build
gates, not simulator UI or signing proof. Commands, source manifest and logs
are retained under `.omb-scratch/verification/apple-build-20260910T201202Z-eeebfb`.
Electron's cached runtime was restored and CLI-verified as **43.4.0 / arm64**
with embedded Node 24.18.1. No desktop GUI or packaged installer was launched.

Research, backup architecture, commercial hypotheses and ranked release
gates are in `muster-os-execution-2026-09-10.md`. Commercial implication:
returning users can find consequential work and reach the right teammate
without losing unread replies. Conversion/revenue lift is unmeasured.
The broader goal remains active; proceed with native release verification
and durable first-task acceptance after this verified push. The next bounded
auth slice addresses startup session-request failures being treated as
sign-out; the observed sign-in page does not establish lost account data.

Loop 23 source release: **55006b4** pushed. GET on `/os` at 20:25:17 UTC
still served `index-D-RsCfsG.js`, without the three new OS markers. The
source is verified; its deployment is pending. The hourly heartbeat was
updated to the current goal and ledger; last allowance was 9% used / 91%
remaining, with no reset or credits consumed.

## Loop 24 — 2026-09-10 — Recover session checks without false sign-out

Startup now distinguishes a confirmed null session from an unavailable or
malformed response. An eight-second request deadline leads to an accessible
retry screen, preserving the current destination and previously known
identity. Request generations fence late retry/sign-out/unmount responses.
The desktop root uses the same gate. Email sign-in/signup verify an actual
session before reporting success; signup recovery rechecks the session
instead of creating another account. Sign-out failures show an error at
both callers. Google callbacks use the existing local-destination validator.

Focused verification: **5 files / 55 passed / 0 skipped in 16.13s**. Four
real HTTP cases exercise the actual Docker entrypoint with owned offline
fixtures: unchanged explicit and generated secrets retain the exact session
and owned bot; expired sessions and changed secrets reject old cookies
while preserving account, bot ownership and a saved-memory canary. Frontend
and server typechecks and scoped lint passed. Vite build passed in **7.21s**
with the existing chunk-size advisory. Final full suite: **206 files / 2209 passed / 8 skipped in 237.97s**,
exit 0, **31 additional passes** over Loop 23. The preceding run passed
2206 tests; a final desktop-root callback correction warranted a second
run after adding three navigation cases. Those cases plus gate checks
passed **22/22 in 0.732s**. Final typecheck/lint passed and Vite rebuild
took **6.06s**. Durable logs: `.omb-scratch/verification/loop24-full-final.log`,
`loop24-types-final.log`, `loop24-lint-final.log`, `loop24-build-final.log`.
Browser interaction is unverified in this slice because CUA is unavailable;
static markup/controller tests are not browser E2E. Production mounts,
Google/native session continuity and backend lookup-failure handling remain
unverified. No production or demo sessions were changed by these tests.

Commercial implication: temporary rollout failures no longer invite an
unnecessary sign-in or duplicate signup attempt. Retention/revenue effects
are unmeasured. Next bounded source slice is native SQLite runtime staging:
the existing addon loads on Node 22 (ABI127), but fails to load on Electron
43.4.0 (ABI148). The existing Node smoke passed startup plus 7 proxy paths;
14 updater tests and 8 Electron syntax checks passed. Those checks did not
establish native compatibility. An owned package attempt stopped at ENOSPC;
only disposable owned build outputs were removed, retaining evidence.

Native audit follow-up: the owned Electron source rebuild succeeded in
30.36s against cached 43.4.0 headers. Actual Electron execution passed
**9/9 checks in 4.34s** (HTTP startup, seven proxy paths, SQLite create/insert/
read). This is an isolated repaired copy of 55006b4, not shipped source or
an installer. The shared native binary remained unchanged. Evidence:
`.omb-scratch/verification/mac-app-20260910T202440Z-37ffa2/electron-runtime-results.json`.
Full package preparation stopped at ENOSPC before compilation; owned cleanup
removed 581,918,720 allocated bytes, with all evidence preserved.

The next source fix should rebuild only the packaged native resource copy
in afterPack before signing, using the actual Electron version/platform/arch
and correct builder resource path. Preserve standalone Node output. A
separate release-control slice must prevent dry-run asset uploads and public
mirroring of partial draft releases, fix the Intel runner selection, and
run native checks under Electron instead of host Node. Do not dispatch the
existing release workflow until those concrete gates are corrected.

Loop 23 production closeout at **20:37:17 UTC**: normal GETs to `/os` and
`/app` both return 200 and load `/assets/index-DXnIF41L.js`; its GET returns
200 and contains all three OS markers (`Your next move.`, `Ready to read`,
`Workspace overview`). This supersedes the earlier pending deployment
observation. Exact deployed SHA and authenticated backend behavior remain
unobserved. Loop 24 still needs its own post-push marker check.

Loop 24 release closeout: **6c61a18** pushed. At **20:50:36 UTC**, normal
`/app` GET returned 200 and loaded `index-CMSE0abM.js`; bundle GET returned
200 with session-recovery, retry and OS markers. Source and serving UI are
confirmed; no new real OAuth or production storage/session experiment was
performed.

## Loop 25 — 2026-09-10 — Package SQLite for the actual Electron runtime

The packaging hook now stages and rebuilds only the packaged native resource
copy for the resolved Electron version, host platform and target architecture.
It restores helper dependencies after resource pruning, rejects invalid or
escaping paths, removes stale addons, clears inherited node-gyp overrides
and fails on compiler/missing-output errors. node-gyp is pinned to 12.4.0.
Framework dependency rebuilding is disabled so shared Node dependencies are
not retargeted. Standalone server artifacts remain unchanged by the hook.

The staged-server smoke now requires explicit runtime/version/architecture
for Electron, checks a real SQLite roundtrip and seven contained proxy paths,
and verifies health belongs to its child PID. It uses owned fixtures and
bounded output/timeouts. Cancellation reaps probe/server process groups,
including resistant descendants, before reporting success. Tests exposed
that execFile ignored detached; the probe now uses explicit spawn. Desktop
renderer smoke expects the confirmed `/sign-in?next=%2Fapp` root handoff.

Focused contracts: **22/22 in 1.41s**, plus **5/5 cancellation tests in
16.99s**, no skips on this Mac. Fake process fixtures are not native proof.
Actual integrated helper rebuilt in **26.25s** (five upstream C++ warnings,
zero errors), then Electron **43.4.0 / Node 24.18.1 / ABI148 / arm64** passed
**9/9 checks in 4.27s** on the current 6c61a18 server. The root Node addon
SHA256 was unchanged. Separate Node22/ABI127 smoke passed **9/9**; the old
host addon deliberately fails the new Electron gate with ERR_DLOPEN_FAILED.
Actual helper evidence uses a builder-shaped owned resources tree and
explicit cached headers; the full builder/default-header gate follows.
Full-suite and actual app-build results are recorded below before commit.

Commercial implication: an installer that starts but cannot use its native
storage breaks the product's core promise. This closes that packaging gap;
no reliability, conversion or revenue rate is inferred from these tests.
Next is release-control guards and actual platform release gates. No new
version, installer publication, native Google login or universal runtime
compatibility is claimed. Usage last measured **11% used / 89% remaining**.

Loop 25 final verification: **208 files / 2236 passed / 8 skipped in
235.39s**, exit 0, **27 additional passes** over Loop 24. Frontend/server
typechecks and scoped lint passed; **14 updater tests / 0 skipped** passed
in 76.48ms; **8 Electron syntax checks** passed. Durable full log:
`.omb-scratch/verification/loop25-full.log`. pnpm10.33.0 warned that the
legacy package.json pnpm.overrides field is ignored; record a P2 configuration
follow-up before dependency updates. This slice changed only the pinned
node-gyp importer in the existing lockfile; no security claim follows.

The actual isolated macOS arm64 app build passed: preparation **46.07s**,
speech **6.02s**, CUA staging **2.96s**, electron-builder **108.78s**, all
exit 0. The real afterPack hook fetched official Electron43.4.0 headers
and checksums with HTTP200 and rebuilt without overrides. **5 upstream
C++ warnings / 0 compiler errors**. The actual packaged Muster executable
then passed **9/9 checks in 7.08s** (owned HTTP, seven proxy paths, SQLite
roundtrip) under **Electron43.4.0 / Node24.18.1 / ABI148 / arm64**.
Independent deep/strict signature verification passed in **0.27s**; the
signature is ad-hoc, with no TeamIdentifier. All nine source-overlay hashes
and the original Node addon hashes were unchanged. This closes the actual
builder/default-header gate; it is not a Developer-ID/notarization claim.

Artifact: `.omb-scratch/verification/mac-app-loop25-20260910T205233Z-d6b3d6/package/mac-arm64/Muster.app`,
version **1.10.4**, built solely for verification. Exact commands, manifests
and results are in that directory's `build-results.json`,
`packaged-results.json`, `artifact-verification.json`, `source-manifest.json`.
No GUI interaction, installed upgrade, new-version publication, DMG,
Windows/Linux runtime or native Google login is established by these gates.
Next: correct release staging/dry-run/draft-mirror controls, then prepare
a versioned release candidate and its remaining native acceptance gates.

## Loop 26 — Release publication controls — 2026-09-10

Audit found dry-run platform uploads, ambiguous staging creation, and draft
releases reaching the public mirror. This slice separates preparation,
platform attachment, publication and stable mirror promotion. All releases
share one concurrency group; each attachment requires a successful real
build and rechecks the exact tag/SHA draft. Manual runs default to dry and
skip release writes and Apple notarization submissions. Intel uses an
explicit Intel runner. Published prereleases cannot promote the stable feed.

`scripts/release-policy.mjs` derives pinned outputs and partial-build draft
state without shell interpolation. `release-state.mjs` verifies lightweight
and bounded annotated tags, exact release target SHA, and strict API results.
A tag-endpoint 404 alone is insufficient: drafts require a complete bounded
release-list lookup. Creation uses --verify-tag and refuses ambiguous,
published, malformed or unavailable state. Only preparation may create;
assertions are read-only. One real authenticated GET confirmed gh's HTTP404
response shape; all unit-test provider calls are injected. No remote writes.

`release-payload.mjs` parses update feeds, verifies size/SHA512 and platform
SHA256 checksums, matches stable aliases to versioned bytes, rejects stale
assets and filesystem links, and requires a complete optional Intel set.
It generates the existing latest.json schema and an explicit rsync list
containing every update target. Generated output names cannot themselves be
feed/checksum references. Pinned yaml2.9.0 is now a project dependency; the
lockfile adds it and associated optional-peer keys without unrelated version
upgrades. The existing pnpm.overrides warning remains a recorded P2 follow-up.

Parsed workflow guard tests cover eight known mutation steps and negative
regressions. Review caught and fixed dry input overrides, fabricated complete
build results, wrong upload targets, GitHub draft lookup behavior, and feeds
referencing files the mirror would overwrite. Focused verification:
**4 files / 180 passed / 0 skipped in 1.47s**. Frontend/server typechecks,
scoped lint and four helper syntax checks passed. Full-suite and final
workflow lint results follow before commit.

Commercial implication: verified update bytes and controlled publication
are prerequisites for a usable desktop distribution; this is not evidence
of conversion or revenue. No release dispatch, installer publication,
notarization submission or VPS mutation occurred. The 1.10.4 packaged app
from Loop25 commit216df5b remains the latest locally verified artifact.

Next release blockers, retained explicitly: run selected-SHA tests in the
release pipeline; replace host-Node desktop smoke with the actual packaged
Electron runtime; move Gatekeeper assessment after notarization; account for
post-staple DMG bytes in update feeds; make stable mirror promotion atomic
and monotonic. Prepare the versioned candidate only after these gates. CI
runner billing remains distinct from Codex allowance; do not retry unchanged
provider failures. Native GUI/install/update, Google native sign-in, Android,
VM execution and Mimosa remain unverified. Latest usage: **14% used / 86%
remaining**. Existing goal and hourly heartbeat remain active.

Loop26 final verification: **212 files / 2416 passed / 8 skipped in
225.28s**, exit0, **180 additional passes** over Loop25. Full log:
`.omb-scratch/verification/loop26-full.log`. Official checksum-verified
actionlint1.7.12 passed **4 workflows / 0 diagnostics in 0.0267s**; ShellCheck
was unavailable. Independent review rejected **5/5 attempted guard
bypasses**, with no new material blocker inside this slice's controls.
The bounded validator is not a general proof of all possible workflow code.
Production updater GET still reports **1.10.4**; this source slice changes
release controls, not the installed or published application version.
Rollback is a reviewed source revert before dispatch; no release, tag or
mirror asset was created or modified during this loop.

## Loop 27 — Native release acceptance — 2026-09-10

Loop26 **5a98daa** is pushed. This slice makes release preparation install
frozen dependencies and run lint, types, main Vitest, broker, updater and
Electron syntax gates on the selected commit before creating a draft. CI's
build job now actually runs the build. Removed the Intel job's dependency
mutation after checkout.

All four native jobs select the exact packaged executable, installed
Electron version, platform and architecture through release-native-smoke.
The existing isolated server gate now checks process.platform too. Private
IPC cancellation lets the helper finish owned-process cleanup before exit;
this avoids the Windows force-termination behavior of forwarded signals.
No new Windows runtime execution is implied by those contract tests.

Mac signature verification stays before notarization; Gatekeeper assessment
requires successful notarization/stapling. refresh-mac-feed preserves ZIP
bytes and updates DMG size/hash plus matching legacy fields through an
atomic local replacement. Changes require explicit successful-notarization
authorization; unsigned/dry runs must still match their original DMG hashes.
Mutation tests reject bypasses of selected-commit tests, actual native smoke,
signing acceptance and feed refresh.

Build and both typechecks passed; Vite **5.61s** with the existing large-chunk
warning. Broker **2/2 in188ms**, updater **14/14 in78.90ms**, eight Electron
syntax checks passed. Focused root/feed checks: **3 files / 121 passed /
0 skipped in24.13s**. Wrapper, actual Mac and full-suite results follow.

Broader lint audit failed: **92 errors / 8 warnings across21 files**, exit1.
Every affected file is byte-identical to Loop26; none belongs to this slice.
Evidence: `loop27-full-lint.log` and `loop27-lint-baseline.json` in
`.omb-scratch/verification/`. Examples include unreviewed type assertions
and unparsed input boundaries in existing tests/server code. Scoped lint
for this slice passes. Do not call the release ready: the new gate correctly
refuses staging while these errors exist. Next pick is this bounded lint
cleanup, then atomic/monotonic mirror promotion and the versioned candidate.

Commercial implication: testing the executable users receive is necessary
for dependable distribution; no conversion/revenue outcome is inferred.
No signing-provider submission, release dispatch, upload or VPS mutation.
Native GUI/install/update, native Google login, Android/Watch UI, VM and
portable account recovery remain unverified. Allowance **15% used / 85%
remaining**; the broad goal and existing heartbeat remain active.

Wrapper contracts: **30/30 in482ms**, no skips. Actual wrapper execution
against the owned Loop25 app passed **9/9 in3.745s**, exit0, using
Electron43.4.0 / Node24.18.1 / ABI148 / darwin-arm64. Native SQLite1,
contained proxies7, owned HTTP/PID1. Runtime, server, addon and signature
resource hashes stayed unchanged. Evidence: `loop27-native-wrapper/`.
This is not a new build, GUI, installer, notarization or Windows/Linux run.
Official actionlint1.7.12 passed **4 workflows / 0 diagnostics in0.021s**;
independent acceptance mutations **10/10 rejected**. ShellCheck remains
unavailable. Evidence: `loop27-acceptance-controls.json` and
`actionlint-1.7.12/loop27-workflows-final-result.json`.

Loop27 final suite: **214 files / 2523 passed / 8 skipped in225.85s**,
exit0, **107 additional passes** over Loop26. Full evidence:
`.omb-scratch/verification/loop27-full.log`. Build/types/scoped lint pass;
the separate global lint result remains **92 errors / 8 warnings**.
Read-only repair grouping: provider storage/transport6files31errors2warnings;
harness/contracts8files29errors1warning; companion/CLI7files32errors5warnings.
Start with provider input/persistence contracts. Preserve queue snapshot
semantics and audit genuine linter false positives instead of weakening
types or globally disabling rules. No new desktop release is claimed.

## Loop 28 — Provider transport and vault preservation — 2026-09-10

Loop27 **1be0aea** is pushed. This slice repairs the provider storage/transport
lint bucket while preserving the hosted workspace containment gate. Google
account and manual Drive connections now share checked upload/list/download
contracts. Failed, malformed, incomplete or cyclic searches cannot silently
become an empty backup or trigger a new upload. Searches request newest
modified files first, follow empty pages, exclude trash, and stop at ten
pages. Sequential uploads update the newest matching file; creates alone
set the app-data parent. Opaque file IDs and upload receipts are validated.
Stored Google token rows are validated per account; a fresh access token
works without requiring a refresh token until renewal is necessary.

Telegram validates both HTTP/envelope status and method results without
stripping the result during shared validation. An explicit chat cannot fall
back to another chat's document. Reconnect preserves a cached file only for
the same complete bot/chat binding. Review caught late-transfer races:
upload cache writes and local restores now reject a changed connection;
manual Drive restore also checks its captured refresh-token binding before
writing. Deferred mocked transfer cases cover the Telegram decision boundary.
Legacy null-chat discovery remains supported and does not prove ownership.

The key vault parses individual account/provider entries, keeps valid
neighbors readable, and refuses mutations when the existing structure is
damaged or unreadable. Disk bytes remain available for repair. Missing files
alone initialize a new vault; readers never migrate. Existing v1 migration,
per-file salts, timestamps and mode0600 are covered. Same-account merge is a
no-op; own-key maps avoid inherited account/provider names. Existing policy
is retained: a structurally valid but undecryptable v2 target entry still
wins a conflicting merge. This needs a separate recovery-policy decision.

Focused verification: **3 files / 166 passed / 0 skipped in2.23s**. Both
typechecks and scoped lint pass. Full build/suite results follow below.
Global lint now reports **61 errors / 6 warnings across15 files**, reduced
by31errors/2warnings. Remaining buckets: harness/contracts29errors/1warning
in8files; companion/CLI32errors/5warnings in7files. No rules were disabled.

Provider API tests use mocked fetch and in-memory/temporary fixtures only;
this is not Google/Telegram browser E2E or cross-device recovery evidence.
References: Google Drive [files.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
and [uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
Concurrent first uploads can still create duplicate Drive files; no old
duplicates were deleted. The v1 bundle remains global and deployment-secret
bound, and hosted routes remain disabled. No real vault, provider backup,
demo session, release asset or external account was mutated by verification.

Commercial implication: trustworthy recovery behavior is a prerequisite for
paid use, not evidence of sales or revenue. Next: clear the harness lint
bucket, then companion/CLI readiness and atomic/monotonic mirror promotion
before preparing a release candidate. Native Google login, GUI/install/update,
Android/Watch UI, VM, portable recovery/sync and Mimosa remain open.

Loop28 final verification: **215 files / 2670 passed / 8 skipped in236.29s**,
exit0, **147 additional passes** versus Loop27. An earlier full pass ran
while review fixes were landing; `loop28-full.log` is the authoritative
rerun after all source changes froze. Build passed (Vite5.17s, existing
large-chunk warning), both types and scoped lint passed. Reviewed hashes
are in `loop28-reviewed-source.json`; full/scoped diagnostic logs are beside
it. Final review found no remaining material blocker within this slice.
Public updater GET returned200 and still reports **1.10.4**. Source push
does not establish deployment or a new desktop release. Allowance now
**18% used / 82% remaining**; no reset consumed. Rebase was up to date.

## Loop 29 — Fleet contracts and bounded goal scheduling — 2026-09-11

Loop28 **36372e6** is pushed. This slice repairs the remaining harness lint
bucket. Driver PID notifications now use their declared RuntimeEvent
variant directly, preserving spawn/retry timing. Watchdog records assign
an optional PID only when present. Goal test fixtures use complete runtime
events and exercise the public timer rather than a private method cast.
The queue snapshot remains explicit: work queued while a dispatch awaits
must wait for the next tick. A deferred two-goal regression covers this.

Review found and fixed a goal-capacity defect: after200 records, creation
could remove the newly inserted goal before its first dispatch. Creation
now preserves active goals and the new record, pruning only the oldest
terminal history to maintain200 records. If all200 are active, creation
returns the existing status409 error convention before changing disk,
events or dispatch state. Stopping a goal makes capacity available again.
Numeric coercion/default/round-cap behavior is retained; this is not a new
HTTP input-validation claim.

Fleet MCP now parses pairing configuration, JSON-RPC requests, tool
arguments and method-specific REST responses through named contracts.
Compact roster fields retain omission semantics; receipt/audit/why/scorecard
data remain available to their existing tools. Approval selection continues
to scan a reversed copy and stop at the newest substantive bot reply.
String request IDs and integer0 retain their identity. Invalid JSON and
request envelopes receive protocol errors; valid notifications stay silent.
References: [JSON-RPC2.0](https://www.jsonrpc.org/specification) and
[MCP base protocol](https://modelcontextprotocol.io/specification/2025-06-18/basic).
No protocol-version upgrade or broader capability claim is made.

Initial focused checks: drivers **3files/55passed/1skipped in4.84s**;
goals/watchdog **2files/26passed/0skipped in2.03s**. Their scoped lint passed.
Fleet/final integrated gates follow before commit. Source review preserves
legitimate202 task acknowledgements without a message ID, string-valued
answered cards and historical usage data. Verification uses local fixtures;
no real provider task, approval or demo session is invoked.

Commercial implication: predictable task dispatch and inspectable tool
failures support reliable fleet use; this is not conversion/revenue evidence.
After this bucket, companion/CLI lint and dependency readiness remain,
followed by atomic/monotonic release mirror promotion and a versioned
candidate. Native Google login, GUI/install/update, Android/Watch UI, VM,
portable recovery/sync and Mimosa remain unverified.

Fleet final focused run: **1file/67passed/0skipped in13.07s** after replacing
the fixture's demo address with an invalid test hostname and a rejecting
default fetch stub. The integrated typecheck found one heterogeneous JSON
fixture inference error; its named JsonObject[] annotation fixes that
without changing runtime behavior. Both types and scoped lint now pass.
Build passed (Vite4.99s, existing large-chunk warning). Global lint is now
**32errors/5warnings across7files**, down29errors/1warning from Loop28.

Next-bucket preflight: Android companion alone has29errors/2warnings in5
files. It is excluded from root tests/types and the root pnpm workspace.
Its configured jest-expo preset is missing/undeclared, there are no tests,
and its local npm lockfile is intentionally ignored. Installed SDK52 needs
an explicit standalone dependency/test plan; schema imports must not rely
on root's incidental Zod. Audit also found premature connected state and
late old-session roster/stream updates in useCompanion. Cover those with
deferred response/reconnect tests. Its README's build/distribution claims
need verification when fixing package readiness; no native parity claim.

CLI preflight contributes the other3errors/3warnings. Preserve its Node22+
zero-external-dependency/copy-install contract. Validate persisted PID/port
and model-option responses at their input boundaries. A valid number is
not process identity: stopDaemon currently signals a recorded PID even
when health fails, so add an owned-process check before any real signal.
QR replacement arrays must retain numeric zero for parity buffers, null
for unassigned modules, and independent rows. Direct CLI helper tests are
missing; cli/*.test.mjs is outside root Vitest discovery. Place regressions
under a configured test path and verify the bundled CLI separately.

Loop29 final verification: **215files/2716passed/8skipped in237.91s**, exit0,
**46 additional passes** versus Loop28. Authoritative evidence:
`.omb-scratch/verification/loop29-full.log`, source hashes in
`loop29-reviewed-source.json`, plus focused/build/type/lint logs. Build,
both types and scoped lint pass; global lint remains32errors/5warnings.
Final review found no material blocker in this slice. No new desktop
version, provider/browser E2E, installer or native login verification is
claimed. Allowance **20% used / 80% remaining**; no reset consumed. The
active goal and existing heartbeat continue with companion/CLI readiness.

## Loop 30 — Companion recovery and CLI process identity — 2026-09-11

Starting from pushed Loop 29 `ab708a9`, this slice clears the remaining
companion/CLI lint bucket while fixing the failures found by its audit.
Android remains a standalone npm package outside root tests and types. Its
declared Jest/Babel/Zod tools and committed lockfile now reproduce without
relying on root dependencies. A clean `npm ci --ignore-scripts --no-audit
--no-fund` installed **998 packages in 8.47s**; `npm ls --all` exits 0 with no
peer problems. The lock matches package dependencies and resolves only to
registry.npmjs.org, with no credential/query-bearing resolved URLs. Existing
SDK dependency deprecation warnings remain in the install log.

The native composition explicitly uses `expo/fetch`, whose streaming support
is documented in the [SDK 52 release notes](https://expo.dev/changelog/2024-11-12-sdk-52)
and present in installed Expo 52.0.49. The SDK 52 global React Native fetch is
not assumed to stream; the old versioned documentation URL redirects to
latest. HTTP defaults remain 8810; explicit HTTPS defaults 443 and bracketed
IPv6 is preserved. Named wire contracts validate saved connections, REST
envelopes and actual server fields while retaining valid neighboring rows.
Unknown wire kinds do not masquerade as authentication revocation.

Connection readiness now requires an accepted event stream with a reader.
EOF/failure clears readiness; stop cancels readers, requests and retry timers.
Review caught the server's hello-before-backlog ordering: a resumed hello's
latest cursor must not skip replayed events. Duplicate committed event IDs
are ignored. When replay is unavailable, a single recovery request refreshes
the fleet; stale snapshots preserve newer SSE state and retry with capped
250/500/1000/2000ms backoff, canceled on reset/disposal.

The session controller fences old connection reads, pairing responses,
frames, cursors, snapshots and pages. Serialized credential writes keep an
old pairing from restoring itself after unpair/remount; requested deletion
survives immediate disposal. Chat selection and retained actions require
the current client and active bot/room thread. These are client-observed
state checks, not an atomic server-side thread precondition.

CLI run records now require bounded positive integer PID/port values.
Health must identify the same Muster PID before SIGTERM, and again before
SIGKILL; redirects cannot provide that evidence. Failed health alone is
neither ownership nor exit. Exit is observed before reporting success;
an absent PID permits stale-record cleanup without a stop signal. Failed
verification preserves the run record, and a fingerprint check preserves
records replaced while shutdown waits. This is not a cross-process lock.
Startup readiness checks the spawned PID; up/setup refuse to overwrite an
unverified record. Setup validates engine/model values without stringifying
malformed IDs. The dependency-free parser has two reviewed, local
`no-runtime-typeof` exceptions at its primitive JSON boundary; no global
rule was disabled. QR buffers retain values/independent rows, and their
capacity error now accurately reports 213 bytes at M or 271 at L.

Final verification: root **216 files / 2,769 passed / 8 skipped in 235.19s**, exit 0,
**+53 passes** versus Loop 29. The separate companion suite is
**3 suites / 117 passed / 0 skipped in 1.277s** after the clean install. Android
typecheck/local lint and forced-root custom lint pass. Global repository
lint now passes with **0 errors / 0 warnings**, down from 32 errors / 5 warnings; the
forced-root check disables nested-config loading so the standalone config
cannot conceal repository rules. Root build includes both typechecks and
passes (Vite 5.10s, existing large-chunk warning). CLI focused 53/53 passed;
the built CLI passed syntax/help plus 1/1 owned-process stop smoke. QR has
220 before/after output comparisons and 2 capacity-error checks; no physical
decoder claim. Root source hashes stayed fixed during its full suite;
Android was checked separately after its final review/freeze.

Evidence: `.omb-scratch/verification/loop30-full.log`, build/lint/CLI/QR
logs and `loop30-root-reviewed-source.json`; standalone commands, install
results, dependency audit and source manifest are in `loop30-android/`.
Final read-only review found no material blocker in this slice. Public
updater GET returned 200 and still reports **1.10.4**. This source slice is
not a new native release or deployment proof. No demo session was touched.

Commercial implication: reliable reconnect, account recovery and predictable
local control reduce avoidable lost work; no conversion/revenue evidence is
claimed. Next release gate is staged, validated, atomic and monotonic public
mirror promotion (current workflow still rsyncs stable files in place), then
correct stale bump-script guidance and prepare a versioned candidate. Keep
the existing signed/runtime/install/update acceptance gates and GitHub billing
escalation intact. A newly identified companion follow-up: ChatViewScreen
still clears composer text before an asynchronous send succeeds; preserve
draft/error recovery in a separate UI slice before native acceptance.
Camera/deep-link UI is unimplemented; native Google login, device streaming,
Android/Watch UI, VM, portable account recovery/sync and Mimosa remain open.
Allowance **22% used / 78% remaining**; no reset consumed. Broad goal and
existing heartbeat remain active.

## Loop 31 — Atomic and monotonic download publication — 2026-09-11

Starting from pushed Loop 30 `4b77308`, the release mirror no longer copies
candidate files directly over live feeds. The workflow transfers an exact
manifest to a fresh `.incoming/<run-id>-<attempt>` directory, then invokes a
dependency-free Unix Python promoter with the expected manifest SHA256.
The existing public root and all its ancestors must be canonical directories
before staging; no root replacement or ownership change is attempted.

The producer hashes feeds and latest metadata as well as installer bytes.
Every updater URL must be a versioned immutable target, so a cached old feed
continues to download its original bytes after publication. `latest.json`
uses the matching GitHub release's authoritative `published_at`, making retry
bytes deterministic. The generated transport manifest cannot appear as its
own feed/checksum input. Canonical version/SHA and supported target names
match the remote contract.

The promoter holds a kernel file lock across validation and version comparison.
It streams file copies/hashes, preserves old versioned targets and unrelated
files such as the CLI, and switches stable/feed/latest aliases through one
`.current` replacement. Legacy flat mirrors first move through an equivalent
old-byte snapshot/link layout; interruption at any exposed migration checkpoint
is resumable. Initial empty mirrors have a separate recoverable state. Lower
versions, conflicting same-version source/bytes, immutable filename collisions
and removal of an already published platform are refused. Current public Intel
availability therefore requires a verified Intel payload in the successor.

The research basis is [GitHub concurrency ordering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
and [Linux rename behavior](https://man7.org/linux/man-pages/man2/rename.2.html).
The design preserves the fixed root because it may be bind-mounted, and does
not pretend that separate HTTP requests to mutable aliases form a transaction.
The [migration/acceptance runbook](../release-mirror.md) records the exact
layout, inputs, recovery rules, retained artifacts and operational limits.

Candidate preparation guidance now matches the tag-triggered workflow: review
and verify a candidate commit, dry-run its exact SHA, then push only its explicit
version tag when release gates and authorization permit. No version was bumped,
tag created or release workflow dispatched in this slice.

Final verification: **219 files / 2,836 passed / 8 skipped in 240.93s**, exit 0,
**67 additional passes** versus Loop 30. Focused producer/workflow checks:
**2 files / 149 passed / 0 skipped in 1.27s**. Promotion and actual loopback
download checks: **2 files / 36 passed / 0 skipped in 5.66s**, including real
fixture-process interruption/lock release, migration checkpoints, cached old
feed targets, corrupted transfer rejection and unchanged retry/target repair.
Candidate script checks: **8 passed / 0 skipped in 651ms**. Those supplementary
counts are included in the full suite, not added to its total. Build and both
types pass (Vite 5.36s, existing large-chunk warning); global/scoped lint pass.
Actionlint reports no diagnostics across 4 workflows; ShellCheck was unavailable
and not run. The bounded workflow verifier still accounts for 4 platform uploads
and 8 mutation steps. Python syntax passed. Reviewed source hashes remained
unchanged through the full run; no generated bytecode is included.

Evidence: `.omb-scratch/verification/loop31-full.log`, focused/build/lint/
actionlint logs, `loop31-reviewed-source.json`, public metadata snapshots and
release-run inspection. Final read-only review found no material blocker in
scope. Public GETs for latest metadata and all three feeds returned 200 and
version **1.10.4**, with versioned targets. No Cache-Control header was present;
actual proxy/mount/cache behavior is not known from this observation.

A read-only SSH attempt to the workflow's default VPS host stopped at unknown
ED25519 host-key verification; no remote code ran and no trust settings changed.
The actual download server config is absent from the repository. Verify trusted
access, internal-path restrictions, symlink serving and cache behavior before
real migration. Latest inspected release run `34470403198` remains completed
with the GitHub account-payment/spending-limit annotation before builds, with
no newer successful run. No retry or payment change was made.

Commercial implication: a predictable installer/update path is a prerequisite
for distributing the desktop product; no adoption or revenue result is claimed.
Next prepare a versioned candidate with the explicitly built/verified CLI bundle
and local native GUI/install/update evidence, resolving external runner/signing/
VPS prerequisites through the board when necessary. Before native acceptance,
also preserve companion composer text on failed async sends in its own UI slice.
Native Google login, mobile/Watch/device E2E, VM, portable account recovery/sync
and Mimosa remain open. No demo session was touched. Allowance **26% used /
74% remaining**; no reset consumed. Broad goal and existing heartbeat stay active.


## Loop 32 — Companion message recovery and isolated desktop UI evidence (2026-09-11)

Starting source: `9fb3abb` (Loop 31 pushed and clean; pull was up to date).
The preceding mirror slice was confirmed with four public GETs after push:
latest metadata and all updater feeds remain **200 / 1.10.4**. Its atomic
promotion is committed source, not a production migration or new release.

Audit found that the Android companion cleared its composer before its async
send completed. A failed request lost the user's task, while the session's
previous void result also made an ignored stale request look like success.
The composer now waits for explicit acceptance, preserves the exact draft on
failure, shows the real error, and synchronously blocks repeated taps while
pending. Input remains editable; a successful earlier request cannot clear
newer edits, even if the user edits away and then back to the same text.

The session returns false for a stale connection/target and rechecks the current
session and thread after an acknowledgment. Composer identity includes the
actual connection object, bot/room kind, target and thread; disposal epochs
ignore late results from a previous screen. This is client-observed context
checking, not a server-side atomic thread precondition. Drafts remain in memory
only for the mounted chat and are discarded on navigation. No persistent draft
store, automatic resend, or delivery idempotency was introduced.

React Native tests now render the real screen using the installed official
native host stubs and React 18.3.1's matching test renderer. They exercise
failure/retry, acceptance, edits during send, repeated taps and bot/account/
thread/unmount isolation. The existing core tests remain in a separate Jest
project. This follows the boundary described in the [React Native testing
overview](https://reactnative.dev/docs/testing-overview): JS component tests
cannot establish native keyboard, device layout or platform-code behavior.

Final standalone verification from a real clean install: **1,004 packages in
9.02s**, then **4 suites / 132 passed / 0 skipped**, Jest **1.577s** (3.80s
command). This is **15 additional passes** over Loop 30's companion baseline.
Android types, local lint and root custom scoped lint pass. Root final suite:
**219 files / 2,836 passed / 8 skipped in 238.90s**, exit 0 (unchanged root count; Android runs separately). Root build and both typechecks pass (Vite 4.99s;
existing large-chunk warning), and global lint passes with no diagnostics.
Nine reviewed source files stayed fixed during verification. Evidence is
`.omb-scratch/verification/loop32-*` and `loop32android/`.

The actual browser suite initially had **7 startup failures / 1 pass** because
Playwright's matching Chromium was missing. After installing Chromium 151 /
build 1234, the same suite passed **8/8 in 34.4s**: desktop/cloud pairing,
consumed-code rejection, messages/reload, exact allow/deny decisions and
rehearsal evidence. The OAuth case verifies construction of the Google
redirect without following it; no real Google login is claimed by that test.

Current-source Electron 43.4.0 also ran through the real window/preload with
seven profile paths confined to a fresh owned directory, allowlisted child
environment and HTTP origins, isolated test accounts/servers and fake ACP.
It passed **8/8 checks in 5.454s**: path confinement, pairing UI, capability IPC,
exact-account pairing from the browser-displayed code, quick start, one task
and reply, transcript reload, and no observed page errors/external requests.
An initial fixture-only selector was ambiguous because the same reply also
appears in the sidebar and activity panel; scoping it to the transcript fixed
the check. Screenshots and result are in
`.omb-scratch/verification/loop32-gui-0iQFm0/`. All owned app/browser/server
processes closed. The demo at 127.0.0.1:8845 was never used or changed.

This is development-shell evidence, **not** packaged installation/update or
native Google acceptance. Direct packaged startup still performs connected-app
registration and computer-access setup before its smoke hook; do not mistake
an unisolated packaged launch for a harmless fixture. Existing local Loop 25
app remains ad-hoc 1.10.4 with 9/9 native runtime checks. Next prepare a versioned
candidate including an explicitly built, verified and published CLI artifact;
current release workflow does not yet produce that CLI. Keep exact-SHA and
atomic-mirror gates. Recorded GitHub runner billing, trusted VPS access/routing,
and signing prerequisites remain unresolved; do not retry unchanged external
failures or spend to bypass them. Device/Watch UI, VM, portable recovery/sync and
Mimosa remain open. Commercial intent is fewer lost first tasks; no measured
retention or revenue uplift is claimed. Allowance **27% used / 73% remaining**;
no reset consumed. The broad goal and existing heartbeat stay active.


## Loop 33 — Verified CLI release payload and 1.10.5 candidate (2026-09-11)

Starting source: `8b766a4`, main clean and pull up to date. Loop 32 was verified
progress, not completion of the broader OS/native/recovery goal. Audit found
that the release workflow never built or published the CLI repaired in Loop 30;
preserving the old public file could not distribute those fixes.

Candidate package version is now **1.10.5**. The public download page keeps its
actual **1.10.4** fallback badge until release metadata changes. No tag, workflow
dispatch, notarization submission, signing identity change, VPS write or public
release was performed in this slice. An explicit candidate version is not a
claim that installers are available.

The new CLI builder embeds the supplied exact version and full source SHA,
checks that the package version matches, and produces a standalone Node 22
bundle with built-in imports only. It writes immutable
`Muster-<version>-cli.mjs`, identical `muster-cli.mjs`, and exactly two SHA256
records in `SHA256SUMS-cli.txt`. The same helper verifies downloaded artifacts
without modifying them. It snapshots no-follow regular files, executes the
already-hashed bytes, rechecks originals after verification and rejects linked
output ancestors before creating directories. Five subprocess checks run with
owned home/data/cache/temp paths and no inherited credentials or Node hooks:
syntax, help, JSON identity, human identity and empty-log behavior. CI provides
Git provenance; the helper validates its inputs and bytes rather than claiming
to attest Git. Unbundled `--version --json` reports package version and null SHA.

The macOS arm64 job builds/verifies the CLI in dry and real runs and uploads
both files and checksums under the existing draft gate. Publication first
validates the downloaded hashes, then re-verifies the actual CLI identity and
commands before release. New complete payloads require the exact CLI pair and
dedicated checksums; partial drafts may omit the entire set, never an unchecked
subset. The latest metadata and transport manifest now include the stable CLI
and immutable target. CLI files cannot be updater feed targets.

The Python promoter makes the CLI part of atomic publication. For an old flat
CLI absent from old release metadata, it snapshots an auxiliary file without
inventing old release provenance. That works for flat desktop mirrors, already
managed generations and roots containing only an old CLI. Equivalent snapshots
preserve old GET bytes while links migrate; actual interruption/retry tests
then confirm one final switch. Previously published CLI URLs remain immutable;
future releases cannot drop the CLI. Existing version/SHA, checksum, lock,
platform, collision and non-downgrade gates remain. Read the updated
[download publication runbook](../release-mirror.md).

Focused verification: **172 producer/workflow tests across 2 files in 1.33s**;
**56 promoter/integration tests across 2 files in 8.32s**, including real process
death and loopback HTTP reads; **78 CLI/artifact tests across 2 files in 7.50s**.
These are subsets of the root suite, not extra counts to add. Final full suite:
**220 files / 2,904 passed / 8 skipped in 244.38s**, exit 0 (**68 additional passes** over Loop 32). Root build/both types pass (Vite **4.97s**, existing chunk
warning); global and scoped lint pass. Actionlint reports no diagnostics across
4 workflows; ShellCheck remains unavailable. Python syntax checks pass. Final
read-only review found no material blocker after fixing verifier snapshot,
ancestor-path and home-isolation gaps. Twelve source files were frozen for
verification; evidence is `.omb-scratch/verification/loop33-*` and `loop33-mirror/`.

Native candidate build/verification: local **1.10.5 arm64 DMG, ZIP and app built successfully**. Preparation
38.05s, speech helper3.22s, CUA staging2.44s, native packaging65.33s; the original
packaged Electron smoke passed **9/9 in5.32s**. Independent inspection passed
**15 artifact assertions**, including DMG verification, integrity of all **1,250
ZIP entries**, app/ZIP version, arm64 architecture, feed sizes/hashes and deep
strict signature checks. The DMG was mounted read-only/nobrowse, its app copied
into an owned installation directory and the mount detached in finally. That
copied app passed **9/9 runtime checks in6.389s**: owned HTTP1, proxy paths7 and
native database1, using Electron43.4.0 / Node24.18.1 / ABI148. Signature is
explicitly ad-hoc, not Developer ID or notarized; no GUI or real profile was
opened. Evidence and installers are in
`.omb-scratch/verification/mac-candidate-loop33-e0e30177df/`, including
`artifact-verification.json`. Source/runtime inputs stayed fixed; only the
expected generated updater bundle changed inside the owned build snapshot.
The shared host-native addon hash remained unchanged.

A live read-only Dependabot API audit confirms **35 open alerts: 1 critical,
25 high, 9 medium**, all in `android-companion/package-lock.json`. Six transitive
packages account for them. The critical `tar` 6.2.1 advisory and related highs
come through Expo CLI/cacache archive tooling; `@xmldom/xmldom`, PostCSS and
image-size are primarily Expo/Metro build/prebuild dependencies. No alert in
this response names the root desktop/server lock, and no direct affected import
was found in companion source. That does not establish project safety. Actual
navigation/UUID callsite checks did not establish the advisory-specific runtime
paths. Details, primary advisory URLs and validation steps are preserved in
`.omb-scratch/verification/loop33-dependency-audit.json`.

Next Android dependency slice should verify compatible tar 7.5.22, xmldom
0.8.15 and PostCSS fixes with a clean install, Metro export and actual Expo
archive/plist paths. image-size's two advisories have no published fixed version
in the inspected data, so evaluate mitigation/replacement separately. Do not
blindly switch CommonJS consumers to ESM-only decode-uri-component or UUID.
No alerts were dismissed and no dependencies were changed by this audit.

Remaining release gates include recorded GitHub runner billing restrictions,
trusted VPS access/serving/cache acceptance, native installation/update/signing
and platform-specific builds. Native Google, device/Watch UI, VM, portable
account recovery/sync and Mimosa remain open. The demo at 127.0.0.1:8845 was not
used or changed. Commercial intent is distributing the corrected CLI and a
verifiable desktop candidate; no adoption or revenue result is claimed. The full goal and existing heartbeat remain active. Allowance **29% used /
71% remaining**; no reset consumed.

Two no-window Electron-only probes (both exit0, 0.451s and0.413s) confirmed that
`--user-data-dir` confines userData/sessionData, while macOS Electron home and
appData still resolve to the real user despite an owned HOME environment. Node
os.homedir honors HOME; Electron temp ignores TMPDIR but honors
MAC_CHROMIUM_TMPDIR. Packaged updater startup also checks externally, so a
broker URL override alone is not a network boundary. No Muster app or
Google flow was launched in that probe. Combined with packaged startup always
requesting CUA permissions, this means environment-only GUI testing is not
fully isolated. Next native acceptance needs a disposable OS session or a
product startup change that makes computer access opt-in and defines a complete
profile path. Evidence: `loop33-electron-path-probe/` and the primary-source
notes in `loop33-packaged-gui-isolation.md` in the verification folder.

Loop33 post-commit evidence: pushed `d60446438c34b5171e64752dcb9a857209b34fc7`.
The recorded candidate's 934 source files match the commit except the two
ledger documents; this is a source comparison, not a fresh dependency-install
attestation. Actual exact-commit CLI build and downloaded-byte verification
passed **5/5 each (10 executions)**. A flat selection of the real Mac arm64 and
CLI candidate passed partial payload validation for **6 selected artifacts in
863ms**. It lacks Intel/Windows/Linux and is not a complete release. Evidence:
`loop33-cli-candidate.json` and candidate `committed-source-verification.json`
under `.omb-scratch/verification/`. Post-push production GET **200** still reports
**1.10.4 / cb5db9c**. The existing hourly heartbeat was updated, not duplicated.


## Loop 34 — Computer access starts with an explicit choice (2026-09-11)

Base `d604464`, pull/rebase up to date. Scope is per-session host computer
control, not a full profile sandbox or native release. Every desktop startup
atomically replaces the active profile's old connection with
`computer-access-off` before server startup. Failure to invalidate stops app
startup with a recovery message. Startup does not resolve the CUA binary,
import its SDK, request its permissions or connect to a standalone daemon.
Existing users now explicitly enable computer control after each full app
quit/reopen; closing a Mac window without quitting is still the same session.

The Runs on card has an **Enable for this session** action explaining Mac
permissions and its scope across This Mac/Auto bots. It does not choose a bot
assignment or send a task. Its buttons wrap and the panel fits a 320px viewport.
Only a live app-owned main frame at the current app origin can invoke native
enablement. Non-Mac platforms fail closed before driver access. Concurrent
clicks share a single attempt; failures show their actual message and permit
retry after confirmed cleanup. Unconfirmed partial-host cleanup requires an
app restart rather than allowing another daemon. Shutdown invalidates first,
fences late SDK/host/socket completion and cleans up the owned embedded host;
it does not stop a standalone daemon belonging to another app or revoke OS
permissions.

The harness treats an explicit userData descriptor as authoritative. Missing,
corrupt, unavailable or off descriptors cannot fall through to a legacy
profile. Legacy lookup remains for callers without a supplied profile; Linux
remains unavailable. Only embedded/standalone descriptors with a nonempty
command are accepted.

Capabilities are read afresh after activation, including failures. Shared
request/lifecycle guards reject stale results. A payload-free notification
from main tells all current renderers to re-read state after native activation
settles, covering a page reload while an old page's request is pending.
Listeners attach before the initial read and unsubscribe on detach. Same
provider remounts also reconcile after pending work. Failed capability reads
show an unconfirmed status instead of claiming access is off.

Verification: focused backend/Electron **5 files /64 passed /0 skipped in1.01s**;
frontend **2 files /26 passed /0 skipped in502ms**. These are subsets of the root
suite. Final full suite: **224 files /2,983 passed /8 skipped in248.18s**, exit0 (**79 additional passes** over Loop33). Final build and both types pass
(Vite4.90s; existing large-chunk warning), global/scoped lint pass. Final
independent review found no remaining source blocker. Seventeen reviewed
source hashes stayed fixed for verification.

Desktop UI verification: **14/14 checks in7.787s**, exit0, with readable non-overlapping 320px consent and wrapped destination controls. Accepted evidence and screenshots: `.omb-scratch/verification/loop34-gui-1P89qN/`; source script and logs: `loop34-desktop-gui*` in the verification folder. The fixture uses actual Electron
window/preload and owned pairing servers, fake ACP, and an owned standalone
socket-presence fixture. It is not authentic packaged GUI or real CUA/Google
acceptance. A native capture guard and an Off fixture bot bound the final run;
no OS permission is granted. A preliminary invocation failed before startup
because tsx is not installed; native Node type stripping is the working runner.
The first GUI attempt passed10 checks then failed its success fixture because
its125-byte Unix socket path was too long. An intermediate13-pass run allowed
Auto to reach the native screen-preview path, so it is excluded from isolated
acceptance; no permission grant was made. The corrected fixture uses a short
owned home, explicitly keeps its bot Off, guards native capture, and waits for
the mobile drawer transition before taking the accepted screenshot. All owned
app/browser/server/socket processes close, and the temporary short home is
removed. Demo127.0.0.1:8845 is untouched.

The actual 1.10.5 DMG/ZIP built in Loop33 is still tied to d604464; it does not
contain this later source change. No new public release, tag, workflow dispatch,
notarization, dependency change, VM launch or production mutation occurred.
The broader goal and existing heartbeat remain active.

Next native acceptance prerequisite: an early documented profile bootstrap
before imports capture Electron home/log/credential/socket paths. Explicitly
map Electron userData/sessionData/home/appData/logs/temp/crashDumps and child
home/cache/config/data/temp/cwd roots. OMB_DATA_DIR alone does not prevent
legacy-home migration; engine-specific home overrides and login-shell startup
also need review. Native permissions, LaunchServices, Terminal and installed
Tailscale remain OS-user scoped. Profile roots are not a filesystem/network
sandbox: broker registration and updater checks remain separate boundaries.
Begin with a no-window actual Electron path/child-env probe; do not label a
bootstrap-patched development shell as packaged acceptance. The separate
Android35-alert remediation, native Google/device/Watch/VM, portable recovery
and sync, Mimosa and recorded runner/VPS/signing gates remain open. Commercial
intent is a clearer first run with explicit desktop access; no conversion or
revenue uplift measured. Allowance **32% used /68% remaining** at the final actual check;
no reset consumed.


## Loop 35 — Explicit desktop profiles and packaged acceptance (2026-09-11)

Base `9e6fb2a`, pull/rebase up to date. The desktop now supports an explicit
`MUSTER_PROFILE_ROOT` paired with the matching launch-time `--user-data-dir`.
It validates the actual Electron browser path before changing other paths,
then configures app, server, companion, engine-home and temporary directories
before application imports capture them. Default launches remain unchanged.
See [Desktop profiles](../desktop-profiles.md) for the supported command,
layout and limits. This is app-data separation, not an OS or network sandbox.

The migration audit found that an explicit custom data directory could take
an existing legacy fleet. Migration now runs only for the implicit default;
explicit blank overrides fail. Profile launches skip the login-shell probe
and fence late results. MCP children receive only the explicit profile path
allowlist in addition to their existing minimal environment; deliberately
configured target overrides remain last.

Focused tests: profile configuration **1 file /35 passed /0 skipped in333ms**;
config/MCP **5 files /64 passed /0 skipped in3.67s**; discovery **2 files /16
passed /7 skipped in1.43s**. These overlap the full suite. Full verification:
**228 files /3,041 passed /8 skipped in250.37s**, exit0, **58 additional passes**
over Loop34. Build/both types pass (Vite4.88s, existing large-chunk warning),
global/scoped lint and diff checks pass. Thirteen reviewed source hashes were
frozen. The profile runbook is documentation only.

Actual no-window Electron43.4.0 / Node24.18.1 profile and utility-child probe:
**37/37 checks in15.807s**, exit0. It validates all seven Electron paths,
parent/child home/temp/cwd and the child path environment without importing
Muster main or invoking native permission APIs. The first fixture timed out
because top-level `await app.whenReady()` deadlocked ESM initialization;
changing the fixture to `.then(...)` resolved it. Evidence:
`.omb-scratch/verification/loop35-electron-path-694e3ba9b2/`.

New Mac arm64 candidate: `.omb-scratch/verification/mac-candidate-loop35-bb659817d0/`.
Preparation37.35s, speech3.26s, CUA2.58s, package58.73s; native smoke **9/9 in5.32s**.
Independent verification passed **15 artifact assertions**, including ZIP1251
entries, DMG integrity, version1.10.5, arm64, feed sizes/hashes and deep-strict
ad-hoc signatures. A copy from the read-only DMG passed **9/9 native checks
in6.662s**; the mount was detached. Shared host-native bytes stayed unchanged.
The build uses existing dependencies and a cached CUA input; it is not a fresh
install or notarization attestation. The updater vendor bundle is regenerated
by the build and recorded separately from authored source hashes.

Actual packaged GUI acceptance passed **10/10 in17.411s**, exit0, with no
renderer page errors. A fresh local email account completed quick start, sent
one task through the sole configured fake ACP engine, rendered its reply and
restored the account/onboarding/transcript after renderer reload. The real
packaged preload executed IPC, the bundled utility process served health and
the app used all seven profile paths. Computer access stayed off throughout.
The app archive, executable, bundled server and UI entry bytes were unchanged.
Root visually inspected sign-in/chat screenshots. Evidence:
`.omb-scratch/verification/loop35-packaged-gui-36dcXp/`.

This acceptance uses an empty synthetic Gemini credential-presence fixture,
an owned broker returning503 and harness-configured Electron session proxies.
It is not real Google/model/VM acceptance. The automatic updater request was
observed after15s and rejected at the owned proxy; download/install remains
unverified. The fixture configures supported `session.setProxy` on the real
default/updater sessions, not a source bootstrap or replacement renderer.
Before launch it checks24 package/build conditions:14 authored startup modules
against frozen source and ASAR bytes, generated updater bytes, five successful
build stages, six compiled server modules, UI entry and package main/version.
All owned app/server/engine/proxy/broker processes close; evidence stays local.

Preliminary packaged runs are preserved, not counted as accepted: **1 pass /
1 failure in2.669s** because Electron43 omits preload from its preference
snapshot, then **2 passes /1 failure in10.851s** because command-line proxy
flags did not configure the updater partition. The corrected preload check
combines exact packaged bytes with execution of the actual bridge. Network
configuration is disclosed explicitly; no OS-network isolation claim is made.

Next audit findings: the packaged auth footer still offers a desktop download
inside the desktop app. Also, source search found no caller for `initAnalytics`,
so activation-event calls are currently gated by an uninitialized tracker;
measurements must not be claimed. Treat UI context and a deliberate telemetry
policy as separate future slices, not a reason to silently enable collection.

No public release/tag, CI dispatch, signing change, production mutation or
real provider credentials were used. Demo127.0.0.1:8845 remains untouched.
The goal remains active. Google/device/Watch/VM acceptance, the Android
35-alert remediation, portable recovery/sync, Mimosa and the recorded
runner/VPS/signing gates remain open. No conversion/revenue result is claimed.
Allowance at the actual check: **34% used /66% remaining**; no reset consumed.
