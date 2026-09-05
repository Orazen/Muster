# Task harness v1 — what Muster adopts from ARC-AGI-3-Agents

_Research → design. 2026-09-05. Source: github.com/arcprize/ARC-AGI-3-Agents
(MIT, Python, the official agent harness for the ARC-AGI-3 benchmark) plus
the Schema harness results already cited in
[muster-win-plan.md](muster-win-plan.md). This turns the "certify-then-commit
seed" from that plan into concrete, ordered Muster work._

## 0. What the ARC harness is

A minimal loop harness for agents solving unknown-rule puzzle games. The
whole framework is **one abstract contract**:

```
while not is_done(frames, latest) and actions <= MAX_ACTIONS:
    action = choose_action(frames, latest)   # agent decides
    frame = take_action(action)              # harness executes + observes
    frames.append(frame)                     # history is first-class input
```

Around that contract: an append-only **Recorder** (JSONL of every action +
frame, replayable by a Playback agent), a **Swarm** (many agents × many
games, threaded, one scorecard), **structured action responses** (pydantic:
action + reason + hypothesis + aggregated_findings), and a templates ladder
(random → LLM → reasoning → multimodal → langgraph → smolagents) so new
agent classes slot into the same evaluation.

Why it matters: the Schema harness paper showed the same model scoring ~43%
under a generic coding harness vs ~99% under a process harness on ARC-AGI-3.
ARC's own repo is the reference implementation of such a harness — study it,
steal the abstractions, and Muster's bots inherit the same discipline for
real work instead of puzzles.

## 1. Adopt: five mechanisms, mapped to Muster

### 1.1 The task-loop contract (already 80% true in Muster)

Muster routines already own the loop (iterations, notes file, sentry
re-check) the way ARC owns the game loop. Adopt the missing piece: a
**structured per-iteration schema**. A routine can opt into requiring each
run to end with `{done, action_taken, reason, hypothesis, findings,
score}` (zod at the boundary). The why-journal already stores intent +
decisions; this makes it *machine-checkable* — a run that can't state its
hypothesis is flagged in the run list. ~1 day, pure validation + UI chip.

### 1.2 The action ledger + Playback (the big one)

Muster already logs every turn as NDJSON native transcripts per thread.
ARC adds two ideas on top: the log is **replayable** (a Playback agent
re-executes a recorded game deterministically) and it is the **certifier's
substrate** (a plan is backtested against recorded transitions before
commit). Muster sequencing:

- **v1 — plan rehearsal (certify-then-commit lite):** before a bot executes
  a multi-step computer plan (Local VM / cloud), the harness replays the
  plan's stated steps against the bot's recorded transition log of similar
  past tasks and shows a match/confidence chip on the approval card: "this
  plan matches 47 recorded steps from 6 similar tasks." No execution
  semantics change — pure evidence on the card the human already reads.
- **v2 — true playback:** re-run a recorded task against a fresh
  environment as a regression test for delegated work ("re-do last week's
  report exactly, assert the same receipts").

### 1.3 The scorecard

ARC scores every run objectively (levels_completed, actions, fps). Muster
receipts already carry duration/tokens/cost. Add a **per-routine scorecard**:
define 1–3 checks with a routine (a grep, an HTTP probe, a file exists),
evaluate them at run end, store with the receipt. Routines become comparable
across runs and across bots; the sentry "changed/unchanged" signal upgrades
to a trend line. ~1–2 days.

### 1.4 Hypothesis memory

The reasoning agent tracks `hypothesis` + `aggregated_findings` per action —
exactly Muster's memory-file model, made structured: add optional
convention sections to MEMORY.md (`## Working hypothesis`, `## Findings`)
that the routine prompt template references. Zero engine change; template +
docs only.

### 1.5 Swarm = the fleet, already shipped

ARC's Swarm (many agents × many tasks, threaded, one scorecard) is Muster's
rooms + routines + roster. Nothing to adopt except the **evaluation
mindset**: the scorecard from 1.3 is what makes "which bot is better at
this job" answerable with data instead of vibes. A future "benchmark my
roster on this task pack" feature rides on it.

## 2. Skip

- The game-API client (ARC-specific), AgentOps integration (Muster's audit
  log + receipts are the equivalent, user-owned), and the Python agent
  classes themselves (Muster bots are arbitrary CLIs/APIs, not in-process
  Python classes).

## 3. Sequencing

1. **Now:** structured iteration schema for routines (1.1) — smallest, makes
   the journal machine-checkable.
2. **Next:** scorecard checks (1.3) — makes receipts comparative.
3. **Then:** plan rehearsal on approval cards (1.2 v1) — the trust
   differentiator no competitor has.
4. **Later:** true playback regression runs (1.2 v2).

Each item is independently shippable; none blocks the others.

## 4. Evidence

- Loop contract: `agents/agent.py` (Agent ABC: choose_action / is_done /
  MAX_ACTIONS; frames list as first-class input).
- Ledger + playback: `agents/recorder.py` (JSONL, guid-keyed) + Playback
  class.
- Structured reasoning: `agents/templates/reasoning_agent.py`
  (ReasoningActionResponse: action/reason/hypothesis/aggregated_findings).
- Swarm: `agents/swarm.py` (agents × games × threads + EnvironmentScorecard).
- Templates ladder: `agents/templates/` (random → reasoning → multimodal →
  langgraph → smolagents → openclaw).
- License MIT — concepts and schemas may be adopted freely; this doc
  borrows abstractions only, no code.
# docs: routine scorecards ship
