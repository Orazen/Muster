# Cobus Greyling Skills — Applied to Muster
# Loop + Fleet + Goal + Graph + Memory + Outerloop
# All 6 skills integrated into Muster's architecture

## 1. Loop Engineering (@loop-engineering)
# Inner loop: agent turns; Outer loop: governance/audit
# Applied: The audit process itself (wave-1 → wave-2 → tail fix) = loop execution
# The lint burn-down: evidence (violations) → verdict (fix guide) → answerability (commit)

LOOP_APPLIED = {
  audit_cycle: "lint detection → fix guide → swarm execution → verification → commit",
  inner_loop: "per-file lint fix",
  outer_loop: "full repo audit + CI gate enforcement",
  loop_engineering: "Applied via ruflo swarm + 15-minute checkpoint polling",
}

## 2. Fleet Engineering (@fleet-engineering)
# Governed agent population with registry, identity, permissions, audit trail
# Applied: Muster's multi-agent roster IS a fleet

FLEET_APPLIED = {
  registry: "server/harness/registry.ts — agent registry with instance mapping",
  identity: "server/auth.ts — session/auth identity per agent",
  permissions: "server/permission-proxy.ts — broker/gated approvals",
  audit_trail: "server/store.ts — event bus + NDJSON transcript",
  fleet_ready_score: "PASS — 0 lint violations, 0 real security findings",
  fleet_engineering_note: "Every bot in sidebar = one agent in governed fleet",
}

## 3. Goal Engineering (@goal-engineering)
# Verifiable, run-until-done objectives (this session's goal tool)
# Applied: The goal-5df83a98 with max_rounds=10, verified-to-completion

GOAL_APPLIED = {
  objective: "Integrate Vellum/Gaia UI + build production-ready self-host/cloud plan",
  verification_condition: "MemoryTab.tsx + NotificationCard.tsx + gaia-theme.ts exist + 0 lint",
  done_condition: "Files verified, goal marked complete",
  goal_engineering_pattern: "Grok Build /goal style — objective + verification + done gate",
}

## 4. Outerloop (@outerloop)
# Evidence → Verdict → Answerability (governance layer over loop)
# Applied: Security audit — evidence (56 findings) → verdict (all false positives/display) → answerability (MUSTER_AUDIT_STRATEGY.md + docs)

OUTERLOOP_APPLIED = {
  inner_run: "agent process executes (Muster harness + agent CLI)",
  evidence: "lint report (1113 → 0) + security findings (56 triaged)",
  human_verdict: "fix approved (mechanical) + security approved (false positives)",
  ledger: "commit 225ae54 + working tree + MUSTER_AUDIT_STRATEGY.md",
  answerability: "Every fix has SAFETY justification comment",
  outerloop_governance: "Applied to audit + code quality enforcement",
}

## 5. Graph Engineering (@graph-engineering)
# Zero-dependency agent graph runtime — nodes=functions, edges=fixed/conditional
# Applied: Muster's event flow = graph (UI → harness → agent → approval → response)

GRAPH_APPLIED = {
  nodes: ["UI (Sidebar/ChatView)", "Harness (registry/bus)", "Agent CLI (claude/codex/grok)", "Broker (permission)", "Computer (box/local)"],
  edges: ["UI→Harness (HTTP command)", "Harness→Agent (CLI spawn)", "Agent→Broker (approval request)", "Agent→UI (SSE stream)", "Agent→Computer (box/local)"],
  graph_engineering_value: "Every layer is a visible function — no hidden dependencies, inspectable at every node",
  mermaid_equivalent: "Available in README.md (flowchart LR — UI→Server→Agents→Apps→Box)",
}

## 6. Memory Engineering (@memory-engineering)
# Durable, trustworthy, budgeted recall (this session's Phase 2 MemoryTab)
# Applied: 8 memory types with staleness windows + source attribution

MEMORY_APPLIED = {
  memory_layer: "src/components/bot-profile/MemoryTab.tsx — 8 types",
  types_implemented: ["episodic", "semantic", "procedural", "emotional", "prospective", "behavioral", "narrative", "shared"],
  persistence: "Local file system (~/.muster) + cloud workspace isolation (Dockerfile.cloud /data/workspace-{id})",
  budget: "Token-efficient — only relevant memory shown, staleness filter applied",
  isolation: "Per-user, per-bot — source attribution tracked",
  memory_engineering_result: "Vellum's 8 memory types integrated into Muster bot profile UI",
  staleness: "Default 7-day window (configurable per type)",
}

# Integration: All 6 skills work together in Muster
# Loop → execution cycle | Fleet → agent governance | Goal → verification gate
# Outerloop → audit/evidence | Graph → architecture visibility | Memory → persistence
