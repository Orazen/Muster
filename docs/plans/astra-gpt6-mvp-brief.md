# Muster — MVP brief for Astra (GPT-6)

*Handoff document, 2026-09-09. Audience: a frontier AI agent ("Astra") that
will (a) test Muster as an external evaluator and (b) develop the next MVP
slice. Written to be readable without the codebase open, but every claim
points at the file or route that proves it.*

---

## 1. What Muster is

Muster is an **AI-agent workforce platform**: not one agent in a chat window,
but a managed roster of persistent bot workers ("the fleet") with per-bot
model engines, budgets, threads, memory, and — the spine of the product —
**human-owned approvals**. A human owns every bot; when a bot hits a
permission gate, the ask surfaces as an OptionCard that can be answered from
the desktop app, the web app, or an Apple Watch. Work finishes with a
**receipt** (duration, tokens, final word) and decisions leave an
**approval-history** evidence trail.

Surfaces: Electron desktop app (Mac), web app + server (`server/index.ts`),
CLI (`cli/muster.mjs`), and as of 2026-09-09 a **fleet MCP server**
(`server/fleet-mcp.ts`) that exposes the whole fleet to external agents —
which is how you, Astra, will drive it.

Repo: github.com/Orazen/Muster (private, BSL 1.1). Work happens on `main`.

## 2. The one-sentence MVP

> **Give an external agent (you) safe, bounded, auditable control of a fleet
> of AI workers — and give every human the approval moment on the device in
> their pocket.**

Everything already shipped serves that sentence; everything below tightens it.

## 3. What is shipped and verified (your test surface)

| Capability | Where | Status |
|---|---|---|
| Fleet REST API (roster, threads, messages, receipts, memory, audit) | `server/index.ts` | Live, session-authed |
| Fleet MCP server — 11 bounded tools | `server/fleet-mcp.ts` | 73 tests, live-verified against a running server |
| CLI: `muster mcp` prints client config; `--serve` runs stdio | `cli/muster.mjs` | Verified |
| Approval cards with A–F hotkeys + history strip | `src/components/OptionCard.tsx` (hotkeys), `src/components/ApprovalCard.tsx` (history) | Shipped |
| Routines (`once`, `daily{time,weekdays}`) | `server/routines.ts` | Shipped + tested |
| Why-journal + routine scorecards (ARC pattern) | `server/why-journal.ts`, `server/routines.ts` | Shipped, unit-tested |
| Receipts per settled task | `server/index.ts` (`/api/receipts/...`) | Live |
| SOUL.md / MEMORY.md per bot | `/api/bots/{id}/soul.md`, `/memory` | Live |
| MCP client side (bots consume MCP servers) | `server/mcp-client.ts` + proxies | Shipped |

**The bounded-by-design rule you must preserve:** the fleet MCP server has
deliberately NO tool for approvals, deletes, credentials, engine changes, or
memory writes. `wait_for_conversation` returning `needs-user` means *the bot's
human must decide* — an external agent relays the question, it never answers
it. Any feature you add must not violate this.

## 4. The eval you (Astra) should run first

This is the "beat the competitor" benchmark, runnable today:

1. Pair: `muster pair` (or use the existing session in `~/.muster/cli.json`).
2. Connect as MCP client: `muster mcp` → paste config → handshake.
3. Run the same task three ways and record evidence:
   - `send_task` a real task → `wait_for_conversation` → expect `settled`
     with a reply.
   - Force an approval path → expect `needs-user` with the card title +
     options relayed verbatim (this is the differentiator: OpenMausBot-class
     products stall or auto-approve here; Muster escalates to a human).
   - Kill the engine mid-turn → expect `failed` (activity "dead"), not a
     silent hang.
4. Pull `get_receipt` and `get_approval_history` — the output should be
   self-explanatory proof-of-work with no transcript spelunking.
5. Score: task completion, escalation correctness, evidence completeness,
   tokens/cost per task.

## 5. The next MVP slice — what to build

Ranked; each is a bounded, shippable increment consistent with §3's rule:

1. **Astra eval harness as a product feature.** Turn §4 into
   `muster eval` (or a docs-run playbook + stored scorecards): same three
   probes, JSON results, trendable. The product that can grade its own
   agents wins procurement conversations.
2. **Fleet MCP write-safe extensions.** `list_sessions`-style reads,
   `get_why_journal`, `get_scorecard` — read-only trust artifacts. Keep
   approvals/deletes/credentials out; the asymmetry IS the product.
   *(all three shipped — `list_sessions` completed the set.)*
3. **Cross-fleet delegation.** One bot's receipt feeding another bot's task
   (`send_task` with a receipt reference), making the fleet composable —
   the "workforce" story beyond parallel chat.
4. **Watch escalation depth.** needs-user cards on Watch with one-tap
   Allow/Deny and the why-journal entry auto-attached. The approval moment is
   the moat; make it frictionless.
5. **Engine parity.** Match OpenMausBot's 11-engine breadth through the
   existing driver layer (CLI/ACP/direct-API); see
   [competitive-landscape.md](competitive-landscape.md).

## 6. Hard constraints (non-negotiable)

- Private repo, BSL 1.1 — do not publish, do not open GitHub issues/PRs
  publicly, never show `npx muster` (that package name is a squatter).
- Never claim security posture without a clean full scan (the last full
  Mimosa run failed with scanner_enobufs; re-run is owed).
- Tests before claims: `npx vitest run`, `npx tsc --noEmit -p tsconfig.server.json`.
- House style: bounded tools, receipts for finished work, human-owned
  approvals, honest outcomes (`failed` stays `failed`).

## 7. Reading list (in order)

1. This file.
2. [competitive-landscape.md](competitive-landscape.md) — who we're beating and why the MCP server exists.
3. [openmausbot-design-study.md](openmausbot-design-study.md) — the design counter-position (incl. v0.1.69 corrections).
4. `server/fleet-mcp.ts` — the door you walk through; its header comment is the contract.
5. [agi-generation-master-plan.md](agi-generation-master-plan.md) — where this goes after the MVP.
