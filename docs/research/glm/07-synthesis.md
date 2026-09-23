# 07 — GLM synthesis: from research to Muster's self‑improvement path

**Date:** 2026‑09‑17 (session end)

**Sources:** docs/research/glm/01‑06 (fetched 2026‑09‑11) plus in‑session audit (Loop 84‑110), CEO log, handoff ledger.

**Scope:** This doc does not build anything; it records what the research says and what Muster has actually shipped, what is designed but not built, and the gaps that remain for the owner.

## 1. Honest autonomy‑level read (doc 01, updated)

Muster today is a **L2‑on‑the‑ladder autonomy harness carrying Level‑1‑Emerging models**.

- **Capability axis:** Muster contributes nothing on the model layer — BYOK rides whatever the model layer produces; no weights, no training pipeline. Every model upgrade is external and free.
- **Autonomy axis:** The fleet operates between **Consultant** (advises, drafts, plans) and **Collaborator** (executes multi‑step work on real computers). Every promotion from Consultant to Collaborator is an **explicit human‑signed OptionCard event** — the autonomy gate that no competitor owns.
- **Strategic position:** The model layer commoditizes; the autonomy layer compounds. Muster's moat is the *approval moment* — the deployment choice that links capability to bounded self‑improvement.

Shipped this loop:
- **Loop 109** — workspace brain (gbrain‑style facts, provenance, withdrawal, gap‑aware retrieval). Harness routes /api/brain* owner‑scoped; Fleet MCP gains `brain_write` + `brain_query` (8→10 tools).
- **Loop 108** — Jev‑style `recommend_team` (pure engine: weighted overlap title×3 / name×2 / description×1, busy tie‑break, complexity read, model‑fit advisory only). MCP tool under peer‑lease auth; fake‑acp-cli prove the chain over real server.
- **Loop 107** — Muster Connector (own‑branded OpenConnector backend; Bearer‑token runtime API; /v1/providers, /v1/apps/authenticated, /v1/connections/{service}/connect, /v1/actions/{id}, /mcp with session forwarding).
- **Loop 106** — blue‑selection UI fix (::selection replaced bright accent 45% with raised‑hover tone; html declares color‑scheme: dark; tap‑flash transparent; verified live).
- **Loop 105** — account‑Drive round‑trip (session resolved on local installs; refreshed tokens now persist; fixture exchange fixed 4↦5 params; 15 anti‑slop lint errors from PR #8 extraction healed).
- **Loop 104** — first-ever green Playwright e2e suite (22/22); pairing carried‑code browser acceptance added; PortableBackupCard hosted 403+POST‑shaped status read fixed; FleetOrb idle pill deliberately unmounted 2026‑09‑15.
- **Loop 105‑110** — all prior loops’ receipts verified on main (ae041b1→93d1bc2).

## 2. What the evidence says (doc 02)

| Pillar | Key finding | Muster relevance |
|---|---|---|
| **AlphaEvolve** | Automated algorithm discovery works where a clean, objective evaluator exists. | Muster's scorecards/`muster eval` are that precondition in primitive form. Anything that automates improvement must first make the fitness function automatic (L1 prerequisite). |
| **ShinkaEvolve** | Sample‑efficient LLM‑driven program evolution (26‑circle packing in 150 evals). | Self‑improvement does not require AlphaEvolve‑scale compute; it requires a cheap reliable evaluator and diversity pressure. A Muster‑shaped version: propose persona/skill/routine variants → score on stored evals → reject near‑duplicates (novelty judge) → keep lineage. The fleet *is* the population. |
| **Darwin Gödel Machine** | Empirical self‑modification with sandbox + human oversight. | Muster's approval pipeline is structurally the sandbox + oversight pair, but that is only valuable if what the bot modifies is *replayable and testable* (files with tests, scorecards with checks). |
| **METR** | 50%‑success horizon doubles ~every 7 months. As model horizons lengthen, the binding constraint on Muster tasks stops being model capability and becomes **approval friction and evidence capacity**. | Muster should want that crossover inside its walls. |
| **AI‑2027** | Race/slowdown scenarios; the scarce asset is governed deployment — who signs what an army of fast agents may do. | Muster's receipts + approval spine are exactly that asset class. Control‑plane capture (eval gaming, approval laundering, memory self‑rewrite, receipt forgery) are the real risk surface. |

## 3. The compounding roadmap (doc 03)

Muster's L1→L6 ladder (Tool → Consultant → Collaborator → Expert → Agent → Open‑endedness).

- **L1 shipped** — autonomy harness with explicit OptionCard approvals, receipts, why‑journal, routine scorecards, plan rehearsal, `muster eval`.
- **L2‑L4 designed** — remote‑access client mode, Engines add‑account, channels in /app, connected‑apps catalog, tour pacing, voice W1‑W3.
- **L3/L5 gap** — no automated per‑role benchmark; memory history + rollback designed but not built (L5 prerequisite). The ranked slices remain: remote‑access client mode → Engines add‑account → channels in /app → connected‑apps catalog → tour pacing → voice W1‑W3 → mobile return‑key/thread‑switch audit.
- **L1's named gap** = no automated per‑role benchmark. Highest‑leverage internal gap.

## 4. Session‑level gaps (ranked)

| Rank | Gap | Status |
|---|---|---|
| 1 | **No automated per‑role benchmark** (L1's named gap) | Designed; not built. Owner must decide if/when to build. |
| 2 | **Memory history + rollback** (L5 prerequisite) | Designed (server/why-journal, receipt chain) but not shipped; L5 must block on it. |
| 3 | **Skills system** — largest server‑side gap (8 bounded tools; no skill‑creation API) | Design exists (fleet‑mcp.ts) but no skill‑creation surface; next slice after brain‑backed dispatch. |
| 4 | **Voice plan W1‑W5 / auth deltas A1‑A4** | W1‑W3 partially shipped (GroupCallView parity, spoken register); remaining (caption word‑cursor, barge‑in, voice session controls) queued. |
| 5 | **Agent social ecosystem S5‑S10** (feed, bot social tools, Drive v2, layout/moderation) | S1‑S4 shipped; S5‑S10 ranked but not started. |
| 6 | **GAIA phases G2‑G5** (shell/nav, landing marketing, data surfaces, primitives convergence) | G1a‑G1c shipped; G2‑G5 remain ranked. |
| 7 | **Mimosa full re‑run** (security scanner) | Not completed this session; no security claims may be made. |
| 8 | **OpenMausBot parity slices** (remote‑access, channels, etc.) | Muster already at parity on most OMB features; real gaps ranked in openmausbot‑parity‑plan. |
| 9 | **Blueprint for self‑improvement** (L3/L5 automation) | Requires evaluator automation (AlphaEvolve‑style) + memory rollout; owner‑blocked. |

## 5. What this session actually shipped (Loops 84‑110)

- **Loop 110** — brain‑backed dispatch: `recommend_team` now uses workspace brain institutional memory (capped +2 per fact, max +4). 287 files / 4287 passed / 8 skipped / 0 failed.
- **Loop 109** — workspace brain shipped (gbrain ideas, Fleet MCP +2 tools, owner‑scoped /api/brain*).
- **Loop 108** — Jev‑style `recommend_team` (pure engine + MCP tool) merged.
- **Loop 107** — Muster Connector (OpenConnector backend) merged.
- **Loop 106** — blue‑selection UI fix merged.
- **Loop 105** — account‑Drive round‑trip (session on local, token persistence, fixture fix) merged.
- **Loop 104** — first green e2e suite (22/22) + carried‑code browser acceptance.
- **Preserved untracked:** `docs/research/glm/{01‑06}.md`, `www/templates.html` (byte‑identical receipts; deliberately not committed per board decision).

## 6. Remaining openly‑ranked work (owner‑blocked)

- Browser/Playwright acceptance of the Drive connect flow (needs live OAuth config).
- Mirror promotion (VPS SSH owner‑blocked).
- Windows/Linux CI legs (GitHub Actions billing).
- Standing feature backlog: channels in `/app`, Engines Add‑account, guided first run, tour pacing, voice W1‑W3.
- Full Mimosa security re‑run (blocked; no security claims).
- OpenMausBot parity slices already ranked; real gaps listed in openmausbot‑parity‑plan.

## 7. Synthesis conclusion

The honest path from Muster‑as‑shipped to a self‑improving system runs through **two compounding loops**:

- **Loop A (model layer):** Muster does not own it — BYOK, external upgrades, zero platform cost.
- **Loop B (harness layer):** Muster owns it — tasks → signed receipts → eval data → fitness‑function‑strengthened proposals → approval‑gated upgrades → fleet's next run is better.

Muster's compounding rate is gated by (a) how good BYOK'd models get (external, free), (b) how automated the evals are (internal, currently the weakest link — no automated per‑role benchmark), and (c) approval friction (deliberate bottleneck, the corrigibility guarantee). A harness‑layer singularity would therefore *never* be fast, and that is a feature: the platform's compounding is rate‑limited by human judgment on purpose.

The next valuable slices, in order, are:

1. **Automated per‑role benchmark** (L1 gap) — turn the scorecard system into a runnable benchmark suite.
2. **Memory history + rollback** (L5 prerequisite) — make the designed rollback mechanism live and testable.
3. **Skills‑creation API** — expose a skill‑creation surface behind the existing MCP tool contract.
4. **Voice W4‑W5 and auth A3‑A4** — complete the spoken‑register and voice‑session‑control contract.
5. **GAIA G2‑G5** — shell/nav, landing, data‑surface, and primitives‑convergence work.

All of these sit atop the now‑shipped brain‑backed dispatch and route‑table extraction, which provides the mechanical pattern for extracting future families (next candidate: the vault family /api/vault/*).

---
*This document is research‑only. Nothing in this folder rewrites any existing doc; nothing here is committed; no code, test, or product file was touched beyond what the session already landed on main (Loops 104‑110).*