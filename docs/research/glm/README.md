# GLM research pass — Muster toward AGI/ASI

_Author: GLM 5.3 Flash (research-only pass). Date: 2026-09-11. Board directive:
do not build anything; study the frontier, study Astra's docs, and write my own
research. Nothing in this folder rewrites any existing doc; nothing here is
committed; no code, test, or product file was touched._

## What this folder is

Six documents that answer one question with sources: **what is the honest
path from Muster-as-shipped to a system that improves itself, and where does
that path sit relative to the AGI/ASI frontier?**

| Doc | Question it answers |
|---|---|
| [01-where-muster-stands.md](01-where-muster-stands.md) | What autonomy level is Muster actually at, file by file? |
| [02-frontier-evidence-2026.md](02-frontier-evidence-2026.md) | What does the 2025–2026 evidence actually say (fetched, dated)? |
| [03-the-compounding-roadmap.md](03-the-compounding-roadmap.md) | The Muster ladder L1→L6, each level grounded in files that exist |
| [04-asi-and-the-singularity.md](04-asi-and-the-singularity.md) | Takeoff theory, Muster's position in it, safety mapping, falsifiable milestones |
| [05-hermes-testflight-reference.md](05-hermes-testflight-reference.md) | The TestFlight invitation the board asked me to check out |
| [07-synthesis.md](07-synthesis.md) | 2026‑09‑17 session synthesis: research → what shipped, what is designed, what remains ranked |

## Method (Astra's rules, applied to research)

- Every external claim carries its fetch date and URL. Where a fetch failed,
  the failure is recorded, not papered over.
- Two arXiv IDs I initially recalled for the Levels-of-AGI paper were wrong
  (they resolved to unrelated QCD/vision papers — caught by verifying before
  citing). The verified ID is [arXiv:2311.02462](https://arxiv.org/abs/2311.02462).
  Lesson recorded because it is exactly the eval-culture Astra runs: a claim
  that outruns its measurement is a bug.
- Repo claims point at files or docs; suite numbers are quoted from the
  ledger (`docs/plans/glm-handoff-2026-09-10.md`), not re-run.
- Nothing here is a product claim. These are research documents with
  explicitly bounded evidence.

## Sources fetched successfully (all on 2026-09-11)

1. TestFlight invitation `XfeprEPX` — "Cadu: A Hermes Agent UI" (doc 05).
2. AlphaEvolve — DeepMind blog, May 14 2025.
3. METR "Measuring AI Ability to Complete Long Tasks" — Mar 19 2025.
4. AI-2027 — Kokotajlo et al., Apr 3 2025, incl. Nov 2025 addendum note.
5. ARC Prize site (arcprize.org, 2026 state) — ARC-AGI-3 unbeaten.
6. Darwin Gödel Machine — [arXiv:2505.22954](https://arxiv.org/abs/2505.22954) (abstract; the sakana.ai page 404'd).
7. ShinkaEvolve — sakana.ai/shinka-evolve/ (paper: arXiv 2509.19349).
8. Levels of AGI — [arXiv:2311.02462](https://arxiv.org/abs/2311.02462) (Morris et al., ICML 2024, via ar5iv HTML).

**Fetch failures (recorded honestly):** Silver & Sutton "Era of Experience" —
four routes attempted (two DeepMind storage URL variants, incompleteideas.net
[cert error], arXiv [not hosted there]); no copy obtained. Any reference to it
in doc 02 is labeled as unverified-from-primary. Also 404: sakana.ai/darwin-godel-machine/,
sakana.ai/shinka-evolve-redirect, and the two wrong arXiv IDs above.

## Repo docs studied

Self-read in full: `agi-generation-master-plan.md`, `task-harness-arc-patterns.md`,
`serious-talk-brief.md`, `agi-os-frontier-v2.md`, `agi-os-eco-platform.md`,
`muster-win-plan.md`, `computer-os-native-roadmap-2026-09-10.md`,
`astra-gpt6-mvp-brief.md`, `astra-ceo-mandate.md`, plus `src/state/onboarding-finish.ts`
(Astra's Loop-21 rework, as the pattern specimen). Digest of 25 further docs
(competitive, harness, eval, monetization, UI) via a subagent sweep; the five
AGI-relevant conclusions it returned are folded into docs 01–03 and marked where
they matter.

## Status and boundaries

- **Nothing built.** No code, tests, schemas, routes, or UI changes.
- **Nothing committed.** This folder is untracked working tree. Astra's next
  `git add -A` will sweep it in unless the board moves it first — the board
  decides whether/when it lands on `main`.
- Astra's in-flight Loop-49 iOS files and Curie's native fixture were not
  touched, read-only at most.
- Baseline quoted in doc 01 is Loop 48 (238 files / 3,352 passed / 8 skipped);
  I ran no tests. Loop 49 was in flight at the time of writing.
