# How Muster wins — the operator's plan

_Founder-facing strategy. Written 2026-09-05. Feeds off
[muster-platform-strategy.md](muster-platform-strategy.md),
[muster-hi-new-agent-mail.md](muster-hi-new-agent-mail.md), and fresh
competitive research: Freebuff (CodebuffAI), Schema harness
(schema-harness.github.io), hi.new. The question it answers: "if I were
running Muster, what would I do to win the world — and what are we
missing?"_

## 0. The honest position

What Muster is today, verified by the codebase and live deployment:

- **The loop works end to end**: hire-by-interview → persistent persona +
  memory (MEMORY.md, SOUL.md) → BYO engine (10+ CLIs, 12 API providers, any
  OpenAI/Anthropic endpoint) → guardrails (approval cards, token/USD caps,
  Privacy Shield) → real computers (cloud Box, OpenSandbox, Local VM, VPS) →
  verifiable signed receipts → routines/sentries/webhooks → WhatsApp channel.
- **Every surface exists**: macOS/Windows/Linux desktop, web, cloud, Docker
  self-host, CLI, iOS/Android companions built (unlisted), Muster OS desktop
  shell with a ⌘K command console.
- **Trust architecture nobody else has**: approval cards, counts-only privacy
  receipts, HMAC-signed shareable receipts, agent-scoped vaults, operator
  gates, per-user isolation.

What that adds up to: Muster is currently the **most complete agent-workforce
codebase that almost nobody has heard of**. The gap is not product — it is
distribution, trust signals, and one structural gap (below). This plan is
about closing those in order.

## 1. The market read (September 2026)

- **Freebuff (CodebuffAI)** is the closest breadth competitor: free,
  ad-funded coding agents on **all five surfaces** (desktop/CLI/web/cloud/chat),
  ~374k claimed users, prompt-to-live-URL hosting, GitHub cloud IDE. Threat
  real on distribution; structurally narrow: coding-only, **ephemeral** task
  agents, no personas/memory/approvals, and an ad-funding model that cannot
  follow into enterprise or self-host. Lesson: "we ship every platform" is
  not a moat anymore — Muster must never lead with surface count.
- **Schema harness research** (schema-harness.github.io) is the marketing
  gift of the quarter: the same frontier model scored ~43% inside Claude Code
  vs ~99% inside their process harness on ARC-AGI-3. **The harness, not the
  model, is the product.** Muster IS a harness company. This is the one-line
  justification for the entire category, citable everywhere.
- **hi.new** proves agent-to-agent mail demand and publishes a full Apache-2.0
  protocol. Muster bots joining that network as first-class clients (shipped:
  Settings → Agent mail) makes Muster part of the emerging agent commons
  instead of an island.
- Everyone else (Osaurus, OpenBot, Rakazo, nanoclaw, Eigent, Cherry) remains
  single-surface or developer-first. No one else owns "persistent governed
  workforce."

**Positioning that wins**: not "Muster runs on every platform" but
**"the agent workforce you can actually own — persistent, governed,
verifiable, self-hostable."** Four words: persistent, governed, verifiable,
yours.

## 2. What we're missing — ranked by impact

1. **Trust-to-first-task friction (the #1 killer).** A new user needs: a
   download, a Gatekeeper workaround (unsigned macOS), an agent CLI already
   installed and logged in, and an idea of what to ask. Each step loses a
   cohort. Missing: (a) code signing + notarization on macOS, SmartScreen
   cert on Windows; (b) a **zero-key first bot** — ship a hosted free-model
   onramp (Google AI Studio key flow already documented; make it a
   two-click wizard) so day-one works without any CLI; (c) the store-listing
   mobile apps (built but unlisted) for the "answer approvals from my phone"
   aha-moment.
2. **Multi-user teams.** Muster is one operator + isolated users. The paying
   category ("AI workforce for a team") needs workspaces: multiple humans,
   roles (who can approve what), shared roster, audit. The multi-tenancy
   design doc exists; shipping the first real team tier converts Muster from
   a power-user tool into a company purchase.
3. **Distribution engine.** No SEO surface, no integration-directory listings
   beyond openalternative plans, no content loop. The receipts feature is a
   built-in viral artifact — every shared receipt should carry a "verified by
   Muster" badge linking to a public trust page; every team-library pack
   should be an indexed landing page (the /bots directory exists — feed it).
4. **Proof-of-work as a public standard.** Receipts are signed and
   verifiable, but verification lives in Muster's own API. Publishing the
   receipt format as an open spec (with a standalone verifier) makes Muster
   the origin of a trust standard — the thing big companies cannot copy
   without adopting our format.
5. **Reliability & observability story.** Engine doctor and provider health
   exist; what's missing for teams: turn failure alerts, weekly email digest,
   status page for Muster Cloud. Trust compounds only if the fleet visibly
   stays healthy.
6. **Certified autonomy (the schema-harness lesson).** "Certify-then-commit"
   for bot plans: agents already produce receipts; the next level is
   backtesting a plan against the bot's own recorded transitions before
   execution, surfacing "this plan matches 47 recorded steps" in the approval
   card. Turns the approval card from a gate into a superpower.
7. **App-store + directory distribution**: listed mobile apps, Chrome
   extension later, Raycast/Alfred later. Also: an MCP **server** directory
   entry (Muster as MCP server for other agents) — the CLI --json surface
   already half-exists.
8. **Name and SEO hygiene.** "Muster" is a generic word; the exact phrase
   "Muster AI agents" / "Muster agent workforce" needs owned pages (docs,
   comparisons, changelog) to win queries the way hi.new owns "agent mail."

## 3. The 90-day plan

**Days 0–14 — remove friction (no new features):**
- Code-sign + notarize macOS; cert for Windows. (Kills the #1 support load
  and the "damaged" README paragraph.)
- Two-click free first bot: onboarding offers a Google AI Studio key flow
  with free-tier Gemini, or OpenCode Zen free models.
- Ship `/skill.md` (done this week) + list Muster in the agent/MCP
  directories; publish the trust page for signed receipts.
- List iOS/Android on stores (accounts still needed — operator action).

**Days 15–45 — the team tier + the network:**
- Workspaces MVP: invite by email, roles = can-approve / can-hire /
  read-only, shared roster, audit view. Price at $20/seat — the workforce
  seat the thesis targets.
- hi.new mail GA (shipped behind Settings this week) + one landing section:
  "Your bots are reachable at hi.new/your-team — grants you approve."
- Weekly email digest + failure alerts (retention + trust).

**Days 46–90 — the standard + the wedge content:**
- Publish the **Receipts spec** (open, versioned, standalone verifier) and
  announce it — "proof-of-work for agents" as a category Muster defines.
- Certify-then-commit prototype on the approval card.
- Content engine: one comparison page/week (Muster vs Freebuff vs Cursor
  agents vs Devin…), one "harness > model" post citing Schema's numbers, one
  customer/builder story. All indexed from llm.txt for agent researchers.
- Team-library growth loop: publishing packs is one click; each pack gets an
  indexable page.

## 4. The one metric

**Weekly Active Tasks (WAT): settled bot tasks per calendar week across all
installs.** Not DAU (chat apps own that), not downloads (vanity). A workforce
product wins when tasks run when the human isn't watching — WAT is the only
number that says the agents are real workers. Everything in §3 exists to move
WAT.

## 5. What I would personally do in the founder's seat

Freeze feature breadth for 30 days. The next four features anyone ships must
be: signing, free-first-bot, teams, stores. Everything else — new engines,
new providers, new chat polish — waits. The product is ahead of its
distribution by roughly two quarters; the fastest way to "win the world" is
to let the world in.
