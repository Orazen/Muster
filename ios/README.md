# Muster companion (iOS)

Your bots keep running on the laptop. This is the phone you watch them from,
answer their approvals on, and send them the next thing.

The laptop stays the only machine that owns agent processes, credentials,
transcripts and computers. The phone owns nothing — it is a second client of the
same harness the desktop app talks to, through the restricted sidecar described in
[`docs/ios-companion.md`](../docs/ios-companion.md).

## Status

Built and verified against a real harness on both a simulator and an iPhone:
QR handoff, Bonjour discovery, manual LAN and Tailscale pairing, the roster, paged chat,
streaming replies, the computer view, and — the one that matters — an approval
raised by a bot on the Mac, answered on the phone, with the bot carrying on.

The event stream deliberately reads raw bytes rather than
`URLSession.AsyncBytes.lines`. Three easy-to-miss failure modes are covered by
real `URLSession` tests:

1. `timeoutInterval = .greatestFiniteMagnitude` — reads as "never time out",
   actually produces a request that opens and delivers nothing, because
   URLSession turns a timeout into a deadline by adding it to the current time.
2. Keeping only the derived line iterator while letting `URLSession.AsyncBytes`
   go out of scope. AsyncBytes cancels its data task when released, so the
   connection died the moment the first frame was returned.
3. Reading with `bytes.lines`, which folds consecutive newlines into one
   separator and therefore never reports the blank line that terminates an SSE
   event. Zero frames, no error, a healthy-looking connection at both ends.

`EventStreamTests` catches that class by driving a real `URLSession`.
[`TESTING.md`](TESTING.md) is the end-to-end runbook.

## Layout

```
ios/
  Package.swift                  CompanionCore + its tests
  project.yml                    XcodeGen spec for the app target
  Sources/CompanionCore/         no UI, no Apple frameworks beyond Foundation
    Models.swift                 the harness's wire types
    Frames.swift                 SSE frames, unknown kinds absorbed
    SSE.swift                    line parser + URLSession event stream
    Client.swift                 every call the phone is allowed to make
    Store.swift                  the fold: frames → state
    FlowerArtwork.swift          the mascot's body path, eye anchors, palette
    FlowerMotion.swift           pose table + blink/float/speech as pure f(t)
    FleetMood.swift              the fleet as one face, precedence in one place
    SpeechText.swift             markdown → words worth hearing, bounded
    VoiceActivity.swift          which face a spoken utterance belongs to
  Tests/CompanionCoreTests/
    Fixtures/                    captured from a real server — do not hand-edit
    DecodingTests.swift          the contract with the harness
    SSETests.swift               the parser, which is where this goes wrong
    StoreTests.swift             the fold
    FlowerMotionTests.swift      the pose invariant and the motion bounds
    FleetMoodTests.swift         the precedence, including "offline wins"
    SpeechTextTests.swift        what a voice may and may not read
    VoiceActivityTests.swift     scope preparation and thread matching
  App/                           SwiftUI, and everything that needs a device
    CompanionApp.swift           entry; owns when the stream lives and dies
    Session.swift                connection, lifecycle, actions
    Discovery.swift              NWBrowser for _muster._tcp
    Keychain.swift               the device token
    AgentAvatar.swift             the mascot face, in the desktop's palette
    PairingView.swift            QR handoff, discovery, address and code fallback
    PairingScanner.swift         native QR camera, permission and recovery UI
    ChatListView.swift           roster, with "waiting on you" pulled to the top
    ChatView.swift               transcript, approval cards, composer
    ComputerView.swift           opt-in live view of a bot's computer
    MarkdownText.swift           the supported Markdown presentation layer
    SettingsView.swift           status, and unpair
    WalkieView.swift             push-to-talk, spoken replies, the bot's quote
    WalkieVoice.swift            the mic and the speaker, on iOS only
    FlowerAvatar.swift           the flower, drawn and animated
  Watch/                         the watch app — an independent watchOS target
    MusterWatchApp.swift         entry; same scenePhase lifecycle rule
    WatchSession.swift           a trimmed Session: restore/backoff/hydrate kept
    WatchViews.swift             fleet, approvals, short replies, settings
    WatchFlower.swift            the same flower, at wrist size, with motion
    WatchVoice.swift             local TTS, scoped so the right face pulses
```

