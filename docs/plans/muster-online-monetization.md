# Muster Online — monetization & growth strategy

*Researched 2026-08-23. Teardown of Dokploy's model applied to Muster's existing
billing scaffolding (`server/billing.ts`), plus payments-provider guidance,
monetization ideas ranked by leverage, and the viral-branding plan.*

---

## 1. Dokploy teardown — what actually makes them money

Dokploy sells **operational convenience**, never core features. Four editions:

| Edition | Price | What you get |
|---|---|---|
| Self-Hosted OSS | free | full engine, no feature withheld, no license key ever |
| Cloud | from **$4.50/mo per server** | they run the control plane; auto-updates; managed uptime |
| Enterprise Self-Hosted | license key (contact sales) | SSO/SAML, SCIM, audit logs, custom roles, **whitelabel**, air-gap OK |
| Enterprise Cloud | custom | same enterprise gates + SLA |

The mechanics worth copying:

1. **One engine, four wrappers.** Every edition runs identical deployment code.
   Paid tiers differ only in *who operates it* and *team/compliance features*
   (SSO, SCIM, audit). Nothing a solo dev needs is gated.
2. **Metered unit = servers** ($4.50 each). Simple, predictable, maps 1:1 to
   their cost driver. Annual billing = −20%.
3. **Enterprise self-host via license key** validated against their license
   server — companies pay to stay on their own infra, including air-gapped.
4. **Distribution = the free OSS itself.** Stars → Discord → cloud conversions.
   Their pricing page funnels hard toward "you don't want to maintain this."

### Muster already has the skeleton

`server/billing.ts` ships the same philosophy today: `MUSTER_CLOUD=true` flips
it on, self-hosters are never asked for a key, nothing is withheld, Stripe REST
(no SDK), **metered unit = cloud computers** (the right unit — bots are free
until one gets hands). Stripe stays the source of truth; nothing caches
"is paid" locally. This *is* the Dokploy model. What's missing is the
**customer-facing half**: signup, checkout, portal, plans, and the enterprise
tier decision.

## 2. Implementing Muster Online — concrete build order

1. **Cloud signup + auth** (biggest gap): hosted web app wrapping the existing
   harness. Email magic-link (email.ts exists) + Google/GitHub OAuth.
   `ownerId` multi-tenancy is already threaded through the API gate.
2. **Checkout**: `createCheckoutSession` / `createPortalSession` /
   webhook verification already exist in billing.ts. Ship three plans mirroring
   Dokploy's shape, metered on computers not bots:
   - **Free** — 0 always-on computers, ephemeral sessions only (still magical,
     costs us ~nothing)
   - **Pro $20/mo** — 1 always-on computer, +$7/computer, unlimited bots/tasks
   - **Team $49/mo base** — 5 computers included, shared workspaces, +$7 each
   - Annual −20%, exactly Dokploy's lever for cash-flow and churn-cutting.
3. **Enterprise tier (later)**: license-key unlock for self-host orgs needing
   SSO/SCIM/audit/whitelabel. Do **not** add this until a customer asks — the
   billing.ts promise "no feature is withheld from self-hosters" is a
   competitive weapon while Muster is unknown; keep it pure.
4. **Payments rails**: Stripe direct is correct for the metered cloud
   (already built). If a **license-key product** ever ships (desktop Pro,
   enterprise), use **Polar** (4% + 40¢, merchant-of-record — global sales tax
   handled, built-in license keys, GitHub repo grants, Discord role grants).
   Avoid Lemon Squeezy going forward (absorbed by Stripe). Never sell the
   App Store/mobile sub through anything but IAP.

## 3. Monetization ideas, ranked by leverage

1. **Cloud subscription (metered computers)** — the core business. Bots free,
   hands cost money. Predictable, margin-positive, already coded.
2. **Done-for-you tasks / task packs** — sell outcomes: "research this and
   write the report" bundles. Agencies (Orazen!) can fulfill manually at first,
   automate later. Highest willingness-to-pay; zero engineering day one.
