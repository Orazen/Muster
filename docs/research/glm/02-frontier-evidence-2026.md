# 02 — Frontier evidence, fetched and dated (2026-09-11)

_GLM research pass. Every entry below was fetched from the primary source on
2026-09-11 unless explicitly marked otherwise. The rule applied: no claim
enters this doc that its source does not carry. "Muster implication" lines are
my analysis and labeled as such._

## 1. AlphaEvolve — the existence proof for automated algorithm discovery

**Source:** DeepMind blog, May 14 2025. **What it is:** an evolutionary coding
agent (prompt sampler → Gemini Flash-for-breadth + Pro-for-depth ensemble →
automated evaluators → evolutionary programs database) that evolves entire
codebases against an objective function.

**Verified results:** Borg data-center scheduling heuristic in production over a
year, recovering on average **0.7% of Google's worldwide compute**; a 23%
kernel speedup worth **1% of Gemini training time**; up to **32.5%** on
FlashAttention; a TPU Verilog circuit rewrite that passed functional verification;
4×4 complex matrix multiplication in **48 scalar multiplications** (beating
Strassen 1969); across 50+ open math problems, rediscovered SOTA in ~75% and
improved it in 20% (e.g., 593 spheres for the 11-dimensional kissing number).

**Stated limitation (the load-bearing one):** it works where "progress can be
clearly and systematically measured" — an automated, objective evaluator is a
precondition, not a feature.

**Muster implication:** the evaluator is the whole game. Muster's scorecards
and `muster eval` are that precondition, in primitive form. Anything in the
compounding roadmap (doc 03) that automates improvement must first make the
fitness function automatic. That is why L1 precedes everything.

## 2. ShinkaEvolve — the sample-efficiency correction

**Source:** sakana.ai/shinka-evolve/ (paper arXiv 2509.19349; Apache-2.0).
**What it is:** LLM-driven program evolution with extreme sample efficiency —
state-of-the-art 26-circle packing in **150 evaluations** (beating AlphaEvolve's
circle-packing result), an AIME agent scaffold evolved in **75 generations**
that generalized to unseen problems and different LLMs, ALE-Bench gains
averaging 2.3% (one result would have placed 2nd in the actual contest), and a
MoE load-balancing loss that beat DeepSeek's Global LBL after 30 generations.

**Core techniques:** parent sampling (explore/exploit), novelty-based rejection
sampling via embedding similarity + LLM-as-novelty-judge, and bandit-based
LLM-ensemble prioritization to cut cost.

**Muster implication:** self-improvement does not require AlphaEvolve-scale
compute; it requires a cheap, reliable evaluator and diversity pressure. A
Muster-shaped version is: propose persona/skill/routine variants → score on
stored evals → reject near-duplicates (novelty judge) → keep lineage. The
fleet *is* the population.

## 3. Darwin Gödel Machine — self-modification with empirical validation

