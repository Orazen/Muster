# Muster — Repository Audit

**Date:** 2026-08-19 · **Branch:** `fix-landing-page` · **Scope:** auth, API surface, release pipeline, distribution, billing readiness

Every finding below is backed by a `file:line` reference. Nothing here is speculative — each
was confirmed by reading the code or the workflow definition.

**Status: all ten findings fixed. Billing implemented.** The sections below describe each
problem as found; the "Fixed in" note records what changed.

---

## Severity summary

| # | Severity | Finding | Area | Status |
|---|----------|---------|------|--------|
| 1 | **Critical** | Self-hosted deployments expose the entire API with no authentication | Auth | ✅ Fixed |
| 2 | **Critical** | Both README/landing "Download" links 404 — artifacts are never renamed | Release | ✅ Fixed |
| 3 | **High** | macOS builds are never signed or notarized; the workflow steps always skip | Release | ✅ Fixed |
| 4 | **High** | `betterAuth()` has no configured secret | Auth | ✅ Fixed |
| 5 | **Medium** | `xcrun` prefix missing on `notarytool` — notarization would fail even if reached | Release | ✅ Fixed |
| 6 | **Medium** | No rate limiting, email verification, or password reset | Auth | ✅ Fixed |
| 7 | **Medium** | Partial releases publish without their auto-update manifest | Release | ✅ Fixed |
| 8 | **Low** | CI never runs the linter | CI | ✅ Fixed |
| 9 | **Low** | `release.yml` uses floating action tags and workflow-wide write permission | CI | ✅ Fixed |
| 10 | **Low** | README license badge contradicts the actual LICENSE | Docs | ✅ Fixed |

### Still open

Nothing from the audit. Two things the billing work deliberately left for later, tracked in
`docs/billing.md`:

- **Subscription enforcement** — nothing yet blocks provisioning a cloud computer when a
  subscription is `past_due` or absent. `getSubscription()` returns everything needed; the check
  belongs in `server/box.ts`.
- **Dunning email and quantity sync** — `invoice.payment_failed` is logged but sends nothing, and
  provisioning an extra computer does not update the Stripe subscription item.

---

## 1. Critical — self-hosted deployments have no API authentication

**Evidence**

- `server/auth.ts` configures Better Auth and `server/index.ts:2092-2101` mounts it at `/api/auth/*`.
- `src/components/AuthGate.tsx` redirects unauthenticated users to `/sign-in`. **This is a React
  component — it is enforced in the browser only.**
- Grepping the entire `server/` tree for session validation outside the auth handler
  (`auth.api`, `getSession`, `requireAuth`) returns **zero matches** in non-test code.
- `server/index.ts` defines **73 routes**. Exactly one group checks credentials:
  `/api/internal/*` at `server/index.ts:2109-2115`, which requires loopback plus the
  per-boot `COMMS_TOKEN` bearer (`server/index.ts:132`).

**Why it is currently survivable**

The default posture is loopback-only. `isAllowedHost()` (`server/index.ts:2069`) rejects any
non-loopback `Host`, and `isAllowedOrigin()` (`server/index.ts:2049`) blocks cross-origin
browser traffic. On a single-user desktop install, the OS network boundary *is* the auth.

**Why it breaks the moment you sell a plan**

```
server/index.ts:2048
const SELF_HOSTED = HOST !== "127.0.0.1" || Boolean(process.env.OMB_PUBLIC_HOST);
```

```
server/index.ts:2071-2072
function isAllowedHost(host) {
  if (isLoopbackHost(host)) return true;
  return SELF_HOSTED;          // ← any Host accepted
}
```

Set `OMB_HOST=0.0.0.0` — the documented way to self-host the web UI (`server/index.ts:90-93`) —
and the host gate opens for every hostname while **no route gains a session check**. An
unauthenticated request from anywhere on the network can then reach, among others:

