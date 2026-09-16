# MusterWatch — research, design, and implementation (2026-09-16)

Plan and record for the watch app: what five reference projects actually do,
what MusterWatch should take from each and deliberately leave, the target
design, and what was implemented and verified. Read with
[watch-approval-history.md](watch-approval-history.md) (what the wrist already
does) and `ios/README.md` §"The watch app" (why it is shaped the way it is).

## 1. What was studied

### 1.1 738/awesome-apple-watch

A curated index, not a codebase. Its value here is the taxonomy and the
confirmation of what is *absent*: every entry is WatchKit-era (Objective-C,
`WKInterfaceController`), a SwiftUI port of an old interface, or a novelty.
The UI category is chart and table libraries (YOChartImageKit,
IGInterfaceDataTable, NKWatchChart); Motion is a single shake detector
(WatchShaker). Nothing in it addresses an agent/approval client, and nothing
in it is worth a dependency. **Take:** the WWDC/HIG references as a checklist.
**Leave:** all libraries — MusterWatch's zero-dependency rule holds
(`ios/README.md`: "Zero third-party dependencies").

### 1.2 b-nnett/codex-apple-watch

The closest reference and the model the owner pointed at. A watchOS companion
that keeps a **mascot on screen** while a Mac runs the agent, with:

- **Mascot-first root.** "Initial screen shows only the mascot. Tap for voice
  mode, long-press for project/chat selection." The fleet is *behind* the
  mascot, not beside it.
- A **five-state model** — `idle`, `thinking`, `running`, `review`, `failed` —
  where the mascot's animation *is* the status display.
- A **Mac bridge** (`ws://<mac-lan-ip>:17842/codex-watch`) streaming mic audio
  as base64 pcm-f32le; Digital Crown moves through projects/chats.
- **Ported sprites** from the desktop app's pet renderer, so the watch shows
  the same character the Mac does.
- Haptics on send, reply, transcript and error.
- Honest scope: "proof of concept, not a hardened App Store release";
  "watchOS does not let third-party apps stay awake forever off-wrist."

**Take:** mascot-first root; the five-state vocabulary; the principle that a
ported desktop mascot is the identity carrier; haptics on state transitions.
**Leave:** its bespoke Mac bridge (MusterWatch already speaks the companion
sidecar, which is strictly better — same auth, same stream, no second daemon)
and its audio-streaming transport (MusterWatch uses system dictation, and
adding a second socket for audio is a lot of surface for little gain).

### 1.3 jacobamobin/AppleInteligenceWatchOS

A clockface that becomes a voice assistant: hold the screen, speak, release,
get a spoken reply. Features worth noting: a **customisable assistant voice
(6 options)**, an **animated glow effect optimised for battery**, and
**local TTS playback** of the response.

**Take:** the loop of *speak the reply back* — this is the "mascot can talk"
half of the request; and the explicit battery-conscious framing of any
always-on animation.
**Leave:** API keys on the watch (the README's `Config.plist` holds ChatGPT
and Perplexity keys — a pattern MusterWatch must not copy: the watch holds one
device token and nothing else), and the third-party model calls (the harness
already owns providers).

### 1.4 nobodywho-ooo/NobodyWho-Watch

"The world's first Apple Watch app that can run AI locally", via NobodyWho's
Swift bindings. Important as a **distribution** datapoint rather than a UI one:

> "a standalone watchOS app is submitted in the App Store Connect like an iOS
> app" … "Apple still requires an empty iOS app in the Xcode project."

and the blocker:

> "the release build is broken" because "NobodyWho's swift bindings don't
> support arm64_32 (old Apple Watch)". A build without arm64_32 works but
> "the binaries gets rejected by Apple."

**Take:** nothing at runtime — on-device inference is not on the roadmap, and
the harness is the model host by design.
**Leave:** the whole approach. But **record the corroboration**: this is a
second independent project hitting the same arm64_32/slice constraint that
`Multiple commands produce` was about in this repo's own archive work
(see §5.3). It also independently confirms the packaging shape settled here:
an iOS container in the project is required, which is why embedding
`MusterWatch` in `MusterCompanion` is the correct distribution answer.

### 1.5 MagsnapMZ/magsnap-ai-watchos

A watch-first voice notebook whose *product rules* are the most reusable thing
in the set:

- "Voice first."
- "One sentence."
- "Zero menus whenever possible."
- A "single-button watch UI".
- "Recording starts only from an explicit user tap and always has a visible
  STOP control."
- An architecture rule: "the AI Core is permanent; every future capability
  should plug into it instead of knowing about other capabilities."
