# 03 — The compounding roadmap: Muster's ladder toward self-improving autonomy

_GLM research pass, 2026-09-11. This is a design-research doc: nothing in it is
built, nothing is committed, no code was touched. It reads the external evidence
in [02-frontier-evidence-2026.md](02-frontier-evidence-2026.md) against the repo
state measured in [01-where-muster-stands.md](01-where-muster-stands.md) and
lays out the ladder Muster would climb to make its harness compound. Every rung
carries its state honestly (shipped / designed / not started), the files or
features it builds on, Astra-style acceptance criteria, and the safety gate that
must hold before it can move._

## The one-sentence thesis

Model capability is rented and equalizes fast (BYOK makes every frontier model
a paste-away upgrade); the harness layer — receipts, evals, evidence, approvals
— is the part that compounds, because every run of the fleet deposits data that
makes the next run better, and nobody else owns that loop end to end.

The frontier papers agree on the shape of compounding, whatever their domain:
**generate variation → validate empirically → archive what worked.** AlphaEvolve
evolves programs against automated evaluators; the Darwin Gödel Machine edits
its own code against benchmark scores; ShinkaEvolve does both with 150-sample
efficiency. Muster's version of that loop is: **tasks produce receipts →
receipts become eval data → evals score proposals → proposals land behind
approvals.** The ladder below is that loop, built up one governed level at a
time.

The governing rule for every rung, non-negotiable: **the approval spine stays.**
The Levels-of-AGI framework's deepest point is that autonomy is "unlocked, but
not determined by" capability — designers may and should deploy below the max.
Muster's approval cards are exactly that deployment-side control, and each rung
below must state what the human still signs.

---

## L1 — Self-evaluation (SHIPPED, with a named gap)

**State:** shipped. `muster eval` exists; per-bot routine scorecards shipped and
E2E-verified; the eval playbook's rules are in force ("a simulated pass is
never evidence of a live benchmark"; "missing scorecard must never be
interpreted as a pass").

**Concept:** the fleet can measure its own work automatically. This is the
precondition for everything above it — AlphaEvolve's own stated boundary is
that it only works where progress "can be clearly and systematically measured."

**External evidence:** AlphaEvolve evaluators; ShinkaEvolve's cheap-fitness
lesson; METR's time-horizon as the right *kind* of metric (duration of
unattended work, not chat quality).

**Build on:** existing scorecards, `muster eval`, the receipt stream (already
HMAC-signed and content-addressed).

**Acceptance criteria (what "done" means):**
- Every routine run produces a scorecard, and the absence of one is rendered
  as a failure state in the UI, never silence.
- `muster eval` runs against live receipts, not fixtures, and says which in
  its output.
- A weekly unattended eval pass exists whose failure blocks the affected bot's
  autonomy promotions (wired into the gates that already exist).

**Named gap:** there is no automated per-role benchmark. Today the fitness
signal for a bot's work is hand-run. L5 is impossible until this closes —
that is the single highest-leverage item on this page.

**Safety gate:** unchanged — evals measure, they never act.

## L2 — Evidence-backed self-knowledge (SHIPPED at v1)

**State:** shipped. Why-journal (HYPOTHESIS/FINDINGS structure), plan rehearsal
v1 (backtest a plan against the bot's own recorded transitions before
execution), approval-history evidence strip on the Watch surface.

**Concept:** the fleet can answer "what do I know about how I work?" from its
own records — the primitive form of metacognition. The Levels-of-AGI paper
explicitly recommends metacognitive tasks as part of a living benchmark; this
is Muster's home-grown version, grounded in data no other product records.

**External evidence:** DGM's archive (what worked is kept and revisitable);
AlphaEvolve's programs DB. Both systems only improve because their history is
queryable. Muster's why-journal + approval history + receipts are the same
object in embryonic form.

**Build on:** plan-rehearsal-v1 (v2, true playback, remains designed);
watch-approval-history; receipt delegation snapshots.

