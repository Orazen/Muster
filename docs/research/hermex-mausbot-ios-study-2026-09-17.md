# Hermex, OpenMausBot and MausBot — iOS companion study (2026-09-17)

Sources the owner supplied, studied read-only on 2026-09-17:

- `uzairansaruzi/hermex` — README, commit history, App Store positioning.
- `milind-soni/OpenMausBot` — `commits/main` and the branch list.
- `aivsomkar/mausbot-app-review` — its single release.

**Method and limits.** README / commit / API pages only. No branch was
cloned, no competitor binary was run, and no competitor test was executed.
Hermex's `AGENTS.md` returned 404 to the fetcher, so its working agreement is
read from its README. OpenMausBot's branch list arrived truncated. Everything
below is what the fetched pages said; nothing is inferred from a screenshot
or a running app.

## 1. Hermex — the direct comparable

A native SwiftUI iPhone app (iOS 18+, Xcode 26) that drives a self-hosted
`hermes-webui` server. The phone is the control plane, the server is the
compute plane. Free, MIT, no IAP, no analytics, no relay; App Store listed
(4.7); iPad "coming soon". It is a client only — it ships no backend, and
it tells the user that self-hosting and securing the server is their job.

### Feature set (README)

- Chat with per-message model, reasoning-effort, workspace and profile
  options; file/image attachments; streaming replies with thinking and
  tool-call detail.
- Steer or stop a run mid-flight.
- Sessions: browse, search, resume; cached sessions readable offline.
- Model picker with recents and favorites.
- Profiles & projects.
- Tasks: view/edit the agent's scheduled cron jobs.
- Skills: browse and search installed skills.
- Workspace file browser.
- Memory & Insights: read-only panels.
- A Live Activity widget and a Share extension.
- Connectivity via Cloudflare Tunnel / Tailscale / reverse proxy; real
  HTTPS required by ATS; `http://localhost:8787` for simulator only.

### The recent commit arc (newest first, 2026-09-11 → 09-16)

| # | What it added |
|---|---|
| 518 | Bot face + name in a glass pill header that opens the bot profile |
| 517 | Idle faces blink; the working bot animates in chat |
| 516 | Pick a rest expression for a bot's drawn face |
| 515 | Edit a bot's look, model and capabilities |
| 509 | Search bot names and saved messages |
| 508 | Native chat settings and context usage |
| 507 | Send attachments; open generated artifacts |
| 506 | Live Bots inbox that honors Desktop pins and hidden bots |
| 505 | Steer active work and queue follow-ups |
| 504 | Answer approvals, questions and credential prompts from the phone |
| 503 | Show tools, reasoning and work progress in chat |

The arc is a **messaging-client quality pass**, not a new product. Worth
reading twice:

- **#517 animation discipline.** Idle faces blink via a custom
  `TimelineSchedule` that fires only at the shut/open edges every 3–5s,
  phased per bot name; the working bot is a "lean-and-sway working pose at
  15 fps"; Reduce Motion disables all of it. This is the same design
  MusterWatch already chose: pure functions of time, seedable phase, low
  frame rate, reduced-motion respected.
- **#515 edit semantics.** Explicit saves with per-section results; a
  Desktop revision conflict keeps the edit dirty until reload.
- **#505 operation vocabulary.** Send, Steer, Queue, Redirect, Stop; drafts
  cleared only after acknowledgement; no automatic retry of an uncertain
  outcome.
- **#504 fail-closed answers.** Approvals / questions / sudo / secret / MCP
  answers capture generation, runtime and request id and revalidate at the
  socket write.
- **#506 cache identity.** Local message history capped at 500 messages per
  bot, 8 MB total, 30 days, keyed to server + connection + profile.

### Contract discipline

`UPSTREAM_TESTED_SHA` pins the tested server commit; `HERMES_AGENT_TESTED_SHA`
pins the tested agent commit and its reported release. An untested release
shows a one-line note and **never blocks sign-in**. Codable models decode
tolerantly so unknown fields never crash the app; endpoints are verified
against upstream source, never invented.

## 2. OpenMausBot — breadth, on branches

### Commits on `main` (2026-09-16)

