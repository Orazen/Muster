# Muster Platform Strategy — the path to a billion-dollar agent OS

_Founder/CTO strategy doc. Written 2026-09-02, after live research into nanoclaw.dev,
openworklabs.com, eigent.ai, cherryai.com, the openalternative.co ecosystem (Macro suite,
Orca, Buzz, Omnigent, Multica), and the earlier wave (t3code, Osaurus, OpenBot, Rakazo).
Builds on docs/plans/growth-and-monetization-plan.md and supersedes its open questions._

## 0. The one-sentence thesis

**Muster is the operating system for a workforce of AI agents** — the only product where a
normal person (not a developer) can hire persistent agents with names, memory, personalities,
real computers, and verifiable proof-of-work, on every platform (OS app, web, cloud, self-host),
paid as a subscription. Everyone else is either a developer harness (t3code, Orca, OpenBot), a
platform-locked app (Osaurus), or an unfinished beta (Rakazo, nanoclaw, most of the field).

## 1. Why this can be a billion-dollar company

The AI-agent market is consolidating into three layers:

1. **Models** (OpenAI, Anthropic, Google) — commoditizing fast, price-collapsing.
2. **Harnesses for developers** (t3code, Orca, OpenBot, Cline) — huge developer mindshare but
   small ARPU; developers are price-elastic and self-host everything.
3. **Agents-as-coworkers for everyone else** — persistent, delegated, monitored, trusted.
   This layer is nearly empty. The reason it's empty is that every attempt so far demanded
   Docker, API keys, and CLI installs from people who don't know what those are.

Muster's entire existing design already attacks layer 3: hiring interview instead of config
files, chat instead of orchestration DSLs, approval cards instead of policy gateways, signed
receipts instead of audit logs, $20 cloud computers instead of BYO infrastructure. The
prize is the "AI workforce" seat — the same buyer paying for Slack seats and Notion seats,
at agent-roster scale (a 10-agent team = 10 × compute + 1 × platform).

A $1B outcome needs ~$100M ARR or a strategic acquisition into an ecosystem (Apple/Google/
Microsoft all lack a credible consumer agent-OS; the current leader in attention, t3code,
has explicitly said no consumer ambitions).

## 2. Platform architecture — one codebase, four surfaces

Already built and the reason none of the new competitors can catch up quickly:

| Surface | What it is today | Status |
|---|---|---|
| **OS app** (macOS/Windows Electron, Ubuntu pkg) | Full desktop: local harness, per-bot VMs, CUA driver, auto-update | Shipped |
| **Web** (muster.orazen.online) | Full product in the browser + marketing site | Shipped |
| **Cloud** (hosted tier) | Hosted harness + $20/mo per cloud computer, Stripe billing | Billing shipped; sandbox orchestration shared with self-host |
| **Self-host** (Docker) | docker-compose, per-provider SSRF-hardened BYOK | Shipped |
| **Mobile** | Native SwiftUI iOS + Expo Android companions | Code + store kits complete; blocked on operator accounts (Apple $99, Google $25, Expo token) |

Strategic rule: **every feature ships on all four surfaces or it doesn't ship.** The harness
API is the product; UIs are views over it. This is what makes "one platform" credible.

## 3. Licensing & subscription architecture

License scaffolding already in place, use it deliberately:

- **Core repo: BSL 1.1** — self-host free forever, personal + internal business use free;
  **competitors may not resell Muster as a managed service** until the Change Date
  (2030-08-19 → Apache-2.0). This is the anti-clone moat; no code needed.
- **`/proprietary` path: MSAL 1.0** — production use under commercial agreement. Home for
  the genuinely closed levers (below).
- **Everything revenue-bearing that is NOT closed-source-able stays free** — the free core
  is the distribution engine.

### SKU ladder (founder decision recorded here)

