# Billing

**Self-hosting Muster is free and unlimited. It always will be.**

There is no licence key, no seat count, and no feature withheld from a self-hosted install. The
billing code in this repository is inert unless `MUSTER_CLOUD=true`, which only the hosted
deployment sets. If you run Muster yourself, nothing on this page applies to you.

This is the same model [Dokploy](https://github.com/Dokploy/dokploy) uses: the paid product is the
hosting, not the software.

---

## How it is wired

One flag decides everything:

```ts
// server/billing.ts
export const IS_CLOUD = process.env.MUSTER_CLOUD === "true";
```

Every exported function returns `null` or a no-op when it is false, so no call site needs to branch.
`/api/billing/*` returns `404 billing is not enabled`, and the Settings → Billing panel renders
"You're self-hosting. Muster is free and unlimited here."

There is no `stripe` package dependency. `server/billing.ts` talks to Stripe's REST API with
`fetch`. The harness is bundled into an Electron app and a Docker image where, for nearly every
user, none of this code ever executes — a payments SDK in that bundle is pure weight.

## What is metered

The **cloud computer** — the Linux desktop a bot drives — not the bot.

Bots are free to create and cost nothing until one is given hands. Charging per bot would bill
people for something that consumes no resources. This maps onto Stripe's quantity-based
subscription items the same way Dokploy meters servers.

| | Self-host | Muster Cloud |
|---|---|---|
| Price | Free, unlimited | Subscription |
| Bots | Unlimited | Unlimited |
| Engines | Your own CLIs and keys | Your own CLIs and keys |
| Cloud computers | You supply the Docker host | Managed, metered |
| Auth | You run it | Managed, with OAuth |
| Support | GitHub | Email |

## Environment

Only for the hosted deployment.

| Variable | Required | What it does |
|---|---|---|
| `MUSTER_CLOUD` | yes | `true` switches the cloud tier on. Unset everywhere else. |
| `STRIPE_SECRET_KEY` | yes | Secret API key (`sk_live_…`). |
| `STRIPE_PRICE_MONTHLY` | yes | Price ID for the monthly plan. |
| `STRIPE_PRICE_ANNUAL` | no | Price ID for the annual plan. Yearly checkout is hidden without it. |
| `STRIPE_WEBHOOK_SECRET` | yes | Signing secret (`whsec_…`) for `/api/billing/webhook`. |
| `OMB_PUBLIC_URL` | yes | Absolute base URL. Checkout redirects back here; a wrong value sends paying customers to localhost. |

`isBillingConfigured()` requires `MUSTER_CLOUD`, `STRIPE_SECRET_KEY` and `STRIPE_PRICE_MONTHLY`
together. With cloud on but Stripe missing, the panel says so rather than offering a checkout button
that fails.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/billing/subscription` | session | Current plan, read live from Stripe |
| `POST /api/billing/checkout` | session | Returns a Stripe Checkout URL. Body: `{ interval: "month" \| "year", quantity: number }` |
| `POST /api/billing/portal` | session | Returns a Stripe Billing Portal URL |
| `POST /api/billing/webhook` | signature | Stripe events. Exempt from the session gate — it authenticates with a signature, not a cookie |

## Design decisions

**Stripe is the source of truth.** Subscription state is never mirrored into our database. Every
read goes to Stripe. A local "is this customer paid" cache is exactly what goes stale when a card
fails at 3am, and reconciling it is a permanent source of billing bugs. The cost is an API call on
page load; the benefit is that the answer cannot be wrong.

**The Billing Portal does the work.** Card updates, invoices, plan changes and cancellation are all
Stripe-hosted. None of it is built here, none of it is maintained here, and no card data touches
Muster.

**Customers are keyed by `metadata['musterUserId']`, not email.** Emails change. A lookup by email
would silently attach a second Stripe customer to the same person, and they would end up paying
twice.

**Webhook signatures are verified on the raw body.** `JSON.parse` plus re-serialise reorders keys
and drops whitespace, and the HMAC no longer matches — so `readRawBody()` in `server/index.ts` reads
the bytes before any parsing. The comparison is constant-time, and the timestamp is checked against
a five-minute window so a captured payload cannot be replayed. Covered by `server/billing.test.ts`.

**The webhook always answers 200.** Stripe retries anything else, for days. Events we do not act on
are acknowledged and ignored.

## Testing

`server/billing.test.ts` covers the signature verifier (correct, wrong secret, altered body,
replayed timestamp, malformed header, no secret configured) and asserts that every entry point is
inert when self-hosting.

Network paths need a Stripe test key and belong in an integration run, not the unit suite. To
exercise them locally:

```sh
stripe listen --forward-to localhost:8799/api/billing/webhook
```

and set `MUSTER_CLOUD=true` with your `sk_test_…` key.

## Enforcement, dunning, and quantity sync

All three are built:

- **Enforcement.** Provisioning a cloud computer (`POST /api/bots/:id/computer/provision`, Box and
  OpenSandbox backends alike) checks the live Stripe subscription first. A `past_due` or missing
  subscription answers `402` with the exact fix ("update your card" / "subscribe"). Self-hosting
  never hits this path — null means billing does not apply.
- **Dunning email.** On `invoice.payment_failed` the customer gets one clear notice with a direct
  link to the Billing panel. Bots and data are untouched; only new provisioning pauses.
- **Quantity sync.** Every successful provision bumps the metered cloud-computer count on the
  subscription item, fire-and-forget — a slow Stripe call must never delay a provision response.
  Customers adjust down any time in the Billing Portal; Stripe remains the source of truth.

One deliberate scope line: turn-driven auto-provisioning (a bot's first cloud use mid-conversation)
is covered by the same session gate every `/api/*` route already requires, but not by the
subscription check — that flow provisions only after an authenticated user explicitly selected
Cloud for that bot. Closing that last seam belongs with per-turn usage metering, not the
provision gate.