| Route | `server/index.ts` | Impact |
|---|---|---|
| `PUT/PATCH /api/config` | 3331 | Write harness config |
| `GET /api/config` | 3319 | Read config |
| `GET /api/providers` | 3322 | Enumerate configured providers |
| `POST /api/local-computer/{pull,run,start,stop,remove}` | 3180 | Container lifecycle control |
| `POST /api/local-computer/screenshot` | 3211 | Screen capture |
| `POST /api/bots/:id/computer/{provision,join,sleep,exec,screenshot}` | 3509 | **Remote command execution** |
| `POST /api/webhooks`, `.../rotate` | 2348, 2357 | Create and rotate webhook secrets |

`/api/bots/:id/computer/exec` is arbitrary command execution on a machine the operator owns.

**Proposed fix**

1. Add a `requireSession(req)` helper in `server/auth.ts` wrapping `auth.api.getSession({ headers })`.
2. In `server/index.ts`, insert a single gate immediately after the host/origin check and before
   the first route match. Allowlist only `/api/auth/*`, `/api/health`, and static assets.
3. Keep `/api/internal/*` on its existing loopback + `COMMS_TOKEN` check — it is not a user route.
4. Preserve today's desktop UX: when `SELF_HOSTED === false`, permit an authenticated-by-loopback
   bypass so the local Electron app does not suddenly demand a login. Gate strictly when
   `SELF_HOSTED === true`.
5. Add tests asserting `401` on a representative sensitive route with `OMB_HOST=0.0.0.0` and no session.

**Fixed in** `server/auth.ts` (`getSession`, `isPublicApiPath`, `SELF_HOSTED`) and
`server/index.ts:2103-2124`. When `SELF_HOSTED` is true every `/api/*` route except `/api/auth/*`,
`/api/health`, and `/api/internal/*` returns `401` without a valid session. Loopback desktop
installs are unchanged. Covered by `server/auth.test.ts`.

---

## 2. Critical — both download links 404

`electron-builder.yml` produces **versioned** filenames:

```yaml
electron-builder.yml:80   dmg.artifactName:  Muster-${version}.dmg
electron-builder.yml:106  nsis.artifactName: Muster-${version}-setup.${ext}
```

The README and the landing page both link to **stable** filenames:

```
README.md:27, 233   .../releases/latest/download/Muster.dmg
README.md:31, 234   .../releases/latest/download/Muster-setup.exe
www/index.html      .../releases/latest/download/Muster.dmg
```

The intent is documented in the config itself (`electron-builder.yml:102-105`): *"ship a second
copy named Muster-setup.exe on the release — the same trick as Muster.dmg beside
Muster-${version}.dmg."* Neither copy is actually produced.

**macOS** — `.github/workflows/release.yml` has **no rename step at all**. `Muster.dmg` is never
created. The download button in the README, and the one I just built into the landing page, both
404.

**Windows** — the rename step exists but references a filename that is never generated:

```yaml
.github/workflows/release.yml:157-160
VERSION=$(node -p "require('./package.json').version")
cp release/Muster-${VERSION}-x64-setup.exe release/Muster-setup.exe 2>/dev/null || true
```

`nsis.artifactName` is `Muster-${version}-setup.exe` — there is **no `-x64-` segment**. The `cp`
fails every run, and `|| true` swallows the error so the workflow reports success.

**Proposed fix**

- Add a macOS rename step mirroring the Windows one.
- Correct the Windows source filename to `Muster-${VERSION}-setup.exe`.
- Drop `2>/dev/null || true` from both so a mismatch fails loudly instead of shipping a broken link.
- Add the stable names to each job's `upload-artifact` path list.
- Add a `publish`-job assertion that `Muster.dmg` and `Muster-setup.exe` are present before the
  release is created.

**Fixed in** `.github/workflows/release.yml` — a "Copy to stable download name" step in both the
macOS and Windows jobs, the Windows source filename corrected, `set -euo pipefail` with no error
suppression, and a publish-job check that both files exist before a non-draft release is created.

