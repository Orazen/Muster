# Muster UI and E2E audit program

**Status: 2026-09-10, conversation, Settings, public-page and approval slices verified locally.** This is the inventory
for the board's request to improve and exercise every page and major feature
on web, desktop, and mobile. Track **route × state × device**, rather than
treating a page opening as proof that every feature on it works.

This document records the current local checks reported by the active audit.
Final browser totals, full-suite results, commit, and deployment evidence
belong in [ceo-log.md](ceo-log.md). Unlisted outcomes remain unverified.

## Current evidence and known failures

- **26 distinct hands-on browser checks passed** for local authentication,
  onboarding, and conversation interactions. These are not automated
  Playwright cases. Separately, fourteen Settings sections were opened/read
  and Usage failed. Focused automated suite: **2 files / 16 passed / 0
  skipped**. Full suite: **182 files / 1799 passed / 8 skipped**, 207.62 seconds.
- **Real local server and account flow checked:** email signup, onboarding,
  reload, sign-out, rejected incorrect password, and successful email login.
  These checks use an isolated local account; they do not establish Google
  authentication, email delivery, or production account behavior.
- **Browser interactions checked with a fake ACP engine:** chat, task and
  model controls, receipt, Deny, Allow once, re-ask, Stop with a cancelled
  ledger result, Inspector, and responsive conversation controls at **320,
  390, 768, and 1440px**. The harness and browser
  interactions are real; the agent is a fixture. No external model completion
  or provider-authentication success is claimed.
- Additional checked states include task creation/switching, model-menu fit
  in a 448px conversation column at a 768px viewport, receipt fit at 320×568,
  empty receipt/missing usage, Copy receipt, Escape/focus return for receipt
  and Tools, Send-button clearance at 320px, and the duplicate waiting entry
  in fleet status. These remain part of the twenty-six hands-on checks.
- **Settings follow-up:** all **15 sections** were opened and checked for
  viewport fit at **320×568, 390×844, and 1280×900**: **45 render/layout
  checks**. These do not verify every control or external integration.
- **Usage crash resolved:** moved the invitation fetch out of render into
  an abortable effect with retry. Usage now loads the fixture's **6 turns /
  75 tokens** and provider history without blanking the app. Invitation
  copying writes the expected URL and only confirms successful copying.
- **Mobile Settings resolved:** a section selector replaces the fixed
  navigation column on phones; all available sections remain accessible.
  Follow-up fixes keep engine rows, credential help, and provider metrics
  readable at 320px. Keyboard checks cover initial focus trapping,
  disclosure navigation, search/Escape, focus return, and mobile selection
  after desktop filtering. Brain waits for the stored brief before enabling edits and serializes
  subsequent writes; load and save failures have separate retry actions. **12 focused browser checks** are recorded for this
  slice, separately from the 45 layout checks. Settings focused tests:
  **4 files / 33 passed / 0 skipped**; final full suite:
  **185 files / 1829 passed / 8 skipped**, 179.76 seconds.
- **Public pages:** all **14 HTML pages** rendered and fit at **320×568,
  390×844, and 1440×900**: **42 layout checks**, with no broken images
  detected after load. Fixed five initial overflow failures (homepage,
  Install, Quick start, For agents, Self-hosting). Nine named browser
  interactions cover table keyboard scrolling, mobile menu/Escape/focus,
  menu-to-docs, setup/install copying, Docker anchor, FAQ, docs navigation,
  and missing-page recovery. Static inspection covered **284 internal links,
  38 known-page fragments, and 2 parsed inline scripts**, with no detected
  fragment/ID/script failures; this is not 284 runtime link checks.
- **Release links:** six production download URLs returned **HTTP 200** and
  non-HTML content through GET, reading only their first 64 bytes. This
  verifies reachability, not archive integrity, current-source freshness,
  signing, installation, or successful application launch.
- **Native iOS, Watch, Android, and packaged Electron checks have not run
  in this program.** Web viewport checks cannot substitute for them.
