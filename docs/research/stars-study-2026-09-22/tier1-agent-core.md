# Tier 1 — agent core (core/meme quality, retrieval, workforce learning)

Method: README/bundle study via web fetch, 22 Sep 2026. Tree attachments are proposals for later slices, not commitments. Format mirrors `docs/research/mascot-character-study-2026-09-18.md`.

---

## tinyhumansai/openhuman (Rust/Tauri, 40.0k★)
- **What**: open-source agent harness — local-first memory, agent orchestration, workflows. The largest harness repo in the list.
- **Adopt**: memory model (local-first + withdrawal provenance) and workflow orchestration shapes; verify against our brain's provenance seam. **Leave**: Tauri rewrite — our desktop is Electron.
- **Attach**: `server/workspace-brain.ts` (memory shapes), `server/routines.ts` (workflows).
- **Next**: clone; read memory schema + orchestration loop; compare fact model (provenance/corrections) with ours; benchmark turn latency 24/7 vs. our booted server harness.

---

## tamaratran/fast-jev-compaction (TypeScript, 6.2k★)
- **What**: replaces compaction summaries with scored decisions — every tool call/result scored in one fast request; stale dropped/truncated, kept stays verbatim.
- **Adopt**: scored-turn-context pattern for long 1:1/room turns and automation turns. **Leave**: Claude-Code-specific plugin glue.
- **Attach**: turn orchestration in `server/index.ts` (context assembly), `server/contracts.ts` (wire shape).
- **Next**: read the scoring prompt + drop rules; pin a regression test through our fake-ACP harness with a long settled turn.

---

## bespokelabsai/nimble (Python, 1.6k★)
- **What**: local typed decisions, contrastive data curation, model evaluation.
- **Adopt**: the evaluation half — typed decision capture for `pnpm bench:roles` grade-over-real-turns pipeline. **Leave**: curation half for now.
- **Attach**: `server/role-eval.ts` + `server/role-eval-harness.test.ts`.
- **Next**: read decision schema; map onto our role-eval capture schema; test a nightly grade re-run with persisted trends (`scripts/bench-trend.ts`).

---

## kerpopule/hermes-jev-skills (Python, 415★)
- **What**: typed-powered model routing, memory, compaction, skill selection, computer + browser use patterns for agents.
- **Adopt**: skill-selection pattern — mount only relevant skills per turn (we mount first-4KB of all skills; relevance gating is the gap). **Leave**: Hermes/Claude-Code plugin shells.
- **Attach**: `server/workspace-skills.ts` + system prompt assembly in `server/index.ts`.
- **Next**: read selection rules; prototype per-turn skill gating behind a config flag; assert prompt size stays bounded.

---

## redhat-et/ripwire (C++23, 2.3k★)
- **What**: "ripgrep of AI context" — zero-dependency CLI + MCP server so agents find what they want without reading the repo.
- **Adopt**: as an MCP backend candidate for a "workspace retrieval" connected app (our MCP client loop already exists). **Leave**: bundling — optional install.
- **Attach**: `server/mcp-client.ts` (external MCP candidate), `server/*-proxy.ts`.
- **Next**: run it over the Muster repo; measure fetch-quality vs. plain `rg` for the questions agents actually ask (router fixes, driver loop, fee seams).

---

## camel-ai/owl (Python, 20.1k★)
- **What**: Optimized Workforce Learning — multi-agent workforce optimization for real-world task automation.
- **Adopt**: workforce-ranking training data shapes for `server/jev-dispatch.ts` (recommend_team ranking is currently hand-weighted). **Leave**: full framework.
- **Attach**: `server/jev-dispatch.ts`, `server/brain-dispatch-harness.test.ts`.
- **Next**: read the learning loop; check whether dispatch evidence can come from our brain facts + routine scorecards instead of synthetic pairs.

---

## agentgram/agentgram (Next.js + Supabase, 40★)
- **What**: open-source AI agent social network — self-hostable, API-first, MIT.
- **Adopt**: reference for the agent-social S-track (`docs/plans/agent-social-ecosystem-plan-2026-09-14.md` S5–S10): profile/post/reply API shapes without crypto complexity. **Leave**: Supabase backend — our server is self-contained.
- **Attach**: social slices in `src/` + `server/index.ts` (S-track routes).
- **Next**: read API contract; note which post/reply invariants we'd need (per-account scoping, replay rejection).

---

## humation-labs/humation (TypeScript, 230★)
- **What**: hand-drawn kawaii avatar engine for apps — no AI, no API calls.
- **Adopt**: adopt/leave call needed against our vector Flower: layered expressions + task motion without an LLM in the loop is exactly our two-layer state model. **Leave**: raster assets if they clash with the Flower contract.
- **Attach**: `src/lib/mascot/` (web reducer sync).
- **Next**: inspect engine shapes (states, transitions); check license; byte-compare interaction feel vs. our annoyed/calm contract.

---

## techjanitor/botmaker (Hermes skill + SOUL, 279★)
- **What**: a bot whose only job is minting other specialist bots.
- **Adopt**: persona + playbook content for our Chief-of-Staff hire flow — hire → draft task → mint bot is shipped; a "specialist-minting" template is a content slice. **Leave**: Hermes-specific skill format.
- **Attach**: workspace template content (Daylight-style), hire flow in `src/`.
- **Next**: read the SOUL + mint playbook; adapt into a Muster template; browser-accept one hire with preserved draft.

---

## agno-agi/agno (Python, 42.3k★)
- **What**: build, run and manage agent platforms (agents, teams, workflows).
- **Adopt**: platform-shape teardown only — how they expose teams/workflows as products (panels, not engines). **Leave**: Python runtime — we have drivers.
- **Attach**: `src/components/` (panel teardown), `docs/plans/competitive-landscape.md` update.
- **Next**: read product docs; list which panels/flows are OMB-parity-relevant; update competitive-landscape exposures.

---

## RyjoxTechnologies/Octopuda-OS (Python, 486★)
- **What**: memory + observability layer — persistent memory, loop detection, hash-chained audit trails, live dashboard.
- **Adopt**: hash-chained audit trail for the why-journal (HYPOTHESIS/FINDINGS hardening — tamper-evident entries) and loop detection for automation turns. **Leave**: separate OS framing.
- **Attach**: `server/why-journal` seam (find via router fix in `server/index.ts`), computer-observation.
- **Next**: read the hash-chain format; prototype why-journal entries with parent hashes; assert NaN-free counters stay NaN-free.

---

## EverMind-AI/EverOS (Python, 13.1k★)
- **What**: one portable memory layer for every agent — local-first, Markdown-native, user-owned, self-evolving across apps.
- **Adopt**: Markdown-native memory export (portable backup contract: `docs/plans/portable-backup-contract-2026-09-12.md`) — brain facts as Markdown the user owns. **Leave**: cross-app sync daemon.
- **Attach**: `server/workspace-brain.ts`, workspace-backup-routes.
- **Next**: read the Markdown memory format; check round-trip (export → reinstall → import) through our backup harness.
