# Muster mascot character system — execution plan (18 September 2026)

Owner goal, in their words: "A character needs more than working and done. If
it's going to sit around while you work, it also needs to know what to do when
nothing is happening, and what to do when you start messing with it." Muster's
Flower becomes a real character: it follows the pointer, gets annoyed, takes a
slap, goes dizzy, shows uploads, errors, finishes — and keeps telling the
truth about the work underneath.

**Evidence base:** `docs/research/mascot-character-study-2026-09-18.md`
(Novra case study, Morph Bot engine, LaoA lab, botato faces, gawk.bot,
Octop, BuddyLiveGF — with adopt/leave calls per source).

**Owner decisions (18 September 2026), binding for all slices:**

1. **Upgrade the Flower** — the engine extends the existing canonical Flower
   (`src/lib/musterbot/*`, `src/components/MusterMascot.tsx`). No ported
   engine, no new character, no copied GrokBot geometry (license + brand).
2. **All four surfaces in v1** — web app, Electron desktop tray/notch,
   iOS Live Activity + widget, Watch.
3. **Full playful with an off switch** — interactions exist; a calm-mascot
   setting and `prefers-reduced-motion` can both silence them.
4. **Two-layer state model** — status states (working, thinking, uploading,
   finished, error, idle) drive body motion/morphs; the 15 existing expression
   poses are the face; interaction states (following, annoyed, slap, dizzy)
   temporarily override the face and decay automatically.

## Stability and truthfulness contracts (unchanged, non-negotiable)

- Keep /app and /os shells, layout, theme, selected conversation, saved
  choices. The mascot system is additive; nothing existing is removed or
  repositioned without an explicit stability note in the ceo-log.
- **Expressions never substitute for approval, uncertainty, or completion
  text.** Every state change that matters is also readable as text. A
  dizzy flower with no textual context is a bug, not a feature.
- Idle CPU stays ~zero: event-driven state transitions, rendering paused
  when the surface is hidden (visibility pausing, as Morph Bot does),
  no per-avatar polling loops. Verify with a real measurement before
  claiming performance.
- `prefers-reduced-motion: reduce` (already handled in
  `muster-mascot.css:74` and `flower-bot.css:91`) must degrade every new
  motion layer to a still pose + text.
- Ports: dev work uses explicit free ports and isolated `OMB_DATA_DIR`;
  never touch 8845 or the user's live companion (8810/8811). Production
  checks GET-only.
- Slice discipline: reproduce/verify before fix; smallest touched surface;
  per-slice gate `npx tsc -b`, `npx tsc --noEmit -p tsconfig.server.json`
  (if server touched), `npx oxlint .` (0/0), `npx vitest run <touched>` then
  full suite before claiming done; UI slices additionally run the owned
  Playwright/e2e set. Record real numbers in the ceo-log, append-only.

## The character contract (single source of truth)

New module `src/lib/mascot/character.ts` (web) owns exactly one reducer:

```
resolveCharacter(input) -> {
  status:   "idle" | "working" | "thinking" | "uploading" | "finished" | "error",
  face:     FlowerPoseName,          // one of the existing 15 poses
  override: null | "following" | "annoyed" | "slapped" | "dizzy",
  morph:    null | "send" | "upload" | "error-bounce" | "celebrate" | "think-cloud",
  task:     string,                  // the one-line narrated label
}
```

Rules encoded there and tested in `character.test.ts`:

- Interaction overrides **never change `status`** — poking a working bot
  keeps it working underneath (the Novra coexistence rule). Overrides decay
  on their own timers (slap → dizzy 1.5s → previous face; annoyed after ≥3
  pokes within 10s, holds ~4s).
- `face` for work statuses is `poseFor`'s existing keyword mapping
  (`src/lib/musterbot/flower.ts:67`); the status layer adds motion, it does
  not fight the face.