- Production GET verification first found the account-entry release
  (`index-CpkiQPaW.js`), also checked in a fresh browser. A later GET found
  `index-DsorEPai.js` with the new Conversation controls and Copy receipt
  strings, confirming the conversation assets rolled out. Authenticated
  production interactions were not executed. Settings rollout needs its
  own release check.

## Route matrix

Route sources: `src/App.tsx` and the public/static handlers in
`server/index.ts`. Marketing routes require the configured marketing
directory; the packaged SPA root instead redirects to sign-in or the app.
The router contains nine explicit SPA route patterns plus its fallback.

| Route | Required interactions and states | Current evidence / dependency |
| --- | --- | --- |
| `/` | Marketing navigation, mobile menu, app/download links; packaged SPA root redirect | Public page layout at three widths; mobile menu/Escape, copy controls, FAQ and Docker handoff checked; packaged root redirect separately unverified |
| `/download.html`, `/teams.html`, `/switch.html` | Narrow layout, navigation, download/catalog links, installation handoff | Three-width layouts checked; Docker anchor works; six release URLs reachable by GET. Catalog/install and native behavior remain unverified |
| `/bots` | Team directory loading, unavailable state, install handoff | Unverified; catalog service is external |
| `/docs`, `/docs/install`, `/docs/quick-start`, `/docs/engines`, `/docs/agents`, `/docs/approvals`, `/docs/automation`, `/docs/goals`, `/docs/security`, `/docs/self-host` | All navigation, readable code/tables, mobile overflow, unknown-page 404; `.html` aliases | All ten guides fit at three widths; sidebar navigation, keyboard table scroll and missing-page recovery checked; existing server tests cover routing |
| `/sign-in?next=…&authError=…` | Email login, error feedback, recovery links, password visibility, return destination, sign-out/re-entry, capability variants | Local wrong/correct email login and sign-out checked; remaining variants unverified; real Google requires provider account/consent |
| `/sign-up?next=…&ref=…` | Account creation, invalid inputs, existing account, disabled signup, referral preservation | Local email signup checked; remaining states unverified; Google-only and verification delivery need their services |
| `/forgot-password`, `/reset-password?token=…` | Neutral response, missing/invalid/expired/reused token, mismatch, successful reset and subsequent login | Unverified in this slice; disposable mail fixture can test app logic, real delivery needs email service |
| `/pair` | Auth gate, generation, copy, countdown, expiry, regeneration, consumed-code rejection | Loop 10: 13 browser checks, 10 layouts and 2 HTTP checks for recovery/copy/expiry/refresh. Loop 11 verifies the anonymous gate and displayed cloud code → local desktop account → visible transcript/reload through CUA. These are isolated local servers; packaged desktop, real Google login and production pairing remain unverified |
| `/claim#CODE` | Missing/malformed/expired/consumed code, fragment removal, session creation, `/app` navigation | Loop 7: missing/malformed/consumed recovery, fragment removal, previously anonymous real local claim → authenticated app, mock 503 retry and departure during/after request checked; nine recovery layouts at 320/390/1440px plus retry at 320px. Expiry covered by server tests; physical QR scanning and production redemption unverified |
| `/app/*` | Auth gate, onboarding, reconnect, empty roster, No Engines, authenticated surfaces below | Local account/onboarding/reload and listed fake-ACP interactions checked; other states unverified |
| `/os` | Bot and Rooms windows, open/focus/minimize/restore/close, drag/resize, command console, attention targets, Back to app | Unverified; browser shell and packaged Electron are separate checks |
| `/desktop-auth/start?redirect=…`, `/desktop-auth/done?grant=…`, `/oauth/finish#code=…` | Invalid/expired grants, OAuth return, exchange, error recovery | Loops 8–9: 20 local HTTP cases cover cookies, callbacks, client/fallback buckets, shared direct/desktop limits, retry guidance and outer gate; 22 helper/lifecycle cases pass. Retry page checked at 320/390/1440px with pointer/keyboard recovery. Cookie forwarding is visible in production. Full Google login, native handoff and production throttle isolation remain unverified |
| Unknown SPA route | Predictable fallback and preserved authentication state | Unverified |

