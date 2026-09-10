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
