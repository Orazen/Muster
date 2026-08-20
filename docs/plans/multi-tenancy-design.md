# Muster — Multi-Tenant Data Isolation Design
_Written after live-confirming, on `muster.orazen.online` production, that two unrelated
accounts see the identical bot (same ID) — see `muster/tenant-isolation-incident` context.
Root cause: `cfg`, `store`, `registry`, `bus`, and every other piece of server state in
`server/index.ts` are module-level singletons — one per process, zero per-user scoping._

## 1. Why this exists, and why it isn't a bug in the usual sense

Muster's server was built for **one person, one deployment** — a personal desktop app, or a
self-host you run for yourself. `~/.muster/config.json`, `bots.json`, `messages.db`,
`auth.db` are all just files on one machine. That model is entirely correct for the vast
majority of how Muster actually gets used (desktop app, personal self-host).

The auth system added this session (sign-up/sign-in/sign-out) controls **access** to that one
deployment — it was never a multi-tenancy layer, and nothing downstream of `AuthGate` was ever
changed to be aware that more than one distinct person might be signed in. Standing up
`muster.orazen.online` as a **publicly signup-able site** exposed that mismatch: every account
shares the one deployment's one set of everything.

**This doc is specifically about `Muster Cloud`-shaped hosting** (see
`docs/plans/omniroute-gateway-and-licensing.md` and `growth-and-monetization-plan.md`) — a
deployment meant to serve many unrelated people. Typical self-host (one person, their own
Docker container or their own machine) needs none of this; today's architecture is already
correct for that case and should stay simple.

## 2. What's actually global today (the concrete list)

All module-level, in `server/index.ts` unless noted:

| Singleton | What it holds | Isolation needed |
|---|---|---|
| `cfg` (`server/config.ts`) | provider API keys, instance config, profile | per-tenant |
| `store` (`server/store.ts`) | bots, threads, messages, groups | per-tenant |
| `registry` (`ProviderRegistry`) | live driver instances (spawned CLI processes, open API connections) | per-tenant |
| `bus` (`EventBus`) | SSE fan-out to connected browser tabs | per-tenant (a tenant must only ever receive their own events) |
| `composio` sessions (`server/composio.ts`) | connected-apps auth state | per-tenant |
| `localVmLease`, `routines`, `watchdog`, and ~15 other module-level `Map`s tracking turn/activity state | in-flight operational state | per-tenant |
| `auth.db` (Better Auth) | **already correctly scoped** — `user`/`session`/`account` rows are already per-user; this part is fine | — |

## 3. Two architectural directions

### Option A — one process, N in-memory tenant contexts
Replace every module-level singleton with a `Map<tenantId, TenantContext>`, lazily created on
first authenticated request for that tenant, evicted after some idle period. Every route
handler resolves `getTenant(session.activeOrganizationId)` before touching `cfg`/`store`/etc.

- **Pro:** one deployment, one container, cheapest to run.
- **Con:** `server/index.ts` is ~3,700 lines with dozens of closures capturing these
  singletons directly (`bus.attach`, `store.appendMessage`, driver event listeners, the SSE
  broadcast loop...). Making all of it tenant-parametric is a genuine rewrite, not a
  refactor — and it's exactly the kind of sweeping, hard-to-fully-test change that produced
  several of the subtle bugs found and fixed this session (the `??` vs `||` bug, the dropped
  request body, the auto-discovery signing bug). High risk of new, hard-to-spot cross-tenant
  leaks if any one of those dozens of closures is missed.
- Also has a real resource ceiling: driver instances hold live child processes (CLI agents)
  and open connections. N tenants' worth of these in one process is a hard capacity limit
  before this even becomes an isolation question.

### Option B — one process per tenant (recommended)
Spin up a dedicated Muster server instance per organization — literally today's single-tenant
`server/index.ts`, completely unmodified — behind a thin multi-tenant gateway that routes an
authenticated request to the right instance by `organizationId`.

- **Pro:** zero changes to the 3,700-line server's business logic — it stays exactly the
  single-tenant program it already is, already tested, already understood. Isolation is
  structural (a different OS process, different `~/.muster` equivalent directory or container)
  instead of "we hope every closure remembered to scope correctly."
