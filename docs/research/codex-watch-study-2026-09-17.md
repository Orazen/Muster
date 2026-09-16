# Codex Watch Companion — what to take, what to leave

Study of `b-nnett/codex-apple-watch` (v0.1.0, May 2026), read as a design
reference for MusterWatch. This is the *second* pass over that repo: the first
(`musterwatch-design-2026-09-16.md`) treated it as one of five references
surveyed broadly. This one is a focused read of the shipping release, prompted
by the release notes and the `group-9.png` screen composite.

The reference repo's own source and screenshots are **not** vendored here.
It is a third-party project, this repo is private and commercially licensed,
and copying its assets in would be a licensing problem rather than a
convenience. Everything below is written from reading it, and the file and
symbol names are cited so the original can be checked.

## What it actually is

A proof-of-concept watch app for keeping a Codex "pet" visible while a Mac
runs Codex. The watch talks to a small bridge process on the Mac over
WebSocket, streams microphone audio up, and receives task state and reply text
back. The README is explicit that it is "a proof of concept, not a hardened
App Store release" — which matters, because several of its choices are
PoC-shaped and should not be copied.

## The screens

Six fixtures, from `docs/screenshots/` and the composite:

| Screen | What it shows |
|---|---|
| `01-idle-pet` | Just the pet, centered on black. Nothing else. |
| `02-thinking` | The pet mid-animation, a task card below it. |
| `03-voice-waveform` | A bar waveform on black; tap anywhere to stop. |
| `04-unread-reply-card` | The pet with an unread badge, above a reply card. |
| `05-message-reader` | Full-screen markdown, title in the nav bar, Reply button. |
| `06-picker` | A list: New Chat, Unread, Pinned, Projects, Chats, Mascot. |

The structural observation: **the pet is the screen, and everything else is a
sheet over it.** `CompanionWatchContent` is a `ZStack` on `Color.black` with
the pet at the bottom layer, and voice, transcript review and the picker as
overlays. There is no tab bar and no list root. The app opens on a face.

## The pet engine

Two files, and both are worth reading closely because they solve problems
MusterWatch has too.

`CodexPetModel.swift` defines the visual states — `idle`, `running`,
`runningLeft`/`runningRight`, `thinking`, `waiting`, `review`, `failed`,
`waving`, `jumping`, `recording` — and, separately, an `animationKey` that
collapses several of them onto one animation. `recording` plays `jumping`;
`thinking` plays `running`. Two states, one loop, no new artwork.

It also carries a **normalisation table** in `desktopState(from:)`: the raw
string the Mac sends is lowercased, underscores become hyphens, and a switch
maps a dozen synonyms onto the canonical states — `"inprogress"`,
`"in-progress"`, `"loading"` and `"working"` all become `running`;
`"approval"`, `"waitingonapproval"`, `"waiting-on-user-input"` all become
`review`. This is the same job `flowerPoseFor` does with its keyword chain,
and it confirms the approach: the *producer* of the state string is not
disciplined about naming, so the consumer must be.

`CodexPetSpriteView.swift` is a spritesheet view, not a drawn mascot. It is
8 columns by 9 rows of 192×208 frames, drawn by offsetting one `Image` inside
a clipped frame at `.interpolation(.none)` / `.antialiased(false)`, and
advanced by an `async` loop that sleeps for each frame's declared duration.
Frame timings are hand-authored per state (`idle` holds its first frame for
1.68s, its last for 1.92s).

**Take:** the `animationKey` collapse and the normalisation table — both are
patterns, and MusterWatch's `FleetMood` and `flowerPoseFor` already implement
them.

**Leave:** the spritesheet. MusterWatch draws its flower as a vector path from
`FlowerArtwork`, which scales to any watch size and is one asset rather than
nine. A bitmap sheet is the right call when the artwork comes from a desktop
app you cannot re-author; it is not the right call when you own the path.

**Leave also:** the `async` frame loop. It is a `Task` per view that sleeps in
a loop, which is awkward to test and awkward to cancel. MusterWatch's
`FlowerMotion` is a pure function of time sampled by a `TimelineView`, which
is testable without a screen and cannot leak a task.

## Input model

`CompanionWatchContent` wires a `digitalCrownRotation` over a focusable
full-screen view: the Crown cycles the selected project or chat, with haptic
feedback on each step, and `.onChange(of: crownValue)` converts the continuous
value into a delta. Tap is voice, long-press is the picker, double-tap is
"open visible text if present, otherwise voice".

This is a genuinely good model and the one part of the reference worth copying
wholesale. **Not yet taken** — MusterWatch's roster is a `List`, which
already handles the Crown as scroll. Crown-to-select would be a change to the
root, and the root is a place the stability contract says not to redesign
without cause. Recorded here as an option, not a defect.

## The reader

`MessageReaderView` is the screen MusterWatch was missing. It renders
`MarkdownText` at reading size with a `Reply` button pinned under the body,
and it makes one layout decision worth naming: `usesTitleAsNavigationTitle` —
if the body is longer than 20 words the title goes in the navigation bar, and
otherwise it is shown inline above the body. A short message gets its heading
on screen; a long one spends that line on the body instead.

MusterWatch already had `Markdown.blocks` in the core and a `MarkdownText`
view on the phone, but the watch was rendering `**bold**` and `- ` as literal
characters in its bubbles. That is the defect this pass fixed; see
`ReaderText` and `WatchMarkdown`.

## What was implemented

- `CompanionCore/ReaderText.swift` — the title rule, the long-form threshold,
  the first-heading lookup, and a preview flattener. Pure functions, tested.
- `Watch/WatchMarkdown.swift` — `MarkdownBlock` rendered at watch sizes
  (15pt body, two heading sizes, wrapping code rather than side-scrolling).
- `Watch/MessageReaderView.swift` — the full-screen reader, with read-aloud
  and an inline reply.
- `WatchRoute.message` and the tap-through from a bot bubble.
- Bot bubbles now render markdown instead of showing the source.
- Send and failure haptics.

## What was deliberately not taken

- **The bridge.** Codex Watch needs a Node process on the Mac to relay.
  MusterWatch already talks to the harness directly with a paired token.
- **Microphone streaming.** The watch's own dictation through the reply
  `TextField` is the platform affordance, needs no permission, and is already
  wired. A custom recorder would be a second audio path.
- **`WKExtendedRuntimeSession`.** The reference starts one to stay alive
  off-wrist and notes that a dedicated watch should also have wrist detection
  disabled. That is a PoC accommodation. MusterWatch holds its stream only
  while the app can use it, which is the rule watchOS actually wants.
- **The spritesheet and its frame loop**, as above.

## Honest limits of this study

The reference's own screenshots did not render in this environment, so the
screen descriptions above come from its README, its source, and a programmatic
read of the `group-9.png` composite — layout, palette and the position of
elements, not a visual judgement of the artwork. The animation timings quoted
are from `CodexPetModel.swift`. Nothing here was verified by running the
reference app.