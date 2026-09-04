# Muster AGI-OS — frontier plan v2 (90-day mechanics + platform ship order)

_Second research wave of the AGI-OS push, 2026-09-04. Two live studies: (a) the
AGI-harness frontier — OpenClaw (~389k★), Nous Research Hermes Agent (~241k★) with its
self-evolution loop, GPT-6 "Astra"; (b) the multi-platform companion landscape (voice,
watch, Windows, PWA-lite). This plan supersedes the build-queue ordering in
agi-os-eco-platform.md §4 where they overlap, and records the new ship order for
surfaces._

## 0. The field converged — and Muster is 80% on target

What the biggest harnesses alive (OpenClaw 389k★, Hermes 241k★) demonstrably converge on,
and Muster's position on each:

| Frontier mechanic | OpenClaw / Hermes | Muster today |
|---|---|---|
| Persona as a plain file (SOUL.md) | both | ❌ persona is DB fields — **add file export/import** |
| Skills as versioned markdown, PR-review flow | Hermes self-evolution | ❌ — **add gated proposal flow** |
| Public skill/flow registry with token economics | ClawHub, Hermes flows | ❌ — team packs marketplace becomes **Muster Hub** |
| One gateway control plane + many channels | OpenClaw Gateway | ⚠️ harness is the plane; chat channels not yet |
| Human approval gates at the boundary | both | ✅ approval cards — Muster is action-scoped (finer) |
| Heterogeneous routing (cheap workers, strong critic) | Hermes MoA flows | ✅ per-bot engines + **add room critic pattern** |
| Self-improvement with constraint gates | Hermes GEPA loop | ❌ — **mine receipts as eval data** |
| GPT-6 Astra (released Sep 2026) | frontier model | ✅ BYOK: paste a key, fleet rides it |

GPT-6 Astra context (reported claims, Wikipedia): released Sep 2026, restricted public
version, agent capabilities cited across multi-step workflows. **Muster's BYOK design is
the free option**: when a frontier model lands, a Muster user pastes one key and the whole
roster upgrades — no code, no migration, no vendor negotiation. That is the strategic
answer to model churn, and it is already built.

## 1. The 90-day mechanics (ranked, with effort)

1. **SOUL.md persona files** (S): export/import personas as plain markdown — name,
   voice, memory highlights, guardrails. Import accepts Hermes SOUL.md directly (their
   241k★ ecosystem becomes Muster's supply). Every change lands as a reviewable diff —
   the PR-review discipline Hermes proved, applied to personas.
2. **Receipts → eval data → persona proposals** (M, after #1): mine the why-journal +
   receipts of each bot's runs as evaluation material; propose improved persona/skill
   text with the same constraint gates (tests pass, size ≤15KB, owner approval). The
   self-improvement loop, grounded in data Muster already produces.
3. **Muster Hub** (M): the team-packs marketplace becomes the public registry —
   personas, flows, room templates, indexed with architecture + token economics (what a
   typical run costs). Umbrel-store UX (already the plan) + Hermes flows indexing.
4. **Room critic pattern** (M): per-room "mixture of agents" — cheap workers draft,
   a designated critic bot reviews, the lead publishes. Built on rooms + delegation
   that already exist; the new part is the critic role flag and the pass/fail handoff.
5. **Chat-channel gateway** (M→L): approval cards and receipts pushed to Telegram/
   Slack/WhatsApp for one-tap authorize-from-phone. OpenClaw's channel architecture is
   the blueprint; our approval cards are the payload.

## 2. Multi-platform ship order (the voice/watch/Windows/PWA study)

The companion landscape converged on a feature baseline: push-to-talk, streaming
speech-to-speech, barge-in, on-device transcription, background conversation. Apple
Watch realistic scope: complication-glance answers, dictation-to-agent, voice replies,
notification triage — NOT full duplex streaming. Windows: MSIX with differential
updates (64KB blocks) + winget + .appinstaller auto-update from our own site.

**Ship order (validated against what ChatGPT/Grok/Pi actually ship):**

1. **Days 0–30 — PWA lite**: installable manifest + service worker + push on
   Android/desktop. Zero-install trial surface; iOS Safari partial is acceptable.
2. **Days 15–45 — iOS + voice**: interruptible streaming (barge-in) is the must-have;
   the SwiftUI companion already exists.
3. **Days 30–60 — Windows MSIX + winget**: differential auto-update via
   .appinstaller; removes the "unsigned exe" friction entirely.
4. **Days 60–90 — Android background voice, then watchOS companion**: dictation-to-
   agent complication with voice reply.

Each platform's must-have is exactly one feature — everything else inherits from the
existing harness.

## 3. Autonomous operations (already running)

- Weekly competitor intel sweep automation (Mondays 09:00) — watches GitHub trending +
  the studied competitors' releases, appends to docs/plans/intel-log.md, pushes.
- Daily health sweep (tests/lint/health-check/feed-version) — requires a fresh session
  to register (automation sessions can't spawn siblings); add it as the first act of
  the next chat.

## 4. What Muster does NOT chase

- Full duplex watch streaming (platform-reserved, low value today).
- A proprietary model. GPT-6 Astra, Claude, Hermes-class open models — Muster's BYOK
  layer rides all of them within hours of release. The platform's answer to frontier
  churn is indifference: any model, any provider, one key.
- Being the gateway for other products' traffic (OpenClaw already won channels; Muster
  wins the workforce layer above them).
