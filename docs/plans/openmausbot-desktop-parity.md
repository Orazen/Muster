# OpenMausBot desktop parity map — Muster (2026-09-23)

The executable map for the owner's parity pass: every OpenMausBot (OMB) desktop
surface → the Muster file that owns it → its status. Companion to
[openmausbot-parity-plan-2026-09-17.md](openmausbot-parity-plan-2026-09-17.md)
(which owns the broader feature-gap analysis) and
[openmausbot-design-study.md](openmausbot-design-study.md) (the design teardown).

**Sources and scope.** Read-only comparison against the OMB source tree at
`/private/var/folders/j2/99fjlfmx07l3vvgrky5lp96m0000gn/T/opencode/openmausbot-src`
(its `package.json` = **v0.1.85**), with shipped-label cross-checks against the
installed 0.1.85 renderer bundle (`/Applications/OpenMausBot.app/Contents/Resources/ui/`).
**No OMB binary was executed** — 0 runtime checks, 0 competitor tests; this is a
source audit, same honesty rule as `competitive-landscape.md`. The design study
covers ≤ v0.1.70, so rows below cite current source, not the study.

**Status vocabulary (strict):**

- **shipped** — implemented in this pass, gates recorded in §8.
- **exists** — Muster already had an equivalent before this pass.
- **partial** — related capability exists, exact OMB behavior does not.
- **placeholder** — a clearly-labeled, disabled row (or card) that states what
  is missing; no fake functionality, nothing pretends to save.
- **deferred** — identified, reason recorded in §7, not built.
- **skipped** — deliberately out of scope for Muster (reason named).
- **ahead** — Muster has the surface, OMB's is equal-or-narrower.

**Must-preserve (owner contract, verified untouched by this pass):** the Muster
mascot/character system (`src/lib/mascot/*`, `MusterMascot`, `MusterBloom`),
route shells in `src/App.tsx`, saved choices, user sessions, the update-status
logic in `SettingsModal.tsx`/`Sidebar.tsx` (parallel-agent surface — only
wrapped, never re-conditionalized), and `server/auth.ts` + auth routes.

---

## 1. Desktop & window layout

| OMB surface | OMB value | Muster file | Status |
|---|---|---|---|
| Default window | 1220×820 | `electron/main.mjs` (`createWindow`) | **shipped** — was 1440×920 |
| Minimum window | 760×520 | `electron/main.mjs` | **shipped** — was 900×600 |
| Settings dialog geometry | fixed h560/w860 (engines h720/w1040) | `src/components/SettingsModal.tsx` (`settings-dialog`) | **exists (differing)** — Muster is responsive `min(760px,…)`/`max-w-[920px]`; not cloned, per stability contract (layout redesign is not parity work) |
| Sidebar: section drag-reorder | `⌥↑/⌥↓` + drag | `src/components/Sidebar.tsx` | **deferred** — ordering state lives in `src/state/store.tsx`; see §7 (U2 precedent) |
| Sidebar: profile popover menu | avatar → menu | `src/components/Sidebar.tsx` footer | **deferred** — §7 |
| Sidebar: attention bell panel | bell → panel | `src/components/Sidebar.tsx` | **deferred** — §7; Muster carries attention as per-row badges + unread counts already |
| Sidebar: phone-status button | status → companion | `src/components/Sidebar.tsx` | **partial** — `CompanionSection` reachable via Settings → Companion |
| Sidebar: density + collapsible sections | persisted | `src/lib/sidebar-preferences.ts`, `Sidebar.tsx` | **exists** (Muster ships three densities; OMB parity) |
| Shared `--color-*` token vocabulary | yes | `src/styles.css` | **exists** — both apps share the token names; all new UI in this pass uses Muster tokens only |

## 2. Settings — section-level map

