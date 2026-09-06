# Muster in the AGI generation — the master plan

_Operator research synthesis, 2026-09-06. Sources: agno-agi/agno (Apache-2.0,
42k★), PrimeIntellect-ai/prime-agent (MIT, ~20k★, RLM harness),
usejarvis.dev, github.com/topics/zcode, the operator's own star history
(623★), plus the earlier docs: muster-win-plan.md,
task-harness-arc-patterns.md, muster-hi-new-agent-mail.md,
account-sync-portable-profile.md. The question: "in this AGI generation,
what do I build, what am I missing, and what would you do in my place?"_

## 0. The landscape read

Three facts define the moment:

1. **"Agent OS" is the crowded claim; governed autonomy is the empty seat.**
   The operator's own stars confirm it — a dozen starred projects are named
   or framed as agent operating systems (EverOS, ironclaw, ouroboros,
   AgentTeams, Auto-Company…). Jarvis sells "governed autonomy" as its
   whole pitch. Freebuff ships all five surfaces free. What nobody has:
   **persistent agents + governance + verifiable receipts + self-host, on
   every surface, for non-developers.** That intersection is Muster's
   seat — it must be taken fast and defended with receipts.
2. **The harness is the moat** (Schema: same model, 43% → 99% by process).
   Agno (42k★) and prime-agent (20k★) are both, at core, harness
   architectures. Muster already owns the hard parts — approvals, vaults,
   receipts — but hasn't productized the two patterns that make harnesses
   famously good: recursive decomposition and evidence-backed memory.
3. **Memory is becoming a user-owned substrate** (EverOS, Jarvis's Vault,
   hi.new's body-free audit). Users increasingly expect their agent's brain
   to be portable and inspectable. Muster's MEMORY.md/SOUL.md are already
   files; the missing piece is the portable bundle (designed in
   account-sync-portable-profile.md).

## 1. Adopt now (from today's research)

### 1.1 From agno — the two-tier automation split
**Routines = workflows (code-defined); Teams = model-directed.** Agno's
cleanest idea: don't make users pick one abstraction for both. Muster's
routines are already code-defined pipelines. The next step is explicit
**team modes**: `route` (Chief of Staff routes each request to a
specialist), `broadcast` (same task to every member — Muster's
everyone-answers), `tasks` (model decomposes a goal and loops a task list).
Rooms gain a `mode` field; route mode is the first build.

### 1.2 From agno — approvals as stored, queryable runtime state
Muster's approval cards are ephemeral UI. Agno persists approvals alongside
sessions/traces. Every approval decision (who allowed what, when, on which
bot) should land in the audit trail as queryable state — it's the exact
governance evidence enterprise buyers and the win plan's "governed" pillar
need.

### 1.3 From prime-agent — bounded autonomy with quality gates
Bounded autonomous mode with turn/token/time budgets plus user-defined
quality gates, and the honest caveat that "a passed gate checks only what
that gate verifies." Maps onto routines + the new scorecards: routines
already have budgets and scorecards; **sessions** (long-running autonomous
chats) need the same budgets + gates. This is the safest path to "agents
that run for hours" — the AGI-generation feature users actually want.

### 1.4 From prime-agent — immutable persona + evidence-backed memory
Bot SOUL.md is the immutable base; memory changes only via small,
evidence-backed updates with snapshots and rollback. Muster's memory is
already a file the bot edits — add a memory history (git-like snapshots per
run) and a review UI. Trust story: "your agent can't silently rewrite its
own personality."

### 1.5 From prime-agent — subagents as explicit async function calls
Bot-to-bot delegation where results arrive only through explicit
messages/files (never synchronous returns) is exactly Muster's room/comms
model — formalize it: delegation creates a task handle + a receipt trail,
depth-limited (already shipped), with the parent's approval policy
inherited.

## 2. Unique UI: what's built and what's next

**Built: FleetOrb** — the ambient presence glyph (Jarvis's pebble pattern in
musterbot identity): color IS the fleet state (clear idle / orange breathing
= working / amber pulsing = waiting on you / green flash = settled), badge
counts, click-through to the waiting thread, reduced-motion aware. Verified
live through real turns: idle → working → amber transitions.

**Next (ordered by differentiation):**
1. **Orb → approval surface**: amber click shows the pending approval card
   inline (approve/deny from the orb itself, like Jarvis) — governance at
   one glance from every surface.
2. **Voice Orbit**: the same glyph in voice mode — halo = listening,
   breathing = speaking, amber = permission asked; wake-word optional. The
   mascot + color language carries across web, desktop, mobile companions.
3. **Muster OS Rooms windows** with live member state (RoomsPanel exists —
   surface scorecards there).
4. **Mobile companions**: push approvals to the orb pattern on iOS/Android.

## 3. The AGI-generation gaps (ranked)

1. **Bounded autonomy for sessions** (1.3) — hours-long runs with gates.
2. **Team modes** (1.1) — route/broadcast/tasks in rooms.
3. **Memory history + rollback** (1.4) — persona drift control.
4. **Portable encrypted workspace** (account-sync doc) — memory as
   user-owned substrate.
5. **One serving core, many interfaces** (agno) — MCP serving of bots,
   WhatsApp/Telegram adapters on the same receipt pipeline.
6. **Distribution** (win plan §2) — signing, free-first-bot, stores.

## 4. The one-paragraph answer to "what would you do"

In the AGI generation, models commoditize weekly; what appreciates is
**process, memory, and trust**. I would stop thinking of Muster as "an app
with agents" and run it as "a governed harness company": every feature must
either extend autonomy (bounded, gated, scored — 1.3) or extend trust
(receipts, memory history, approvals-as-state — 1.2/1.4). Ship the two-tier
automation split before competitors notice rooms and routines are the same
idea. Let bots join open networks (hi.new shipped) so Muster is inside the
agent commons. And spend design effort only where Muster is already unique:
the mascot-state language (FleetOrb shipped), the approval card, and the
receipt. Everything else is table stakes that steals time from the seat
that wins: **governed autonomy for everyone.**