**Voice is scoped, not global.** `Announcer` (phone) and `WatchVoice` (watch)
each publish the `VoiceActivity` in flight. A flower pulses only for the
utterance that is about it: the watch fleet header for the aggregate status
line, a roster row or chat header for its own thread's reply. The speaker is
app-scoped on both surfaces — hoisted out of `WalkieView` for exactly this —
which is also why closing Walkie no longer stops the reading, and why the chat
header carries a stop-speaking control while its thread is being read.

## The watch app

`MusterWatch` is an **independent watchOS application**, not a WatchKit
extension embedded in the iOS bundle: it pairs with the computer directly,
over the same sidecar and the same six-digit code, and runs whether or not
the phone app is installed. `WKRunsIndependentlyOfCompanionApp` says so;
`WKApplication: true` makes it a single-target SwiftUI app, which is all a
modern watch app needs.

Paired with Bonjour discovery — no camera on a wrist, so the QR flow the
phone uses is replaced by tapping the computer from the found list, then
typing the code Companion shows. The manual-address fallback (Tailscale
MagicDNS) works here too. The token goes to the watch's Keychain with the
same `AfterFirstUnlockThisDeviceOnly` class; the connection lands in
`UserDefaults`, deliberately apart, so what gets backed up is never the
credential.

WatchSession is a trimmed copy of the phone's `Session`, and the trimming is
the design: notifications (the phone raises banners; a watch without its
phone's server-side route would double-buzz), screen watching (a base64
desktop capture is the one thing a wrist must never ask for — `screens:
false`, always), search, tasks and branch editing all stay off. What remains
is the part worth keeping byte-identical: the three-outcome restore story
(a locked keychain is "unlock this watch", not "unpaired"), the
generation-guarded stream with 1→15s backoff, the cold-hydrate-on-
unresumed-hello rule, and no optimistic writes. Those were the hard-won
parts on the phone; a second subtly-different implementation would be a
second home for the same bugs.

What the wrist is for: glance the fleet, settle an approval (Deny is drawn
before Allow — an accidental tap on a wrist should cost the bot a retry,
not run a command), and dictate a short reply through the system keyboard.
Everything else lives on the phone and the computer on purpose.

Build it like the phone:

```sh
cd ios && xcodegen generate
xcodebuild -project MusterCompanion.xcodeproj -scheme MusterWatch \
  -destination 'generic/platform=watchOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

## Building

The core needs nothing but a Swift toolchain:

```sh
cd ios
swift test
```

The app needs Xcode. The `.xcodeproj` is generated rather than committed:

```sh
brew install xcodegen
cd ios && xcodegen generate && open MusterCompanion.xcodeproj
```

**Re-run `xcodegen generate` after pulling any change that adds a file to
`App/`.** The spec says `sources: App`, but XcodeGen resolves that to explicit
file references when it generates, so a new file is simply absent from the
target until you regenerate — and the build fails with `Cannot find 'X' in
scope`, which reads like a code error and is not one.

If you'd rather not install XcodeGen, make an iOS App target by hand, add the
`App/` folder and the local `CompanionCore` package, and copy the Info.plist
keys out of `project.yml` — `NSLocalNetworkUsageDescription` and
`NSBonjourServices` especially. Without them `NWBrowser` returns no results at
all, *silently*, which looks exactly like "no computers on this network".

## Regenerating the fixtures

Whenever the companion API changes:

```sh
node scripts/capture-companion-fixtures.mjs   # from the repo root
```

It boots a real harness against a throwaway home directory, drives the real
pairing handshake through the sidecar, and writes down what came back. The
harness may use SQLite internally; the fixture records the public HTTP/SSE
contract, which is the only storage surface the phone should know.
Commit the diff — a change there is a change to the contract, and reviewing it
is the point.

## What the phone may and may not do

Enforced by the default-deny policy in `companion/src/routes.ts`, and mirrored
here by simply not having the methods:

| Allowed | Refused |
|---|---|
| Read bots, rooms and transcripts | Write API keys (`PUT /api/config`) |
| Send messages | Manage pairing or revoke devices |
| **Answer approvals and questions** | Drive the Local VM or this computer |
| Interrupt a bot, mark chats read | Reach `/api/internal/*` |
| Fetch screen images on demand | Load the packaged desktop UI |
| Open an explicitly enabled cloud desktop | Provision, sleep or run shell commands on cloud computers |

Marking a chat read and remembering an approval use purpose-built server
verbs. The sidecar does not expose the general bot or room `PATCH` routes,
because those can also change execution policy, computers, connected apps, and
working directories.

Companion settings stay on the computer on purpose: losing the phone must not
mean losing the ability to lock it out.

Interactive cloud desktop access is additionally enabled per paired device and
starts off. The phone asks the Mac to mint a fresh provider URL after an
explicit warning, validates that it is HTTPS, opens it in an in-app Safari
sheet, and never persists it. The Local VM's loopback-only noVNC listener and
the host computer remain unreachable through the companion.

## Design notes

- **Zero third-party dependencies.** The raw-byte SSE reader, Keychain,
  `NWBrowser`, and notifications are all first-party.
- **QR scan confirms before connecting.** The QR carries a short-lived,
  high-entropy credential rather than relying on the visible six-digit code.
  The app validates the target, asks the user to confirm it, exchanges the
  credential once, and persists only the resulting device token in Keychain.
- **Thin client.** The harness already folds provider events into settled
  messages. The phone folds `message`, `message.patch`, and `bot` frames, plus
  the small `runtime` delta subset needed to show a reply while it is typed.
- **`screens=off`.** The harness would otherwise push a base64 desktop capture
  every few seconds to a device on cellular.
- **Reconnect by cursor.** The stream is resumable: hold the `<streamId>:<seq>`
  cursor, and on reconnect the server replays what was missed or says
  `resumed: false`, which is the signal to hydrate. Lifecycle — not the parser —
  is the hard part of a phone client, which is why the stream is torn down
  deliberately on backgrounding rather than left for iOS to kill.
- **No optimistic state.** Actions call the harness and let the event stream
  deliver the result. A phone that draws its own version of what just happened
  is a phone that disagrees with the laptop.
- **Messaging-app shape, not settings-list shape.** Mascot faces at roster size,
  the bot's role as a chip beside its name, timestamps that say "Yesterday"
  rather than a date, and a gap-based separator in the transcript instead of a
  stamp on every message. The palette in `AgentAvatar.swift` is copied verbatim
  from `src/lib/mascot.ts`: a bot the user knows as "the orange one" should be
  the same orange on both screens.
- **Return sends, Shift+Return breaks the line**, via `.onKeyPress`. Returning
  `.ignored` for the shifted case hands the keypress back to the text field,
  which is the only thing that can insert the newline once Return is claimed.
  Software keyboards have no Shift+Return, so there `.onSubmit` sends.
- **No affordance without a feature behind it.** The reference design this was
  modelled on has a composer mic; there is no dictation here, so it is not
  drawn. Search covers the SQLite transcript store and opens the exact task,
  branch, and message; the roster's "+" creates the same basic bot the desktop
  endpoint creates, then opens it.

## Not in this version

The live connection is foreground-only. Notification frames produce native
banners, sounds, time-sensitive approval alerts, and an app badge while connected;
the resume cursor replays alerts missed during a short background pause. There is
no APNs delivery after the app is terminated, no voice/call mode, and no hosted relay.
Task management, SQLite transcript search,
transcript sharing, reactions, and edit/version controls use narrow companion
routes and the computer remains the source of truth. Tailscale is supported
through manual MagicDNS entry; it is not a dependency and Muster does not
operate a cloud copy of local data.