- Deliberate v1 exclusions, stated as such: no bypassing passcode, wrist
  detection, heat limits or system scheduling.

**Take:** the product rules (they match the wrist's job already described in
`ios/README.md`); the explicit-stop rule for anything capturing input; the
"AI Core is permanent" framing, which in Muster's case is `WatchSession`.
**Leave:** its iPhone-round-trip-plus-direct-call fallback (two code paths to
the same provider), and any UI that presents a menu where a button would do.

## 2. What MusterWatch already is, and what it is missing

Already true and worth protecting (verified by reading the sources):

- `WatchSession` is a deliberately trimmed `Session`: three-outcome restore
  (locked keychain ≠ unpaired), generation-guarded stream with 1→15s backoff,
  cold-hydrate-on-unresumed-hello, no optimistic writes
  (`ios/Watch/WatchSession.swift`).
- Approvals are the point: deny-first ordering, lease-scoped submit,
  `ApprovalActionCoordinator` reuse, previous-run evidence disclosure
  (`ios/Watch/WatchViews.swift:352-512`).
- The stream is foreground-only and drops deliberately on backgrounding.
- Everything is a `List`. The roster is text rows with a `Circle()` for colour
  (`WatchViews.swift:294-330`).

Missing, relative to the references and to the request:

1. **No mascot at all on the watch.** The phone draws the authored flower
   (`ios/App/FlowerAvatar.swift`); the watch draws an 8-point coloured circle.
   A bot the owner knows as "the orange flower" is a dot here. This is the
   single largest identity gap and the thing the request is really about.
2. **Nothing animates and nothing speaks.** The mascot is static even on the
   phone; the watch has no voice output.
3. **No at-a-glance state on the root.** The root is a list; "is my fleet
   working?" requires reading rows.

## 3. Design

### 3.1 The mascot-first root (from codex-apple-watch)

The root becomes: **the mascot, large, with the fleet's aggregate state** —
then the list below it, unchanged in content. This is additive: no route is
removed, no approval flow changes, so it does not violate the stability
contract (the web's; the watch's own contract is `watch-approval-history.md`,
which this preserves).

Concretely, a header section above "Needs you":

- the animated flower in the *aggregate* state — an approval waiting wins,
  then any bot working, then any unread, then idle;
- one line of text: `2 need you` / `working` / `up to date`;
- tapping the mascot speaks the state aloud (§3.3).

### 3.2 The expression vocabulary, shared and tested

The web's flower has 15 poses and a keyword chain (`flower.ts`), asserted by
`flower.test.ts` to differ from idle on at least three channels so no pose
reads as "idle with a tint". The phone copied that table verbatim into
`App/FlowerAvatar.swift` — a second copy, untested.

**Change:** move `FlowerPose`, `FLOWER_POSES`, `flowerPoseFor` into
`CompanionCore` (new `FlowerMotion.swift`), so there is exactly one
expression table, it is covered by `swift test`, and the watch can use it
without duplicating anything. `App/FlowerAvatar.swift` keeps only the drawing.

### 3.3 Animation, driven by pure functions of time

The web animates with CSS keyframes (compositor-driven, free). SwiftUI's
nearest equivalent that is both cheap and *deterministic* is a
`TimelineView` at a low frame rate with the motion computed as a pure
function of elapsed time. This is better than `repeatForever` animations for
three reasons: the phase is seedable per instance (a roster must not blink in
lockstep — the web solves this with `--bot-blink-seed`), the functions are
unit-testable without a view, and a watch can drop the rate when nothing is
happening.

Ported and new channels, all in `CompanionCore.FlowerMotion`:

| Motion | Source | Behaviour |
|---|---|---|
| `blinkScale` | `flower-bot-blink`, 5.7s | eyelid closes to 0.08 for ~0.23s, eased, phase-shifted by a per-bot hash |
| `floatOffset` | `flower-bot-float`, 6s | whole body drifts 0 → −2 viewBox units and back |
| `speakingScale` | new | a two-frequency body pulse while a reply is spoken — the flower has no mouth and the pose table forbids added marks, so "talking" is carried by the body |
| `gazeOffset` | `gaze.ts` | pointer→eye vector, clamped, so eyes can follow a Crown turn or a tap location |

### 3.4 The mascot speaks (from AppleInteligenceWatchOS)

`AVSpeechSynthesizer` on watchOS gives spoken replies with no network and no
new permission. Scope is deliberately narrow and stated:

- Speaking is **opt-in per use**, never automatic. A wrist that starts talking
  because a bot replied is a wrist people take off.