- The task line is mandatory whenever status ≠ idle; collapsed surfaces
  render face + line, nothing else (the "one bot in focus, the rest in
  sight" rule).
- A `calm` flag (settings, persisted like existing choices) forces
  `override: null` and static motion; reduced-motion forces static motion.

## Slices, in dependency order (parallel work: A/B any time; C needs A; D/E need A+B; F needs C; G last)

### Slice A — Character core (web engine + state machine) — **start here**

Files: new `src/lib/mascot/character.ts` + `character.test.ts`; extend
`src/lib/musterbot/flower-bot.css` with motion classes; new one-shot morph
keyframes with the RESET → ENTER → HOLD → EXIT lifecycle; event-driven
pointer-follow (transform only, rAF-throttled, listeners removed on unmount,
visibility-paused).

Status layer sources (existing, must be wired not invented):
turn-tail presence already streams real turn state into ChatView
(`src/lib/turn-tail.ts`, `src/components/ChatView.tsx:927` mascotMotion);
`src/lib/mascot.ts:78` already defines `AGENT_MOTIONS`; `FleetOrb.tsx:69`
already renders presence. The face's 15 poses and their ≥3-channel
difference guarantee stay exactly as tested in
`src/lib/musterbot/flower.test.ts`.

Accept: unit tests for the reducer (coexistence, decay, calm, reduced-motion,
unknown-state fallback to idle) + all ordered state transitions (Morph Bot's
regression idea, scaled: ~6 statuses × 4 overrides × calm on/off).

### Slice B — Interaction grammar (web) — **parallel with A**

Cursor-follow, poke/slap, annoyed counter, dizzy chain, idle antics
(occasional blink/stretch/look-around when idle ≥20s — small, calm-able).
Files: new `src/components/FlowerCharacter.tsx` (wrapper mounting
`MusterMascot`/`FlowerBot` + interaction listeners + decay timers),
mounted first at the chat turn-tail position and the onboarding mascot;
pointer-events and hit-targets must not steal clicks from adjacent
controls (keyboard/touch parity: a visible "wave" button already exists as
the accessibility path — keep it working).

Accept: Playwright e2e — poke → reaction with status text unchanged;
3 pokes → annoyed; slap → dizzy → recovered; reduced-motion → static;
calm setting → no interactions; zero console errors; existing e2e suite
still green (23/23 baseline).

### Slice C — Web surface rollout (needs A)

Mount the character where the mascot already lives, without moving
anything: chat turn-tail (existing mount, new motion), FleetOrb presence
(`FleetOrb.tsx`) gains status faces with the narrated line on hover/expand,
roster avatars keep static faces (cheap surfaces stay cheap), Onboarding
mascot gains reactions. Add the calm-mascot toggle to the existing mascot
appearance picker surface, persisted like other saved choices.

Accept: full unit suite + e2e green; visual receipts in the ceo-log;
no layout shift beyond the character itself (screenshot before/after).

### Slice D — Desktop tray/notch companion (needs A+B)

Electron: a small always-on-top tray window (the "notch slot") rendering
the same `FlowerCharacter` from the same bundle — one web component, not a
second implementation. Aggregate fleet status (the busiest / needs-you bot
in focus, others as face+line — the Novra "one bot in focus" rule), click
to focus the relevant conversation, state pushed over the existing local
IPC (no new ports). Follow BuddyLiveGF's rule: no modification of packaged
app internals; the window is its own surface.

Accept: `pnpm package:mac` builds; manual receipt with screenshot; tray
state tracks a real harness turn on owned ports; CPU measured at rest.

### Slice E — iOS Live Activity + widget (needs A, shares Slice F contract)

iOS: Live Activity (Lock Screen) showing face + narrated line; widget
(home screen) with the two Novra views — multi-bot (several faces) and
single-bot focus. Implementation on the existing vector flower:
`ios/Sources/CompanionCore/FlowerArtwork.swift` + `FlowerMotion.swift`
(already the single shared mascot implementation per the musterwatch plan),
ActivityKit for the Live Activity, WidgetKit for the widget. Face derives
from the same pose table; motion is per-surface (Live Activity is static
frames + text; widget may animate lightly with the existing
TimelineView-sampled `FlowerMotion`).

Accept: builds in the generated project (`xcodegen generate` first);
preview screenshots; pairing/turn state drives it via the existing
companion sidecar — no new server routes required if the existing
status feed suffices (check `companion/src/*` before adding any).

### Slice F — Watch aggregate mascot (needs C/E contract settled)

Per `docs/plans/musterwatch-design-2026-09-16.md` §3.1: mascot-first root
already planned — the aggregate state (approval waiting > working > idle)
animates the flower; tap speaks state aloud (WatchVoice exists); haptics on
state transitions. This slice implements it on the owned Watch with the
same FlowerMotion table.

Accept: owned-simulator screenshot receipt; haptic + voice check; the
already-documented "mascot is a dot" failure mode stays closed.

### Slice G — Delight + docs close-out (needs everything)

App icon state tint (finished/error states tint the icon badge-style, per
Novra's icon exploration — never replacing notification counts);
LaoA-style share-card PNG export (1080×1440, bot face + state + one line,
generated client-side); landing-page hero uses the interactive character
with reduced-motion still; README/docs updated with real screenshots;
ceo-log entry consolidating receipts.

## File-ownership map for parallel agents

| Agent | Owns | Must not touch |
|---|---|---|
| A | `src/lib/mascot/character.ts`, `character.test.ts`, `flower-bot.css` additions | `flower.ts` pose tables (read-only), ChatView |
| B | `src/components/FlowerCharacter.tsx` + its e2e | reducer internals (consumes via A's exports) |
| C | mounts in ChatView turn-tail, FleetOrb, Onboarding, settings toggle | reducer + interaction files |
| D | `electron/*` tray window files | web components (imports them) |
| E | `ios/App`/`CompanionCore` Activity/widget files, `ios/project.yml` | web mascot code |
| F | `ios/Watch/*` | CompanionCore motion table (read-only) |
| G | README/docs/assets/scripts | any slice's source files |

Coordination rule from AGENTS.md applies: read
`docs/plans/current-state.md` → `docs/guides/web-app-stability.md` → tail
of `docs/plans/ceo-log.md` → `AGENTS.md` before editing; `git status`
before any staging; scoped pathless commits per slice; never blanket
`git add -A`.

## What this plan deliberately does not do

- No Rive, no Lottie additions, no Live2D, no third-party animation runtime —
  the engine is original CSS/SVG/TS on the existing flower channels.
- No copying of GrokBot/Morph Bot/OpenMausBot geometry or motion data.
- No new network services: the character consumes existing status feeds
  (turn-tail, FleetOrb presence, companion sidecar). If a feed is missing,
  the slice documents the gap instead of adding a server route silently.
- No security/deployment/release claims from mascot work. Slices D–F
  produce local build receipts only.