## Authenticated surface matrix

These panels are application state under `/app/*`, not independent routes.
Repeat the interactions at narrow widths and with side panels open. The
current responsive conversation checks cover 320/390/768/1440px; other widths,
orientations, zoom levels, and native keyboard behavior remain separate.

| Surface | Required interactions and states | Current evidence / dependency |
| --- | --- | --- |
| **Onboarding:** Welcome, Engines, Teammate, Permissions, First task | Back/continue/skip, capability refresh, dismissal persistence, first useful task | Local onboarding and reload checked; every branch and capability variant remains unverified |
| **Roster / New or share:** New Bot, New Room, Export all bots, Teams, Archived bots | Selection/search, keyboard navigation, rename/pin/duplicate/archive/restore, isolated export/import | P2 observed in Loop 13: selecting a non-first bot is lost on reload; hydration returns to bots[0]. Evidence remains intact after reselection. Remaining actions unverified unless recorded |
| **Chat** | Send/stream, retry/edit/branch, attachment/paste, older messages/search, scroll preservation, queued messages, Stop | Chat and Stop checked with fake ACP; remaining interactions unverified |
| **Group chat** | Member selection/mentions, group send/stream, room bulletin and working folder, find, replies, failure/empty states | Unverified |
| **Task / Model / Usage / Working folder pickers** | Open/close/focus, selection persistence, disabled reasons, long names, narrow columns | Task creation/switching, model controls/menu fit and responsive controls checked with fake ACP; usage/folder and full picker state matrix unverified |
| **OptionCard / Pending approval** | Allow/Deny, keyboard choice, history/evidence/rehearsal, expired/already answered ask, exact sibling-task navigation | Loop 12: Allow once and Deny checked with an engine that waits for the decision; same card survives pending/completed reload, actual ACP choice verified. Three local HTTP tests cover Allow, Deny and exact thread isolation. Loop 13 retains rehearsal/history/why after decisions and reload (with explicit bot reselection), with 8 evidence checks and 6 layouts. Earlier re-ask and Stop/cancel ledger checks remain; other states unverified |
| **Goal mode / Job receipt** | Bounded goal progression/stop, completion/failure evidence, exact task receipt and copy/export | Receipt, empty/missing-usage state, copy, narrow fit and Escape/focus return checked with fake ACP; goal lifecycle and remaining receipt states unverified |
| **Bot Settings** | Profile/persona, Chief of Staff, peer communication, model/effort, computer mode, folder, memory, Auto mode, voice | Unverified; real model/voice/computer effects need their runtimes |
| **Computer / Browser** | Available/unavailable/error states, navigation/profile selection, stop/reopen and recovery; actual computer control separately | Loop 15 verifies address-driven browser preview with installed Brave and isolated profiles; it is separate from agent browsing and has no page-input/takeover transport. Local/cloud desktop control remains unverified. See latest CEO log for exact counts. |
| **Inspector** | Open/read, thread identity, filters/search, empty/error states, reload | Inspector interaction checked with fake ACP; remaining states unverified |
| **Automations → Schedules / Webhooks** | Create/edit/pause/run/cancel, timezone, calendar/receipts, trigger/error, scorecard checks | Unverified; fake engine and local receiver can exercise isolated logic |
| **Connected apps → Marketplace / Connected** | Search/filter/detail, connect/cancel/refresh/disconnect | Unverified; real connections require vendor OAuth |
| **Teams → Explore / Import** | Catalog/error, manifest preview, file/URL import, confirmation, resulting bots/rooms | Unverified; local manifest covers fixture path, catalog/network separately |
| **Command palette / Fleet status / Notifications** | Search/action, keyboard dismissal/focus return, exact attention target | Duplicate fleet waiting-entry regression checked; other states unverified |
| **Muster OS → Agent window / Rooms / Command console** | Window management, room membership/messages, command recipient, attention navigation | Unverified |

