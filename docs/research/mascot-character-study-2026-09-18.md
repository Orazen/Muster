# Mascot character system — reference study (18 September 2026)

Owner request: make Muster's mascot a real character in the GrokBot mold —
reactive, interruptible, multi-surface — and study the supplied references
first. This file records what each source actually is (grounded in its README
or live page), what Muster should adopt, and what it must leave. The execution
plan is `docs/plans/mascot-character-system-plan-2026-09-18.md`; this study is
its evidence base. Every claim below is about the referenced project, not about
Muster, and nothing here is a security or deployment claim.

## The primary reference: Novra's GrokBot character system

[novra.design/case-studies/grokbot](https://www.novra.design/case-studies/grokbot)
documents an independent concept: Grok's bot mascot (character and motion by
Benji Taylor) extended across **Mac notch, iPhone widget, Lock Screen Live
Activity, and the app itself**. Readings that matter for Muster:

- **"A working state is easy. A character that can mess around while it's
  working is a little harder."** The breakthrough is not the states; it is
  that interaction and work coexist without confusing what the agent is
  actually doing. Novra mapped the coexistence logic in Figma, then built it
  as a Rive state machine.
- **The state list the owner quoted** — Follow, Annoyed, Slap, Dizzy, Upload,
  Error, Finished, Working — splits cleanly into two kinds: interaction
  states (Follow, Annoyed, Slap, Dizzy — caused by the user) and work states
  (Upload, Error, Finished, Working — caused by the agent).
- **"One bot in focus. The rest in sight."** With several agents running, the
  useful question is not what one bot is doing but *which one needs you*: the
  active bot gets room for state + current task; the rest collapse to a face
  and their current line. State stays readable even when the interface
  collapses.
- **Motion exposed gaps that static layouts hid** — how focus shifts between
  bots, how states change, what can disappear without losing clarity.
- Even the app icon carries state (not as a badge).

## Owner decisions (recorded 18 September 2026)

Four questions were asked; the owner chose:

1. **Upgrade the Flower** — build the character engine on Muster's existing
   orange Flower identity (`src/lib/musterbot/*`), not a ported or new
   character.
2. **All four surfaces in v1** — web app, Electron desktop (tray/notch),
   iOS (Live Activity/widget), Watch.
3. **Full playful with an off switch** — cursor follow, poke/slap → dizzy,
   annoyed-after-repeats, idle antics, plus a calm-mascot setting and
   reduced-motion respect.
4. **Two-layer state model** — a small status layer drives body motion and
   morphs; the existing expression poses layer on top as the face; interaction
   states temporarily override the face.

## Source-by-source: what it is, adopt, leave

### scrya-com/grokbot-animation ("Morph Bot")

**What it is:** an unofficial 2D SVG animation study of the public Grok Bot
front-end snapshot: 39 states, 18 body shapes, 21 material presets, 25
two-eye expression rings, 14 one-shot "Morph" task effects with a full
RESET → ENTER → HOLD → EXIT → DONE lifecycle, a timeline editor, and a
framework-free `<morph-bot>` Web Component with Shadow DOM. Regression suite:
1,521 ordered state transitions, 1,800 shape/expression/eye combinations,
morph entry/exit and eye-restoration checks. There is also a Flutter port.

**Adopt (concepts and contracts, not assets):**
- The **state/shape/material separation** as an API discipline: a state
  controls expression pools, cadence, blinking, pose, motion and default morph
  behavior; a shape changes the outline without changing meaning; a material
  repaints the same geometry. Muster's two-layer model is exactly this.
- The **one-shot morph lifecycle** (RESET → ENTER → HOLD → EXIT → DONE) for
  task moments (send, upload, error bounce), and repeated-cycle states
  (progress/spawn) with a rest interval.
- The **regression-test philosophy**: assert every ordered transition and
  every combination so the character can be refactored without fear. Muster
  already does a miniature version (`flower.test.ts` requires every pose to
  differ from idle on ≥3 channels).
- **Shadow-DOM-like isolation** and visibility pausing (pause the simulation
  when the element is off-screen) — cost discipline Muster's engine should
  copy.
- Their **warning is itself data**: the geometry is derived from a public xAI
  snapshot and the project grants **no license** for reference-derived assets
  — replacement or original assets are required before commercial use.

**Leave:** the actual geometry, state data files, and any runtime code from
the repo — Muster's character must be original Flower geometry. Copying
GrokBot's look would also be a brand and legal mistake.

### zhulin025/LaoA-GrokBot (+ its live lab grokbot.liuwa.xyz)

**What it is:** MIT-licensed customizable GrokBot expression lab: 10 colors,
8 shapes, 25 expressions, 39 states, body parts, accessories, 6 "jelly" quick
actions, share-card PNG generation, share-to-X prefill. The live site proves
the interaction grammar: drag on the bot's area to control gaze; state and
expression are separately pickable; quick actions are one-shot.

