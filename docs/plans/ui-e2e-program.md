# Muster UI and E2E audit program

**Status: 2026-09-10, current UI slice in progress.** This is the inventory
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
- **Settings inventory inspected:** **14 of 15 sections opened and read on
  desktop**, including General and all available sections except Usage.
  Opening a section does not verify every action, save, integration, or
  failure state within it.
- **Usage failure:** opening Usage blanks the application. The current
  engineering audit diagnosed a render-phase fetch loop in `InviteSection`.
  This is a failing flow, not a skipped or passing Settings check.
- **Mobile Settings failure:** a **390px** screenshot shows the fixed
  **190px** navigation column leaving roughly **100px** for content. The
  content is unreadable. The next slice must fix this layout and the Usage
  crash, then verify every Settings section again at the relevant widths.
- **Native iOS, Watch, Android, and packaged Electron checks have not run
  in this program.** Web viewport checks cannot substitute for them.
- Production GET verification found the previous sign-in release's
  `auth-shell`/`auth-password` bundle (`index-CpkiQPaW.js`). That confirms the
  earlier auth rollout; deployment of this responsive slice is not verified
  by that observation.

## Route matrix

Route sources: `src/App.tsx` and the public/static handlers in
`server/index.ts`. Marketing routes require the configured marketing
directory; the packaged SPA root instead redirects to sign-in or the app.
The router contains nine explicit SPA route patterns plus its fallback.

| Route | Required interactions and states | Current evidence / dependency |
| --- | --- | --- |
| `/` | Marketing navigation, mobile menu, app/download links; packaged SPA root redirect | Unverified in this slice; distinguish deployment modes |
| `/download.html`, `/teams.html`, `/switch.html` | Narrow layout, navigation, download/catalog links, installation handoff | Unverified; installer behavior needs platform checks |
| `/bots` | Team directory loading, unavailable state, install handoff | Unverified; catalog service is external |
| `/docs`, `/docs/install`, `/docs/quick-start`, `/docs/engines`, `/docs/agents`, `/docs/approvals`, `/docs/automation`, `/docs/goals`, `/docs/security`, `/docs/self-host` | All navigation, readable code/tables, mobile overflow, unknown-page 404; `.html` aliases | Unverified rendered UI; existing server tests cover routing |
| `/sign-in?next=…&authError=…` | Email login, error feedback, recovery links, password visibility, return destination, sign-out/re-entry, capability variants | Local wrong/correct email login and sign-out checked; remaining variants unverified; real Google requires provider account/consent |
| `/sign-up?next=…&ref=…` | Account creation, invalid inputs, existing account, disabled signup, referral preservation | Local email signup checked; remaining states unverified; Google-only and verification delivery need their services |
| `/forgot-password`, `/reset-password?token=…` | Neutral response, missing/invalid/expired/reused token, mismatch, successful reset and subsequent login | Unverified in this slice; disposable mail fixture can test app logic, real delivery needs email service |
| `/pair` | Auth gate, generation, copy, countdown, expiry, regeneration, consumed-code rejection | Unverified in this slice; two isolated servers can exercise bridge |
| `/claim#CODE` | Missing/malformed/expired/consumed code, fragment removal, session creation, `/app` navigation | Unverified; disposable claim fixture for browser logic, physical phone for QR scanning |
| `/app/*` | Auth gate, onboarding, reconnect, empty roster, No Engines, authenticated surfaces below | Local account/onboarding/reload and listed fake-ACP interactions checked; other states unverified |
| `/os` | Bot and Rooms windows, open/focus/minimize/restore/close, drag/resize, command console, attention targets, Back to app | Unverified; browser shell and packaged Electron are separate checks |
| `/desktop-auth/start?redirect=…`, `/desktop-auth/done?grant=…`, `/oauth/finish#code=…` | Invalid/expired grants, OAuth return, exchange, error recovery | Unverified in this slice; full success needs real OAuth and local desktop handoff |
| Unknown SPA route | Predictable fallback and preserved authentication state | Unverified |