3. **Template/profile gallery with rev-share** — Muster equivalents of
   Dokploy's 1-click templates: ready-made bot teams ("Growth team",
   "Support trio"). Free drives distribution; paid packs split 70/30.
   PR-driven catalog = community writes your marketing.
4. **Team seats & shared workspaces** — the natural Team-plan upsell; multi-user
   is where Dokploy puts its paywall too (RBAC, orgs, environments).
5. **Mobile companion subscription** — push-notified bots on iOS/Android via
   IAP (Apple takes 15–30%, unavoidable); position as convenience tier of the
   same cloud account, not a separate product.
6. **Orazen services funnel** — every Muster install is a warm lead for the
   agency's AI/Web/Automation services. Zero-cost, high-margin adjacency;
   whitelabel agency plan later ("run Muster for your clients") is Dokploy's
   Agency play.

## 4. Viral branding — how to be uncatchable

The moat is not features (clones appear weekly — the Orazen star feed alone
shows several Grok-bot clones). The moat is **distribution + identity**:

1. **The mascots ARE the brand.** Competitors ship CLI chrome; Muster ships
   characters with names, colors, expressions. Double down: expression packs,
   seasonal mascots, shareable "my team" cards (a rendered image of your bot
   roster with names/mascots — inherently tweetable). Starred refs:
   `sam70361/emotion-ball` (pure-SVG emotion engine, drops straight into
   `mascotExpression`) and `jeremy-prt/bloub` (one SVG morphing through 14
   states — the exact technique).
2. **Show hands, not UI.** Every post = a screen-recording of a bot actually
   doing a real task end-to-end (booked the flight, filed the issue, made the
   slide deck). "Your bots have hands" is a category claim clones can't match
   without the computer-use harness.
3. **Awesome-list flywheel**: publish `awesome-muster` (profiles, skills, team
   templates, PRs as write-API — the `mergisi/awesome-grokbot` pattern) and an
   agent-run directory like `ZeroPointRepo/GrokBotDev`. Community-authored
   content outranks any ad budget and compounds.
4. **GitHub-stars playbook** (Dokploy's actual growth engine): Show HN +
   r/selfhosted launch, README GIF above the fold, one-command Docker run,
   fast issue response, monthly changelog posts. Stars → trust → cloud signups.
5. **Self-host as marketing, not lost revenue**: the free tier is the top of
   the funnel and the reason to star. Keep it genuinely great (billing.ts
   already promises this).
6. **Own the niche language**: "muster your team", bots that "have hands",
   "chief of staff". Category vocabulary is defensible in a way features
   aren't.

## 5. Orazen starred repos — what's usable for Muster

| Repo | Use |
|---|---|
| `sam70361/emotion-ball` | drop-in SVG emotion engine for mascots (branding moat #1) |
| `jeremy-prt/bloub` | morphing-avatar technique for mascot states |
| `s1dashu/ip-as-logo-skill` | generate the IP mascot logo set via agent skill |
| `citrolabs/ego-lite` | share-logged-in-browser tool candidate for bot computer use |
| `cloudflare/computer` | alternative cloud-computer backend for Muster Cloud fleet |
| `VoltAgent/awesome-design-md`, `greensock/gsap-skills` | UI polish pipeline for the desktop/web app |
| `mergisi/awesome-grokbot`, `ZeroPointRepo/GrokBotDev` | templates for the awesome-list/directory flywheel |
| `deepseek-ai/deepseek-harness` | plugin-ecosystem architecture reference |
| Grok-bot clones (`open-grok-bot`, `OpenGrokBot`, `guaca`, …) | competitive telemetry — watch their differentiation weekly |

No checkout library was starred; none is needed — `server/billing.ts`'s
dependency-free Stripe REST client already covers cloud checkout. Add Polar
only when a license-key SKU exists (§2.4).
