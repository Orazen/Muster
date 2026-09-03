# Muster AGI-OS — eco-platform plan (the "nothing else like it" blueprint)

_Founder/CTO strategy, 2026-09-03. Third research wave: 15 products studied live
(treg.to, inline.chat, UmbrelOS, OmaBot, Squad, Flayr Max, PortOS, holaOS, Mercury OS,
Fabric, Puter, Cua, BrowserOS, Osaurus re-check, NodeOS/cloudflare-os). This doc
integrates everything into one platform plan: Muster CLI, Muster OS, Muster Cloud chat,
and the sync fabric that makes them one thing. Supersedes the "build queue" in
muster-platform-strategy.md §5 where they overlap._

## 0. The synthesis (why the field keeps validating us)

Every product in three research waves is a **slice** of what Muster already is:

| They built | Their slice | Muster's equivalent |
|---|---|---|
| UmbrelOS | self-host app-store OS | Muster OS + self-host + (planned) store |
| Squad | AI teammates on cloud computers, $99/mo | roster + $20/computer + rooms |
| BrowserOS | agentic browser w/ session replay | Obscura tools + (planned) replay |
| OpenWork / PortOS / Fabric | org orchestrators over CLI agents | chief-of-staff + dispatch + BYOK |
| Puter / cloudflare-os | web OS w/ sandboxed AI apps | Muster OS (web surface) |
| NanoClaw / Inline | agents in chat apps | rooms + (planned) chat bridges |
| t3code / Cua | harnesses + computer-use infra | harness + cua-driver (already a supplier) |
| Eigent / Flayr Max | desktop agent w/ schedules + spend caps | routines + Vault budgets |
| OmaBot | ambient workforce status | (planned) presence surface |
| Mercury OS | intent-driven UX concept | (planned) Muster OS interaction model |

**Nobody ships identity + rooms + receipts + BYOK + browser + computers + four surfaces.**
The plan below binds the remaining slices into one platform and names the sync fabric
that makes OS, web, cloud chat, and CLI feel like a single organism.

## 1. The five surfaces, one organism

```
        ┌──────────── muster.orazen.online (Cloud) ────────────┐
        │   identity · rooms · receipts · billing · pairing    │
        └───────┬──────────────────────┬───────────────────────┘
                │ sync fabric (SSE + CRDT-lite deltas)         │
   ┌────────────┴───────┐      ┌───────────────┬──────────────┐
   │ Muster OS (desktop) │      │ Web (/app)    │ Muster CLI   │
   │ local harness, VMs, │◄────►│ cloud chat,   │ pair, roster,│
   │ CUA, Obscura        │      │ approvals     │ send, watch  │
   └─────────────────────┘      └───────────────┴──────────────┘
                ▲                              ▲
                └──── mobile companions (built, store-blocked) ────┘
```

Surfaces already shipped: desktop, web, cloud (billing included), self-host, mobile
code. **The missing surface is the CLI** — and it is also the cheapest: the pairing
API (`/api/pair/create` → code → `/api/pair/verify` → session) was built for the
desktop companion and works for a terminal client unchanged.

## 2. Ship now: Muster CLI (`muster`)

The t3code/Orca lesson: agents and terminal people are the *distribution* layer. A CLI
makes Muster callable FROM other agents, scripts, and cron — and makes `npx muster`
the top-of-funnel.

