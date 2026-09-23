# 01 — Where Muster stands: an honest autonomy-level read

_GLM research pass, 2026-09-11. Read-only. Every "shipped" below means "the
file or doc exists in the repo at the time of writing"; where I cite suite or
E2E numbers they come from the Loop ledger, not from tests I ran. Framework
borrowed from Levels of AGI ([arXiv:2311.02462](https://arxiv.org/abs/2311.02462)),
which splits **capability** (Emerging→Superhuman) from **autonomy**
(Tool→Consultant→Collaborator→Expert→Agent) and insists autonomy is
"unlocked, not determined by" capability — a deployment choice. Muster is,
almost by definition, a product about making that deployment choice explicit._

## 0. The one-paragraph answer

Muster today is a **L2-on-the-ladder autonomy harness carrying Level-1-Emerging
models**. On DeepMind's autonomy scale the fleet operates between
**Consultant** (advises, drafts, plans) and **Collaborator** (executes multi-step
work on real computers), and — the part no competitor owns — every promotion
from Consultant to Actor is an **explicit human-signed event** (the OptionCard).
On the capability axis, Muster contributes nothing (it trains nothing; BYOK
rides whatever the model layer produces). On the autonomy axis, Muster is the
most instrumented deployment control in its niche: approvals, receipts,
why-journal, scorecards, plan rehearsal, approval history — the paper's
"tie levels to risk profiles" recommendation, shipped as a product. That is the
strategic position: the model layer commoditizes; the autonomy layer compounds.

## 1. What is actually built (file-grounded)

| Mechanism | Where it lives | What it honestly is |
|---|---|---|
| Fleet REST + MCP server | `server/fleet-mcp.ts` — 6 bounded tools + read-only `get_why_journal`/`get_scorecard` (fleet-evidence-tools.md), 13/13 tests at ship time | External agents can drive the fleet but have **no tool** for approvals, deletes, credentials, engine changes, or memory writes. `needs-user` means the human decides. |
| Approval cards + history | `src/components/OptionCard.tsx`; approval-history strip on Web/iPhone/Watch (watch-approval-history.md) | The autonomy gate. Watch cards carry the previous why-journal entry (300-char cap, redaction before truncation). |
| Receipts | `/api/receipts/...`, HMAC-signed, content-addressed verify (agi-os-eco-platform.md §3) | Proof-of-work per settled task; the substrate every later rung consumes. |
| Why-journal | `server/why-journal.ts` — HYPOTHESIS/FINDINGS per run, E2E-verified both paths | Structured self-report; the raw material for machine-checkable plans. |
| Routine scorecards | per-routine checks stored with receipts (task-harness-arc-patterns.md §1.3) | Fitness measurements. "Missing scorecard must never be interpreted as a pass" (fleet-evidence-tools.md). |
| Plan rehearsal | plan-rehearsal-v1.md — PLAN TOOLS block vs last 2,000 runtime records, prefix-match evidence on the card | A bot reasoning over its own recorded past; explicitly "not a statistical confidence score." |
| `muster eval` | fleet-eval-playbook.md — Completion/Escalation/Failure probes, versioned scorecard JSON, never overwrites | Self-measurement. "A simulated pass is never evidence of a live benchmark." |
| Cross-fleet delegation | fleet-receipt-delegation.md — `send_task` + `receiptRef`, frozen snapshot, grants no permissions | Composition. Nothing is sent if receipt validation fails. |
| Agent mail (hi.new) | muster-hi-new-agent-mail.md — `hi_new` tool, invite-grant model, `/skill.md` published | The fleet is reachable from the agent commons. |
| Context durability | `server/store.ts` canonical record; compaction records; `engineIsFresh()` (agent-harness-upgrades v1/v2) | The harness, not the model, is what survives engine switches and restarts. |
| Budgets + gates | routines with turn/token/time budgets (agi-generation-master-plan.md §1.3) | Bounded autonomy for scheduled work; sessions are the designed next step. |

## 2. What is designed but not built (and who designed it)

- **Persona/skill self-proposals**: mine receipts + why-journal → propose
  improved SOUL.md/skill text with constraint gates (tests pass, ≤15KB, owner
  approval) — agi-os-frontier-v2.md §1.2. This is the seed of rung L5 and it is
  a design doc today.
- **Memory history + rollback** (persona drift control) — agi-generation-master-plan.md §1.4.
- **Team modes** route/broadcast/tasks in rooms — agi-generation-master-plan.md §1.1.
- **True playback regression** (re-run a recorded task, assert same receipts) — task-harness-arc-patterns.md §1.2 v2.
- **Sessions with gates** (hours-long autonomous runs) — agi-generation-master-plan.md §1.3.
- **Portable encrypted workspace** — account-sync-portable-profile.md.
- **Physical actions** (robotics seam): designed rule — never eligible for
  always-allow (robotics-and-ecosystem-research.md). Correct rule; nothing built.

## 3. The measured state

- Suite: **238 files / 3,352 passed / 8 skipped** (Astra Loop 48, root), 270
  Swift tests, HTTP 32/32 — quoted from the Loop ledger; Loop 49 was in flight
  at writing time. This is the balance sheet that must only go up.
- Prod: muster.orazen.online, auto-deploys on push (~2–3 min), GET-only verify.
- Known debts the ladder must not build on silently: delegations persisted
  nowhere at v1-audit time (restart drops them — agent-harness-upgrades.md);
  browser takeover was a cosmetic boolean per the 2026-09-10 audit
  (computer-os-native-roadmap-2026-09-10.md, slice 1); Mimosa full re-run still
  owed — no security claim may be made anywhere in this folder.

## 4. Mapping to the two DeepMind axes

- **Capability**: whatever BYOK brings. Muster's exposure to the frontier is
  deliberately *indifference* — one key upgrades the whole roster
  (agi-os-frontier-v2.md §0). No capability claims are Muster's to make.
- **Autonomy**: Tool → Consultant → **Collaborator (today, gated)** → Expert →
  Agent. Muster's ladder (doc 03) is a deployment-side autonomy ladder: each
  rung expands what a bot may do *without asking*, and each rung is purchased
  with evidence, not capability. The Levels-of-AGI insight that autonomy can be
  held below capability is Muster's moat phrased academically: **the approval
  moment is the product.**

## 5. Non-claims

No security posture claim (Mimosa re-run owed). No competitive claim (0
executable competitor tests, per competitive-landscape.md). No AGI claim about
Muster itself — doc 04 explains why "orchestration layer" is the ceiling of
what Muster can honestly call itself regardless of what models do.
