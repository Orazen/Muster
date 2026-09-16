# MusterMobile — iOS development plan from the companion study (2026-09-17)

Grounded in the local iOS tree and in
[the companion study](../research/hermex-mausbot-ios-study-2026-09-17.md).
This is a plan, not a claim of work done. Every "already exists" line was
verified by reading the file named beside it.

## 1. The finding

MusterMobile already covers most of what Hermex and OpenMausBot ship on the
phone — roster, transcript, streaming, approvals, questions, tasks, search,
tool activity, export, live computer view, and voice. The gap is three things,
in order of how cheaply they land:

1. The phone mascot is **static**. `CompanionCore.FlowerMotion` exists and is
   tested, but only `ios/Watch/WatchFlower.swift` consumes it;
   `App/FlowerAvatar.swift` draws the pose table with no motion.
2. The composer has **no steer/queue** path — only send and stop.
3. The phone has **no attachments and no artifact preview**.

## 2. Ranked slices

### Slice 1 — animate the phone mascot (ready now; no new route, no permission)

Change `ios/App/FlowerAvatar.swift` to draw under a `TimelineView` and apply
the motion that already exists: `FlowerMotion.blinkScale` to the eyelids,
`FlowerMotion.floatOffset` to the body, seeded per bot with
`FlowerMotion.seed` so a roster does not blink in lockstep. Honor
`@Environment(\.accessibilityReduceMotion)` — blink, float and any pulse are
disabled, exactly as the web does via `prefers-reduced-motion`.

Why this is the right first slice: the math is already written and covered by
`ios/Tests/CompanionCoreTests/FlowerMotionTests.swift`; the watch proves the
approach; there is no transport, no permission and no companion route
involved. It is the port the watch slice deliberately left for the phone.

Verification: `cd ios && swift test` for the core; build the phone target;
keep the avatar `accessibilityHidden` so the face is never the only carrier of
state. Report real pass/fail counts.

### Slice 2 — composer operations beyond send (needs a server verb)

Add Steer and Queue beside Send and Stop, using the existing lease-based
`ComposerCoordinator`. Hermex `#505` and OpenMausBot `#1323` both ship this,
so it is now an expected capability rather than a differentiator.

**Check first:** whether `server/index.ts` already exposes a steer/queue verb
that the phone simply does not call. If it does, this is a client-only fold.
If it does not, it is a server + contract change and its own slice with its
own tests.

Carry the fail-closed rule: a draft is cleared only after acknowledgement, and
an uncertain outcome is never auto-retried — the same no-optimistic-writes
rule `ios/App/Session.swift` already follows.

### Slice 3 — attachments and artifact preview (needs a bounded download route)

Photos and files through the composer's `+` menu, and generated artifacts
opened with Quick Look. Hermex `#507` is the reference. The companion's
default-deny table (`ios/README.md`) permits reads and sends, so a bounded,
authenticated artifact download fits the existing policy — but the route must
be added deliberately, and the Quick Look path is iOS-only work.

### Slice 4 — bot look editing (product decision required)

Hermex `#515`/`#516` let the phone edit a bot's look, expression and default
model. Muster's contract is that companion settings live on the computer so
losing the phone cannot lock you out (`ios/App/SettingsView.swift`,
`ios/README.md`). A bot's *look* is not a security setting, so editing name /
expression / color is defensible — but it needs a narrow companion verb and a
revision-conflict story, and it is the one item here that moves the deliberate
"settings stay on the computer" line. Treat as a product decision, not an
automatic port.

### Slice 5 — Live Activity / Lock Screen (distribution-shaped)

A Live Activity for a running turn or a pending approval. Hermex ships one;
Muster has notifications only (`ios/App/Notifications.swift`). This needs a
widget extension target — a project-shaped change like the watch target was —
so it ranks below the client-only slices.

The **watch complication** (pending-approval count on the face) is already
queued as item 5 of `musterwatch-design-2026-09-16.md` §3.6; unchanged.

## 3. Explicitly not now

- CarPlay — an Apple entitlement gate on top of pending Developer-account
  work; backlog behind shipping.
- On-device inference and raw mic streaming — the harness is the model host,
  and system dictation is enough.
- A second socket for anything.

## 4. Verification and reporting

For any slice: build the phone target with `xcodebuild`, run
`cd ios && swift test` for the core, and report real pass/fail counts. A
client-only slice does not touch the web/server suite; a slice that adds a
server verb must carry its own server tests and pass the full `npx vitest run`
gate before commit.

## 5. Constraints carried in

- Companion default-deny (`ios/README.md`): the phone may read bots/rooms/
  transcripts, send, answer approvals, interrupt, mark read, and fetch screens
  on demand; it may not write API keys, manage pairing, drive the Local VM, or
  reach `/api/internal/*`.
- Zero third-party dependencies in the iOS app and in CompanionCore.
- Settings stay on the computer.
- ATS: server URLs must be HTTPS; no plaintext fallback.
- Client-only slices do not touch the web-app stability contract, and the
  paused automation stays paused.

## 6. Not verified

- No competitor branch was built or run.
- Whether the harness already has a steer/queue verb is a check owed before
  Slice 2 is scoped; this plan does not claim it exists.
- No claim that MusterMobile is better or worse than any competitor beyond
  the file-level comparison in the study.