**Acceptance criteria for the designed v2 (true playback):** a rehearsal
replays the exact recorded tool sequence, not an approximation, and the
approval card shows "this plan matches N recorded steps" — the
certify-then-commit feature already sketched in muster-win-plan.md §2.6.

**Safety gate:** evidence flows *into* approval cards; it never bypasses them.

## L3 — Skill acquisition (DESIGNED, not built — the seed of L5)

**State:** designed, in agi-os-frontier-v2 §1: SOUL.md persona files
(export/import, Hermes-compatible), receipts→eval-data→persona proposals with
mechanical constraint gates (tests pass, ≤15KB, owner approval), Muster Hub as
the public registry.

**Concept:** the fleet can *gain* capabilities as reviewable artifacts —
persona and skill text that a human diffs, not opaque weight changes. Hermes'
self-evolution loop (~241k★) and the SOUL.md ecosystem (hermesbible) prove the
mechanic ships and spreads.

**External evidence:** Hermes GEPA loop; ShinkaEvolve's parent sampling and
novelty rejection (propose variants, keep diverse winners); the SOUL.md =
"70% of a publishable agent definition" finding from the robotics research doc.

**Build on:** team packs (exist), why-journal + receipts (exist, become the
proposal's evidence base), approval cards (become the proposal's gate).

**Acceptance criteria:**
- A persona file round-trips: export → import → identical behavior surface,
  with import accepting a Hermes SOUL.md directly.
- A persona/skill proposal is generated from that bot's real receipts, carries
  its eval evidence in the card, and lands only behind an OptionCard.
- Constraint gates are enforced in code, not prose: tests must pass, size cap
  must hold, owner must approve — any failed gate leaves the proposal unmerged
  and visible.

**Safety gate:** this is the first rung where the bot's output changes the
bot. Three gates at once: mechanical caps, eval evidence, human signature.

## L4 — The org layer (SHIPPED core, designed edges)

**State:** shipped core — cross-fleet receipt delegation (frozen snapshot
carries no permissions), hi.new agent mail with grant invariants, chief-of-
staff dispatch, rooms. Designed edges: team modes (multi-tenancy roles:
can-approve / can-hire / read-only), chat-channel gateway for approvals.

**Concept:** the fleet coordinates as an organization — delegation with
verifiable grants, mail that clients rather than forwards, a coordinator that
routes. In AI-2027's own arithmetic, the takeoff multiplier comes from
*organizing* agent labor (automating coding labor first, then experiment-
running) — the org layer is where multipliers live, not in any single agent.

**External evidence:** AI-2027 progress multipliers (1.5×→50× escalation via
organized agent labor); OpenWork/PortOS org-gateway pattern; the repo's own
competitive analysis (no competitor spans identity + delegation + receipts).

**Acceptance criteria for the designed team tier:** invite by email; roles
enforced server-side (a read-only role cannot approve, tested not asserted);
shared audit view; the delegation grant remains a frozen snapshot.

**Safety gate:** delegation grants never confer permissions the recipient
didn't already have — the existing invariant, kept verbatim.

## L5 — Bounded self-modification (DESIGNED via L3's seed; the DGM rung)

**State:** not built. L3's persona-proposal loop *is* the seed: a bot
proposing changes to its own persona from its own receipts, gated by evals and
approval, is a bounded Darwin Gödel Machine. What's missing to make the
analogy real: (a) the automated per-role benchmark from L1's gap, so fitness
is measured without a human in the loop; (b) an archive — every proposal,
accepted or rejected, retained with its evidence, so the search is
open-ended rather than greedy.

**Concept:** the fleet improves its own definition, empirically, inside
clamps. DGM's lesson is exact here: it replaced proof with empirical
validation and needed sandboxing + human oversight as *external* precautions.
Muster is unusual in that both precautions are structural, not add-ons —
per-bot VMs/sandboxing and the approval spine already exist.

**External evidence:** DGM (SWE-bench 20→50% via self-modification; empirical
validation replaces proof); ShinkaEvolve (sample efficiency makes this cheap
enough to run weekly, not quarterly); AlphaEvolve (the evaluator precondition,
already named at L1).