## App Settings matrix

Source: `src/components/SettingsModal.tsx`. There are thirteen standard
sections; Audit and Why are inserted when reachable for the selected bot.
All fifteen sections below were opened and checked for layout at 320, 390,
and 1280px. **Every action/save/error-state entry below remains unverified
unless explicitly reported elsewhere.** Layout coverage is not integration
coverage.

| Exact section name | Required functional checks / dependencies | Current state |
| --- | --- | --- |
| General | Profile persistence, channel turn cap, diagnostics, account/sign-out, merge, updates, VPS setup; real account/desktop/server dependencies where applicable | Layout at three widths; actions unverified |
| Brain | Shared brief edit/save/reload, empty/error, saved text reaches intended fixture turn | Local edit/save/reload checked; delayed-read/write regressions covered separately; injection into a new turn remains unverified here |
| Appearance | Skin selection/persistence, contrast, reduced motion, keyboard focus across surfaces | Atelier applies and persists after reload; Midnight restored; contrast and reduced-motion audit remain unverified |
| Connections | Configured/unconfigured states, key save/error, workspace sync; real service accounts separately | Layout at three widths; actions unverified |
| Engines | Availability/refresh/setup, CLI path, unavailable reasons, selected model; real authenticated CLI separately | Layout at three widths; actions unverified |
| Providers | Key save/error, configured flags, refresh and actual provider request; external account needed for live leg | Layout at three widths; actions unverified |
| MCP Servers | Add/edit/remove isolated server, unavailable/error, tool discovery; real integrations separately | Layout at three widths; actions unverified |
| Companion | Desktop capability gate, start/stop owned sidecar, pairing/cancel/expiry, reconnect/device management; native and network legs separate | Layout at three widths; actions unverified |
| Local VM | Missing prerequisites, provision/start/stop owned VM, error recovery; supported local runtime required | Layout at three widths; actions unverified |
| Voice | Voice selection/preview, dictation capability, microphone permission, playback; audio/native capabilities and optional vendor key | Layout at three widths; actions unverified |
| Usage | Totals/history, provider health, invitations, loading/error; fixture data plus separately verified accounting | Crash fixed; fixture totals, provider history, and invitation copy checked; live accounting and public Wrapped publication remain unverified |
| Vault | Configured/unconfigured, backup/list/restore isolated data, failure/recovery; external backup account for live leg | Layout at three widths; actions unverified |
| Billing | Plan/read-only state, checkout unavailable/error, fixture checkout handoff; no live purchase implied | Layout at three widths; actions unverified |
| Audit | Correct bot, allowed/denied/rule outcomes, filtering/history, empty/error | Layout at three widths when available; actions unverified |
| Why | Correct bot, hypotheses/findings/outcomes, expansion/navigation, empty/error | Layout at three widths when available; actions unverified |

## Native and packaged clients

**None of these native UI checks has been executed in this program.**
The actual Android source is `android-companion/`; the handbook's `android/`
path is not the current checkout location.

| Client | Actual surfaces | Evidence required |
| --- | --- | --- |
| iOS | Pairing, roster, bot/room chat, task manager, computer, settings | Simulator layout/navigation; physical QR/Bonjour, background notification, reconnect and notification-to-task |
| Watch | Pairing, approvals-first roster, approval detail, bot/room chat, settings | Simulator layout plus actual Watch delivery/interaction and duplicate/stale decision behavior |
| Android | PairingScreen, ChatListScreen, ChatViewScreen; unpair action in roster | Emulator/device navigation, keyboard/safe areas, QR, streaming/reconnect, decisions; no separate Settings screen is declared by current `App.tsx` |
| Electron | Web shell plus native auth bridge, updates, companion, local capabilities | Packaged launch/relaunch, native window controls, filesystem/dialog/permission behavior and local OAuth return |