- Only the *latest assistant message in the open thread* can be spoken —
  bounded to a sane length, with markdown stripped, because a watch speaker
  reading a code block is a category error.
- It is a foreground-only affordance. No background audio session, no
  interruption of whatever the user is already listening to without an
  explicit tap.

### 3.5 Voice input stays system dictation

`WatchSession`'s header already states the rule: watchOS has first-class
dictation on every text field, so there is no Speech-framework work and no
microphone permission. The references that stream raw audio
(codex-apple-watch, magsnap) each pay for a second transport and a second
permission. MusterWatch keeps the platform affordance. This is a decision to
re-examine only if a *push-to-talk-anywhere* gesture is ever wanted.

### 3.6 Feature ranking (what to build, in order)

1. **Animated flower + mascot-first root** — the identity gap, cheapest to
   verify, no new permission, no new transport. *Built in this slice.*
2. **Spoken replies** — the "can talk" half. *Built in this slice.*
3. **Haptic vocabulary** — distinct haptics for approval-arrives, approval-
   answered, reply-arrives. Cheap, high feel. *Partially present already
   (`.notification` on new approvals, `.success` on confirmed answer).*
4. **Crown-driven fleet scrolling** — from codex-apple-watch. Low risk, real
   ergonomic gain with many bots.
5. **Complication** — show pending-approval count on the watch face. Needs a
   widget extension target; a distribution-shaped change, not a UI one.
6. **Rejected for now:** on-device inference (harness is the host),
   mic streaming (system dictation is enough), a second socket for anything,
   and any always-on animation that ignores reduced-motion.

## 4. Accessibility and cost rules carried into the code

- `@Environment(\.accessibilityReduceMotion)` disables blink, float and pulse.
  The web does the same via `prefers-reduced-motion`.
- The animation rate is low by construction (≈12 fps ceiling, and only while
  the view is on screen); there is no per-frame layout, only transform.
- The mascot is `accessibilityHidden`; the state it depicts is also always
  present as text, so the face is never the only carrier of meaning.

## 5. Implementation record

### 5.1 Shared core

- `ios/Sources/CompanionCore/FlowerMotion.swift` — `FlowerPose` (public),
  `FLOWER_POSES`, `flowerPoseFor`, and the pure time functions.
- `ios/Tests/CompanionCoreTests/FlowerMotionTests.swift` — pose-table
  completeness, the ≥3-channel invariant ported from `flower.test.ts`,
  keyword-chain mapping, blink window/bounds, float bounds, speech-pulse
  bounds, and gaze clamping.
- `ios/App/FlowerAvatar.swift` — now consumes the shared table; its own copy
  deleted. The phone's appearance is unchanged.

### 5.2 Watch

- `ios/Watch/WatchFlower.swift` — the animated view.
- `ios/Watch/WatchVoice.swift` — the speaker.
- `ios/Watch/WatchViews.swift` — mascot-first root header; flower in roster
  rows replacing the colour dot; Speak control in chat.
- `ios/Watch/WatchSession.swift` — aggregate-state helper and the speak path.

### 5.3 Build facts that shaped the code (verified earlier, 2026-09-16)

- ~~The `MusterWatch` **scheme** also builds the iOS target, so `actool` compiles
  `App/Assets.xcassets` (iOS-only icon) with `--target-device watch` and fails
  with "AppIcon did not have any applicable content". Build the **target**
  (`-target MusterWatch -sdk watchsimulator`) instead; `-derivedDataPath` is
  rejected on a `-target` build, so use `SYMROOT`/`OBJROOT`.~~

  **Corrected 2026-09-17.** That advice is now backwards and the `-target`
  recipe is what fails. Verified both ways on this tree: the **scheme** build
  (`-scheme MusterWatch -destination 'generic/platform=watchOS Simulator'`)
  exits 0, while the `-target` build with `SYMROOT`/`OBJROOT` overrides exits
  65 on `App/Discovery.swift:13 unable to resolve module dependency:
  'CompanionCore'` — the package graph resolves and `CompanionCore` compiles,
  but the watch target cannot import it when the build directory is relocated.
  The iOS app scheme builds too. `ios/README.md` already documented the scheme
  form; that is the one that works, and the overrides should not be used.
- `MusterWatch` is embedded in `MusterCompanion` for TestFlight; a standalone
  watch-only app has no beta path (the NobodyWho datapoint in §1.4 reaches the
  same conclusion from another project). A Release archive places a universal
  watch binary (arm64 + arm64_32) at
  `MusterCompanion.app/Watch/MusterWatch.app`; the watch keeps its own bundle id
  `com.muster.companion.watchkitapp` and ships `WKRunsIndependentlyOfCompanionApp`.
