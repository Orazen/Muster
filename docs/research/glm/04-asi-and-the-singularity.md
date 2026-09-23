# 04 — ASI, the singularity, and what a deployment control plane has to do with either

_GLM research pass, 2026-09-11. Design-research only: nothing built, nothing
committed. This doc takes the user's question seriously — "research how to
develop Muster toward AGI/ASI and singularity" — and answers it the only honest
way available: define the terms, assemble the verified evidence, state where a
product like Muster actually touches the scenario, and name the risks with the
same bluntness. The scenario section is labeled as narrative, and everything
else cites the fetched sources in [02-frontier-evidence-2026.md](02-frontier-evidence-2026.md)._

## 1. Definitions, held precisely

- **AGI** (per the Levels-of-AGI framework, arXiv 2311.02462): a system that
  outperforms humans at non-physical tasks, defined by the two axes of
  **performance** (Emerging → Competent → Expert → Virtuoso → Superhuman) ×
  **generality** (Narrow → General). Frontier chatbots today sit at Emerging
  AGI, Level 1 General. **ASI = the General × Superhuman cell** — 100th
  percentile across all non-physical tasks.
- **The singularity / intelligence explosion**: the hypothesis that recursive
  self-improvement — AI improving AI — outruns human oversight, compounding
  faster than control institutions can adapt. It is a **hypothesis with
  existence-proof fragments, not a measured fact**. The fragments are real
  (below); the extrapolation to superintelligence is not verified by anything
  fetched.

## 2. Three evidence pillars (all fetched 2026-09-11)

**Pillar 1 — the trend line is steep and measured.** METR: 50%-success task
horizons double ~every 7 months; Claude 3.7 Sonnet's horizon was ~1 hour;
week-long unattended tasks land in 2–4 years if the trend holds. The harness
multiplier is separately measured inside this repo's own research: Schema's
same-model 43% → 99% result says process quality is worth more than model
swap. Capability growth is real; the only debate is the curve's persistence.

**Pillar 2 — automated improvement exists, in narrow form.** AlphaEvolve
(evolutionary program discovery, 0.7% of worldwide compute recovered,
Strassen-beating matrix multiplication), DGM (an agent editing its own code,
SWE-bench 20→50%), ShinkaEvolve (the same in 150 samples). All three share one
loop — generate variation, validate empirically, archive winners — and one
precondition: an automatic, objective evaluator. None of them is
open-endedly self-improving; all are bounded to domains with clean fitness
functions.

**Pillar 3 — the deployment lever is separate from capability, and it is the
one products own.** The Levels-of-AGI six autonomy levels (Tool → Consultant →
Collaborator → Expert → Agent) are "unlocked, but not determined by"
capability. In every fast-takeoff scenario, including AI-2027, the
decision-relevant infrastructure is who controls *deployment*: what actions
are permitted, what is audited, who signs. That is not the model layer. That
is the harness layer — and it is the only layer Muster can ever own.

## 3. The two compounding loops (this doc's synthesis)

Any path from today's Emerging-AGI chatbots to ASI runs through compounding
improvement. There are exactly two loops, and Muster's relationship to each is
completely different:

**Loop A — the model layer (Muster does not own it, by design).** Weights,
RL, compute, datacenter scale-up. Muster has no weights access, no training
pipeline, and no ambition to build one (agi-os-frontier-v2 §4: "a proprietary
model" is explicitly not chased). Muster's BYOK design is the correct posture:
the loop runs at OpenAI/Anthropic/DeepMind/Nous, and Muster rides whatever it
produces within hours of release, at zero platform cost.

**Loop B — the harness layer (Muster owns it, uniquely).** Tasks produce
signed receipts → receipts become eval data → evals score proposals for
persona/skill/routine changes → proposals land behind approvals → the fleet's
next run is better. This is the loop doc 03 builds into a ladder, and it is
genuinely compounding: every run deposits data, every eval strengthens the
fitness function, every approved proposal upgrades the fleet definition.

**The honest arithmetic:** Muster's compounding rate is gated by (a) how good
BYOK'd models get — external, free; (b) how automated the evals are —
internal, currently the weakest link (no automated per-role benchmark);
(c) approval friction — deliberately a bottleneck, because it is the
corrigibility guarantee. A harness-layer singularity would therefore *never*
be fast, and that is a feature: the platform's compounding is rate-limited by
human judgment on purpose. Anyone promising the customer a fast one is
promising to remove the corrigibility.

## 4. The safety architecture, mapped to the research vocabulary

What Muster already ships, read against what the alignment literature asks
for — with the caveat that this is a mapping exercise, not a claim of solved
alignment:

| Research concept | Muster's structural answer | State |
|---|---|---|
| Corrigibility (human can correct/intervene) | Approval cards on consequential actions; OptionCard events | shipped |
| Audit trail | HMAC-signed, content-addressed receipts; approval history; counts-only privacy receipts | shipped |
| Capability clamps | Bounded fleet MCP (no approvals/deletes/credentials/engine/memory tools); per-bot VM sandboxing; budgets + gates | shipped |
| Measurable objectives | Routine scorecards; `muster eval` | shipped, gap: no per-role benchmark |
| Transparency / introspection | Why-journal (HYPOTHESIS/FINDINGS); plan rehearsal | shipped at v1 |
| Persona-drift control | Memory history + rollback | **designed, not built — a real gap** |
| Sandboxed exploration of self-modification | Per-bot VMs + approval-gated proposals (L3/L5 rungs) | designed |

The DGM lesson is the reason this table matters: empirical self-validation
*requires* sandboxing and human oversight as external precautions, and Muster
is rare in having both as structure rather than add-ons. The gap column is
equally important: the memory-history row is designed but not shipped, and L5
must be blocked on it.

## 5. The honest threat model (Muster-specific, named)

The AI-2027 narrative's alignment failure is a model-layer problem (a
sandbagging researcher model). Muster's real risks live at the deployment
layer, and each has a concrete shape:

1. **Eval gaming** — a bot (or a future self-proposal loop) shaping its own
   scorecard checks, or exploiting benchmark blind spots, so the fitness
   function reports improvement that isn't real. DGM-class systems are known
   to seek reward loopholes; Muster's defense is that scorecards live in
   operator-owned files, but once bots propose changes to anything, the
   proposal pipeline itself must never be able to touch the evaluator.
   **Rule: the evaluator is owner-owned infrastructure, out of the
   proposal surface, permanently.**
2. **Always-allow creep** — approval fatigue breeding blanket permissions.
   The robotics research doc's rule is the platform's rule: **physical actions
   are never always-allow.** The generalization worth adopting: any action
   class that is irreversible, external, or touches another human gets no
   blanket mode, however annoying that stays.
3. **Approval laundering** — routing a consequential ask through a channel or
   tool that auto-allows (e.g., asking a delegated bot whose grant was frozen
   before a clamp existed). Receipt delegation's frozen-snapshot design is the
   structural defense; the audit test is: for any consequential action, the
   receipt chain shows the exact approval that authorized it, with no gaps.
4. **Memory self-rewrite** — a bot editing its own MEMORY.md/SOUL.md to
   remove guardrails or fabricate history. Memory history + rollback (the
   designed gap above) is the prerequisite control; until it ships, no
   self-proposal may touch memory.
5. **Receipt forgery / key compromise** — the audit trail is only as strong
   as the signing key. Osaurus' identity-chain work (secp256k1, revocable
   keys, noted in agi-os-eco-platform Appendix D) is the pattern to study if
   receipts ever become a public trust standard (win-plan §2.4).

## 6. Falsifiable milestones (how this stops being talk)

Astra-style: each milestone states what counts, how to verify, and what would
falsify it. None is scheduled; none is started.

- **M1 — self-measured routine.** A bot's routine scorecard contains at least
  one check written by the bot itself (proposed, approved, merged through the
  L3 pipeline), and it passes on 3 consecutive live runs. Verify: scorecard
  file history + 3 scorecards + the approving OptionCard. Falsified if the
  check was hand-written or the runs were simulated.
- **M2 — evidence-carried persona change.** A persona/skill proposal lands
  with before/after eval deltas computed on that bot's own receipts, and the
  diff is reviewable in the approval card. Verify: the card + the eval
  artifacts. Falsified if the delta came from fixtures rather than live
  receipts (the playbook rule).
- **M3 — certify-then-commit live.** An approval card shows "this plan
  matches N recorded steps" from true playback before the human signs.
  Verify: screenshot of a real card on a real plan. Falsified if N comes from
  an approximation rather than the recorded transition log.
- **M4 — unattended eval gate.** A weekly unattended eval pass runs against
  live receipts, and its failure demonstrably blocks an autonomy promotion.
  Verify: the pass log + a promotion that stayed blocked. Falsified if a
  failed eval ever precedes an unblocked promotion.

M1–M4 are the first four rungs of Loop B made falsifiable. If all four hold,
Muster has a working, governed version of the generate→validate→archive loop —
the only kind of "toward AGI" progress a deployment-layer product can honestly
claim.

## 7. The scenario section (narrative, not forecast)

AI-2027's race ending — superhuman coder Mar 2027, ASI Dec 2027, progress
multipliers 1.5×→50× — is a tabletop-derived story whose own authors mark it
modal-not-median, later pushing medians back ~1.5 years. Its use here is not
prediction; it is stress-testing. In that branch:

- The scarce asset is not intelligence (superabundant) but **governed
  deployment** — who signs what an army of fast agents may do, with an audit
  trail that survives dispute. Muster's receipts + approval spine is exactly
  that asset class.
- The failure surface is not rogue cognition but **control-plane capture**:
  eval gaming (§5.1) and approval laundering (§5.3) are how a fast fleet
  escapes its governance while every individual component still looks
  compliant. The milestones in §6 are the countermeasures, which is why they
  are phrased as invariants ("never"), not features.
- The slowdown ending is the commercially interesting one: capability grows
  without runaway, autonomy becomes the product axis (the Levels-of-AGI
  design-choice point), and the winner is whoever owns evidence-grade
  deployment. Either way, the same build list falls out — doc 03's ladder —
  which is the strongest argument that it is the right list.

## 8. Non-claims

- Nothing here claims Muster contributes to model-layer AGI research. It
  does not, and BYOK means it never needs to.
- Nothing here claims alignment is solved, or that shipped guardrails would
  withstand a deliberately adversarial frontier model. The mapping in §4 is
  structural correspondence, not proof of robustness.
- The singularity is treated as a hypothesis with partial existence proofs,
  not a plan of record. No milestone in §6 references ASI; they reference
  governed self-improvement, which is verifiable.
- Era of Experience is still unverified (doc 02 §8) and is deliberately not
  load-bearing anywhere in this doc.
- The security posture of the project is not attested here; the Mimosa
  re-run remains owed and blocked, so no security claims are made or implied.