- `#1323` steer a queued message into the running turn instead of interrupting it
- `#1335` iOS: Return inserts a newline, only the arrow button sends
- `#1336` Android: the same keyboard rule
- `#1285` optional retention sweep for thread event logs
- `#1284` delete thread event logs with the thread
- `#1317` iOS: keep thread switching reachable and add bulk deletion
- `#1318` routines dispatch scheduled work into a free thread slot
- `#1324` electron: stale Windows data-dir lease after PID reuse
- `#1326` Android: dedupe Session task CRUD onto one shared policy
- `#1327` iOS: one `Chat.destination` helper
- `#1337` coordination: send each teammate result once
- `#1353` rooms: resolve the prepared approval mode the same way the re-check does

Two readings. The **composer's Return key** and the **iOS
navigation/thread model** are live bugs for them — worth checking whether
MusterMobile's Return handling and thread switching have the same edges.
And **steering a queued message** shipped the same week Hermex shipped its
Send/Steer/Queue vocabulary: steering is now table stakes, not a differentiator.

### Branches

The visible branch names (the list was truncated) are almost all `codex/*`
feature branches: `approval-levels`, `attachment-previews`,
`avatar-image-providers`, `channels-implementation`, `chief-of-staff`,
`computer-inventory`, `cross-team-coordination`, `cua-computer-use-hardening`,
`desktop-cross-device-bot`, `engine-library-ui`, `ios-companion-hardening`,
`fix-ios-ipad-layout`, `fix-ipad-full-window-default`. Two facts follow: the
iOS companion is a **first-class, independently hardened surface** (there is
a branch literally for it), and the project's breadth is carried on branches,
not only on `main`.

## 3. MausBot App Review — the distribution datapoint

One release: tag `demo-2026-09-15`, asset `MausBot-AppReview-Demo.mp4`
(54.9 MB), body: "Filmed on a physical iPhone next to a Mac running the
OpenMausBot desktop app", showing "the pairing (QR code from Settings →
Remote access) and the chat workflow", "Recorded 2026-09-15 for App Store
review of MausBot 1.0.0."

Read: OpenMausBot is submitting a companion to the **App Store**, and the
demo video is the review artifact. OpenMausBot's own README still calls
hosted/mobile connectivity "being built" and calls/native dictation
"macOS-only", so the App Store companion is the first slice of a mobile story
that is otherwise incomplete. MusterMobile's equivalent artifact already
exists (the embedded-watch TestFlight build), which is a small lead.

## 4. What MusterMobile already has

So the gap list is honest — this is the local tree, not the sources.

| Capability | Where |
|---|---|
| Roster: mascot faces, "waiting on you" pulled top, role chip, search | `ios/App/ChatListView.swift` |
| Transcript from the folded state, streaming bubble + reasoning | `ios/App/ChatView.swift` |
| Approval cards with previous-run why-journal disclosure, A–F options | `ios/App/ChatView.swift` (`CardView`) |
| Questions (seed cards), reactions, edit-and-retry, version switch | `ChatView.swift`, `SeedCardView.swift` |
| Composer: Return-sends / Shift+Return-newline, lease-based drafts | `ChatView.swift`, `ComposerCoordinator.swift` |
| Tasks CRUD; transcript export (Markdown/JSON) | `TaskManagerView.swift`, `Session.swift` |
| Live bot computer view (opt-in; screens off unless watching) | `ComputerView.swift` |
| Walkie: push-to-talk + spoken replies (TTS) | `WalkieView.swift`, `Walkie.swift`, `Announcer` |
| Mascot pose table + motion math, shared and tested | `CompanionCore/FlowerMotion.swift`, `FlowerArtwork.swift` |
| Spoken-text rules (markdown stripped, bounded) | `CompanionCore/SpeechText.swift` |
| Watch app: mascot-first root, animated flower, speaker | `ios/Watch/WatchFlower.swift`, `WatchVoice.swift` |
| Settings deliberately minimal; config stays on the computer | `SettingsView.swift`, `ios/README.md` |

MusterMobile is already **ahead of Hermex on voice** (Walkie + TTS on both
phone and watch) and **level on approvals**. The real gap is narrower than the
competitor feature lists first suggest.

## 5. Limits

- Read-only page study; no competitor branch cloned, built or run.
- No competitor tests executed; no comparative performance or reliability claim.
- Hermex `AGENTS.md` returned 404; its agreement is read from the README.
- OpenMausBot's branch list was truncated; only the shown names were read.
- The MausBot demo video was neither downloaded nor watched.
- No security posture claim about any project.