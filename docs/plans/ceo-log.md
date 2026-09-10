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