Read-only toolchain inventory: Xcode 26.6, Swift 6.3.3, XcodeGen, eleven
available iOS 26.5 and five watchOS 26.5 simulator devices are present; all
were shutdown. Android SDK/API images, Java 17, installed Expo dependencies,
and an existing AVD are available, but three referenced artwork files and
the configured `jest-expo` preset are missing. The development Electron
binary is missing; installed/release applications exist but their source
freshness is unverified. This inventory ran **0 tests/builds/native UI
checks** and installed or launched nothing. Begin native verification with
`swift test --package-path ios`, then the explicit simulator build/manual
steps in `ios/TESTING.md`; core tests are not SwiftUI coverage. Establish
isolated Electron userData as well as OMB_DATA_DIR before native launch.

`ios/TESTING.md` separates core tests, desktop sidecar, simulator, physical
phone, and off-network pairing. Follow that distinction. Historical Swift
test/build results are useful regression evidence, but do not validate this
slice's native UI. No checked-in native UI test suite was found in the audit.

## Existing automated coverage and its gaps

- `e2e/pairing.e2e.spec.ts` and `e2e/approval-card.e2e.spec.ts` contain six
  declared browser cases at the audit baseline. `playwright.config.ts`
  configures one 1280×900 browser viewport; it does not define mobile or
  packaged Electron projects. Loop 12 now typechecks and discovers **7 cases
  in 2 files**, including two rewritten approval cases. **0 Playwright runner
  cases executed** under current CUA-only UI instructions. Loop 11 records
  nine pairing browser checks; Loop 12 records ten approval browser checks.
  Loop 13 adds a two-turn rehearsal case: **8 cases in 3 files discovered
  and typechecked, 0 runner cases executed**. Discovery does not establish
  that the runner cases pass.
- Loop 11 replaces the false-positive **"sent messages actually RENDER in the
  transcript"** case. The revised test sends a unique message and requires
  visible user/reply text in unique transcript rows before and after reload.
  CUA verified those interactions with two real local servers and a fake ACP
  engine; the revised Playwright runner itself remains unexecuted.
- The OAuth case asserts a Google authorization-URL redirect using dummy
  client credentials. It does not complete Google authentication or verify
  the final desktop session.
- Loop 12 repairs an approval false positive: the old fake engine emitted
  its successful reply before requesting permission. The new gated mode
  emits success only after the exact Allow once response and a distinct
  denied reply after Deny. Both rewritten browser cases pin the same card
  through reload, assert no premature reply and verify actual ACP outcomes.
  Shared fixtures own their ports, accounts, environment and cleanup;
  unexpected browser errors and external requests fail the test.
- `scripts/e2e-server.mjs` exercises HTTP APIs rather than browser UI. Its
  requests do not attach a session cookie, and it permits skipped engines
  and soft-passed approval legs. Do not run it against the existing demo
  server or count its final success line as an all-features browser result.
- `server/docs-static.test.ts` checks public document routing, not browser
  readability. `src/pages/AuthPages.test.ts` checks rendered markup contracts,
  not completed authentication. `server/liveness-e2e.test.ts` uses the real
  harness with fake ACP processes, not a real external engine or browser.
- Full Vitest, typecheck, build, lint, browser interactions, external
  integrations, and native checks each report their own results. A pass in
  one category does not fill another category's unverified cells.

## Next verified slices

Loop 7 narrowed entry recovery to the self-host claim page. A malformed `%`
fragment previously threw `URIError` and blanked the app. Its effect also
removed the fragment before React's development re-subscription, producing
a false missing-code state; a completed request could redirect after leaving.
The repaired flow keeps one request, validates confirmation, detaches UI
updates and cancels navigation on departure, with explicit recoverable errors
inside the shared responsive auth layout. Open console reloads authentication
even when the server set a session cookie but its confirmation was malformed;
a real local claim through a response-corrupting proxy verified that recovery.
Browser fixtures confirmed exactly
one delayed submission and two submissions only after an explicit 503 retry.
These controlled responses do not prove external authentication.

