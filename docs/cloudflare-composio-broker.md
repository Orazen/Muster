# Deploying the `muster-composio` Cloudflare Worker

The Composio broker is a standalone Worker in [`cloudflare/composio-broker/`](../cloudflare/composio-broker/).
It proxies MCP traffic to Composio, records installations in D1, and rate-limits
registration. Deploying it needs a maintainer with a Cloudflare account — this
page is the runbook; the code-level README lives beside the source.

Verified offline (no account needed): `npx wrangler deploy --dry-run` bundles
cleanly with every binding resolved, and the worker's vitest suites pass
(22/22 as of 30 Sep 2026).

## What you need

- A Cloudflare account with Workers **deploy** permission and access to the
  `muster-composio` D1 database (id in `wrangler.jsonc`).
- `node` >= 23.4 (repo requirement; native deps build under Node 24).
- The Composio API key (secret `COMPOSIO_API_KEY`).

## Steps (about ten minutes)

```sh
cd cloudflare/composio-broker
npx wrangler login            # opens a browser; verify with `npx wrangler whoami`
npx wrangler d1 migrations apply muster-composio --remote
npx wrangler secret put COMPOSIO_API_KEY    # paste the key when prompted
npx wrangler deploy
```

`deploy` prints the `*.workers.dev` URL. The worker already exists in the
account (`muster-composio`), so this is an update, not a create — the D1
binding and rate-limit namespaces in `wrangler.jsonc` are already wired.

## Verify after deploy (GET-only)

```sh
BASE="https://muster-composio.<your-subdomain>.workers.dev"
curl -s "$BASE/health"        # expect {"service":"muster-composio","ready":true}
```

Then one full round trip:

```sh
# 1. register an installation (rate limit: 30/min)
curl -s -X POST "$BASE/v1/installations" -H 'content-type: application/json' -d '{}'
# 2. with the returned credentials, confirm identity:
curl -s "$BASE/v1/me" -H "authorization: Bearer <installation-token>"
#    expect 200 with the same installationId
# 3. catalog through the worker (exercises the Composio proxy path):
curl -s "$BASE/v1/catalog" -H "authorization: Bearer <installation-token>"
```

`ready:false` on `/health` means the secret is missing or stale — re-run
`wrangler secret put COMPOSIO_API_KEY`.

## Rollback

```sh
npx wrangler rollback         # previous version, secrets and data intact
```

Secrets and D1 data survive rollbacks; only code changes revert.

## Boundaries

- `REGISTRATION_MODE=open` is currently set in `wrangler.jsonc`; tighten it
  before any untrusted audience uses the deployed URL.
- Do not commit the API key anywhere; `wrangler secret put` only.
- The D1 database id is not sensitive (it appears in the committed config) but
  never rename the database — the binding is by id.
