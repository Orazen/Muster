# CEO decisions: OpenSandbox integration + pricing strategy
_Written in-character as founder, per explicit direction to make the calls that were previously
left open. Backed by evidence gathered this session, not guesses._

## 1. OpenSandbox — DECIDED: integrate as a self-hosted "computer" alternative

### What it is (audited from source, `opensandbox-group/OpenSandbox`)
- 14,430★, Apache-2.0, backed by Alibaba (`com.alibaba.opensandbox` package namespace).
- Self-hostable sandbox runtime: Docker locally, Kubernetes at scale, official JS/TS/Python/Go/
  Java SDKs, a documented OpenAPI lifecycle spec (`OPEN-SANDBOX-API-KEY` header auth, runs on
  `localhost:8080` for local dev — i.e. genuinely runnable on your own infra, not just a hosted
  product).
- Real security posture: Cosign-signed images, gVisor/Kata/Firecracker isolation options,
  OpenSSF Best Practices badge, CNCF landscape listing.

### Why this matters for Muster specifically
Muster's only "cloud computer" today is `server/drivers/boxagent.ts`, which talks exclusively to
`box.ascii.dev` — a single paid third-party vendor. The Settings screen you showed me
("No cloud computer configured. Add a Box API key...") is the whole story: self-hosters who don't
want to pay a third party for this feature currently have zero alternative, which cuts directly
against Muster's own self-host positioning.

### Decision: build it, scoped correctly
OpenSandbox is **not** a drop-in replacement for `BoxAgentDriver` — Box's API is "run an AI agent
for me inside this box" (`POST /boxes/{id}/prompt`), a higher-level abstraction than OpenSandbox's
"give me a sandbox, let me exec commands and manage files in it." The correct integration point is
architecturally the same shape as Muster's existing **Local VM (Cua)** feature — a shared sandbox
bots can drive with shell/browser tools — except hosted on OpenSandbox instead of local
Docker/Podman/Colima. That also solves the Local VM screen's own blocker ("Install a supported
container runtime first") for anyone who'd rather point at a remote OpenSandbox server than
install one locally.

**Sequencing:**
1. `server/drivers/opensandbox.ts` (new): lifecycle create/exec/file operations against the
   OpenSandbox REST API, using the official `@alibaba-group/opensandbox` TS SDK as a dependency
   rather than hand-rolling the OpenAPI client.
2. Wire it as an alternate backend for the existing Local VM computer-use tools (same shape as
   `server/drivers/local-inject.ts`'s tool surface), not a new driver kind end users have to
   understand — from the bot's perspective, "the computer" just has two possible backends now.
3. Settings: alongside "Box API key," add "OpenSandbox server URL + API key" (self-hosted
   deployments point this at their own OpenSandbox instance; nothing changes for people who keep
   using Box).
4. Ship behind the same "Optional" framing as Box today — additive, not a replacement, no existing
   user's setup breaks.

This is real build work (a full driver + tool-surface wiring, matching the effort of the 12
provider drivers already shipped this session) — scoped and ready to start, not started yet in
this pass, since it deserves its own focused session rather than being squeezed in.

## 2. Figranium — DECIDED: not integrating

GPL-3.0. Embedding GPL-licensed code directly into Muster's own codebase would put the combined
work under GPL's copyleft terms — in direct tension with Muster's BSL 1.1 (and its post-2030
Apache-2.0 conversion). Consuming figranium purely as an external HTTP service (never vendoring
its code) would sidestep the licensing conflict, but the actual capability — visual browser-
workflow building — doesn't address a gap Composio's existing 500+ app connectors and the
computer-use tools don't already cover. Not worth the legal surface area for unclear incremental
value. Revisit only if a specific browser-automation gap is identified that Composio can't fill.

## 3. Pricing — DECIDED, as founder, since explicitly asked to make this call

### Structure
- **Self-host: $0, forever, unconditionally.** Already decided and evidence-backed (Dokploy,
  OpenMausBot both converged here independently; BSL 1.1 already protects against a competitor
  reselling this exact code as a rival SaaS, so free self-host costs nothing in competitive terms).
- **Muster Cloud: the paid product.** Given the multi-tenancy work required (see
  `docs/plans/multi-tenancy-design.md`) is not yet built, Cloud is a future product, not something
  to price and ship today — but the target shape below is decided so engineering has a north star.

### Cloud tiers (USD reference pricing)
| Tier | Price/mo | What it includes |
|---|---|---|
| **Free** | $0 | 1 bot, bring-your-own model keys, no cloud computer (local CLI only) — a real trial, not a crippled demo |
| **Pro** | $20/mo | Unlimited bots, 1 always-on managed cloud computer (the OpenSandbox-backed one from §1, run on our infra), Composio connected apps, priority support queue |
| **Team** | $60/user/mo | Everything in Pro + shared bot rosters across a team, org-level billing, SSO (this is exactly the kind of feature that could live in the `/proprietary` scaffold from the licensing doc if it's ever built as a self-host add-on too) |

Anchored against the closest real competitor with public pricing signal from this session's
audits: rakazo's positioning and typical AI-coding-tool SaaS pricing in this exact bracket
($20/mo individual, $50-60/user team) — not invented from nothing.

### Regional/currency pricing — DECIDED: adopt Purchasing Power Parity (PPP) adjustment
This is standard, evidence-backed SaaS practice (Spotify, Netflix, JetBrains, and most successful
global subscription products all do this) — charging India, Brazil, or Indonesia the same $20 as
the US measurably kills conversion in markets where $20 is a much larger fraction of income, while
charging everyone US pricing leaves real revenue on the table in high-income markets by under-
pricing nothing there.

**Mechanism:** use a PPP index (World Bank PPP conversion factors are public and free), bucket
countries into 3-4 pricing tiers relative to US pricing, and let Stripe's own multi-currency
support handle actual currency conversion/display — no need to build custom currency logic.

Illustrative buckets (PPP-adjusted, Pro tier $20 US baseline):
| Bucket | Example countries | Pro tier (local pricing power equivalent) |
|---|---|---|
| Tier 1 (100%) | US, UK, Germany, Japan, Australia, Canada | $20 (or local-currency equivalent at market FX) |
| Tier 2 (~65%) | Brazil, Mexico, Poland, Turkey | ~$13 equivalent |
| Tier 3 (~40%) | India, Indonesia, Nigeria, Philippines | ~$8 equivalent |
| Tier 4 (~25%) | Pakistan, Bangladesh, Ethiopia | ~$5 equivalent |

**Guardrail against arbitrage:** IP-based geolocation at checkout (Stripe Tax/Radar can do this),
lock the tier to the account's billing country, and disallow VPN-detected mismatches from claiming
a lower tier — standard implementation, not a new problem to solve from scratch.

### What's still open
1. Confirm/adjust the $20/$60 anchor prices — reference point, not gospel.
2. Confirm PPP as the model (vs. flat global USD, which is simpler to build but leaves real
   emerging-market revenue on the table based on how every large successful comparable prices).
3. Timing: this entire pricing structure is moot until Muster Cloud (multi-tenancy) actually
   exists — so this is a north star for engineering + business planning, not a today action item.