Loop 8 repairs the desktop OAuth handoff by forwarding Better Auth's separate
`Set-Cookie` headers with the authorization redirect. The real local callback
accepts the returned signed state cookie and reaches a simulated provider
cancellation; missing or mismatched cookies still produce `state_mismatch`.
Twelve local HTTP cases use random dummy OAuth settings, separate fixture
processes, outbound fetch/TCP guards and manual redirects. An initial shared
fixture hit actual rate limits (8 passed / 4 failed); isolating each behavior
retains throttling and passes all 12 cases. A production GET before this fix
confirmed HTTP 302 to Google with zero cookies. Neither these tests nor that
GET followed an external redirect or completed provider authentication.

Loop 9 preserves the complete original X-Forwarded-For header through the
desktop wrapper, matching direct auth requests. It leaves Better Auth's IP
validation and chain handling intact; it does not promote the outer limiter's
Cloudflare/leftmost value into an auth identity. Local tests show distinct
accepted single-IP clients have separate limits, direct/desktop routes share
a client's budget, and missing/malformed/multi-value headers retain the shared
fallback. Production proxy topology is still unverified.

Upstream throttling now returns HTTP 429 with validated Retry-After seconds,
no-store and a readable recovery page. The outer ten-attempt gate remains
enabled and returns one-minute guidance. Pointer/keyboard recovery and three
final viewport layouts passed. Automated HTTP tests followed no external
redirects; one initial browser fixture attempt did reach Google's
invalid-client page, completing no login. It was repeated behind a local
proxy that blocks external redirects. These checks do not complete OAuth.

Loop 10 repairs `/pair` recovery in the shared AuthShell. Retry remains
available after request or malformed-response failures; copy is enabled only
for a confirmed live code and browser clipboard denial selects it manually.
The countdown respects exact expiry. Refresh retains a live code and its
original deadline; a new code follows expiry or consumption. Read-only
review caught and corrected dark-theme contrast and spacing before final
browser verification. Thirteen browser checks, ten layouts and two real
local consume/reuse HTTP checks passed. Controlled failures and short expiry
come from a local proxy; the successful generation/refresh/consumption path
uses the owned real API. The initial Loop 10 anonymous access attempt reused an existing session.
Loop 11 now verifies the anonymous redirect and cloud email sign-in, reads the
actual code field, pairs the exact account into a separate local server and
checks a unique message and fake-engine reply visibly before and after reload.
Consumed-code reuse leaves the desktop at sign-in. Nine CUA browser checks at
1280×720 and one manual-redirect HTTP OAuth check passed, with zero captured
browser console errors. This completes the isolated local bridge, not a
packaged Electron or real-provider login. Nine focused harness tests cover
environment isolation, ownership, pairing, fake-engine output and cleanup.
Loop 12 replaces the approval fixture's inherited provider environment,
fixed port, cleanup and unasserted errors with the shared owned fixture.
Three automated local HTTP cases verify Allow, Deny and thread isolation.
Ten CUA checks cover pairing/Quick start, pending state without a final reply,
pending reload, decision/result and completed reload for each decision.
Two direct outcome-file assertions verify the actual ACP selections; four
tabs reported zero captured console errors. These use current-source built
UI, two independent local cloud/desktop pairs and a fake engine. Browser
window size changed during manual verification (final measured 566×817);
no new device-layout matrix is claimed. Both fixture pairs and owned
data were cleaned up. Seven declared cases are discovered/typechecked,
not executed by the Playwright runner; current computer-use instructions
require CUA for browser actions. Real Google, model and native outcomes
remain separate gaps.

1. **Settings follow-through.** The Usage crash and responsive navigation
   slice is locally verified. Continue individual save/error and integration
   flows from the matrix; opening all sections is not their completion.
