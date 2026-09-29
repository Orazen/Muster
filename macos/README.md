# MusterMac — native Mac prototype (M0)

SwiftUI/AppKit prototype of the native Mac interface from
[the native migration plan](../docs/plans/native-swift-desktop-plan-2026-09-29.md),
following the reviewed design concept at
`design/native-mac-2026-09-29/` (27/27 prototype checks; that number is the
design artifact's receipt, not this code's).

## What this is

- A real SwiftUI app: sidebar (Today, Conversations, Browser, Memory,
  Settings), Today daily-planning workspace with sample calendar and review
  sheet, conversation with composer and a live approval card, a browser
  panel with agent/takeover states, memory management, and
  light/dark/system appearance.
- Fixture-driven: all data comes from `MusterMacCore/Fixtures.swift` and is
  decoded through the shared `CompanionCore` wire types (bots, messages,
  option cards), so the UI exercises the same contracts production uses.
- The mascot renders from `CompanionCore.FlowerArtwork` — the canonical
  artwork shared with iOS/Watch, no copied assets.
- An explicitly-identified GET-only harness probe
  (`MusterMacCore/HarnessProbe.swift`) that can fetch `/api/bots` from a
  base URL you name and refuses every other verb at the type boundary. The
  prototype UI does not call it by default.

## What this is not

- Not a release, not a signed `.app`, not an updater, not a data migration.
- No network mutations: sends, approvals, memory changes, plan edits and
  device state are all local to the running window. No OAuth, no model
  download, no real calendar, no Drive.
- No production profile, no default live server, no port 8845, no Electron
  changes, no shared-core edits (the `../ios` dependency is read-only).

## Build and run

```bash
swift build --package-path macos
swift test --package-path macos
.build/debug/MusterMac            # launches the actual executable
```

Requires Xcode/Swift on Apple Silicon. The executable opens a single window
labeled as fixture data.

## Verification performed for M0

- `swift build --package-path macos` — clean build.
- `swift test --package-path macos` — contract tests over fixture decoding,
  local state machines (send/approval/memory/plan/device), appearance
  resolution, and the GET-only probe boundary.
- Manual launch: navigation across all five destinations, composer send with
  streaming tail, approval answer/dismiss, plan review sheet, memory
  forget/reset, browser takeover toggle, sleeping-device waiting banner,
  light/dark/system themes, panel toggle, VoiceOver labels on primary
  controls, reduced-motion steady streaming tail.

## Next slices (not in M0)

- M1: CompanionCore transport parity (durable `clientIntentId` on sends,
  streaming-session separation) — shared-core edits with their own owner.
- M2: real app bundle, owned Node helper lifecycle, packaged identity.
- M3: real authentication; the composer's send stays local until then.