| SKU | Price | What it is | Surface |
|---|---|---|---|
| **Self-host** | Free | Full product, unlimited bots | Docker/desktop |
| **Cloud Personal** | **$20/mo per cloud computer** ($192/yr) | Hosted harness + managed cloud computers, no setup | Web/mobile |
| **Cloud Pro** | **$49/mo** (3 computers included, +$15 each) | + priority sandboxes, signed-receipt verification branding, rooms beyond limits | Web/mobile |
| **Teams** | **$18/seat/mo** (min 3) | Multi-seat rooms, shared bot roster, admin roles, SSO (Muster Cloud or self-host w/ key) | All |
| **Enterprise** | Custom | MSAL-licensed `/proprietary` modules: org policy gateway, audit export, SSO/SCIM, on-prem sandbox orchestration, support SLA | Self-host/cloud |
| **Marketplace** | 80/20 rev-share | Paid team packs ("hire a finished team") — the template library becomes a store | All |

Pricing psychology: the computer is the metered unit (real compute, real margin); seats are
for collaboration; the free self-host tier is the wedge that feeds the directory/community
flywheel. Never paywall the roster itself.

### Licensing TODO (founder actions, not code)

- [ ] Stripe products for the ladder above (billing portal already wired).
- [ ] Enterprise inquiry address (sales@) + MSAL agreement template.
- [ ] App Store / Play presence (accounts already scoped in growth plan §3) — free companion
      apps, subscription upsell inside cloud.

## 4. Competitive map (full research notes in appendix below)

**Direct (agent roster / agent OS):** nanoclaw, openworklabs, eigent, cherry, Rakazo,
OpenMausBot, Sub8, Omnigent, Multica. **Developer harnesses (adjacent, big but different
buyer):** t3code (21k★), stablyai/orca (48k★), OpenBot. **Differentiated incumbents:** Osaurus
(macOS-local), Cherry (consumer chat client).

The verdict after both research waves: **nobody combines identity + rooms + receipts + BYOK +
cloud computers + four surfaces.** The moat is the combination plus the BSL anti-SaaS clause.

## 5. The build queue (what actually gets us to the valuation)

Priority order — each item is scoped and shippable:

1. **Mobile push-approvals** (blocked on operator APNs/FCM credentials only) — approval cards
   to the phone, deep-link back to the thread. Turns Muster into "a team you can manage from
   anywhere"; unique across every competitor. OpenWork's "Dispatch" validates the idea.
2. **Rooms collaboration polish** — @-mentions, receipt chains per room, presence. Rakazo has
   delegation; Buzz (Block, 31.9k★) validates agents-as-teammates in team chat.
3. **Signed-receipt ecosystem** (shipped 2026-09-02) — keep: export badges, per-room receipt
   chains, embeddable verification widget.
4. **Team packs marketplace** — template library → store (80/20), needs Stripe connect
   decision. Eigent's "Spaces" (versioned agent+skill+connector bundles) validates format.
5. **Org isolation** (multi-tenancy hardening, docs/plans/multi-tenancy-design.md) — the
   real prerequisite for Teams/Enterprise tiers.
6. **Org Connect** — one authenticated MCP/skill-gateway URL for teams (OpenWork's best
   feature); the Teams/Enterprise pillar, rides the MSAL /proprietary path.