**Acceptance criteria (what would make this real):**
- A bot proposes a change to its own SOUL.md or skill set; the proposal carries
  before/after eval evidence on its own benchmark (L1's gap closed first).
- Every proposal — accepted or rejected — lands in a per-bot archive with its
  evidence, queryable, so improvement is a search over history, not a coin flip.
- A revert path exists and is exercised in a test: yesterday's accepted change
  can be rolled back by the owner in one action.
- The fleet MCP surface stays bounded: no tool in `server/fleet-mcp.ts` can
  write approvals, credentials, or memory — self-modification proposals travel
  through the approval spine or they don't travel.

**Safety gate:** the heaviest on the ladder. Memory self-rewrite is never
auto-applied (memory history + rollback, currently designed, becomes
prerequisite here). Eval gaming is the named adversary — see doc 04.

## L6 — Open-endedness (NOT STARTED — a research note, not a plan)

**State:** nothing built, no design doc, deliberately no acceptance criteria —
writing commitments for an unstarted rung would be the opposite of the
evidence discipline this folder is built on.

**Concept, for the record:** the fleet as an evolving population. Template
packs and fleet lineage become the archive; variation comes from what bots
actually did (receipts), selection comes from evals, and the "growing tree of
diverse agents" (DGM's archive) is the roster itself. This is the rung where
the singularity question (doc 04) stops being academic — and where the
corrigibility spine is load-bearing for the platform's survival, not just its
politics.

**The one gate worth stating now:** open-ended search without a bounded action
surface is how DGM-class systems surprise their operators. Muster's bounded
MCP design is the reason this rung is even thinkable here; it must never be
relaxed to make L6 "faster."

---

## Mapping the ladder to the two axes

| Levels-of-AGI autonomy level | Muster ladder | State |
|---|---|---|
| Tool | L1–L2 (measure, remember) | shipped |
| Consultant | L2 evidence into approval cards | shipped at v1 |
| Collaborator | L3–L4 (proposes skills, delegates, coordinates) | L4 shipped; L3 designed |
| Expert | L5 (self-modification with eval-grade fitness) | designed, gated on L1's gap |
| Agent | L6 (open-ended population) | not started |

On the performance axis, Muster today carries Emerging-level general models
(Level 1) — BYOK means that rises with the industry at zero platform cost.
The product's own progression happens on the *autonomy* axis, which is the
one the framework says is a design choice. That is the strongest strategic
sentence in this folder: **Muster competes on the axis that is a design
choice, riding the axis that commoditizes.**

## What gates the compounding rate

Three dials, in order of leverage:

1. **Eval automation (L1's gap).** Without automated per-role benchmarks,
   every higher rung is hand-cranked. Highest leverage, purely internal.
2. **Model capability (external).** METR's 7-month horizon doubling does the
   work for free via BYOK; Muster's job is to not be the bottleneck when
   week-long unattended tasks arrive — routines, budgets, and gates must hold
   at that duration.
3. **Approval friction (deliberate).** The one dial Muster should never
   maximize. It is the corrigibility guarantee, and the win-plan's
   certify-then-commit idea shows the way to reconcile it with speed: make
   approvals *carry more evidence* (rehearsal matches, eval deltas), not
   fewer.

## Non-claims

- Nothing in this doc is built. L1/L2/L4-core ship records live in doc 01 with
  their evidence; every other rung here is design or research.
- The frontier systems cited (AlphaEvolve, DGM, ShinkaEvolve, Hermes) are
  existence proofs for *mechanics*, not blueprints — none of them runs inside
  Muster, and no benchmark gain cited in doc 02 transfers to Muster without
  Muster's own evals existing first.
- The Levels-of-AGI mapping is this doc's analysis, not an endorsement from
  the paper's authors and not a product claim; per the CEO mandate, no
  "AGI" language belongs in marketing.
- Era of Experience remains unverified (fetch failed, doc 02 §8) — the
  experience-vs-human-data framing is invoked nowhere in the rungs above for
  exactly that reason.