## Authenticated surface matrix

These panels are application state under `/app/*`, not independent routes.
Repeat the interactions at narrow widths and with side panels open. The
current responsive conversation checks cover 320/390/768/1440px; other widths,
orientations, zoom levels, and native keyboard behavior remain separate.

| Surface | Required interactions and states | Current evidence / dependency |
| --- | --- | --- |
| **Onboarding:** Welcome, Engines, Teammate, Permissions, First task | Back/continue/skip, capability refresh, dismissal persistence, first useful task | Local onboarding and reload checked; every branch and capability variant remains unverified |
| **Roster / New or share:** New Bot, New Room, Export all bots, Teams, Archived bots | Selection/search, keyboard navigation, rename/pin/duplicate/archive/restore, isolated export/import | Unverified unless individually recorded in the slice report |
| **Chat** | Send/stream, retry/edit/branch, attachment/paste, older messages/search, scroll preservation, queued messages, Stop | Chat and Stop checked with fake ACP; remaining interactions unverified |
| **Group chat** | Member selection/mentions, group send/stream, room bulletin and working folder, find, replies, failure/empty states | Unverified |
| **Task / Model / Usage / Working folder pickers** | Open/close/focus, selection persistence, disabled reasons, long names, narrow columns | Task creation/switching, model controls/menu fit and responsive controls checked with fake ACP; usage/folder and full picker state matrix unverified |
| **OptionCard / Pending approval** | Allow/Deny, keyboard choice, history/evidence/rehearsal, expired/already answered ask, exact sibling-task navigation | Deny, Allow once, re-ask and Stop/cancel ledger checked with fake ACP; other states unverified |
| **Goal mode / Job receipt** | Bounded goal progression/stop, completion/failure evidence, exact task receipt and copy/export | Receipt, empty/missing-usage state, copy, narrow fit and Escape/focus return checked with fake ACP; goal lifecycle and remaining receipt states unverified |
| **Bot Settings** | Profile/persona, Chief of Staff, peer communication, model/effort, computer mode, folder, memory, Auto mode, voice | Unverified; real model/voice/computer effects need their runtimes |
| **Computer / Browser** | Available/unavailable/error states, viewer controls, navigation/profile selection, take/release control | Unverified; actual control needs provisioned local/cloud runtime and relevant permissions |
| **Inspector** | Open/read, thread identity, filters/search, empty/error states, reload | Inspector interaction checked with fake ACP; remaining states unverified |
| **Automations → Schedules / Webhooks** | Create/edit/pause/run/cancel, timezone, calendar/receipts, trigger/error, scorecard checks | Unverified; fake engine and local receiver can exercise isolated logic |
| **Connected apps → Marketplace / Connected** | Search/filter/detail, connect/cancel/refresh/disconnect | Unverified; real connections require vendor OAuth |
| **Teams → Explore / Import** | Catalog/error, manifest preview, file/URL import, confirmation, resulting bots/rooms | Unverified; local manifest covers fixture path, catalog/network separately |
| **Command palette / Fleet status / Notifications** | Search/action, keyboard dismissal/focus return, exact attention target | Duplicate fleet waiting-entry regression checked; other states unverified |
| **Muster OS → Agent window / Rooms / Command console** | Window management, room membership/messages, command recipient, attention navigation | Unverified |

## App Settings matrix

Source: `src/components/SettingsModal.tsx`. There are thirteen standard
sections; Audit and Why are inserted when reachable for the selected bot.
All sections below except Usage were opened and read on desktop. **Every
action/save/error-state entry below remains unverified unless explicitly
reported elsewhere.** The mobile layout failure applies across this surface.