2. **Public routes and entry-state completeness.** Sweep marketing/docs and
   auth/pair/claim recovery states using isolated accounts and fixtures.
   The misleading transcript case is repaired and its core flow checked via
   CUA. The approval fixture is now isolated and its Allow/Deny lifecycle
   checked. Preserve the distinction between test discovery, hands-on checks
   and completed runner tests. Keep the Google
   redirect test separate from a successful provider login. The public-page slice fixed the Docker
   anchor, mobile overflows, and selected unsupported network, backup,
   license, receipt, and competitive claims while preserving Muster pricing.
   Remaining feature claims need their own source/runtime verification. Source has a PostHog integration but no
   current `initAnalytics()` caller was found; actual transmission remains
   unverified. Avoid claiming either active telemetry or no external traffic.
3. **Workspace operations.** Verify roster, group chat, Teams import,
   Connected apps, Bot Settings, and OS windows one bounded slice at a time.
   Keep task-specific waiting/working/queued attention discoverable when
   simplifying navigation; alerts must land on the exact conversation.
4. **Work lifecycle and evidence.** Loop 13 fixes the missing transcript
   rehearsal/why/history in `ApprovalCard`. Eight final browser evidence
   checks and six layouts at 320/390/1440px passed using actual local runtime
   journals and fake engine events. Reload checks explicitly reselected the
   original bot because selection reset was a separate P2. Loop 16 now
   restores bots/groups per account and tab; six local browser workflows
   passed. Room selection survives a 320px reload, but its header overflows
   to 450px and is the next layout slice. Then cover queueing, goal limits,
   retry/failure, routine/webhook outcomes and receipt correctness.
5. **Optional phone handoff and native clients.** Add a discoverable,
   skippable handoff after useful work, then verify pairing/reconnect and
   approval targeting on each supported client. Do not equate a mobile web
   screenshot with native app verification.
6. **Real integrations and release evidence.** Complete authorized provider
   and Google flows with their actual prerequisites; test packaged Electron
   and native builds. Verify deployed UI with GET requests and browser
   evidence, keeping production checks within the mandate.

## Research basis and claim boundaries

Gaia UI was checked at
[`14e20153ff1fa89897e2e90aa13eb17c69d4b156`](https://github.com/theexperiencecompany/gaia-ui/tree/14e20153ff1fa89897e2e90aa13eb17c69d4b156).
The actual StatRow source is adapted in `src/components/ui/stat-row.tsx`;
`public/third-party-notices.txt` ships its complete MIT notice and covers
the existing Gaia-derived message-bubble CSS. No Gaia runtime dependency,
documentation framework, or unrelated icon library was added.

The refreshed comparison is in
[competitive-landscape.md](competitive-landscape.md) and
[openmausbot-design-study.md](openmausbot-design-study.md). OpenMausBot
v0.1.70 was inspected at commit
[`67336fb2d7139de1b91a8050d9c1ca1215844fea`](https://github.com/milind-soni/OpenMausBot/commit/67336fb2d7139de1b91a8050d9c1ca1215844fea),
dated 2026-09-10 04:13:31 +05:30. This was source research, not competitor
runtime testing. It provides three concrete patterns for this program:

- [Conversation controls responsive to the chat column](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/ChatView.tsx).
- [Task-specific attention even when history is hidden](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/SidebarBotActivity.tsx).
- [Optional phone setup during onboarding](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/Onboarding.tsx).

Source-supported interactions are design inputs. They do not establish
performance victory or unmatched capability. The corrected studies withdraw
blanket assertions that OpenMausBot is single-bot, lacks mobile approvals,
or has no receipts. No security claim follows from UI work.

For every slice, report the tested build and environment, real test results,
what was simulated, observed failures, and remaining prerequisites. Distinguish
"opened/read," "interaction checked," "local end to end," "real external
integration," and "deployed verification." Keep unverified states visible
until their actual evidence exists.
