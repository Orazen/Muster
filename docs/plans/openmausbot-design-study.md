# OpenMausBot desktop design study — what it means for Muster on macOS

Studied from the repo (github.com/milind-soni/OpenMausBot, v0.1.60; **re-checked
against v0.1.69 on 2026-09-09** — see the corrections section at the bottom) and
its `docs/screenshots/` set: `hero`, `computer-panel`, `approval-card`,
`model-picker`. Written 2026-09-07 to inform the Muster Mac desktop app.
Companion to the glass design system (f442d6d), which was built as the
deliberate counter-position to this app's surface language. The product-level
comparison (fleet MCP server, Grok Bot, OpenClaw) lives in
[competitive-landscape.md](competitive-landscape.md).

## What OpenMausBot actually looks like

**Surface language.** Flat, opaque, near-black (#0D–#1C range). No translucency,
no depth cues beyond 1px borders and slightly-lighter card fills. It reads as
"dark-mode chat app" — visually quiet, nothing moves except the mascots. Fast to
render, zero GPU compositing cost, zero risk of the backdrop-filter pitfalls we
documented in glass.css. The trade: every window looks like every other chat app;
nothing about the surface says "agents."

**Three-column shell.**
- Left sidebar (~280px, opaque #111): macOS traffic lights, a "+" add-bot button,
  a search field, then the **bot roster as a contacts list** — each row a colored
  cursor-mascot avatar (paper-plane arrow shape, per-bot hue: red/green/teal),
  name + last-message preview + timestamp. Bottom anchors: Automations, Plugins,
  then the user profile + settings gear.
- Center: transcript. Bot replies in large dark rounded cards (left), user
  messages in lighter gray bubbles (right). Tool runs surface as small pill
  chips with green checkmarks inline in the flow ("ToolSearch ✓"). Questions and
  approvals render as **inline cards with lettered options (A/B/C/D)** and an X
  dismiss — answering by letter or free text in the composer. Date separators.
  Composer is a full-width pill with "+" and mic.
- Right panel (the "Computer" panel, ~340px): header with gear + X; "Atlas's
  screen" label over a **live screenshot card**; "Open desktop" (takes over in
  the browser) and "Sleep" buttons; a "Runs on" card with a segmented control
  **Cloud box | This Mac | Off**; a "Routines" card with description + "Create
  Routine".

**Interactions worth stealing.**
- Right-click a bot → contact-style menu: pin, mark unread, edit profile,
  duplicate, copy conversation ID, hide, delete. Cheap to build, makes bots feel
  like manageabe entities rather than config rows.
- Model picker as a header chip that opens a provider rail (provider icons in a
  left gutter, defaults badged, unavailable providers dimmed **with the reason
  shown**).
- Tool-run activity chips in the transcript (not a separate log drawer).
- Onboarding as an in-chat question card ("What do you mostly want help with?"
  A–D + free text) — zero forms, the first approval card teaches the approval
  interaction.
- Bot screenshots/screens folded INTO the transcript as message attachments.
- Secrets write-only: settings show "configured" flags, never values.

**Their philosophy, verbatim-ish:** "One assistant in one box is the wrong shape
for agents." Bots as contacts, watch them work, approve what matters. This is
also Muster's thesis — the difference is the surface it plays on.

## Where Muster already differs (shipped)

- **Glass vs flat**: `.glass-panel/.glass-strip/.glass-well`, ambient wash driven
  by fleet state (FleetOrb), translucent shell fill with no backdrop-filter on
  shell surfaces (containing-block lesson). OpenMausBot has no equivalent; this
  is the visual identity wedge. Keep it.
- **Muster OS** (/os: dock, presence bar, ⌘K CommandBar) vs their plain sidebar —
  Muster already has a stronger "operating system for agents" frame.
- **Approval history strip on cards** (amber when last denied) — strictly more
  informative than their plain Allow/Deny cards.
- **Browser side panel** — per-bot embedded Chromium with screencast frames and
  address bar; theirs is a screenshot card + "Open desktop" hand-off to an
  external tab. Ours is the deeper primitive; the study below borrows their
  presentation of it.

## Adopt (concrete, cheap, high-value)

1. **Runs-on segmented control as a first-class card** ("Cloud box | This Mac |
   Off") next to the browser/computer panel. Muster has the machinery (local
   harness vs cloud) but exposes it less legibly.
2. **Lettered-option approval/question cards** (A/B/C/D keyboard answers + free
   text). Low cost, big UX win — Muster's OptionCards can gain letter hotkeys.
3. **Tool-run chips inline in the transcript** with pass/fail coloring rather
   than a separate activity drawer.
4. **Contact-style right-click menu on roster bots** (pin, duplicate, copy
   conversation id, hide). Note their "duplicate" — instant persona cloning is a
   feature Muster's persistent-persona model should do BETTER (clone with memory
   fork point).
5. **Dimmed-with-reason in pickers**: wherever Muster dims unavailable models/
   providers/instances, show the reason inline. Trust through honesty — fits the
   governed-agents positioning.
6. **Onboarding as in-chat question card** — Muster's onboarding-gate could
   present as the bot's first message rather than a modal.

## Avoid

- **Opaque flat shell.** Ceding the surface to "another dark chat app" erases the
  only free differentiator Muster has against a v0.1.60 incumbent with momentum.
- **External hand-off as the only escape hatch.** Their "Open desktop" leaves the
  app; Muster's embedded panel + takeControl should stay the primary path.
- **No memory surface in the main shell.** Their bots have transcripts only;
  Muster's MEMORY.md/SOUL.md are the moat — keep memory visible (why-journal,
  scorecards), don't hide it in settings.

## Net

OpenMausBot validates the category (bots-as-contacts, approvals, computer use)
and sets a floor, not a ceiling: its UI is competent-generic. Muster wins on
(glass identity + OS frame + memory/governance surfaces + deeper browser panel),
and should copy only the interaction micro-patterns listed above.

## Corrections after the v0.1.69 re-check (2026-09-09)

Full source re-study (all branches) found five facts above that were stale,
wrong, or already-shipped by Muster — recorded so nobody re-flags them:

1. **Lettered options already exist in Muster.** OptionCard renders A/B/C/D
   hotkeys today (src/components/OptionCard.tsx). "Adopt" item 2 was already
   done when written — the pattern was independent convergence, not a gap.
2. **Their MCP surface is bounded, and that part is right.** Earlier notes
   implied a sprawling tool surface; the code shows a deliberately small
   server. That legitimized the design of Muster's own fleet MCP server
   (server/fleet-mcp.ts) — bounded six-tool surface, no
   approvals/deletes/credentials, shipped 2026-09-09.
3. **Tool-run chips**: Muster's transcript already renders tool activity
   inline (message kind "tool" with ok/spoken fields) — item 3 was likewise
   already shipped, not a to-do.
4. **Routines**: OpenMausBot's "Create Routine" card mirrors Muster's
   RoutineManager (server/routines.ts, daily/weekly/once schedules + run-on
   semantics). Parity exists; the differentiator to push is Muster's
   why-journal + scorecards on top of routines (ARC pattern).
5. **Composio/tool-ecosystem**: Muster's connector/agents/dweb MCP proxies
   (server/mcp-client.ts and spawn sites) cover the "plugins" story
   OpenMausBot markets as Plugins; the gap was never tool access — it was
   exposing Muster ITSELF to external agents, closed by the fleet MCP server.

Version note: v0.1.60 → v0.1.69 changed nothing structural in the shell or
approval model; release cadence is fast but the surface described above held.