- **Pro:** this is the *same pattern Muster already implements* for bot sandboxing (per-bot
  cloud computers, Docker/Box isolation) — extending "one isolated environment per bot" to
  "one isolated environment per tenant" is architecturally consistent with what the product
  already does, not a new paradigm.
- **Con:** real infra to build: process/container orchestration, port or Unix-socket
  allocation per tenant, idle shutdown (a tenant with nobody connected shouldn't burn
  resources indefinitely), and a gateway that authenticates a request once (shared `auth.db`,
  or a dedicated control-plane DB) then proxies to the correct backend.
- This is genuinely the shape of "Muster Cloud" as a product (see the monetization plan) —
  this isn't overhead specific to fixing the bug, it's the same infrastructure a paid hosted
  tier needs anyway.

**Recommendation: Option B.** Lower risk (no rewrite of already-fragile shared state logic),
reuses an isolation pattern the codebase already trusts, and the infra work directly becomes
the hosted-tier product rather than being throwaway plumbing.

## 4. Concrete building blocks for Option B

1. **`organization` plugin** (`better-auth/plugins`) — confirmed available in the installed
   `better-auth@1.7.1`. Gives `organization`, `member`, `invitation` tables and
   `session.activeOrganizationId` for free. One organization = one tenant = one backing
   Muster instance.
2. **Control-plane service** (new, small): owns `auth.db` (shared — this part is already
   correctly scoped per-user) and an `organization -> backend` mapping. On a request, resolves
   the session's `activeOrganizationId`, looks up (or lazily provisions) that org's backend,
   proxies the request there (WebSocket/SSE-aware proxy, since Muster's live updates ride SSE).
3. **Per-tenant backend**: today's `server/index.ts`, run as-is, one instance per organization,
   each with its own `OMB_DATA_DIR` (already exists as an env var — this is the existing
   per-deployment data-root knob, just now one per org instead of one for the whole box).
   Container-per-tenant (reusing the Docker/E2B/Daytona sandbox patterns already in Muster's
   own bot-computer code) is the natural implementation.
4. **Idle eviction**: stop a tenant's backend container after N minutes with no open SSE
   connection and no in-flight turn; the control plane starts it back up on the next request
   (accepting one cold-start hit) — same operational shape as serverless/sandbox platforms.

## 5. What does NOT need to change

- Self-host for a single person/team sharing trust (the common case) — unaffected, still just
  runs `server/index.ts` directly like today.
- `auth.db`'s schema — already correctly per-user.
- Any of the driver/provider code shipped this session (OpenAI, Anthropic, the 6
  OpenAI-compatible providers, Google, Cohere, OpenCode Zen) — these are tenant-agnostic by
  construction (credentials come from `cfg`, which becomes per-tenant under Option B with zero
  driver-code changes).

## 6. Sequencing

1. Add the `organization` plugin to `server/auth.ts`; migrate `auth.db` (Better Auth handles
   this automatically via its own migration path).
2. Build the control-plane service: session → org resolution, org → backend registry (can
   start as a static in-memory map for a handful of orgs before real orchestration exists).
3. Containerize `server/index.ts` as a per-tenant unit (it's already close — the existing
   Dockerfile builds exactly this).
4. Build the proxy layer (HTTP + SSE passthrough) in the control plane.
5. Add provisioning (create a new tenant backend on first sign-up into a fresh org) and idle
   eviction.
6. Migrate `muster.orazen.online`'s current single shared backend to be "tenant zero" under
   the new control plane, rather than a special case.

## 7. Open questions for you

1. Is `muster.orazen.online` meant to become the real paid "Muster Cloud" product, or is it
   currently just your own working install that happened to get a public sign-up page? If the
   latter, the actual fix might be simpler: keep it single-tenant, keep sign-up closed
   (already done), and skip this entire project until there's a real reason to support
   multiple people.
2. If Cloud is real: rough timeline/priority relative to the provider-gateway and licensing
   work already scoped? This is a multi-week build, not a multi-day one.
3. Container orchestration preference — plain Docker on the existing Dokploy-managed VPS
   (matches current infra), or something with a real API (Fly.io machines, E2B, Daytona — all
   already referenced in `growth-and-monetization-plan.md`'s competitive audit of rakazo)?