---

## 3. High — macOS signing and notarization always skip

```yaml
.github/workflows/release.yml:43-46
- name: Import Apple certificate
  if: ${{ env.APPLE_CERTIFICATE != '' }}
  env:
    APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
```

A step's own `env:` block is **not** in scope for that step's `if:` expression. GitHub evaluates
`if:` against workflow- and job-level `env` only, so `env.APPLE_CERTIFICATE` is `null`, the
comparison against `''` is true-by-coercion in the *negative* direction, and the condition
evaluates **false on every run**.

The same bug is at `release.yml:71` for the Notarize step (`env.APPLE_ID`).

**Consequences**

- Every macOS build ships unsigned and un-notarized, regardless of whether the secrets are set.
- Gatekeeper shows the "damaged / unidentified developer" warning on first launch.
- The README claims *"signed & notarized"* (`README.md:35`, again at `README.md:233`) — inaccurate.
- **macOS auto-update is broken.** `electron-updater` requires a valid signature to apply a macOS
  update; the workflow header acknowledges this at `release.yml:6-7`.

**Proposed fix** — hoist the secrets to job-level `env` and test them there:

```yaml
jobs:
  macos:
    env:
      APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
      APPLE_ID: ${{ secrets.APPLE_ID }}
    steps:
      - name: Import Apple certificate
        if: ${{ env.APPLE_CERTIFICATE != '' }}
```

Then add a post-build `codesign --verify --deep --strict` + `spctl -a -t exec -vv` assertion so a
silent regression fails the build.

**Fixed in** `.github/workflows/release.yml` — the five Apple secrets moved to job-level `env` on
the `macos` job, and a "Verify signature" step added.

---

## 4. High — no Better Auth secret

`server/auth.ts:20-34` calls `betterAuth({ ... })` with no `secret` field, and there is no
`BETTER_AUTH_SECRET` anywhere in the repo or in `server/config.ts`.

Better Auth uses this secret to sign session tokens and hash verification values. Without an
explicit one it falls back to a default/derived value. Practical effects:

- Two instances of the same self-hosted deployment cannot validate each other's sessions.
- Session tokens do not survive a process restart consistently.
- A predictable signing key is a session-forgery risk in any multi-tenant or public deployment.

**Fixed in** `server/auth.ts` (`resolveSecret`) — exactly as proposed. Documented in
`docs/self-host.md` and made a required variable in `docker-compose.yml`.

---

## 5. Medium — `notarytool` is called without `xcrun`

```yaml
.github/workflows/release.yml:79-84
notarytool submit "$DMG" \
```

`notarytool` is not on `PATH` as a bare executable; it is an `xcrun` subcommand. Compare line 86,
which correctly uses `xcrun stapler staple`. Even after finding 3 is fixed, this step would fail
with `command not found`.

**Fixed in** `.github/workflows/release.yml` — now `xcrun notarytool submit`, with
`set -euo pipefail` so a failure surfaces.

---

## 6. Medium — auth feature gaps

`server/auth.ts:21-23` enables `emailAndPassword` only. Missing for any hosted or
internet-reachable deployment:

- **Rate limiting** on `/api/auth/sign-in` — unlimited password guessing.
- **Email verification** — `emailVerified` is surfaced in `src/lib/auth.tsx:18` but never enforced;
  anyone can register with any address.
- **Password reset** — no recovery path, so a forgotten password means a lost account.
- **Password policy** — no minimum length or strength requirement configured.
- **OAuth providers** — email/password only; no GitHub or Google sign-in.

None of these matter for a loopback desktop install. All of them are prerequisites for the cloud
tier.

**Fixed in** `server/auth.ts`, `server/email.ts`, and the sign-in UI:

- Rate limiting (5 sign-in attempts per minute per IP, 10 sign-ups per hour) and
  `minPasswordLength: 12`.