- The `Multiple commands produce …/MusterWatch.app/MusterWatch` failure comes
  from the `application.watchapp2` product type, whose `CopyAndPreserveArchs`
  step writes the same executable path as the linker. With the plain
  `application` type the archive exits 0. `SKIP_INSTALL: YES` is kept only so the
  embedded app is not also installed as a second copy of the same binary — it is
  not what silences that error. `PRESERVE_ARCHS_IN_PRODUCT: NO` was a workaround
  for the watchapp2 step and is no longer set. **Verified 2026-09-17:** a full
  `archive` for `generic/platform=iOS` succeeds with the watch embedded, the
  watch icon compiles into `Assets.car`, and both bundles carry version 1.0.0
  (build 5).

## 6. What this slice does not claim

Not claimed, and each needs its own verification:

- Physical-device runtime (no Apple Watch is paired to this Mac).
- Spoken-audio fidelity on real watch hardware; TTS was exercised on the
  simulator only.
- Battery impact of the animation over a real day.
- Minimum watchOS 10 runtime; the simulator is watchOS 26.5.
- Any change to approval correctness — the approval flow is untouched and
  remains governed by `watch-approval-history.md`.

## 7. Voice sync — one utterance, every matching face (2026-09-17)

The voice follow-on the owner asked for. Both surfaces already spoke; what they
could not do was agree on *whose* face should move while a voice was speaking.
The watch pulsed its fleet header for any utterance — including a reply read
inside a chat — and the phone pulsed nothing at all outside Walkie's own sheet.

**The shared vocabulary.** `CompanionCore/VoiceActivity.swift` adds `VoiceScope`
(`.fleet` or `.thread(id)`) and `VoiceActivity` (a scope plus prepared text).
`VoiceActivity(scope:source:)` prepares through `SpeechText`; the phone passes
text it already stripped with `Walkie.spokenText`. That split is deliberate —
each surface keeps reading aloud exactly what it read before, and only the
scope is new. Six tests in `VoiceActivityTests` cover preparation, the empty
and code-only cases, and the thread-matching rule.

**One speaker per surface, at app scope.** The watch already hoisted
`WatchVoice` into `MusterWatchApp`; the phone did not, which is why nothing
outside Walkie could see the announcement. `Announcer` moved from a
`@StateObject` inside `WalkieView` to `CompanionApp`, and `ChatListView` and
`ChatView` now read it. A `fullScreenCover` is a new environment root and does
not inherit the app's objects, so Walkie is handed both explicitly.

**What pulses, and for what.** `FlowerAvatar` gained a `speaking` flag that
drives `FlowerMotion.speakingScale` about the same chin pivot the watch uses,
suppressed under Reduce Motion. It is wired to the utterance's scope, so:

- the watch fleet header pulses only for `.fleet`;
- watch roster rows and the phone roster rows pulse only for their own thread;
- the phone chat header pulses only for its own thread;
- `WatchVoice`/`Announcer` clear the scope when the synthesizer finishes on its
  own, so a face never keeps moving after the voice stops.

**Speech now outlives the sheet.** Because the speaker is app-scoped, closing
Walkie no longer cuts the reading off. That made the existing stop control
unreachable, so the chat header draws a Stop-reading button while its own
thread is the one being spoken — the rule that every utterance has a visible
stop, kept true rather than assumed.

**Verified.** `cd ios && swift test` → **338 tests, 0 failures** (332 before
this slice, +6). `xcodebuild -scheme MusterCompanion -destination
'generic/platform=iOS Simulator'` → exit 0; the resulting
`MusterCompanion.app` embeds `Watch/MusterWatch.app` as a simulator-arch
(x86_64 + arm64) bundle. `xcodebuild -scheme MusterWatch -destination
'generic/platform=watchOS Simulator'` → exit 0, and a Release `archive` for
`generic/platform=iOS` exits 0 with the device-arch watch embedded. The watch
app was installed and launched on a watchOS simulator.

**Not verified, and not claimed:** the running app was not driven through the
behaviors below, so the pulse, the scope routing and the stop control remain
compile-and-unit-test evidence (plus a launch) rather than observed behavior.
`Announcer`'s `AVSpeechSynthesizerDelegate` callbacks are not
exercised by tests — they need a speaker. Battery cost of a pulsing roster is
unmeasured, and the watch's own physical-device caveats from §6 stand.