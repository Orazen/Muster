# Competitive landscape — agent-workforce products (September 2026)

Research basis: direct study of OpenMausBot's source (all branches), xAI's public
Grok Bot materials, the OpenClaw ecosystem, and prior scans in
[openmausbot-design-study.md](openmausbot-design-study.md) and
[robotics-and-ecosystem-research.md](robotics-and-ecosystem-research.md).
Every "they have / they lack" below was checked against code or primary docs at
study time — not scraped from launch posts.

## The three that matter

### 1. OpenMausBot — the direct competitor
2.4k stars, single-repo local app, 11 model engines, four approval tiers, and —
the part worth copying — a **bounded MCP server** exposing the product to
external agents. Its trajectory is "one user's terminal agent, productized."

**Where Muster is ahead (verified):**
- **Fleet, not a bot.** OpenMausBot is one agent in one window. Muster runs a
  roster of bots with per-bot engines, budgets, threads, and state.
- **Approvals as a product spine.** Muster's OptionCard → Watch/phone approval
  flow is a first-class surface. OpenMausBot has approval tiers but no mobile
  approval device.
- **Fleet MCP server (shipped this cycle).** `muster mcp` exposes six bounded
  tools (status / send / wait / receipt / memory-read / approval-history) with
  no approvals-deletes-credentials surface — the same bounded-server idea,
  fleet-scale, reuse-of-session-auth.
- **Receipts + why-journal.** Every settled task emits a proof-of-work receipt
  (duration, tokens, final word) and approval decisions carry evidence
  history. OpenMausBot has neither.
- **Offline pairing.** QR/chip-code local pairing vs. their config-file setup.

**Where they're ahead (honest):**
- **Engine breadth:** 11 engines vs Muster's fewer, though Muster's driver
  architecture (CLI/ACP/direct-API) makes parity an integration task, not a
  rewrite.
- **Zero-config first run:** their clone-and-run path is real. Muster's
  `muster setup` closes most of the gap but ships with the desktop app.
- **Mindshare:** 2.4k stars in months. The private repo means Muster can't
  compete for stars — it competes on product depth.

### 2. xAI Grok Bot — the distribution threat
Subscription-priced shared-VM bots that learn routines. No local mode, no
approval surface a human owns, transcripts live on xAI's VMs. The threat is
distribution and price, not architecture: Muster's counter is the things a
shared VM structurally cannot offer — local execution, per-bot credential
isolation (default-deny allowlists), human-owned approvals, receipts you can
audit, and offline operation.

### 3. OpenClaw — the format war
~389k stars, mostly a `soul.md` persona-format movement with an app around it.
Format adoptions are winner-take-most; Muster already reads/writes SOUL.md per
bot (`GET/PUT /api/bots/{id}/soul.md`), so it interoperates instead of
fighting. The watch-item is OpenClaw growing a real harness underneath.

## Patterns across the landscape

1. **Bounded MCP beats sprawling MCP.** Both OpenMausBot and every serious
   integration surface converge on a small tool set. Muster's six-tool fleet
   server follows this; keep future tools gated behind the same review.
2. **The approval moment is the moat.** Every competitor treats "agent asks
   permission" as a settings toggle. Muster treats it as a cross-device
   product moment (Watch + OptionCard + approval history). This is the
   hardest thing to copy and the easiest thing to demo.
3. **Economics win fleets.** Per-bot engine routing (cheap model for routine
   work, frontier model for hard steps) is table stakes for a *workforce*
   story; single-engine products can't tell it.
4. **Proof-of-work builds trust.** Receipts + why-journal + approval history
   are the trust artifacts none of the competitors ship.
5. **Local-first is defensible.** Shared-VM bots can't follow. Lead every
   comparison with it.

## Exposures to fix next (ranked)
1. **Mimosa full security re-run** still owed after the scanner_enobufs
   failure — blocked on MCP enablement, not on code.
2. **Dependabot alerts on main untriaged (2 high)** — standing debt.
3. **Engine breadth** — add engines via the driver layer until the roster
   matches OpenMausBot's 11.
4. **Zero-config onboarding** — collapse `up`+`setup` into one guided path.

## What "beating OpenMausBot" means, concretely
Not stars (private repo). It means: when the same task is given to both,
Muster finishes with a receipt, a bounded-MCP audit trail, and a human
approval record — and the bot that hit a snag escalates to the owner's Watch
instead of stalling in a terminal. That comparison is runnable today and
should be recorded as a benchmark doc when Astra (GPT-6) runs its eval.