- `server/email.ts` — dependency-free Resend transport over `fetch`. Three modes: real delivery
  when `RESEND_API_KEY` is set, console logging otherwise so a self-hoster mid-setup can still
  click through, and disabled in a packaged build.
- Email verification and password reset, both wired only when mail can actually be delivered.
- GitHub and Google OAuth, configured per provider and only when *both* halves of the credential
  pair are present.
- `PUBLIC_BASE_URL` + `baseURL` — without it, a production deployment mails users a localhost link.
- `GET /api/auth-capabilities` and `src/components/SocialSignIn.tsx` — the UI asks the server what
  works and renders accordingly, so it never shows a button that silently fails.
- `src/pages/ForgotPasswordPage.tsx` and `ResetPasswordPage.tsx`. The forgot page shows the same
  confirmation regardless of whether the address is registered, so it cannot be used to enumerate
  accounts.

---

## 7. Medium — partial releases ship without auto-update manifests

```yaml
.github/workflows/release.yml:207
if: ${{ !cancelled() && (needs.macos.result == 'success' || needs.linux.result == 'success') }}
```

Windows can fail and the release still publishes. That is deliberate (commit `e200379`, *"allow
partial release success"*), but the side effect is that `latest.yml` — the manifest
`electron-updater` polls — is absent from the release. Installed Windows clients then fail their
update check against a release that exists but has no manifest for them.

**Fixed in** `.github/workflows/release.yml` — a "Decide draft state" step sets `draft: true`
whenever any platform job did not succeed.

---

## 8. Low — CI never lints

`package.json` defines `"lint": "oxlint ."` and `.oxlintrc.json` is configured, but
`.github/workflows/ci.yml:36-40` runs only `typecheck`, `test`, `check:electron`, and `vite build`.
Lint violations reach `main` unchallenged.

**Fixed in** `.github/workflows/ci.yml` — `pnpm lint` now runs before `typecheck`.

*(Note: I could not execute `oxlint` in the Linux sandbox — `node_modules` holds the macOS-arm64
native binary from your host install. Lint status is therefore unverified, not clean.)*

---

## 9. Low — release workflow supply chain

`ci.yml` is well hardened: actions pinned to full commit SHAs, `permissions: contents: read`,
`persist-credentials: false` on the packaging job. `release.yml` does not match that bar:

- Every action uses a floating tag (`actions/checkout@v4`, `softprops/action-gh-release@v2`, …)
  rather than a pinned SHA.
- `permissions: contents: write` is declared **workflow-wide** (`release.yml:21-22`); only the
  `publish` job needs it.
- No `persist-credentials: false` on the build jobs, so the checkout token stays in the git config
  of a runner that then executes `pnpm install` and third-party build scripts.

**Fixed in** `.github/workflows/release.yml` — all six actions pinned to full commit SHAs,
workflow-level permission dropped to `contents: read` with `contents: write` scoped to `publish`,
and `persist-credentials: false` added to all three build checkouts.

---

## 10. Low — license badge contradicts LICENSE

`README.md:21` renders a `license-MIT` badge. `LICENSE:1` is **Business Source License 1.1**
(Licensor: Ramagiritharun, Change Date 2030-08-19, converting to Apache 2.0). The README footer and
the landing page both correctly say BSL 1.1.

This matters commercially: BSL restricts production use by others, which is precisely the leverage
behind a paid cloud tier. An MIT badge undermines that and could be read as an alternative grant.

**Fixed in** `README.md:21`.

---

# Billing — free self-host, paid cloud

**Implemented.** See `docs/billing.md` for the operator-facing reference; `server/billing.ts` for
the code; `server/billing.test.ts` for the tests. The research below is retained as the rationale.

## How Dokploy does it

A single environment flag decides everything:

```ts
packages/server/src/constants/index.ts:5
export const IS_CLOUD = process.env.IS_CLOUD === "true";
```

The billing code **ships in the open-source repo** but is inert when self-hosting — every entry
point returns early:

```ts
apps/dokploy/server/utils/billing.ts:18
if (!IS_CLOUD) return null;
```

Around that flag:

- `apps/dokploy/server/api/routers/stripe.ts:168` — `stripe.checkout.sessions.create` to subscribe.
- `apps/dokploy/server/api/routers/stripe.ts:206` — `stripe.billingPortal.sessions.create` so
  customers manage their own card, invoices, and cancellation. No custom billing UI to maintain.
- `apps/dokploy/pages/api/stripe/webhook.ts` — the webhook receiver; subscription state is derived
  from Stripe, never stored as the source of truth.
- Plans are `hobby` / `startup` / `legacy`, each with a monthly and an annual Stripe price ID.
- Metering is **quantity-based** — per-server line items, adjusted by updating the subscription
  item quantity (`stripe.ts:269-279`).
- Lifecycle emails live in-repo: `stripe-welcome.tsx`, `invoice-notification.tsx`,
  `payment-failed.tsx`.

The key property: **self-hosters are never asked for a license key, and no feature is withheld from
them.** The paid product is the hosting, not the software.

## Proposed shape for Muster

| | Self-host | Muster Cloud |
|---|---|---|
| Price | Free, unlimited | Subscription |
| Bots | Unlimited | Unlimited |
| Engines | Your own CLIs and keys | Your own CLIs and keys |
| Cloud computers | You supply the Docker host | Managed, metered |
| Auth | You run it | Managed, with OAuth |
| Updates | Manual or auto-update | Continuous |
| Support | GitHub | Email |

The natural metered unit for Muster is the **cloud computer** (the Linux desktop each bot drives),
not the bot — bots are free to create and cost nothing until one gets hands. That maps cleanly onto
Dokploy's per-server quantity model.

## What was built

1. `server/billing.ts` — `IS_CLOUD` flag, Stripe over REST (no `stripe` SDK dependency), customer
   lookup keyed on `metadata['musterUserId']` rather than email, checkout, billing portal, and a
   constant-time webhook signature verifier with a five-minute replay window.
2. `server/index.ts` — `GET /api/billing/subscription`, `POST /api/billing/checkout`,
   `POST /api/billing/portal`, and `POST /api/billing/webhook`. The webhook reads the body via a new
   `readRawBody()` before any parsing, since Stripe signs the exact bytes, and is exempt from the
   session gate because it authenticates by signature rather than cookie.
3. `src/components/BillingSection.tsx` — Settings → Billing. Renders "You're self-hosting. Muster is
   free and unlimited here" when the API 404s, a configuration hint when cloud is on but Stripe is
   not set up, and the plan otherwise.
4. `server/billing.test.ts` — signature verification (correct, wrong secret, altered body, replayed
   timestamp, malformed header, unconfigured) plus inertness when self-hosting.
5. `docs/billing.md` — operator reference, environment table, and design rationale.

**Metered unit:** the cloud computer, not the bot. Bots cost nothing until one gets hands, so
billing per bot would charge for something that consumes no resources.

**Prerequisite met:** finding 1. Billing identity would have been meaningless while the API accepted
unauthenticated requests — anyone could have reached a paying customer's harness directly.

---

# Recommended sequence

1. **Finding 1** — server-side session enforcement. Blocks everything else.
2. **Finding 4** — `BETTER_AUTH_SECRET`. Small, ships with finding 1.
3. **Finding 2** — download link renames. One-line fix, currently costing you every install.
4. **Finding 3 + 5** — signing and notarization. Unblocks macOS auto-update.
5. **Findings 6–10** — hardening and hygiene.
6. **Billing** — only after 1, 4, and 6.

Findings 2, 3, and 5 are independent of the auth work and can go out as a `fix/release-pipeline`
branch immediately.