Scope (one file, ~300 lines, zero deps beyond node's fetch):

```
muster pair                     # print the cloud pairing code + URL (or redeem one)
muster bots                     # roster: name, engine, busy/activity, budget left
muster send <bot> <text>        # send a turn, stream reply to stdout
muster watch <bot>              # tail the thread live (SSE → plain text)
muster approve [allow|deny]     # answer the oldest pending card
muster status                   # fleet summary: busy, waiting-on-you, spend
muster receipts [n]             # last N job receipts, signed, copy-ready
```

Config: `~/.muster/cli.json` = `{ base, cookie }` written by `muster pair`. Local
desktop installs work with zero pairing (loopback session); cloud pairs via code.
Ship as `bin: { muster: ./cli.mjs }` in package.json + `npm i -g` path; also publish
the file standalone for curl-install.

## 3. Ship next: the sync fabric (the actual moat)

The "all will sync together" ask, made concrete. One rule: **the cloud is the
identity + ledger; each surface is a cache with write-through.**

- **Identity**: already account-scoped (onboarding gate, owner-scoped bots).
- **Roster sync**: bots/groups already replicate via SSE `bot`/`group` frames — the
  CLI and mobile read the same stream. Add `since` cursors so a reconnecting client
  gets a delta, not a refetch.
- **Receipt chain**: signed receipts are content-addressed (hash of canonical JSON);
  surfaces verify locally against the public verify endpoint — no cloud round-trip
  needed for trust.
- **Cross-surface handoff**: "start on desktop, approve from phone" — approval cards
  already broadcast on the SSE stream; the CLI `muster approve` and mobile push
  subscribe to the same events. This is the openalternative-class differentiator:
  **Squad charges $99/mo for what is a Tuesday here.**
- **Conflict rule**: last-write-wins on scalar bot fields; append-only on messages,
  transcripts, receipts (never merged, always ordered by server receipt).

## 4. Stolen-with-credit roadmap (ranked by effort × impact)

| # | Feature | From | Effort | Why it beats them |
|---|---|---|---|---|
| 1 | **Muster CLI** (§2) | t3code/Orca pattern | S | callable-from-agents distribution nobody in the roster class has |
| 2 | **Ambient presence**: "who's waiting on you, longest wait first" as a menu-bar/OS-dock element | OmaBot | S | the killer glanceable state; OmaBot proved demand on 1.2k★ |
| 3 | **Daily USD spend cap + kill switch** per agent | Flayr Max | S | Vault budgets in $$ terms + one-tap halt-all |
| 4 | **Session replay** for Obscura: scrubbable video + action timeline stored beside the receipt | BrowserOS | M | receipts prove what happened; replay SHOWS it — no competitor pairs both |
| 5 | **Recipes** marketplace: one-click (model + persona + tools + budgets) bundles | holaOS HolaHub / Umbrel store | M | the store is the ecosystem flywheel |
| 6 | **Org Connect** (team MCP/skill gateway w/ roles) | OpenWork | M | Teams/Enterprise pillar (already queued) |
| 7 | **Per-agent identity bundle**: own email + browser profile + scoped tool grants | Squad | M | turns personalities into true coworkers |
| 8 | **Account stacking + mid-task fallback** across BYOK providers | Squad + Treg | M | free-tier users get resilience; paid users get uptime |
| 9 | **Intent-first Muster OS**: rooms/tasks assembled per intent, pull-only notifications | Mercury OS | L | the UX thesis that makes Muster OS an OS, not an app |
| 10 | **Gadgets**: AI-built mini-apps in sandboxed no-network iframes | cloudflare-os | L | every artifact is safe to run; agent-built UI ecosystem |
| 11 | **Peer SDK**: first-party storage/KV/AI APIs agents can call in-turn | Puter | L | agents that build + persist = platform lock-in done right |
| 12 | **Trajectory export** for computer-use sessions | Cua | L | training/audit data export; cua is already a supplier |

## 5. The eco flywheel

```
CLI (npx muster) ──► free self-host ──► directory listings ──► roster grows
     ▲                                                      │
     │                                                      ▼
recipes store ◄── community packs ◄── signed receipts shared ◄── bots do work
     │                                                      ▲
     └──► Teams/Enterprise (Org Connect, identity bundles) ◄─┘
```

Each loop feeds the next: CLI users become self-hosters, self-hosters share verified
receipts (marketing), shared receipts create demand for packs, packs create demand for
Teams. **Umbrel's store + Squad's pricing + t3code's distribution + Mercury's UX thesis
= the AGI-OS category, and no single competitor spans more than one slice of it.**

## Appendix D — wave-3 study notes (2026-09-03)

### Group 1: treg.to / inline.chat / UmbrelOS / OmaBot / Squad / Flayr Max / PortOS / holaOS

- **Treg** (AGPL): "OpenRouter for agent tools" — 2,630 endpoints/47 providers, one key,
  measured success-rate routing, per-call ~$0 markup, server-side credential injection.
  Steal: measured routing for BYOK; per-call pricing as a Cloud tier complement.
- **Inline Chat** (Apache-2.0, 689★): thread-based chat where agents join via CLI/MCP;
  Rust; SQLCipher local DB; Matrix bridge; voice stack. Steal: rooms-as-threads with
  first-class agent membership (have it) + a Matrix bridge (queued idea).
- **UmbrelOS** (PolyForm NC, 11.9k★): home-server OS, 300+ app one-click store, GPU
  accel, Tor, FailSafe storage. Steal: curated store UX + "cloud convenience, you own
  the data" onboarding. v2 stable due 2026-09-22 — watch their store taxonomy.
- **OmaBot** (Apache-2.0): Omarchy bar widget parsing the desktop app's local state;
  avatars sorted by wait; redact mode. Steal: ambient presence + expressive avatar
  states encoding wait-time.
- **Squad** ($99/mo): named teammates, own email + browser profile + scoped tools on
  dedicated cloud computers, account stacking w/ mid-task fallback, approval queue,
  daily send caps, secret vault, action log, AI chief-of-staff onboarding. Steal:
  identity bundles, stacking/fallback. Their $99+subscriptions price is our $20 wedge.
- **Flayr Max** (MIT, macOS 26+): menu-bar agent, ⌥Space, scheduled loops, Telegram/
  Discord/Slack/iMessage + SSH control, command approvals + denylist + daily USD cap
  + kill switch + actions.log. Steal: USD cap + kill switch, scheduled loops.
- **PortOS** (MIT): "Umbrel for repos/AI workflows" — project tiles, Autofixer for
  crashed processes, chief-of-staff over CLI agents, Second Brain (BM25+vector),
  Tailscale-only trust. Steal: Autofixer; the cautionary tale is their zero-hardening.
- **holaOS** (modified Apache): HolaApps live side-by-side app UIs w/ two-way context,
  IM context with per-tool approval, 100+ OAuth, Combos, shared memory as editable
  local files, HolaHub recipes. Steal: recipes + human-readable shared memory.

### Group 2: Mercury OS / Fabric / Puter / Cua / BrowserOS / Osaurus / NodeOS / cloudflare-os

- **Mercury OS** (concept, 2019): intent-driven Modules→Flows, pull-only "Focused"
  mode, designed for low executive function. It is vaporware — the thesis is free to
  execute, and Muster OS (rooms = modules, receipts = flows, approval pull) is the
  first real implementation candidate.
- **Fabric** (fabric.pro, SaaS): 50+ named agents in an org hierarchy, decision
  lineage, artifact diffs, 100+ MCP. Cloud-only. Steal: named-agent org chart UI,
  decision lineage beside signed receipts.
- **Puter** (AGPL): Internet OS — web desktop + developer cloud APIs (storage/KV/
  serverless/AI) + app store. Steal: the peer-SDK pattern and rooms-as-apps store.
- **Cua** (22.1k★, MIT+): drivers that click/type/verify without stealing focus,
  Cua-Bench with trajectory export, Lume Apple-Silicon VMs, run.cua.ai fleets. Muster
  already uses cua-driver; the steal is trajectory export + focus-free default.
- **BrowserOS** (open): Chromium fork w/ agent; "neo" second-browser-for-agents;
  logged-in profile import; per-tab agent dashboard; scrubbable session video replay
  stored locally. Steal: replay+timeline beside receipts; logged-in state import for
  Obscura.
- **Osaurus re-check**: NEW since last study — per-agent Linux Sandbox (Apple
  Containerization), crypto Identity chain (secp256k1 + revocable osk-v1 keys),
  Relay + E2E Secure Channel, fail-closed 1.5B privacy filter, subagent spawn.
  Mac-only ceiling unchanged. Steal: identity chain hardening for receipts; their
  sandbox validates our per-bot VMs.
- **NodeOS** (dormant since ~2017): npm-as-userspace. Steal: per-agent isolated
  workspace that runs its own init — matches our per-bot workspace direction.
- **cloudflare-os** (9.6k★, Apache-2.0): NOT an OS — Cloudflare's internal AI
  productivity env on Workers. Gatekeepers (capability-wrapped OAuth w/ human approval
  before outbound actions), gadgets (AI-built apps sandboxed w/o network), blueprints,
  multiplayer via Durable Objects. Steal: gadgets' no-ambient-network rule (same
  posture as our VM caps); Gatekeepers ≈ approval cards — theirs is service-scoped,
  ours is action-scoped (finer).

- **hermesbible.com**: community docs for Nous Research's Hermes Agent (SOUL.md
  persona files) — confirms persona-file ecosystems are trending; our team packs
  should support SOUL.md import.
- **ua-parser-js**: utility only; useful for the mobile/web surfaces' client
  fingerprinting, not strategic.
