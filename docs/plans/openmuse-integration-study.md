# OpenMuse integration study — feature-by-feature mapping onto Muster

Owner instruction: "checkout https://github.com/CopilotKit/openmuse — integrate these
features in Muster, even the iOS app — checkout all."

- **Source studied:** `/private/var/folders/j2/99fjlfmx07l3vvgrky5lp96m0000gn/T/opencode/openmuse-src`
  (already cloned; CopilotKit/OpenMuse, **MIT license**, `LICENSE` = "Copyright (c) 2026
  OpenMuse contributors").
- **Method:** mined `docs/FEATURES.md` (declared inventory) → `ROADMAP.md` (shipped vs
  planned) → `docs/VERIFICATION.md` (what is actually exercised) → the source trees
  (`apps/`, `packages/`, `infra/`, `tests/`) for what is really implemented. Every claim
  below is bounded by what the source proves. Companion frame notes:
  `docs/plans/openmuse-demo-notes.md`.
- **Status of this doc:** research/planning only. No code was changed, no tests were run,
  no app or network service was started. Verification plans are written for the
  implementing agent that picks a slice up.
- **Conflict streams in this working tree (verbatim, from the owner brief):**
  - **(i) desktop layout/parity agent** owns `src/App.tsx`,
    `src/components/SettingsModal.tsx`, `SettingsPrimitives.tsx`, `ShortcutsSheet.tsx`,
    `src/lib/keyboard-shortcuts.ts`, `electron/main.mjs`,
    `docs/plans/openmausbot-desktop-parity.md`
  - **(ii) OTP agent** owns `server/auth.ts`, `server/email.ts`,
    `server/email-otp-login.ts`, `src/lib/auth.tsx`, `src/pages/LoginPage.tsx`,
    `src/components/EmailOtpSignIn.tsx`
  - **(iii) memory agent** owns `server/memory-retrieval.ts`, `server/memory-grants.ts`
  - **(iv) backups agent** owns `server/workspace-backup-routes.ts` + new snapshot files +
    a standalone `SnapshotsCard.tsx`
  - **(v) iOS parity agent** owns `ios/**`

---

## 1. What OpenMuse actually is, and what it has proven

OpenMuse is a **personal-agent alpha** (their word): one owner per deployment, a
CopilotKit React Native client (iOS/Android/web from one Expo tree), a Hono API +
CopilotKit runtime, a server-owned durable task worker, a token-protected Playwright
browser worker with persistent Chromium profiles, and an optional nonroot Docker Linux
"computer". Workspace data lives in embedded PGlite (or PostgreSQL for a split worker).

**Declared verified (`docs/VERIFICATION.md`, dated 2026-09-16):**

- 154 tests pass (no failures/skips) across API, task engine, integrations, computer
  lifecycle, Docker runner, conversation queue, browser address handling, domain, dates.
- Real Chromium lifecycle test: navigate/read, failed-profile cleanup, same-UUID reopen,
  localStorage/profile persistence after restart.
- Real Docker computer smoke against an isolated context: nonroot commands, read-only
  system files, disabled network, output caps, text editing, symlink rejection,
  PDF byte-preserving import/export, stop/start file persistence, interruption of a
  running command. Disposable container/volume removed afterwards.
- Native iPhone acceptance for the browser flow (HN → relaunch → CopilotKit → Take
  control) with **scripted AI Mock model responses** against a **real** Chromium worker
  and a **real** (fictional, isolated) mailbox for `search_mail`/`read_mail_thread`.
- Durable-work tests: real PGlite restart, two-worker lease races, expired-lease
  recovery, cancellation, pause/resume, missing inputs, approval fairness.
- Gmail/Calendar adapters are tested with **controlled HTTP fixtures only**; rich-threads
  Intelligence boundary is **mocked**; Android is bundle-validated, not device-tested.

**Explicitly NOT proven (do not port these as claims):**

- No live Google credentials were ever supplied — OAuth/mail/calendar acceptance on real
  accounts remains required (`ROADMAP.md` "Integration acceptance next").
- Live model quality / provider-account acceptance pending (demos use CopilotKit AI Mock).
- CopilotKit Intelligence (Rich Threads live persistence/replay) needs a paid third-party
  project key; sample mode is a local single conversation.
- OpenBot adapter is **disabled** — contract-tested against a pinned upstream, never a
  live connection.
- No device push, voice, image generation, health/bank/social connectors, OCR, calendar
  recurrence editing, multi-tenant auth, or full desktop VM isolation.
- The Linux computer has no network, one owner, no disk quotas; it is a container, not a
  VM or graphical desktop.

---

## 2. Feature inventory → Muster mapping (37 features)

Classes: **AE** = ALREADY-EQUIVALENT (Muster has the capability; cite), **AD** = ADAPTABLE
(their shape → Muster shape), **RG** = REAL-GAP (genuinely new to Muster).
Muster file cites below were verified to exist in this tree during this study.

| # | OpenMuse feature (source) | Class | Muster surface (already there, or what it takes) |
|---|---|---|---|
| 1 | Streamed chat runtime: headless CopilotKit chat, AG-UI events, server tools, local model fixture (`apps/mobile/src/chat.tsx`, `apps/server/src/engine/conversation.ts`) | AE | Muster owns its own streaming turn engine over SSE + `server/fleet-mcp.ts` bounded tools incl. `send_task` (`server/index.ts`, `src/state/store.tsx`). Porting CopilotKit runtime would *replace* Muster's engine — not done. |
| 2 | Send/stop in one input pill; button keeps position, label flips Send↔Stop; draft kept while stopped (`chat.tsx` `accessibilityLabel={replying ? "Stop reply" : "Send message"}`) | AE | `src/components/Composer.tsx` already renders stop (filled `Square`, aria "Stop this turn") in the *same right slot* while a turn runs, else the circular send (aria flips to "Queue message" while busy). |
| 3 | Visible follow-up queue: multi-item, removable, queue pauses on Stop, explicit **Send queued messages** resume (`apps/mobile/src/conversation-queue.ts`, `chat.tsx`) | AD | `server/steer-queue.ts` (X1) already lands mid-turn messages as persisted `queued` bubbles and drains them, but joins a burst into ONE follow-up turn; `Composer.tsx` shows a single per-room queued strip with discard. Adapt: multi-item queue strip + explicit paused-resume chip; keep Muster's join-into-one-turn drain (it is cheaper than their per-message sequential runs). Their queue is app-memory only ("keep the app open"); Muster's words are persisted thread messages — Muster's durability is already stronger. |
| 4 | Retained drafts across navigation/sheets (`chat.tsx`, `RICH-THREADS.md`: visited chats stay mounted, drafts preserved) | AE | `src/lib/drafts.ts` — per-thread drafts *and* attachment chips in localStorage, survives restart (stronger than in-app retention). |
| 5 | "Latest messages" floating scroll-to-latest control (`EXPERIENCE.md`, `web-26s` frame) | AD | New affordance in `src/components/ChatView.tsx`; its waterfall/geometry is contract-tested (`src/lib/run-waterfall.test.ts`) — add without touching existing math. |
| 6 | Inline browser card: real screenshot, source title/domain, reading progress, **Take control** button (`apps/mobile/src/browser-tool-card.tsx`, `agent-ui.tsx`) | AD | `server/browser-panel.ts` already produces per-bot frame feeds; card is a new render row in `src/components/MessageBody.tsx`/`ChatView.tsx` that deep-links the existing `src/components/BrowserPanel.tsx`. |
| 7 | Inline mail card + full email viewer + attachment row (`mail-tool-card.tsx`, `details.tsx`, `web-11s`/`web-16s` frames) | AD | No mail viewer in Muster; depends on slice "Gmail depth" (§5 S13). Attachment row pattern exists: `server/attachments.ts`. |
| 8 | Task/plan progress card: `n/m steps`, progress bar, "Review requested"/"Your input is needed" states (`agent-ui.tsx` TaskCard) | AD | Live-run view already exists: X2 run waterfall (`src/lib/run-waterfall.ts` + `ChatView.tsx`) built from settled step reports. The *durable, restart-surviving* plan list is the new part → §5 S4. |
| 9 | Durable artifact cards: plan / comparison / report saved against a task (`save_artifact` in `engine/model.ts`, `ArtifactCard`) | AD | Nearest equivalents: `server/receipts.ts` + `server/receipt-findings.ts` (settled-task receipts) and `server/fleet-evidence.ts`. Adapt: artifact rows keyed to durable tasks once §5 S4 lands. |
| 10 | Review/approval card: exact recipient/action, accept/reject, ownership+hash+version binding, expiry, disconnect invalidation (`apps/server/src/actions.ts`, tests `tests/actions.test.ts`) | AE | `server/approval-action-contract.ts`, `server/approval-why.ts`, `server/approval-history.ts`, `server/auto-approve.ts`, UI `src/components/ApprovalCard.tsx` + composer-takeover `PendingApproval.tsx` + `src/components/OptionCard.tsx`, plus Apple Watch approvals (`ios/Watch/**`). Muster's why-journal + plan rehearsal are layers OpenMuse lacks. |
| 11 | Structured ask-input: `ask_user` question card with typed answer / fields, mid-task (`engine/model.ts`, `TaskDetail` input card) | AE | In-stream option cards are Muster's signature: `src/components/OptionCard.tsx` / `SeedOptionCard.tsx` / `PendingApproval.tsx` (A–E letters, hotkeys); iOS typed answers: `ios/Sources/CompanionCore/SeedAnswerDraft.swift`. What OpenMuse adds is *where* it pauses (durable task) → §5 S4. |
| 12 | Durable task engine: server-owned jobs, ordered checkpoints, SQL leases, retries, cancel, restart recovery (`engine/worker.ts`, `engine/service.ts`, `persistence.test.ts`) | **RG** | Muster's turns run in-process; `server/delegations.ts` persists its queue to `delegations.json` but has no plan/checkpoint/lease engine. Port the *shape* (checkpointed status machine + lease + recovery), not their PGlite topology → §5 S4. |
| 13 | Pause/resume of durable work + `waiting_input`/`waiting_approval` states that survive a restart (`engine/routes.ts` `/tasks/:id/control`, `/tasks/:id/input`) | **RG** | Same gap as #12; approval waiting exists (OptionCard) but pause/resume of long server work does not → §5 S4. |
| 14 | Ideas: evidence-backed suggestions (mail rules, empty-goal plan), accept/edit/dismiss, retirement of sent/completed sources, CAS races (`service.ts refreshIdeas/decideIdea`) | AD | Proactivity layer exists but has no suggestion *queue*: `server/briefing.ts` (morning brief, pure composer), `src/components/ProjectScout.tsx` (folder → team lineup with reasons), `SeedOptionCard`. Adapt their evidence+state machine onto workspace signals, surface as cards → §5 S9. |
| 15 | Goals with milestones; empty goal spawns a "make a plan" idea (`service.ts createGoal`, conversation tool `create_goal`) | AD | `server/goals.ts` Goal mode is a *bounded autonomy loop* (rounds/maxRounds/budget) — a different, stronger shape. Adapt: milestone list as child records under a goal + the empty-goal nudge → §5 S12. |
| 16 | Monitors: recurring public-page checks — `change` (text hash), `contains`, USD price threshold; per-check dedup key, failure backoff/`failures:0` reset, auto-pause, pause/resume/stop/manual check (`service.ts observe/matchesPrice`, `activateMonitor`) | AD | `server/routines.ts` has schedules (`once`/`daily`+weekdays), manual/webhook triggers, waiting status, and deterministic **scorecard checks** (`RoutineCheck`: contains/not_contains/matches) + `server/sentry.ts` notify; `server/goals.ts` covers *autonomous* work. Missing: deterministic URL fetch + hash/threshold state + backoff → §5 S6. |
| 17 | Durable in-app notification inbox: server-stored, `insertIfAbsent` dedup by key, read state, restart reconciliation, source-linked "View task" (`service.ts notify`, `background-updates.tsx`) | AD | `src/components/NotificationStack.tsx` + `NotificationCard.tsx` are **ephemeral banners** (max 3, 6 s auto-dismiss, in-memory) fed by `src/lib/notify.ts` frames, plus an OS/desktop channel. Adapt: persist frames server-side with read state → §5 S5. |
| 18 | Personal identity: editable name, tone, avatar, avatar color, status line ("Here when you need me"), background status names current work/input (`engine/model.ts` identity read, `EXPERIENCE.md`) | AE | Per-bot personas: `server/soul-md.ts` (SOUL files), `server/agent-character.ts`, `src/lib/agent-templates.ts`; header/status analogs: `ConversationHeader.tsx`, `FleetOrb`/mascot surfaces. |
| 19 | Editable memories with explicit **forget** (`routes.ts /memories`, `/memories/:id/forget`) | AE | Memory brain: `server/workspace-brain.ts` + fact history/restore (`server/workspace-memory-history.test.ts`) — Muster is ahead (restore where they only delete). In-flight retrieval/grants = stream (iii). |
| 20 | Background-update preferences: `showChatUpdates` flag persisted with identity (`background-updates.tsx`) | AD | Equivalent flags exist as settings, but the natural home is `SettingsModal.tsx` → **deferred behind stream (i)** (see §5, deferred list). |
| 21 | Persistent browser worker: one Chromium per owner/session, profiles on disk, same-UUID reopen, profile persistence after restart (`apps/worker/src/browser.ts`, `apps/server/src/browser.ts`) | AE | `server/browser-panel.ts`: one Chromium per bot, "Bot's own" persistent `user-data-dir` vs "Guest" scratch wiped on switch; per-bot ownership enforced upstream. |
| 22 | Public-page read tool with URL validation and evidence excerpts (`read_web` in `engine/model.ts`; worker URL/DNS/egress checks in `tests/browser.test.ts`) | AE | Browser-panel navigation validation refuses loopback/private hosts (code behavior in `server/browser-panel.ts`, stated as behavior, not a security claim); bounded read-only batch surface already published at `/webagents.md` + `/.well-known/webagents.json` (`server/agent-workflow.ts`); bot-turn browsing lives in `server/obscura.ts`. |
| 23 | Interactive **takeover console**: live screenshot console, click-to-select field, type text, Enter/Tab/Backspace, scroll, refresh, live/disconnected status, retained text after errors, visibility-aware polling, signed preview links with renewal, owner boundaries (`apps/server/src/browser-console.ts`, `tests/conversation-browser.test.ts`) | AD | Muster's `BrowserPanel` preview is explicitly honest about being non-interactive and its legacy `takeControl` wire flag "is ignored by the preview UI" (`server/browser-panel.ts` header). `DESIGN.md` §39 already names this exact upgrade: "live-view + human-handoff for MFA (BrowserPanel's preview is already honest about being non-interactive; the handoff round-trip is the upgrade)". Port their console's interaction model onto Muster's CDP session → §5 S1. |
| 24 | Browser/PDF downloads imported back into the app (`apps/worker/src/downloads.ts`, RICH-THREADS "PDF links") | AD | Wire worker-side saves into Muster attachments/vault (`server/attachments.ts`, `server/workspace-files.ts`). |
| 25 | Isolated Linux computer: nonroot container, bounded argv, 30 s timeout, output caps, no container network, stop/start file persistence, interrupted-run recovery without replay (`apps/server/src/computer.ts`, `smoke.test.ts`) | AE | Muster already has *more*: cloud box (`server/box.ts`, `server/vps-computer.ts`) and the Cua-backed Local VM (`server/container-computer.ts`, `server/vm-bootstrap.ts`, `src/components/ComputerPanel.tsx`, `LocalComputerSection.tsx`) with resource limits and a single-bot lease. Do not downgrade to their minimal container; borrow the receipts/files/PDF patterns only. |
| 26 | Per-command receipts: saved output + exit status kept for the session, "New command" reopens input (`computer.ts` "Computer receipt could not be saved", `VERIFICATION.md` polish list) | AD | Task-level proof exists (`server/receipts.ts` is deliberately a pure composer, batched per settled task; `server/receipt-findings.ts`). Adapt: per-command records alongside VM exec in `server/container-computer.ts` → §5 S7. |
| 27 | Workspace Files UI: list/read/write/mkdir, in-app text editor, command+file drafts persist across sheet navigation, late responses can't overwrite newer edits (`computer-routes.ts`, `VERIFICATION.md`) | AD | `server/workspace-files.ts` (vault files) exists; the *computer's* filesystem browser/editor is new UI on `ComputerPanel` → §5 S7 (keep edits out of `SettingsPrimitives.tsx`, owned by (i)). |
| 28 | PDF transfer between computer workspace and Documents, byte-preserving (`computer-routes.ts /files/import`, `/files/export`, smoke test) | AD | Compose `server/attachments.ts` bytes + Local VM file write; same slice as #27. |
| 29 | Documents PDF pipeline: background import → typed input request for supported AcroForm fields → filled copy → preview → reviewed reply → receipt (`packages/integrations/src/pdf.ts`, `files.ts`, `tests/pdf.test.ts`) | **RG** | Muster ingests attachments and has review cards, but no AcroForm parse/fill engine and no typed-field request flow → §5 S10. (Boundary: supported AcroForms only; no OCR — do not promise more.) |
| 30 | Native/web PDF viewer: paging, zoom, supported fields, sharing (`PdfReader.native.tsx`/`.web.tsx`, iPhone acceptance on a real two-page PDF) | **RG** | No PDF viewer in `src/components` or the iOS tree. Web half → §5 S10; native half is **mapped only** to `ios/**` (stream (v)) → §4. |
| 31 | Finance: strict transaction CSV parser (exact cents, 500 KB / 5 000-row caps, date+amount validation, category grouping) → spending artifact + savings-goal action (`engine/finance.ts`, `FinanceArtifact`) | **RG** | No finance surface in Muster. Pure-parser shape ports cleanly → §5 S11. |
| 32 | Gmail depth: complete MIME threads/attachments, saved drafts, CRLF-correct sends, connection-change invalidation — **fixtures only, never live** (`packages/integrations/src/google.ts`, `tests/google.test.ts`) | AD | Muster reaches mail through its ownership-guarded connector layer (`server/composio.ts`, `server/connector-proxy.ts`) rather than hand-rolled adapters; no rich mail viewer. Adapt viewer/draft UX over existing connector seams, **never** through `server/email.ts` (OTP stream (ii)) → §5 S13 (deferred: live-credential acceptance is out of scope for this repo pass). |
| 33 | Calendar: discovery, event CRUD, ETags, timezone/DST handling, reviewed create/update/delete, recurrence *unsupported* (`tests/google.test.ts`) | AE | Muster's calendar is deeper: `server/calendar-oauth.ts`, `calendar-access.ts`, `calendar-grants.ts`, `calendar-enrollment.ts`, `calendar-device-grants.ts`, `calendar-day.ts`, `calendar-plan.ts` + `CalendarAgenda/Connection/DeviceEnrollment/Planning.tsx`. Nothing to port; their recurrence gap is a warning not to claim it. |
| 34 | Rich Threads UX: stable main conversation, side chats, rename, archive/restore, pagination, replay (via CopilotKit Intelligence in live mode; local store in sample mode) (`threads.tsx`, `docs/RICH-THREADS.md`, `tests/rich-threads.test.ts`) | AD | Muster threads are already durable and replayed (SSE resume, `server/sync-journal.ts`, branch leaves in `src/state/store.tsx`) with in-place rename (`src/components/RenameTitle.tsx`). Missing: thread *registry* UX — archive/restore, side chats, pagination → §5 S8. Port the UX, **not** the CopilotKit Intelligence dependency (§6). |
| 35 | Activity screen behind the avatar: status names current work, task list, reviews, receipts (`AgentStatus`, `AgentActivityScreen`, `EXPERIENCE.md`) | AD | Pieces exist: `FleetOrb`, `NotificationStack`, receipts (`server/receipts.ts`), `TaskPicker.tsx`, approvals. Adapt: one "activity" popover listing active tasks + waiting-input + recent receipts → §5 S3/S5. |
| 36 | Bottom segmented nav pill: chat / apps(computer) / ideas / goals / connectors, active pill highlight (`screens.tsx`, all frames) | AD | Web: Muster's `Sidebar.tsx` + `CommandPalette.tsx` cover the same destinations; a mobile-web pill is responsive CSS only. Native iOS tab restructure = map only (§4, stream (v)). |
| 37 | Delegate-task menu with kinds plan / document / finance / agent (`DelegateSheet`) | AD | Muster equivalents already exist per kind: task picker (`src/components/TaskPicker.tsx`), Goal mode (`server/goals.ts`), fleet MCP `send_task` (`server/fleet-mcp.ts`), routines (`server/routines.ts`). The sheet's one-tap kind list is presentation → folds into §5 S3/S9. |

