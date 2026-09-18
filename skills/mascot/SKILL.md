# Muster Mascot Character — agent skill

Work on Muster's mascot character system (the Flower). This skill encodes the
decisions, contracts and verification gates so any agent can pick up a slice
without re-deriving them. The plan is
`docs/plans/mascot-character-system-plan-2026-09-18.md`; the reference study
with adopt/leave calls is `docs/research/mascot-character-study-2026-09-18.md`.

## When to use

Any task mentioning: mascot, Flower, character, poses, states, follow/annoyed/
slap/dizzy, upload/error/finished/working states, tray/notch companion,
Live Activity, Watch mascot, FleetOrb presence, turn-tail motion.

## The four binding decisions (owner, 2026-09-18)

1. **Upgrade the Flower** — original engine on `src/lib/musterbot/*` +
   `src/components/MusterMascot.tsx`. Never port Morph Bot's code, never copy
   GrokBot geometry (no-license warning applies), never adopt OpenMausBot's
   mascot.
2. **Four surfaces v1** — web, Electron tray/notch, iOS Live Activity/widget,
   Watch. Same character, per-surface vocabulary.
3. **Full playful with an off switch** — interactions exist; `calm` setting
   and `prefers-reduced-motion` both silence them completely.
4. **Two-layer model** — status states (idle/working/thinking/uploading/
   finished/error) drive motion and one-shot morphs; the 15 existing
   `FLOWER_POSES` are the face; interaction states (following/annoyed/slap/
   dizzy) override the face temporarily and decay automatically.

## Hard rules

- **Truthful status:** expressions never substitute for approval, uncertainty
  or completion text; any non-idle state carries a text line.
- **Coexistence:** an interaction never changes the underlying work status
  (poke a working bot → it reacts, still working).
- **Zero idle CPU:** event-driven transitions, rendering paused when hidden,
  no polling loops. Measure before claiming.
- **Stability contract:** /app & /os shells, layout, saved choices untouched;
  nothing removed or repositioned without a ceo-log stability note.
- **No new server routes or ports.** The character consumes existing feeds
  (turn-tail, FleetOrb presence, companion sidecar). Missing data = document
  the gap, don't invent a feed.
- **Ports:** owned fixtures, explicit free ports, isolated OMB_DATA_DIR,
  never 8845, never the user's live companion (8810/8811), production GET-only.

## Before editing

Read, in order: `docs/plans/current-state.md` →
`docs/guides/web-app-stability.md` → tail of `docs/plans/ceo-log.md` →
`AGENTS.md` → the plan doc above. `git status --short
--untracked-files=all` before staging; scoped pathless commits per slice;
never `git add -A`. Claim your slice's files from the plan's ownership map
and don't touch other slices' files.

## Verification gate (per slice, real numbers only)

```sh
npx tsc -b && npx tsc --noEmit -p tsconfig.server.json   # if server touched
npx oxlint .                                             # 0 warnings / 0 errors
npx vitest run src/lib/mascot <touched tests>            # focused first
npx vitest run                                           # full suite before "done"
npx playwright test                                      # UI slices; dist rebuilt via npm run build first
```

Record actual pass counts in the ceo-log entry. Honest failure reporting is
the house style: a red gate is reported as a red gate.

## API sketch (Slice A defines it; consumers bind to this)

```ts
import { resolveCharacter } from "@/lib/mascot/character";
// input: { status, face, override, morph, task } per the plan's contract.
// Tests must cover: coexistence, decay timers, calm + reduced-motion,
// unknown-state fallback, and every ordered status×override transition.
```

## Sources

- Case study: https://www.novra.design/case-studies/grokbot
- Engine study (concepts only): https://github.com/scrya-com/grokbot-animation
- Interaction lab (MIT): https://github.com/zhulin025/LaoA-GrokBot
- Face/motion vocabulary: https://github.com/hackyguru/botato
- Presentation reference: https://gawk.bot/
- Persona tinting (later): https://github.com/TencentCloud/Octop
- Appearance-follow rule: https://github.com/zhulin025/BuddyLiveGF
- Skill format followed: https://github.com/dbreunig/building-with-jev-skill
