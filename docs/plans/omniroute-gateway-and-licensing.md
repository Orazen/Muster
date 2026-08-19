# Muster — Multi-Provider AI Gateway & Self-Host Licensing Design
_Companion to `growth-and-monetization-plan.md`. Written after auditing `diegosouzapw/OmniRoute`
(MIT, single-endpoint gateway to 340+ providers) and Dokploy's own self-host-Pro-license model._

## 1. Problem this solves

Muster's current "Install an AI engine" screen requires a **local CLI install per provider**
(Grok, Kimi, Droid, Claude, Codex, Antigravity, OpenCode, Qwen, Hermes). This works, but:
- Every new provider needs a new installer script and a new "is it installed / signed in" probe.
- Users who just have an API key (no interest in installing 9 CLIs) have no fast path.
- There's no way to meter, rate-limit, or upsell around model usage — which is where recurring
  revenue for a hosted "Muster Cloud" tier (see monetization plan §4.1) would actually come from.

OmniRoute's actual value, reduced to what's reusable here: **one gateway endpoint, provider
credentials stored server-side, request routed/rewritten to the right upstream, usage metered
centrally.** That's the shape worth adopting — not a literal dependency on OmniRoute itself.

## 2. Proposed architecture

```
Bot process → OMB_MODEL_GATEWAY_URL (new) → Muster's own gateway route (server/gateway.ts, new)
                                                    │
                                        ┌───────────┼────────────┐
                                   provider A   provider B   provider C
                                (stored key)  (OAuth token) (local CLI passthrough — unchanged)
```

- **Local CLI path stays exactly as-is** — nothing breaks for current users. This is additive.
- **New: `server/gateway.ts`** — a thin HTTP route (`/api/gateway/:provider/*`) that:
  1. Looks up the caller's stored credential for `:provider` (encrypted at rest — reuse the
     `writeFileAtomic` + `chmod 0600` pattern already in `server/auth.ts`'s secret handling, or a
     new `credentials` table in the existing `auth.db` SQLite file, encrypted the same way).
  2. Rewrites the request to the real provider endpoint, injects the real credential, streams the
     response back untouched (SSE/chunked passthrough, same as today's local CLI process piping).
  3. Emits a usage event (`{botId, provider, model, tokensIn, tokensOut, costEstimate}`) to a new
     `usage` table — this is the metering hook a paid tier needs later, and it's free to add now
     while the credential-storage code is being written anyway.
- **New UI**: on the "Install an AI engine" screen, each provider card gets a **third mode**
  alongside "Local CLI" — **"Use an API key"** (paste key, validated with one test call) and
  **"Sign in with OAuth"** where the provider supports it (this mirrors what OmniRoute and rakazo's
  "Pi" broker both do). Falls back to today's CLI-install instructions if the user picks neither.

## 3. Credential storage — concrete plan (reuses code that already exists)

`server/auth.ts` already has exactly the right pattern for a secret nobody but this server should
read: `writeFileAtomic` + `chmodSync(0o600)`, keyed off `DATA_DIR`. Extend it:

```ts
// server/credentials.ts (new)
// One row per (botId | "shared", provider): encrypted API key or OAuth token,
// AES-256-GCM with a key derived from BETTER_AUTH_SECRET the same way Dokploy
// derives its own DB-encryption key from its auth secret — see
// docs/plans/omniroute-gateway-and-licensing.md §5 for why that pattern is
// trustworthy (we independently verified it against Dokploy's own source).
```

This deliberately mirrors the `enc:v1:` scheme audited from Dokploy's `@dokploy/server` package
during this session (`HMAC-SHA256(secret, "muster:credential-encryption:v1")` as the AES-256-GCM
key, IV + authTag + ciphertext framed and base64'd) — a good scheme, worth reusing rather than
reinventing.

## 4. Provider priority (proposed, needs your confirmation)

Ranked by "users most likely to have a key already, lowest integration effort":
1. **Claude** (Anthropic API key) — you already use this constantly; trivial test call.
2. **Codex** (OpenAI API key) — same reasoning, huge existing user base.
3. **Grok** (x.ai API key) — matches Muster's own positioning ("Grok Bot alternative").
4. **OpenCode Go** — already OSS-friendly, likely has a simple key format.
5. Kimi, Droid, Antigravity, Qwen, Hermes — lower priority, add once the gateway plumbing above
   is proven on the first four.

## 5. Self-host "Pro" licensing (Dokploy-style), concretely

Dokploy's actual model, confirmed by reading its own shipped source during this session:
- Core product: **fully open-source, self-hostable, no gate** (Dokploy itself has no license-key
  check anywhere in the code paths audited).
- Revenue comes from **Dokploy Cloud** (hosted, they run the infra) — not from gating self-host
  features behind a key.

Recommendation: **mirror this exactly rather than inventing a license-key gate for self-host.**
A license-key system self-hosters can crack (it's their own server) is a support burden for
negative revenue — Dokploy, Plausible, Uptime Kuma, and most successful open-core self-host tools
all converged on "self-host is 100% free and open, cloud is the paid product" for exactly this
reason. Muster's `IS_CLOUD` flag in `server/billing.ts` already encodes this split correctly.

**Where a paid self-host add-on does make sense** (opt-in, not a feature gate):
- **Managed updates/support contract** — a paid Slack/email support SKU for self-hosters running
  Muster in production (like Dokploy also sells separately from Cloud).
- **Priority bot-template packs** — ties into the marketplace idea in the monetization plan (§4.2),
  works identically for self-host and cloud since it's content, not a code feature gate.

## 6. What's needed from you before any of this is code

1. Confirm provider priority order in §4 (or reorder).
2. Confirm the "no self-host feature gating" recommendation in §5, or tell me specifically which
   features (if any) you do want gated — I'd rather build the metering/usage-tracking plumbing once
   knowing the real answer than guess and rebuild.
3. Decide if `server/gateway.ts` should ship behind a feature flag first (recommended — lets it land
   incrementally without risking the working local-CLI path) or as a full replacement UI flow.

## 7. Sequencing if approved as-is

1. `server/credentials.ts` — encrypted storage, tests, no UI yet.
2. `server/gateway.ts` — routing + usage events for Claude + Codex only (prove the pattern).
3. UI: "Use an API key" mode on the two proven provider cards.
4. Expand to remaining providers from §4 once the first two are live and tested.
5. Usage table feeds into a future "Muster Cloud" billing dashboard (out of scope here — tracked in
   the main monetization plan).