**Counts: ALREADY-EQUIVALENT = 11 (#1,2,4,10,11,18,19,21,22,25,33), ADAPTABLE = 21
(#3,5,6,7,8,9,14,15,16,17,20,23,24,26,27,28,32,34,35,36,37), REAL-GAP = 5 (#12,13,29,30,31).**

Muster-ahead items worth stating explicitly (OpenMuse has none of these): Apple Watch
approval cards, why-journal HYPOTHESIS/FINDINGS (`server/why-journal.ts`), plan rehearsal
on approval cards (`server/plan-rehearsal.ts`), routine scorecards (`RoutineCheck` in
`server/routines.ts`), receipts + findings (`server/receipts.ts`), `/webagents` bounded
batch manifest (`server/agent-workflow.ts`), Drive/portable backup v2 + snapshots
(`server/account-drive.ts`, `server/workspace-bundle-v2.ts`), Telegram **and** WhatsApp
channels (`server/telegram-sync.ts`, `server/whatsapp.ts` — OpenMuse lists WhatsApp as
roadmap-only), memory fact history/restore, skills CRUD (`server/workspace-skills.ts`),
eval harness (`server/role-eval.ts`, `server/fleet-eval.ts`, `muster eval`/`muster bench`),
voice (`server/tts/`, `SpeakButton.tsx`, iOS `DictationFlow.swift`), multi-tenant
ownership guards (they are single shared-access-key by their own README).

---

## 3. Deep dives on the called-out capabilities

### 3.1 Takeover browser console (persistent profiles)
Their model: the *same* worker session the agent read is reopened in an interactive
console — screenshot-only rendering ("remote page code never runs in this document"),
click coordinates map to a fixed 1280×800 viewport, a text input types into the selected
field, Enter/Tab/Backspace/scroll buttons, 2 s preview polling paused when hidden,
short-lived signed preview URLs (tests renew after 16 minutes), explicit
live/disconnected status, and the unsent text survives errors. Persistent profiles are
shared between agent reads and takeover (same session UUID across app relaunches).
**Muster mapping:** profiles + frames + ownership already exist (`server/browser-panel.ts`);
only the *input round-trip* is missing, and `DESIGN.md` §39 already budgeted it as the
human-handoff upgrade. This is the highest-leverage port because it executes an
owner-planned item with a working, test-covered reference.

### 3.2 Isolated Linux terminal + command receipts + workspace files/PDF
Their computer: nonroot container, no host mounts, no container network, 30 s command
limit, capped output, per-command saved output/exit receipts, named `/workspace` volume
that survives stop/start, Files browser with text editing, PDF import/export that is
byte-preserving, interruption of a live command recovered without replay.
**Muster mapping:** the execution substrate is already stronger (Local VM/box with
Cua driver, resource limits, lease). The deltas are (a) per-command receipts surfaced in
the panel, (b) a Files/editor tab over the VM's workspace, (c) PDF transfer into
attachments — all additive to `server/container-computer.ts` + `ComputerPanel.tsx`.

### 3.3 Durable task plans vs Muster's run waterfall — say the difference plainly
OpenMuse's plan is **server state**: `set_plan` writes up to 12 steps to the task row,
each tool call serializes through a queue and `ctx.checkpoint()`s ordered state, a SQL
lease lets a second worker recover after a crash, and pause/resume/input/approval states
are read back by any client after restart. Muster's X2 run waterfall
(`src/lib/run-waterfall.ts`) is **derived presentation**: each step's bar is "the wait the
previous report ended", computed from settled message timestamps — beautiful for *one
finished turn*, but it has no durable identity, cannot be resumed, and an in-process
restart loses the run's continuation. Muster's delegations persist their queue
(`server/delegations.json`) but not plans/checkpoints. **The port is not their UI; it is a
durable plan record + status machine + recovery, rendered by Muster's existing cards.**

### 3.4 Ideas (evidence-backed suggestions)
Rules over workspace facts, not model opinions: a mail whose subject/body matches
form/permission/fill/sign → document idea; coffee/meet/available/schedule → coordination
idea; active goal with zero milestones → plan idea. Each carries an `evidence[]` excerpt,
a one-click `prompt`, deterministic hash IDs (`insertIfAbsent` = idempotent), a CAS
`new → accepted/dismissed` transition, and **retirement** when the source reply was sent
or a matching task already completed. VERIFICATION scopes this honestly as "rules-based
suggestions; broader model-derived personalization remains future work".
**Muster mapping:** adopt the *state machine + evidence + retirement* semantics; Muster's
suggestion sources are richer (briefing, scout, workspace signals), so feed those in.

### 3.5 Goals & recurring public-page checks vs Muster routines/scorecards
Two different objects in OpenMuse: **Goals** (user-declared outcomes with milestones that
tasks tick off) and **Monitors** (interval-driven page observations). Monitor semantics
worth taking: content-hash `change` detection only notifies when a previous hash exists,
`contains` and price-threshold matching, a dedup `key` (`monitor:<id>:<hash>`) so a stable
page never re-notifies, `failures` reset to 0 on success with backoff and automatic pause,
plus pause/resume/stop/manual-check controls. **Muster mapping:** routines already own
scheduling, waiting states, scorecard checks (`RoutineCheck`) and sentry-style
notifications (`server/sentry.ts`); goals already own autonomous looping. Add a
deterministic "watch" trigger type with hash/threshold/backoff state — do NOT bolt it
into Goal mode (bounded autonomy) or into the scorecard (that grades *outputs*, it does
not fetch pages).

### 3.6 Documents PDF pipeline
Mail attachment → durable import job → typed `waiting_input` for the supported AcroForm
fields only → new filled PDF (values must come from the user, enforced in the tool
description) → artifact preview → *separate* reviewed reply → receipt. Field types
bounded; OCR/scanned forms out of scope by their own doc. **Muster mapping:** genuinely
new (#29); the approval half reuses OptionCard/PendingApproval unchanged.

### 3.7 Finance CSV
A deliberately strict pure function: 500 KB cap, 1–5 000 rows, requires
`date,description,amount,category`, ISO dates, ±plain amounts, exact cents via
`Math.round(x*100)`, unclosed-quote detection, positive=expense/negative=income with the
convention echoed in the artifact, category grouping sorted desc, period from/to.
**Muster mapping:** ports as a pure module + tests with zero I/O — cheapest REAL-GAP on
the list, though its user value depends on whether finance belongs in the personal-assistant
beta (owner call).

### 3.8 Gmail/Calendar depth — checked
Calendar: Muster is ahead (device enrollment/grants are not in OpenMuse at all; their
recurrence is explicitly unsupported — do not claim it in Muster either). Gmail: OpenMuse
has deeper *thread/MIME/attachment* handling than Muster's connector surface shows, but
it has never run against live Google — only fixtures. Any Muster mail slice must say
"fixture-verified" until real credentials exist, and must route around stream (ii)'s
`server/email.ts` (login mail), which is a different concern entirely.

### 3.9 Rich Threads vs threads-under-bots
OpenMuse: one owner-bound main thread provisioned before first message, side chats get
fresh client IDs, rename/archive/restore/pagination via CopilotKit's `useThreads`, rich
tool messages re-fetch live task state by ID (so a stale card never lies), expiring URLs
minted server-side and never stored in messages. Muster: threads live under bots/rooms,
persisted, branch-leafed, SSE-replayed, renamed in place — but no archive/restore, no
side-chat registry, no pagination control. **Port the lifecycle UX and the "cards fetch
current state by ID" rule; keep Muster's own persistence.**

### 3.10 Inline card types in chat
Observed card families: browser (screenshot + domain + check + Take control), mail
(snippet + Open email → full viewer modal), plan/progress (steps + waiting badges),
artifact/finance (structured tables), approval (lavender review card), plus a *plain*
inline tool line (e.g. "🔍 Found 1 email" — no chip box). All fetch live state by ID.
Muster already renders option/approval/receipt/tool-chip rows; the new renderers are
browser, plan-progress, artifact, mail — one additive row-kind switch in
`MessageBody`/`ChatView`.

### 3.11 Send/stop pill + follow-up queue + retained drafts — honest comparison
Muster already ships: stop in the same right-hand slot (`Composer.tsx:619` "Right: stop
(while a turn runs) or the GAIA circular send"), busy placeholder text, one queued strip
with discard for rooms, per-thread localStorage drafts **and** attachments, and X1's
persisted queued bubbles with stop-then-steer. OpenMuse's genuine additions are: a
**multi-item** visible queue with per-item remove, an explicit paused-queue resume button
after Stop, and the scroll-to-latest pill. Their honest caveats to also keep: queued
messages live in the open app only (Muster's persist), and stopping does not cancel
delegated tasks. Their sequential one-run-per-message drain is *worse* than Muster's
join-into-one-turn — do not copy that part.

### 3.12 Personal context
Name/tone/avatar/color/status line + editable memories with forget + a
`showChatUpdates` preference + durable source-linked notifications. Muster: personas
(SOUL/character/templates) and memory-with-restore are already equal-or-better; the
adaptable pieces are the durable inbox (#17) and the background-update toggle (#20,
settings-hosted → deferred behind (i)).

---

## 4. iOS angle — mapped, NOT touched (stream (v) owns `ios/**`)

OpenMuse's mobile client is CopilotKit React Native (one Expo app also serving web).
Muster splits that surface: native `ios/**` (CompanionCore + Watch, owned by another
agent RIGHT NOW — **do not touch**) and Muster's responsive web. Mapping for each
mobile-relevant pattern:

| OpenMuse mobile pattern | Lands in | Target (map only / build) |
|---|---|---|
| Input pill send↔stop morph, retained draft while replying | Responsive web | **Web — build** (`src/components/Composer.tsx`; already largely equivalent, see §3.11). Native equivalent already exists in spirit via `ios/Sources/CompanionCore/ComposerContract.swift` + `ComposerCoordinator.swift` — **map only, stream (v)**. |
| Multi-item follow-up queue strip + resume chip | Responsive web | **Web — build** (`Composer.tsx` + `server/steer-queue.ts`). iOS queue visibility = **map only** (`ComposerContract`). |
| Inline cards (browser/mail/plan/finance) in transcript | Responsive web first | **Web — build** (`MessageBody.tsx`/`ChatView.tsx`). Native card rendering later via `ios/Sources/CompanionCore/Markdown.swift` / `SeedCard.swift` — **map only**. |
| Activity screen behind avatar (status, tasks, reviews, receipts) | Responsive web + iOS | **Web — build** (FleetOrb/NotificationStack area). iOS list view = **map only** to `FleetSnapshot.swift` / `FleetFocus.swift`. |
| Plan/progress view with waiting states | Responsive web + iOS | **Web — build** next to X2 waterfall (`ChatView.tsx`). iOS read-only status = **map only** (`FleetSnapshot`). |
| Durable inbox notifications (badge → open task) | Responsive web + iOS | **Web — build** (`NotificationStack`→durable store). iOS push/badge = **map only** — and note OpenMuse has *no* device push either (their roadmap), so nothing to copy natively. |
| Bottom segmented nav pill (chat/apps/ideas/goals/connectors) | Responsive web (mobile width) | **Web — build** (CSS-level; destinations exist in `Sidebar`). Native tab bar = **map only, stream (v)**. |
| Take control from a phone (console sheet) | Responsive web first | **Web — build** (§5 S1 opens the same console on narrow screens). iOS full-screen console = **map only**. |
| PDF viewer paging/zoom | Web + iOS | **Web — build** (§5 S10). Native viewer = **map only, stream (v)**. |
| Stop/queue/pause affordances on Watch | Apple Watch | Not in OpenMuse at all. Muster's Watch approvals stay as-is; nothing to map. |

Rule for implementers: **zero edits under `ios/**` in any OpenMuse slice.** Anything
native goes into this doc's map for the iOS parity agent to pick up.

---

## 5. Ranked implementation slices (highest user value first)

Legend (conflict streams, verbatim from the owner brief): **(i)** desktop layout/parity
agent owns `src/App.tsx`, `src/components/SettingsModal.tsx`, `SettingsPrimitives.tsx`,
`ShortcutsSheet.tsx`, `src/lib/keyboard-shortcuts.ts`, `electron/main.mjs`,
`docs/plans/openmausbot-desktop-parity.md`; **(ii)** OTP agent owns `server/auth.ts`,
`server/email.ts`, `server/email-otp-login.ts`, `src/lib/auth.tsx`,
`src/pages/LoginPage.tsx`, `src/components/EmailOtpSignIn.tsx`; **(iii)** memory agent
owns `server/memory-retrieval.ts`, `server/memory-grants.ts`; **(iv)** backups agent owns
`server/workspace-backup-routes.ts` + new snapshot files + a standalone
`SnapshotsCard.tsx`; **(v)** iOS parity agent owns `ios/**`.
Every slice below: **no edits under `ios/**` (stream (v)) — iOS targets are map-only
per §4**, and `server/index.ts` / `src/state/store.tsx` are hot files already carrying
other agents' uncommitted edits → additive hunks only, `git status --short` review
before any staging (staging is not this subagent's job).

### S1 — Browser takeover round-trip (the DESIGN §39 human-handoff upgrade)
- **What:** interactive console over the existing per-bot Chromium: click-to-select,
  type-into-field, Enter/Tab/Backspace, scroll, refresh, live/disconnected status,
  text retained after errors, visibility-aware preview polling — screenshot-only
  rendering, remote page code never runs in-app (their `browser-console.ts` model).
- **Files:** `server/browser-panel.ts` (add input/scroll/key/click endpoints over the
  existing CDP session + short-lived preview signature), `server/browser-panel.test.ts`
  (extend), `src/components/BrowserPanel.tsx` (console sheet, narrow-screen friendly),
  `src/components/BrowserPanel.test.ts`, `server/index.ts` (panel routes only — additive).
- **Verification plan:** extend the existing `server/browser-panel.test.ts` harness
  (ownership, URL validation, input echo/rejection, signed-link renewal) +
  `src/components/BrowserPanel.test.ts`; `npx tsc --noEmit -p tsconfig.server.json`;
  `npm run lint`; touched-file vitest loop, then full `npx vitest run` before any commit.
  Optional new e2e spec as its own file — **never modify** existing `e2e/*.e2e.spec.ts`
  (working tree churn). Frame notes for visual parity: `docs/plans/openmuse-demo-notes.md`
  (web-37s / mobile-27s).
- **CONFLICT FLAG:** none of (i)–(v) owns `server/browser-panel.ts` or
  `BrowserPanel.tsx`. Hot-file caveat: `server/index.ts` is modified in this tree by a
  non-listed stream — additive routes only. Does not touch `src/App.tsx` (i) beyond its
  existing mount point — keep JSX inside `BrowserPanel`.

### S2 — Composer queue parity: multi-item follow-up queue + explicit resume + scroll-to-latest
- **What:** visible multi-item queue strip with per-item remove for 1:1 threads (rooms
  already have the single strip), an explicit "resume queued" chip after Stop, and the
  floating "Latest messages" control. Keep Muster's join-into-one-turn drain and X1
  stop-then-steer semantics — that part is better than theirs.
- **Files:** `src/components/Composer.tsx`, `server/steer-queue.ts` (expose queue
  snapshot to the client), `server/steer-queue.test.ts`, `src/components/ChatView.tsx`
  (scroll-to-latest only), `src/lib/drafts.ts` (reuse as-is).
- **Verification plan:** `npx vitest run server/steer-queue.test.ts` + new colocated
  `Composer` test following the `src/pages/AuthPages.test.ts` pattern; existing draft
  tests must stay green; typecheck + lint; full suite before commit. UI check against
  demo frames (mobile-12s stop state, mobile-19s latest-pill).
- **CONFLICT FLAG:** none of (i)–(v). `keyboard-shortcuts.ts` (i) untouched; do not
  reuse `ShortcutsSheet`. Hot file: `src/state/store.tsx` if queue state lands there.

### S3 — Inline rich cards: browser / plan-progress / artifact rows in the transcript
- **What:** browser card (live-state fetch by ID + Take control → S1 console), plan
  progress card (`n/m steps`, waiting badges), artifact card, and the plain inline tool
  line style. Cards must re-fetch current state by ID so historical cards never show a
  stale page (their rule).
- **Files:** `src/components/MessageBody.tsx`, `src/components/ChatView.tsx`,
  new `src/components/chat-cards/*` (new files only), `server/contracts.ts` (additive
  row kinds), `server/index.ts` (read-only card-state endpoint if needed — additive).
- **Verification plan:** colocated component tests patterned on
  `src/components/SeedOptionCard.test.ts` / `ApprovalCard.test.ts`; contract tests next
  to `server/contracts` consumers; typecheck + lint + touched tests, full suite before
  commit.
- **CONFLICT FLAG:** none of (i)–(v) owns MessageBody/ChatView. Do not restructure the
  App shell (i owns `src/App.tsx`); cards live inside the transcript. Hot files:
  `server/index.ts`, `src/state/store.tsx`.

### S4 — Durable task plans with pause/resume and input requests (the REAL-GAP core)
- **What:** server-owned plan records (≤12 ordered steps), checkpointed tool state,
  status machine `queued/running/waiting_input/waiting_approval/paused/succeeded/failed/
  cancelled`, client control (pause/resume/cancel/retry) and typed input answers that
  **survive a server restart**; render plans in cards (S3) and surface waiting work in
  the activity list (S5). Port the *shape*, not their PGlite/Postgres topology — Muster
  keeps its DATA_DIR persistence house pattern (`server/atomic.ts`,
  one-JSON-file-per-feature as in `server/why-journal.ts`, `server/delegations.ts`).
- **Files:** new `server/task-plans.ts` + `server/task-plans.test.ts`, additive routes in
  `server/index.ts`, `server/contracts.ts` (plan/control/input payloads),
  `src/state/store.tsx` (plan state slice), `server/goals.ts` + `server/delegations.ts`
  (attach plans at the seams, minimal edits).
- **Verification plan:** new vitest module covering checkpoint ordering, control
  transitions, typed-input round-trip, and a **restart-recovery test** (pattern:
  `server/workspace-bundle-v2-recovery.test.ts` / `server/delegations` persistence);
  concurrency CAS races patterned on `server/plan-rehearsal` tests' determinism
  discipline; typecheck + lint; full suite before commit.
- **CONFLICT FLAG:** none of (i)–(v). Hot files: `server/index.ts` and
  `src/state/store.tsx` — additive hunks only. Do not alter waterfall geometry
  (`src/lib/run-waterfall.ts` is contract-tested) — plans render beside it, not inside it.

### S5 — Durable notification inbox + background-update card
- **What:** server-stored notifications with dedup keys, read state, restart
  reconciliation, source links (open the task/bot), feeding the existing banner stack
  plus an inbox list ("n more updates"). This also powers activity-screen parity (#35).
- **Files:** new `server/notifications.ts` + `.test.ts`, additive routes in
  `server/index.ts`, `src/state/store.tsx`, `src/components/NotificationStack.tsx`,
  `src/components/NotificationCard.tsx`, `src/lib/notify.ts` (frame → also persist).
- **Verification plan:** pure-module tests for dedup-key idempotency + read-state
  transitions + restart reconciliation (clock-injected, briefing-style); store tests
  extend `src/state/store.test.ts`; typecheck + lint; full suite before commit.
- **CONFLICT FLAG:** none of (i)–(v). Deferred sibling: the `showChatUpdates`
  background-update preference belongs in `SettingsModal.tsx` → **owned by (i) — do not
  open that file**; land it as a later slice after (i) lands, or expose via API-only flag.

### S6 — Public-page monitors for routines (change / contains / price thresholds)
- **What:** deterministic watch trigger on top of `server/routines.ts`: periodic fetch,
  content-hash change detection (notify only when a prior hash exists), contains +
  USD-threshold conditions, dedup key so stable pages never re-notify, failure backoff
  with reset-on-success and auto-pause, pause/resume/stop/manual check — alerts through
  the existing sentry/notify + S5 inbox.
- **Files:** new `server/page-watch.ts` + `.test.ts` (pure decision logic: hash/match/
  backoff/dedup with injected clock), `server/routines.ts` (trigger wiring only),
  `server/routines.test.ts` (extend), `src/components/RoutinesPage.tsx` (editor row),
  `server/index.ts` (routes, additive).
- **Verification plan:** pure-logic vitest (deterministic backoff/dedup tables, like
  `server/briefing.test.ts` style), extended `server/routines.test.ts`; typecheck + lint;
  full suite before commit. Do not use live third-party pages in tests — fixture HTML.
- **CONFLICT FLAG:** none of (i)–(v). `RoutinesPage.tsx` is not owned by any stream;
  it imports from `SettingsPrimitives` (i) — import only, no edits to that file.

### S7 — Computer surface: Terminal + Files tabs, per-command receipts, PDF transfer
- **What:** bring OpenMuse's computer UX to Muster's stronger substrate: a Terminal tab
  (bounded command, timeout, output cap — reuse Local VM/box exec), per-command receipts
  (command, exit, duration, capped output) persisted and listed with a "New command"
  affordance, a Files tab (list/read/write/mkdir + editor drafts that survive
  navigation), and PDF import/export bytes between attachments and the VM workspace.
- **Files:** `server/container-computer.ts` (receipt capture around existing exec),
  `server/container-computer.test.ts`, new `server/computer-receipts.ts` + test or fold
  into receipts module, `src/components/ComputerPanel.tsx` (tabs), maybe
  `src/components/LocalComputerSection.tsx` (status only — no `SettingsPrimitives` edits),
  `server/attachments.ts` (PDF byte hand-off).
- **Verification plan:** extend `server/container-computer.test.ts` with the file's
  existing harness (Docker-dependent checks only where the suite already gates them);
  receipt-composition unit tests follow the `server/receipts.ts` pure-composer pattern;
  typecheck + lint; full suite before commit.
- **CONFLICT FLAG:** none of (i)–(v) owns ComputerPanel/container-computer. **Do not edit
  `SettingsPrimitives.tsx` (stream (i))** — ComputerPanel/LocalComputerSection must keep
  working with imports unchanged.

### S8 — Rich Threads lifecycle UX on Muster's own threads
- **What:** thread registry with archive/restore, side chats (fresh context threads under
  a bot), pagination control, and the "rich cards fetch live state by ID" rule (S3).
  Rename already exists (`RenameTitle`). No third-party thread service.
- **Files:** additive thread-registry routes in `server/index.ts`, persistence in
  `server/store.ts` house pattern or a small `server/thread-registry.ts` + test,
  `src/state/store.tsx` (thread list state), `src/components/ConversationHeader.tsx`,
  `src/components/Sidebar.tsx` (list entries), `src/components/RenameTitle.tsx` (reuse).
- **Verification plan:** registry tests (archive→hidden, restore→same messages, side-chat
  isolation — follow `server/agent-rooms.test.ts` isolation discipline); store tests in
  `src/state/store.test.ts` style; typecheck + lint; full suite before commit.
- **CONFLICT FLAG:** none of (i)–(v). Sidebar/ConversationHeader unowned; hot file
  `src/state/store.tsx`.

### S9 — Ideas: evidence-backed suggestion queue
- **What:** suggestion records with `evidence[]`, deterministic idempotent IDs, CAS
  new→accepted/dismissed, retirement when the source is answered/completed, accept
  creates a seeded prompt/goal. Sources: workspace signals Muster already has
  (briefing inputs, unanswered approvals, stale backups, idle bots) — not their mail
  regexes verbatim.
- **Files:** new `server/ideas.ts` + `.test.ts`, additive routes in `server/index.ts`,
  new `src/components/IdeasPanel.tsx` + a `Sidebar`/`CommandPalette` entry (**not**
  `SettingsModal`), `server/briefing.ts` (input only if needed — keep it pure).
- **Verification plan:** pure-generator tests with fixture workspace state (evidence
  presence, idempotency on refresh, retirement rules, CAS race), modeled on
  `server/briefing.test.ts` + `server/project-scout`-style suggestion tests; typecheck +
  lint; full suite before commit.
- **CONFLICT FLAG:** none of (i)–(v), **with the explicit exclusion: no
  `SettingsModal.tsx`/`SettingsPrimitives.tsx` edits (stream (i))** — surface Ideas from
  the sidebar instead.

### S10 — Documents PDF pipeline (import → typed fields → fill → reviewed reply → receipt)
- **What:** durable PDF job: import attachment → `waiting_input` asking only the
  supported AcroForm fields → filled copy artifact (user-supplied values only) → preview
  → reviewed reply through the existing approval surface → receipt via `server/receipts.ts`.
  Web viewer (paging/zoom) ships with it; **no OCR, no unsupported field types** (match
  their documented boundary).
- **Files:** new `server/pdf-jobs.ts` + `.test.ts` (fixture PDFs committed as test
  fixtures), `server/attachments.ts`, `server/contracts.ts` (additive), approval seams
  (`server/approval-action-contract.ts` unchanged — consume), viewer component
  (new `src/components/PdfViewer.tsx`), `server/index.ts` (additive routes).
- **Verification plan:** fixture-PDF tests patterned on `server/attachments.test.ts` +
  `tests/pdf.test.ts` equivalents (field extraction, fill determinism, byte checks),
  approval round-trip patterned on `server/approval-action-contract.test.ts`; typecheck +
  lint; full suite before commit. Claims bounded: "fixture-verified" only.
- **CONFLICT FLAG:** none of (i)–(v). **Native iOS viewer = map only (stream (v) owns
  `ios/**`)** — do not add Swift PDF code in this slice.

### S11 — Finance CSV → spending artifact
- **What:** strict pure parser (500 KB cap, 1–5 000 rows, required columns, ISO dates,
  exact cents, quote validation, expense+/income− convention echoed) → spending summary
  card (income/spending/saved/categories/period) + savings-goal action seeded into Goal
  mode.
- **Files:** new `server/finance.ts` + `.test.ts` (pure, no I/O), card render under
  `src/components/chat-cards/` (S3), `server/contracts.ts` (additive), optional
  `server/goals.ts` seed action (additive).
- **Verification plan:** table-driven parser tests (caps, malformed quotes, column
  mismatch, cents overflow, 5 000-row boundary, empty) — the pattern is already proven
  by their `tests/finance` shape and Muster's pure-composer tests; typecheck + lint; full
  suite before commit.
- **CONFLICT FLAG:** none of (i)–(v). Lowest coupling of any slice — safe to run in
  parallel with every stream.

### S12 — Goal milestones enrichment
- **What:** milestone list under a Goal record (child items ticked by settled work),
  auto-suggest a plan when an active goal has zero milestones (their Ideas rule),
  surfaced on the goal chip/card.
- **Files:** `server/goals.ts`, `server/goals.test.ts`, goal UI chip in `ChatView` or
  Composer goal toggle area (`Composer.tsx` goal mode row — unowned), `server/index.ts`
  (additive).
- **Verification plan:** extend `server/goals.test.ts` (milestone transitions, budget
  interaction — maxRounds must still bound autonomy), typecheck + lint; full suite.
- **CONFLICT FLAG:** none of (i)–(v). Keep rounds/budget semantics untouched — bounded
  autonomy is shipped behavior (`server/goals.ts`).

### S13 — Gmail mail viewer depth over existing connector seams — **DEFERRED (honesty slice)**
- **What (when unblocked):** thread list + full viewer + attachment row + draft compose
  over Muster's ownership-guarded connector layer, fixture-verified first.
- **Files (planned):** `server/connector-proxy.ts` / `server/composio.ts` seams, new mail
  routes in `server/index.ts`, new `src/components/MailViewer.tsx`; cards from S3/S7.
- **Verification plan:** fixture-driven tests only (their google.ts fixture discipline);
  live-credential acceptance explicitly out of scope and unclaimed until credentials exist.
- **CONFLICT FLAG:** **(ii) OTP agent owns `server/auth.ts`, `server/email.ts`,
  `server/email-otp-login.ts`, `src/lib/auth.tsx`, `src/pages/LoginPage.tsx`,
  `src/components/EmailOtpSignIn.tsx` — none of these may be touched or routed through;
  `server/email.ts` is login mail, a different concern.** Also `src/lib/auth.tsx`
  connector-session interplay must be read-only reference at most.

**Deferred behind a stream (not scheduled):** background-update preference toggle in
`SettingsModal.tsx` → stream (i); anything native (PDF viewer, tab bar, console sheet,
inbox badge) → stream (v) map (§4); snapshots/backups interplay → stream (iv) if a
monitor ever watches backup freshness; memory-evidence cards → stream (iii).

---

## 6. License + attribution, and what NOT to port

### License
- OpenMuse is **MIT** ("Copyright (c) 2026 OpenMuse contributors"). Muster is
  **BSL 1.1** (change date 2030-08-19 → Apache-2.0). MIT permits reuse inside Muster
  provided the MIT copyright notice and permission notice are retained with the
  software/copies.
- **Attribution rule for this repo:** on any verbatim or near-verbatim reuse (e.g. the
  console HTML/CSS tokens, the CSV parser, bounded command wrappers), add a source
  comment in the **file header**: `Adapted from OpenMuse (github.com/CopilotKit/OpenMuse),
  MIT License, Copyright (c) 2026 OpenMuse contributors.` Per AGENTS rules, **never put
  that github.com link in user-facing UI** — headers/docs only.
- No security claims and no deployment claims may ride along with any ported slice; their
  fixture-tested adapters are "fixture-verified", not "verified against Google".

### Recommend NOT porting (with reasons)
1. **CopilotKit runtime / AG-UI / `@copilotkit/*` dependencies and the Expo React Native
   app shell** — would replace Muster's own engine and split ownership of the client.
   Muster ships native `ios/**` + responsive web; ios/** is owned by stream (v).
2. **CopilotKit Intelligence "Rich Threads" backend** — a third-party paid service
   requiring a server-only project key, outside this repo's license, and never verified
   live by them (mocked boundary). Muster's persistence (`sync-journal`, thread store) is
   the source of truth; port only the UX (S8).
3. **OpenBot adapter** — disabled in their source, contract tests only, no live bridge;
   Muster *is* the harness. Pure dead weight.
4. **PGlite/Postgres split-worker topology + `pnpm` workspace infra / biome config /
   their CI containers** — Muster's house pattern is DATA_DIR JSON modules +
   oxlint/vitest/GitHub-Actions-as-is. Port lease/checkpoint *semantics* (S4), not their
   deployment shape.
5. **AI Mock demo runner + fictional mailbox/sample pages** — a second demo harness
   duplicates Muster's fixtures, and the demo server on `127.0.0.1:8845` is untouchable.
   Their demos' scripted-response honesty is a *practice* to cite (see demo notes), not code
   to install.
6. **Live Google OAuth/Gmail-send acceptance flows** — require live credentials that do
   not exist in this environment; shipping unverifiable claims would violate the honest-
   reporting rule. Defer whole (S13).
7. **Their minimal Docker computer** — would downgrade Muster's Local VM (Cua, resource
   limits, lease). Borrow receipts/files/PDF patterns only (S7).
8. **Single shared access-key auth** — explicitly "not a multi-tenant authentication
   system" by their README; Muster has per-account ownership guards. Also collides with
   stream (ii).
9. **Their notification push *plans*, voice plans, Drive/Docs plans** — these are
   roadmap-only items in OpenMuse; Muster already ships Drive backup v2, Telegram/WhatsApp,
   and voice, so there is nothing to copy — and no claim to inherit.
10. **Health/bank/social/Plaid connectors (theirs)** — need live partner credentials and
    are unverified everywhere in their tree; deliberately out of Muster's current scope.

---

*Written by the research/planning subagent (read-only pass): source mined 2026-09-23.
No tests executed, no services started, no existing file modified. Frames extracted to
`docs/screenshots/openmuse/` and annotated in `docs/plans/openmuse-demo-notes.md`.*