7. **Muster Vault** — per-agent key injection with policies/rate limits (NanoClaw's best).
8. **Side-by-side multi-model asks** — one prompt, N roster bots answer side-by-side
   (Cherry's best; trivially built on the dispatch engine).
9. **Distribution**: submit to openalternative.co (account-gated: magic link/Google/GitHub;
   every listed product is open-license + public repo, which Muster satisfies) + Product
   Hunt + awesome lists; botdirectory PRs.

## 6. GTM in one paragraph

Free self-host + directory listings + template marketplace feed the top of the funnel; the
landing page converts with the hire-a-team story; Cloud Personal converts "I don't want
Docker"; signed receipts make every share a marketing asset ("what did your agent do? here's
the verified receipt"); Teams seats turn companies into revenue; Enterprise closes the
compliance buyers. Every surface markets every other surface.

## Appendix A — new-competitor research (nanoclaw / openworklabs / eigent / cherry)

_Filled from the 2026-09-02 live study; see the companion research notes appended at the end
of this file._

## Appendix B — openalternative.co ecosystem study (2026-09-02)

**The directory itself**: an SEO directory of open-source alternatives ("1M+ users replaced
proprietary tools with open source"), built on the Dirstarter template. Listings show stars,
last commit, license, and the proprietary tool replaced. Monetized via sponsor banners, ad
slots, UTM-tracked affiliate links (sponsors: CodeRabbit, c15t, OpenLane, capture.page,
ScreenshotOne, Sevalla, Sent, InfluxDB, Docmost). **Submission**: /submit, gated behind
sign-in (magic link / Google / GitHub) → dashboard; requirements/pricing not disclosed, but
every listed product has an OSS license + public repo. Paid featured placement is a separate
/advertise track — worth it only after Product-Hunt-level traction.

**The 9 listed products studied:**

| Product | What it is | Category | Pricing | License |
|---|---|---|---|---|
| Macro Tasks | Task tracking + agents that open/close tasks (one of five Macro modules) | alt to Linear/ClickUp | not shown | AGPL-3.0 |
| Macro Mail | Keyboard-driven AI email: mail+chat+tasks+agents in one inbox | alt to Gmail/Superhuman | not shown | AGPL-3.0 |
| Macro Chat | Team chat, unified inbox, "@Macro" agent with workspace context | alt to Slack/Teams | not shown | AGPL-3.0 |
| Macro Docs | Markdown docs, CRDT real-time, agents edit with live cursor | alt to Notion/Obsidian | not shown | AGPL-3.0 |
| Macro CRM | CRM auto-built from team email; agents update records | alt to Attio/Salesforce | not shown | AGPL-3.0 |
| Orca (onorca.dev) | 25+ coding agents in parallel git worktrees; terminal/browser/diff review | coding-agent orchestrator | Free | MIT |
| Buzz (buzz.xyz) | Team chat where agents are invited as teammates, read discussions, pick up tasks — by Block, ~31.9k★ | team chat | not shown | Apache-2.0 |
| Omnigent (omnigent.ai) | Harness over coding agents: policy, sandboxing, spend caps, model routing, credential brokering | orchestrator | not shown | Apache-2.0, ~9.6k★ |
| Multica (multica.ai) | Coding agents as team members: profiles, task queues, assignee picker, skills library, monitoring | agent platform | not shown; self-host uncapped | open |

Note: Macro Tasks/Mail/Chat/Docs/CRM are five modules of one product
(github.com/macro-inc/macro, 4,173★, +484%/30d) listed as five entries — smart directory SEO.

**Read for Muster:**

- **Direct competitors from this batch**: Multica (closest — agents as team members with
  rosters/queues/monitoring, coding-focused), Orca (parallel coding agents, 48k★-class),
  Omnigent (governance harness), Buzz (agents-in-team-chat, Block-backed), Macro (workspace-
  level agents). None ships consumer onboarding + cloud computers + signed receipts + BYOK +
  four surfaces — the §4 verdict holds across all 13 products studied.
- **Crowded categories** (per the directory's own trending): coding-agent orchestrators, agent
  platforms, team chat, CRM, docs. **Open lanes Muster already occupies**: "AI workforce for
  non-developers", agent identity/personality, verifiable proof-of-work, metered cloud
  computers. The "AI-native" collection on the site is brand-new — early listings get outsized
  visibility.
- **Action**: submit Muster (self-host Docker = OSS-adjacent story; BSL license is listed for
  other products like Sentry-class tools, so it's not disqualifying), pick the category
  "AI Agent Platforms", point the listing at the self-host docs. Zero cost, founder to do.

### Appendix A — 2026-09-02 study: nanoclaw / openworklabs / eigent / cherry

**NanoClaw** (nanoclaw.dev) — MIT, free, self-hosted agent that lives in chat apps
(WhatsApp/Telegram/Slack/Discord/iMessage…), terminal-driven, one Docker container per
session, SQLite queues. No GUI at all.
- Steal: **Agent Vault** — agents never hold raw keys; a vault injects credentials
  per-request with per-agent policies/rate limits. Stronger than Muster's BYOK storage;
  natural MSAL `/proprietary` or hardening feature ("Muster Vault").
- Steal: per-channel wiring flexibility + scheduled briefings (Muster routines already
  cover scheduling; channel wiring maps to Muster's future chat-app channels).
- Weaknesses to exploit: Docker-only, no GUI, needs a terminal-comfortable owner. Muster's
  wizard + cloud tier is the anti-nanoclaw.

**OpenWork** (openworklabs.com) — ~23.3k★, YC-backed (Different AI), SOC 2 Type I.
Open-source desktop (OpenCode-based) + alpha browser + Cloud. Desktop free/BYOK; Team
Starter first 5 seats free then **$10/seat/mo**; Enterprise custom (SSO, BYO inference).
- Steal: **OpenWork Connect** — org-level MCP/skill gateway: configure MCP servers/skills
  once per org, distribute to every teammate/agent via one authenticated URL with roles and
  policies. This is the Teams/Enterprise-tier killer feature for Muster (maps to MSAL
  `/proprietary` + org isolation roadmap item).
- Steal: **Dispatch** (assign tasks from phone) and **live auto-refreshing artifacts**;
  both validate our mobile push-approvals + receipt-chain roadmap.
- Steal: **agent-installable-via-prompt** (paste a prompt into Claude Code/Cursor and it
  installs/configures the product) — cheap, high-signal distribution trick.
- Weaknesses to exploit: many features alpha/coming-soon; a Claude Cowork clone by its own
  positioning; Muster's shipped consumer polish + onboarding is ahead.

**Eigent** (eigent.ai) — "Cowork" desktop app on CAMEL-AI; open-source + self-host; remote
control via browser/WhatsApp; Spaces (versioned agent+skill+connector bundles with locally
bound secrets). Free tier (1,000 credits) → **Plus $19.99/mo (2,000 credits)** → Pro
$99.99/mo (10,000). Teams "coming soon".
- Validation: their credit pricing confirms hosted-agent compute is a payable SKU; Muster's
  simpler $20/computer-undercuts-credits story is easier to explain and margin-real.
- Steal: **Spaces packaging** → Muster "team packs" marketplace bundles (roster + routines
  + connectors as one install); **approvals that survive interruptions** (Muster's approval
  cards already persist in-thread — verify parity); **event/condition-triggered automations**
  beyond cron for routines.
- Weaknesses to exploit: Teams not shipped, no SOC 2, opaque credit burn. Muster's
  per-computer pricing and receipts are the transparency answer.

**Cherry Studio** (cherryai.com) — AGPL-3.0 Electron client, 300+ assistants, multi-model
simultaneous chat, docs, WebDAV backup; Enterprise edition proprietary (admin, RBAC,
on-prem).
- Steal: **multi-model simultaneous chat** — one prompt fan-out to N roster bots side-by-side
  in the thread; trivially built on Muster's dispatch engine and very demo-able.
- Steal: large persona/assistant library (Muster's 13 shapes + team packs grow here);
  WebDAV/backup export of `~/.muster` state (vault exists — add export).
- Weaknesses to exploit: AGPL deters commercial adopters; no agent-computer concept at all
  (chat client, not workforce). Muster's signed receipts + computers are categorically ahead.

**Four stolen-feature commitments, sequenced into the §5 queue:**
6. **Muster Vault** — per-agent key injection with policies/rate limits (NanoClaw).
7. **Org Connect** — one authenticated MCP/skill gateway URL for teams (OpenWork) — Teams/Enterprise pillar.
8. **Side-by-side multi-model asks** in chat (Cherry) — dispatch fan-out view.
9. **Spaces-style team packs** with bound secrets (Eigent) — marketplace SKUs.