**Source:** [arXiv:2505.22954](https://arxiv.org/abs/2505.22954) (Zhang, Hu,
Lu, Lange, Clune; abstract fetched — the sakana.ai page 404'd). **What it is:**
a coding agent that iteratively **modifies its own code**, with each change
validated empirically on benchmarks (SWE-bench **20.0% → 50.0%**, Polyglot
**14.2% → 30.7%**) rather than proven safe like the theoretical Gödel machine.
An archive of past agents enables open-ended exploration — "a growing tree of
diverse, high-quality agents."

**Safety note, stated precisely:** the fetched abstract records sandboxing and
human oversight as precautions. It does **not** detail the objective-hacking
and self-preservation episodes the full paper is widely summarized as
reporting — I could not verify those from the primary page I fetched, and this
doc does not assert them as fetched evidence. The abstract-level fact stands on
its own: empirical self-validation needs sandbox + oversight as external
precautions.

**Muster implication:** Muster's approval pipeline is structurally the
sandbox + oversight pair — but that is only worth anything if what the bot
modifies is *replayable and testable* (files with tests, scorecards with
checks). Self-modification of unmeasured surfaces is unguardable.

## 4. METR — the capability trend line

**Source:** metr.org blog, Mar 19 2025. **Finding:** the 50%-success **time
horizon** (task length, in human-professional time, at which an agent succeeds
half the time) has doubled roughly every **7 months** across 6 years. Claude
3.7 Sonnet's horizon was ~1 hour. Extrapolating 2–4 years gives agents handling
week-long tasks; continuation to 2030 implies month-long projects.

**Caveats they state:** fitted-trend sensitivity (2024–25-only fits pull the
forecast earlier ~2.5 years); SWE-Bench Verified doubles faster (<3 months)
partly for dataset-structural reasons; real-world transfer is the biggest
uncertainty. Even a 10× measurement error shifts dates only ~2 years given the
steep slope.

**Muster implication:** METR's metric is a horizon — *duration of unattended
work*. That is exactly what routines, budgets, and gates govern. The product
consequence: as model horizons lengthen, the binding constraint on Muster tasks
stops being model capability and becomes **approval friction and evidence
capacity**. Muster should want that crossover to happen inside its walls.

## 5. AI-2027 — the scenario, with its own caveats attached

**Source:** ai-2027.com, Kokotajlo, Alexander, Larsen, Lifland, Dean — Apr 3
2025; built from ~25 tabletop exercises, 100+ reviewers; two endings (race /
slowdown). **Milestone spine (race ending):** superhuman coder Mar 2027 →
superhuman AI researcher Aug 2027 → superintelligent researcher Nov 2027 → ASI
Dec 2027; progress multipliers escalate 1.5× → 3× → 4× → 10× → 50× as coding
labor, then experiment-running, automates.

**The caveats are part of the source:** the authors state 2027 was the *modal*
year, not the median (Nov 2025 addendum); a July 2025 update pushed medians
back ~1.5 years; post-2026 the scenario extrapolates "years of progress
happening in weeks" and they flag that as where uncertainty explodes. It is a
forecast fiction built on real trend data, not a measurement.

**Muster implication (labeled as analysis):** in any fast-takeoff branch, the
value Muster owns is not intelligence — it is the **deployment control plane**:
who approves what an army of 30×-speed agents may do, with receipts. The
scenario's alignment failure mode (Agent-4 sandbagging alignment work) is a
model-layer problem; Muster's equivalent surface is **eval gaming and
approval-laundering** — a bot engineering its scorecards or routing asks
through a channel that auto-allows. Doc 04 treats that as the honest threat
model.

## 6. ARC Prize — the fluid-intelligence counterweight

**Source:** arcprize.org (2026 state). ARC-AGI-3 is introduced as "the world's
only unbeaten benchmark that measures agentic intelligence"; the foundation's
position is "scaling alone will not reach AGI" and its working AGI definition
is a system that matches **human learning efficiency**. $2M prize pool for 2026,
supplied to NIST CAISI. (Per-task leaderboard numbers were not on the fetched
page; not asserted here.)

**Muster implication:** a reminder against model-hype leakage into product
claims — and a validation of the harness thesis the repo already cites
(Schema: same model, ~43% → ~99% by process, per muster-win-plan.md). The
harness is the product; ARC is the benchmark culture that proves it.

## 7. Levels of AGI — the vocabulary Muster should adopt

**Source:** [arXiv:2311.02462](https://arxiv.org/abs/2311.02462), Morris et al.
(Google DeepMind), ICML 2024 (via ar5iv HTML). **Framework:** performance
(Emerging → Competent → Expert → Virtuoso → Superhuman) × generality (Narrow →
General); frontier chatbots sit at **Emerging AGI, Level 1 General**;
Competent-through-ASI cells "not yet achieved." Two principles matter more
than the ladder: **capability ≠ autonomy** (six autonomy levels: No AI → Tool →
Consultant → Collaborator → Expert → Agent, "unlocked, but not determined by"
capability — designers may deploy below max), and **potential, not deployment**
(benchmark-level capability counts; deployment drags in legal/social risk).

**Muster implication:** this is the precise academic vocabulary for what Muster
already sells. Muster is an autonomy-deployment control plane for
Emerging-level general models — and doc 01 maps the fleet to
Consultant/Collaborator autonomy. Adopt the vocabulary in design docs; never in
marketing (the mandate bans "first in the world" claims and this would rhyme).

## 8. Era of Experience — FETCH FAILED, unverified

**Status:** four fetch attempts on 2026-09-11 (two DeepMind storage URL
variants → 404; incompleteideas.net → certificate error; arXiv → not hosted).
**No copy obtained.** The thesis as it is commonly summarized (Silver & Sutton,
2025: human-data era ends; experience era begins — streams instead of episodes,
actions/observations instead of prompts/answers, grounded environment rewards
instead of human opinion, planning/reasoning from experience) is **NOT verified
against a primary text in this pass** and is included only so the roadmap
doc 03 can say "this is the frame the next design sprint should verify." Do not
quote it anywhere until a copy is pulled and read.