**Adopt:** the **gaze-follows-pointer** interaction (the case study's "Move
your cursor around. It'll follow you."), the separate expression/state pickers
as a settings surface, and the share-card idea as a cheap delight feature
(1080×1440 PNG of your bot's current state) for a later slice. The MIT
license permits code study.

**Leave:** the GrokBot-branded geometry and accessories.

### hackyguru/botato

**What it is:** local-first Tauri desktop app: bots with memory, schedules,
rooms, phones paired over QUIC. For this study the load-bearing part is the
**face system**: every bot gets a procedural face (head, eyes, brows, resting
smile, mark) with **7,776 combinations derived from the bot's own id** so no
two bots look alike, and a motion vocabulary: **blinks, thinks with a cloud
overhead, jumps when a turn lands, slumps when one fails**.

**Adopt:** **id-derived visual identity** (Muster already assigns bot colors;
deriving a stable per-bot character seed from the bot id is the same idea),
and the four motion verbs (blink always; think-cloud while streaming; jump on
land; slump on fail) — cheap, readable, and they map 1:1 onto the two-layer
model's status layer.

**Leave:** everything else (out of scope for the character system).

### gawk.bot

**What it is:** an open-source Grok Bot competitor whose site is worth
studying for presentation: named worker bots (filer, triager, chaser…) with
one-line narrated outcomes, and a strong "trust your bots with less over
time" permissions posture.

**Adopt:** the **narrated one-liner under the collapsed bot** — "the face
gets your attention, the line underneath tells you what changed" (Novra's
Lock Screen rule, visible in gawk's worker cards too). Status text always
accompanies state motion.

**Leave:** licensing mimicry and their product scope.

### TencentCloud/Octop

**What it is:** self-hosted multi-user assistant (FastAPI + React) with MBTI
persona templates, an expert library, IM channels, ACP, terminal/browser AI.
Relevant idea only: **16 MBTI persona templates** as a persona vocabulary.

**Adopt (later slice):** persona-expression tinting — a bot's persona biases
which idle expressions its flower picks. Not a v1 requirement.

**Leave:** the rest — Muster's harness architecture is already its own.

### zhulin025/BuddyLiveGF

**What it is:** a closed-source "living character skin" controller for
WorkBuddy on macOS: two dynamic character themes that follow light/dark
appearance, corner and immersive layouts, no app-bundle modification,
loopback-only connection. Distributed as releases only, ad-hoc signed.

**Adopt:** two structural rules — **follow the app's appearance setting
automatically** (dark/light variants must be automatic, not chosen twice), and
**do not modify the host app bundle** (Muster's desktop skin must be its own
surface, e.g. the tray/notch window, never a patched Electron resource).

**Leave:** the girlfriend-skin framing; Muster's character is the Flower.

### x.com/ab_workss status 2100662110107664574 (John Bai's notch bot)

Referenced by the Novra case study as the origin: John Bai put the Grok bot
in the Mac notch. Muster's equivalent slot is the **Electron tray window**.
That is the desktop v1 surface.

### trycua/cua

Computer-use agent framework (VMs, macOS/Linux/Windows sandbox VMs, native
OS automation). Studied at README level: no character/animation surface to
adopt. Its value to Muster is the earlier computer-panel work, not this plan.

### anywhere-labs/Agents-Anywhere and zhulin025/Agents-Anywhere

Agent runtime projects. No character surface to adopt. Read at README level.

### raihankhan-rk/friends-pay, jevarena, diffjury

Small app projects (payments between friends; agent arena; diff-judging).
No character surface to adopt. They sit in the owner's ecosystem reading
list, not in this plan's dependency graph.

### Marcus-Mok-GH/nova-cloud-computer, jkudish/jev-browser, hamedgitty/bloks

Cloud-computer / browser / bloks-style builders. No character surface to
adopt. The "build you a microapp to manage the outcome" pattern (gawk, bloks)
is already tracked elsewhere in the roadmap.

### milind-soni/OpenMausBot

The existing parity target with its own mascot (orange flower-like) and
7-step onboarding; Muster's parity plan already tracks surfaces. For this
system: **do not copy OpenMausBot's mascot**; keep the canonical Muster
Flower. The parity plan's mascot gap is exactly what this system closes.

### browser-use/jev-ultrafast and dbreunig/building-with-jev-skill

jev-ultrafast is a fast browser-use style agent; the jev-skill repo is an
agent-skill example (SKILL.md + install instructions). No animation surface.
The **skill format** is adopted for this work: `skills/mascot/SKILL.md`
follows the same shape (what it is, install/use, sources) so any agent can
load the conventions quickly.

### x.ai/bot, x.com/grok, x.com/bot, treg.to, superdesigndev repos

Competitor/context references. Two rules are extracted: **study grammar, not
pixels** (never copy GrokBot's geometry, names, or motion data — the Morph Bot
license warning applies to Muster too), and **state must remain truthful**
(Muster's existing contract: expressions never substitute for approval,
uncertainty, or completion text).

## Synthesis: the system Muster is building

The references converge on one architecture, which the owner has chosen:

- **Two layers.** A small status layer (working, thinking, uploading,
  finished, error, idle) drives body motion, particles and one-shot morphs.
  The 15 existing expression poses (happy, mad, thinking, focused…) remain
  the face. Interaction states (following, annoyed, slap, dizzy) temporarily
  override the face and decay automatically.
- **State coexistence logic** (the Novra/Figma step): an interaction never
  destroys the work state — poke a working bot and it reacts *while staying
  working*, then returns. Status text always accompanies state motion.
- **One character, four surfaces, per-surface vocabulary.** Web: full
  interaction. Desktop tray/notch: full states, click-to-focus. iOS Live
  Activity/widget: face + current line. Watch: aggregate state, haptics.
- **Truthfulness and stability first:** no animation replaces approval text;
  reduced-motion and a calm mode exist; the mascot's idle CPU stays ~zero via
  event-driven, visibility-paused rendering; port 8845 and the stability
  contract are untouched.

## Licensing note (load-bearing)

Morph Bot explicitly grants **no license** for its xAI-derived reference
assets and requires replacement or permission before commercial use. Muster's
character system therefore adopts **concepts and contracts only** — original
Flower geometry, original motion data, original names. The canonical Flower
(`MusterMascot.tsx` / `muster-mascot.css` / `flower.ts`) is already Muster's
own authored asset (Loop 14), and all new motion layers extend it.