| Exact section name | Required functional checks / dependencies | Current state |
| --- | --- | --- |
| General | Profile persistence, channel turn cap, diagnostics, account/sign-out, merge, updates, VPS setup; real account/desktop/server dependencies where applicable | Opened/read on desktop |
| Brain | Shared brief edit/save/reload, empty/error, saved text reaches intended fixture turn | Opened/read on desktop |
| Appearance | Skin selection/persistence, contrast, reduced motion, keyboard focus across surfaces | Opened/read on desktop |
| Connections | Configured/unconfigured states, key save/error, workspace sync; real service accounts separately | Opened/read on desktop |
| Engines | Availability/refresh/setup, CLI path, unavailable reasons, selected model; real authenticated CLI separately | Opened/read on desktop |
| Providers | Key save/error, configured flags, refresh and actual provider request; external account needed for live leg | Opened/read on desktop |
| MCP Servers | Add/edit/remove isolated server, unavailable/error, tool discovery; real integrations separately | Opened/read on desktop |
| Companion | Desktop capability gate, start/stop owned sidecar, pairing/cancel/expiry, reconnect/device management; native and network legs separate | Opened/read on desktop |
| Local VM | Missing prerequisites, provision/start/stop owned VM, error recovery; supported local runtime required | Opened/read on desktop |
| Voice | Voice selection/preview, dictation capability, microphone permission, playback; audio/native capabilities and optional vendor key | Opened/read on desktop |
| Usage | Totals/history, provider health, invitations, loading/error; fixture data plus separately verified accounting | **Fails: blank app; render-phase fetch loop diagnosed in InviteSection** |
| Vault | Configured/unconfigured, backup/list/restore isolated data, failure/recovery; external backup account for live leg | Opened/read on desktop |
| Billing | Plan/read-only state, checkout unavailable/error, fixture checkout handoff; no live purchase implied | Opened/read on desktop |
| Audit | Correct bot, allowed/denied/rule outcomes, filtering/history, empty/error | Opened/read on desktop when available |
| Why | Correct bot, hypotheses/findings/outcomes, expansion/navigation, empty/error | Opened/read on desktop when available |

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

`ios/TESTING.md` separates core tests, desktop sidecar, simulator, physical
phone, and off-network pairing. Follow that distinction. Historical Swift
test/build results are useful regression evidence, but do not validate this
slice's native UI. No checked-in native UI test suite was found in the audit.

## Existing automated coverage and its gaps

- `e2e/pairing.e2e.spec.ts` and `e2e/approval-card.e2e.spec.ts` contain six
  declared browser cases at the audit baseline. `playwright.config.ts`
  configures one 1280×900 browser viewport; it does not define mobile or
  packaged Electron projects. This program has not rerun those specs.
- The pairing case named **"sent messages actually RENDER in the
  transcript"** currently pairs, dismisses onboarding, and closes the
  context. It never sends a message or asserts its rendered row. Repair
  that test before counting it as transcript coverage.
- The OAuth case asserts a Google authorization-URL redirect using dummy
  client credentials. It does not complete Google authentication or verify
  the final desktop session.
- The approval spec does exercise message → fake ACP ask → Allow once →
  rendered completion. It does not cover all approval outcomes or devices.
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

1. **Settings usability and Usage crash.** Fix the `InviteSection` request
   lifecycle and responsive Settings layout. Exercise Usage without a blank
   app or repeated requests; open all fifteen sections on desktop and mobile,
   verify readable content and keyboard/focus behavior, then report numbers.
2. **Public routes and entry-state completeness.** Sweep marketing/docs and
   auth/pair/claim recovery states using isolated accounts and fixtures.
   Repair the misleading transcript E2E case and preserve an explicit record
   of what the Google test does and does not cover.
3. **Workspace operations.** Verify roster, group chat, Teams import,
   Connected apps, Bot Settings, and OS windows one bounded slice at a time.
   Keep task-specific waiting/working/queued attention discoverable when
   simplifying navigation; alerts must land on the exact conversation.
4. **Work lifecycle and evidence.** Expand fake-engine browser coverage to
   queueing, goal limits, rehearsal/history, retry/failure, routine/webhook
   outcomes, and receipt correctness. Use isolated data for mutations.
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