| OMB section (label) | Muster section | Status |
|---|---|---|
| general | `general` | exists (rows in §3) |
| desktopWorkspaces ("Connected workspaces") | `workspaces` (same label) | exists — `ConnectedWorkspacesSection.tsx` |
| organization ("Organisation") | `organisation` | exists — card + company-gateway copy |
| appearance | `appearance` | exists (rows in §3) |
| experimental | `experimental` | exists — honest "nothing enabled yet" card (OMB's flags have no Muster config key: **skipped**, §6) |
| connections | `connections` | exists — `ApiKeyRow`s + Connector/Composio details |
| engines | `engines` | exists — `EnginesSettings.tsx` + engine keys |
| companion (pairing/remote) | `companion` **and** `remoteAccess` | exists — Muster splits phone companion from remote-access transport (`CompanionSection.tsx`, `RemoteAccessSection.tsx`) |
| computer ("Local VM") | `computer` | exists — `LocalComputerSection.tsx` |
| usage | `usage` | exists — `UsageSection.tsx` + `ProviderHealthSection.tsx` |
| people (invite/users/admins) | invite lives under `usage`; org members under `organisation` | **partial** — no standalone People section; capabilities exist |
| backups | `vault` (+ `PortableBackupCard` under connections) | **partial** — v2 bundle/restore + devices; see portable-backup contract |
| workspaces (multi-tenant clients/fleet) | — | **skipped** — OMB tenant workspaces have no Muster concept (rooms/groups are a different axis, §6) |
| — | `brain`, `providers`, `mcp`, `voice`, `audit`, `why` | **ahead** — six Muster sections OMB lacks |
| `remote` (forced → companion when remote-client active) | `remoteAccess` | exists — Muster has no remote-client mode; see parity plan §2 |

## 3. Settings — General & Appearance rows (row-level map)

OMB `general` render order → Muster:

| OMB row | Control | Muster equivalent | Status |
|---|---|---|---|
| Profile (name/email) | inputs | `ProfileFields` in `SettingsModal.tsx` | exists |
| **Language** | select (system + 11 locales) | `LanguageRow` | **placeholder** — Muster ships English only; no locale packs, no `language` config key. Disabled select + honest subtitle. i18n itself: **deferred** (§7) |
| **Usage analytics** | switch → `analyticsEnabled()`/`setAnalyticsEnabled()` | `AnalyticsRow` | **shipped** — backed by `src/lib/analytics.ts` opt-out; `initAnalytics()` now called once at app start (`src/App.tsx`), gated so an opted-out install never calls `posthog.init()` |
| Group/room turn timeout | number settings | `ChannelTurnCapCard` (`channels.turnCapMinutes`, 1–120) | exists — Muster's channel turn cap is the same knob for channels |
| **Parallel threads** (max running threads/bot) | number | `ParallelThreadsRow` | **placeholder** — Muster runs one turn per bot and auto-queues the rest (`server` 202 `queued:true`); no per-bot cap config exists |
| **Event log cleanup** (retention days) | switch + number | `EventLogCleanupRow` | **placeholder** — Muster keeps transcripts in its message store, no per-thread event-log files to trim |
| Welcome/app tour replay | 2 buttons | `TourCard` ("Replay welcome tour") | exists — one button; Muster's 7-step tour replay is account-gated (`clearOnboardingGate`) |
| Updates | row + button | `UpdatesRow` | exists — **protected**: update-status conditionals untouched this pass (parallel-agent surface; pre-existing uncommitted `percent == null` edit preserved) |
| Diagnostics | row + export button | `DiagnosticsCard` (`GET /api/diagnostics` download) | exists |
| — (OMB lacks) | — | `VpsCard`, `AccountSection`, `MergeAccountsCard` | ahead |

OMB `appearance` render order → Muster:

| OMB row | Control | Muster equivalent | Status |
|---|---|---|---|
| Skin/theme picker | picker | `SkinPicker` inside Appearance card | exists |
| **Threads** ("show thread lists on this device") | switch → `useShowThreads()` local pref | `ShowThreadsRow` | **placeholder** — Muster keeps rooms-under-teammates visible; the device-local display prefs it does ship are density + section collapse (`src/lib/sidebar-preferences.ts`, persisted) |
| **Tool calls** (show tool chips in transcript) | switch → `config.features.showToolCalls` | `ToolCallsRow` | **placeholder** — Muster's transcript always shows activity messages; no `features` config key exists (needs server config + transcript filter: §7) |

Primitives: OMB `Switch` + `SettingRow` (`SettingsPrimitives.tsx`) →
**shipped** in `src/components/SettingsPrimitives.tsx` as Muster-styled
reimplementations (`bg-accent`/`bg-raised`/`bg-card` tokens, card-shaped rows
so they stack like Muster cards — not OMB's bare hairline rows).

## 4. Settings — remaining sections (summary)

Connections/Engines/Providers/MCP keys: **exists** (`ApiKeyRow`, `EnginesSettings`,
`ProvidersSection`, `McpServersSection`) — OMB's per-provider key list maps onto
Muster's engine + provider keys; Muster's provider-engine creation (paste a key →
new engine) is **ahead**. Companion/Remote: **exists** (pairing, secure HTTPS /
Tailscale / Wi-Fi, custom domain absent in Muster → remote-access *client mode*
is the parity plan's ranked slice 1, partially shipped). Usage: **exists**
(`TaskUsageStats`/`UsageSection`). Backups/Vault: **partial** (K1 recovery codes
+ S0 devices shipped; hosted sync still gated — portable-backup contract).

## 5. Feature surfaces

| OMB surface | Muster file | Status |
|---|---|---|
| Roster: pin/hide/archive/delete/duplicate, context menu, "New task" | `Sidebar.tsx`, `BotContextMenu` | exists (Loop176 added New task) |
| Roster: search filter | `Sidebar.tsx` query | exists |
| Status dots: working / waiting | `PresenceDot` in `Sidebar.tsx` | exists — green/amber |
| Status dot: **queued** | — | **deferred** — no queued signal on the roster wire; see §7 |
| Composer: send while busy → queued + auto-send, queued affordance | `Composer.tsx`, `Message.queued` | exists |
| Composer: queued **steering** (Enter again to redirect) | — | **deferred** — §7 |
| Composer: `/commands` picker | `src/lib/composer-commands.ts` | exists (Loop176) |
| Composer: mentions, voice, goal | `Composer.tsx` | exists |
| Approval cards + A–F hotkeys, history strip, Watch one-tap | `OptionCard.tsx`, `ApprovalCard.tsx` | **ahead** (why-journal attachment) |
| Attention: unread/waiting counts on section headers | `SectionHeader` in `Sidebar.tsx` | exists |
| Keyboard shortcuts: **searchable modal** (filter, platform keys, empty state) | `ShortcutsSheet.tsx` + `src/lib/keyboard-shortcuts.ts` | **shipped** — was a static sheet |
| Shortcuts: `?` and `⌘/` chords | `src/App.tsx` handler | exists (unchanged) |
| OMB-only shortcuts (`↑` edit-last, `⌘Return` save-bulletin, `⌥↑↓` reorder) | — | **skipped** — features they act on don't exist in Muster (§6) |
| Empty states: empty roster scene, filtered-no-match, settings-search empty | `MusterBloom`, `SettingsModal`, now `ShortcutsSheet` | exists (shortcuts empty state **shipped**) |
| Onboarding: first-run tour incl. phone step, replayable | `Onboarding.tsx`, `TourCard`, `OnboardingChat` | exists — tour-pacing gap remains per openmaus-onboarding study |
| Command palette (`⌘K`) | `CommandPalette.tsx` | exists |
| Updates: banner, sidebar chip, settings row | `UpdateBanner.tsx`, `Sidebar.tsx`, `SettingsModal` | exists — protected surface, untouched logic |

## 6. Reviewed and deliberately skipped

- **Model-provider configuration** (OMB's provider config screens, OpenAI-compat
  URL, provider presets): **skipped by owner direction** — Muster owns this via
  `server/drivers/` + Providers/Engines sections; not ported.
- **i18n locale packs** (11 locales, `t()` everywhere): **deferred**, not a row
  toggle — Muster has no translation layer at all; the Language row is a
  placeholder rather than a fake selector.
- **OMB feature flags** (`config.features.*`: skill authoring, built-in
  browser): **skipped** — Muster has no feature-flag config surface; its
  browser panel ships unconditionally (`BrowserPanel.tsx`), which is the
  end-state OMB gates behind a flag.
- **Multi-tenant client workspaces** (OMB `workspaces` section): **skipped** —
  no Muster concept; connected workspaces + rooms cover the real jobs.
- **Localization-dependent chrome** (lang attributes, dir): follows i18n.

## 7. Deferrals with reasons (do not re-derive)

1. **Queued presence dot** — OMB's roster wire carries `bot.queued`; Muster's
   roster snapshot carries `busy`/`activity` only (`GET /api/bots`, `wireTask`),
   and `Message.queued` is thread-local (known only for the open conversation).
   Partial coverage already exists: queued messages only exist while the bot is
   mid-turn, and that window renders the green *working* dot. A truthful queued
   dot needs a per-bot queued count on the roster wire (server + store slice),
   not a client guess.
2. **Sidebar profile popover / attention bell / drag-reorder** — all three
   restructure `Sidebar.tsx` footer/roster and ordering state in
   `store.tsx` (the U2 deferral precedent in current-state.md). Shape needs an
   owner-visible slice; Muster's inline footer + badges already carry the jobs.
3. **Show-threads / Tool-calls toggles as live behavior** — each needs a
   consumer (sidebar thread rows / transcript filter) plus persistence;
   Tool-calls additionally needs a `features` config key in `server/`
   (parallel-WIP surface). Shipped as labeled placeholders instead of dead
   switches.
4. **Queued steering** — depends on the same thread-slot model as (1); Muster's
   auto-send-on-settle covers the base behavior.
5. **Window geometry beyond defaults** — OMB's fixed dialog sizes ignored;
   Muster's responsive dialog is the house pattern (stability contract).

## 8. Verification (this pass — real outputs)

Commands run after the implementation slices. The full vitest suite is the
owner's gate and was deliberately **not** run by this pass.

| Gate | Result |
|---|---|
| App typecheck — `npx tsc --noEmit -p tsconfig.json` | **0 errors, exit 0** (one intermediate run flagged `src/components/EmailOtpSignIn.test.ts` — a parallel agent's untracked WIP file, not touched by this pass; clean on immediate re-run as the file changed under us) |
| oxlint — 9 touched files (`npx oxlint <files>`) | **0 warnings / 0 errors** (111 rules; the three anti-slop hits this pass introduced were resolved with house-style `oxlint-disable-next-line` justifications, per `SpeakButton.tsx`/`AuthGate.test.ts` precedent) |
| oxlint — full repo (`npm run lint` = `oxlint .`, 934 files) | **7 errors, 0 attributable to this pass** — all in parallel-agent WIP: `server/memory-retrieval.ts`, `server/memory-grants.ts`, `server/index.test.ts`. (Was 11 before this pass's three fixes; parallel files are changing during the run.) Loop170's clean 0/0 baseline stands for committed code |
| Focused tests — `npx vitest run src/lib/analytics.test.ts src/lib/keyboard-shortcuts.test.ts src/lib/sidebar-preferences.test.ts` | **3/3 files, 25/25 tests passed** (10 analytics + 10 keyboard-shortcuts + 5 sidebar-preferences) |
| Electron syntax — `pnpm check:electron` | **exit 0** (`node --check electron/main.mjs` + companion/terminal-launch/preload/capabilities/cua-connection/cua/speech) |
| Full vitest suite | **not run by this pass** — owner's gate; latest accepted baseline: 338 files / 5,036 passed / 0 failed (ceo-log Loop170) |

**Not claimed:** deployment, security posture, browser/screenshot acceptance of
the new rows (no e2e covers SettingsModal), OMB runtime behavior (0 checks),
physical-device anything. This doc is a source-level map, not a benchmark.

**Known behavior change to disclose at review:** wiring `initAnalytics()` in
`src/App.tsx` makes the previously-dead `track()`/`identifyEmail()` call sites
(~20 across Composer/Sidebar/Onboarding/CallView) live for the first time, on
installs that never opted out. The Analytics switch genuinely stops init and
every capture, including surviving restarts and blocked storage (10 tests).
