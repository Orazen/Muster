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
