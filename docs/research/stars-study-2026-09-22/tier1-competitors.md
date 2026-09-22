# Tier 1 — competitor teardowns (surface parity intel)

Purpose: surface intel for `docs/plans/competitive-landscape.md` and OMB-parity gaps (`docs/plans/openmausbot-parity-plan-2026-09-17.md`). Study informs behavior; never redesign (`docs/guides/web-app-stability.md`).

---

## tinyhumansai/openhuman (Rust/Tauri, 40.0k★) — *also tier1-agent-core*
- **Surface intel**: harness as product — model picker, memory panel, workflow panel. Compare with our Engines list + Providers panel.

## hackyguru/botato (TypeScript, 56★) — *already in mascot study; product-side addendum*
- **Product intel**: "Discord pre-loaded with AI agent superpowers" — rooms-like rooms with agent powers. Check their power-permission flow vs. OptionCard.

## PersonalClaw/PersonalClaw (Python, 5★)
- **Product intel**: agentic OS for one person — chat, autonomous goal loops, memory, knowledge base, skills, automation, MCP bidirectional. Closest 1:1 to our fleet. Compare their goal-loop stop conditions with Goal mode.

## hamedgitty/bloks (Electron, 89★)
- **Surface intel**: local-first desktop workspace for personal agents (Electron, like ours). Note tray/window management and onboarding.

## felinics/Memoh (Go, 2.5k★)
- **Product intel**: every agent gets its own computer, desktop, network, long-term memory; BYOK or self-hosted brains. Compare their per-agent isolation story with our workspace brain + drivers.

## yetone/cumora (TypeScript, 3.8k★)
- **Product intel**: team chat where AI agents are first-class teammates, cloud or BYO (Claude Code/Codex) brains. Direct rooms+channel competitor. Check their agent-in-channel permission flow.

## cosmicstack-labs/mercury-agent (TypeScript, 316★)
- **Product intel**: soul-driven agent, permission-hardened tools, token budgets, multi-channel 24/7 (CLI/Telegram). Compare their token-budget enforcement with allowance reservations.

## open-jarvis/OpenJarvis (Python, 10.1k★)
- **Product intel**: "Personal AI, On Personal Devices" — closest tagline to our assistant-beta strategy. Teardown their personal-device autonomy bounds.

## EKKOLearnAI/hermes-studio (TypeScript, 11.2k★)
- **Surface intel**: local-first multi-agent workspace for desktop + web — chat, coding, visual workflows. Note their workflow-panel product shape.

## nearai/ironclaw (Rust, 12.6k★)
- **Product intel**: Agent OS focused on privacy, security, extensibility. Study their extensibility surface (plugins?) vs. our fleet-MCP bounded tools.

## anywhere-labs/Agents-Anywhere — *also tier1-ux (phone control)*
- **Surface intel**: cross-device workbench — control any coding agent from any device.

## jaywedgeworth22/BotFleet (TypeScript, 3★)
- **Product intel**: OpenMausBot fork with iOS companion, iMessage relay, fallbacks, per-bot platform choice. iMessage relay is a channel candidate we lack.

## aabhishek3d/mitrachat (7★)
- **Product intel**: local-first agent chat with Gemini voice mode (OpenMausBot fork). Voice-mode patterns for walkie.

## uzairansaruzi/hermex, ZSeven-W/rish-app, CodeUpdaterBot/Hermes-Mobile-App, dylan-buck/Hermes-iOS — *also tier1-mobile*
- **Mobile intel**: native iPhone app flows for bot state/notifications/approvals/sensors.

## runta-dev/errand (TypeScript, 120★)
- **Product intel**: "open-source take on Grok Bot/Muse" — persistent AI teammates with their own cloud computers. Compare their cloud-computer isolation with our automation boundaries.

## spyrae/kronos-agent-os (Python, 52★)
- **Product intel**: durable agents runtime — memory, skills, MCP tools, automations, dashboard, optional swarm coordination. Compare their durability (resumable loops) with our settled-turn + retry opt-in semantics.

## Helmryth/HelmRyth (TypeScript, 7★)
- **Concept intel**: "persistent operators on CLIs you already own, crews that share a brief without sharing state" — crew-brief separation is a useful pattern for room turns (brief shared, state isolated).

## agentgram (40★) and camel-ai/oasis (5.2k★), Kevinchamplin/ai-social (1★)
- **Social intel**: agent social-network API shapes and simulation research for the S-track (S5–S10).

## SSBrouhard/grokbot-telegram-bridge (10★)
- **Pattern intel**: self-hosted Telegram bridge for a local gateway — patterns for channel reliability (webhook + poll, reply folding — Loop160 shipped ours; comparison only).
