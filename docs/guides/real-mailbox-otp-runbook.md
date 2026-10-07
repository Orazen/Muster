# Real-mailbox readiness runbook — Muster email + 6-digit OTP sign-in

**Owner:** auth/OTP lane · **Written:** 2026-10-07 · **Source audited:**
`origin/main` @ `cf2bafbc1f5c87f6f8328c1d8cc786015525def2`

This runbook exists because every automated test in this lane delivers codes
through a stub transport or the dev console sink. **None of them proves a real
inbox receives a real code.** This document is the exact procedure for the one
demonstration that cannot be faked, plus the precise list of what it needs.

Nothing here changes any default. The enablement condition below is read from
source and left exactly as shipped.

---

## 1. The enablement condition, read from source

**There is no boolean flag.** OTP sign-in is advertised when — and only when —
the deployment has a mail transport, i.e. `RESEND_API_KEY` is a non-empty
string after trimming.

| Link in the chain | File:line | Source |
|---|---|---|
| Transport present? | `server/email.ts:40` | `isEmailConfigured()` → `Boolean(RESEND_API_KEY)` |
| Capability advertised to the UI | `server/auth.ts:495` | `authCapabilities().emailOtp = isEmailConfigured()` |
| Read once, at module load | `server/email.ts:29` | `const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim()` |

**Current default: OFF.** With `RESEND_API_KEY` absent, `isEmailConfigured()`
returns `false`, so `/api/auth-capabilities` reports `emailOtp: false` and
`src/pages/LoginPage.tsx:169` renders no email-code form at all. The plugin
routes still exist and still work (that is how the dev/test suites drive
them), but the flow is not offered to a person.

> The send route still answers `200 {"success":true}` when there is no mailer —
> the code is printed to the server log under the `[otp]` prefix instead
> (`server/email.ts:210`). That is **not** delivery to an inbox. Never record it
> as a real-mailbox pass.

---

## 2. Environment the deployed server needs

Every variable below was located by reading source, not guessed.

### Required — without these the flow is not offered or does not deliver

| Variable | Read at | Why |
|---|---|---|
| `RESEND_API_KEY` | `server/email.ts:29` | The enablement condition itself (§1). A Resend API key. |
| `EMAIL_FROM` | `server/email.ts:30` | Sender identity. Defaults to `Muster <noreply@localhost>`, which **no provider will deliver from** — you must set it. Format: `Name <sender@your-verified-domain>`. |
| `BETTER_AUTH_SECRET` | `server/auth.ts:78` | Signs every session token. **Required when self-hosting** (`server/auth.ts:81-86` throws without it). Stable across restarts, or every session dies on boot. |
| `EMAIL_FROM`'s domain | provider-side | Resend must have this domain verified (or the sender address individually verified) in the same account as the API key. Not a source-level variable — see §5. |

### Required for the links/callbacks in the session to point at the right place

| Variable | Read at | Why |
|---|---|---|
| `OMB_PUBLIC_URL` | `server/auth.ts:40,44` | Canonical public base. Sets Better Auth's static `baseURL`. |
| `OMB_PUBLIC_HOST` | `server/auth.ts:40,47` | Friendlier form; assumes `https` on 443. Either one of these two is enough. |
| `OMB_HOST` | `server/auth.ts:27` | Non-loopback ⇒ `SELF_HOSTED`, which turns on the session gate and requires `BETTER_AUTH_SECRET`. |
| `OMB_PORT` | `server/auth.ts:49` | Loopback default base for the un-pinned case. |
| `OMB_ALLOWED_ORIGINS` | `server/auth.ts:368` | Extra trusted origins, comma-separated. Usually unnecessary: `requestOwnOrigin()` (`server/auth.ts:382`) already trusts the request's own Host. |

### Only if you want a closed or restricted deployment

| Variable | Read at | Effect on the OTP door |
|---|---|---|
| `OMB_SIGNUPS_CLOSED` | `server/email-otp-login.ts:76` | `true` ⇒ unknown addresses get `403 SIGNUPS_CLOSED` on **both** send and verify. Existing accounts are unaffected. |
| `OMB_SIGNUP_ALLOWLIST` | `server/email-otp-login.ts:77` | Comma-separated addresses that may still create an account. |
| `OMB_DESKTOP_APP` | `server/email-otp-login.ts:76` | `true` exempts a desktop install from the closed-signups gate. |
| `OMB_GOOGLE_ONLY_SIGNUP` | `server/email-otp-login.ts:70` | `true` ⇒ `403 GOOGLE_ONLY_SIGNUP` for every unknown address, checked **before** the closed-signups gate. Takes precedence. |

Gates close **new accounts only**. An address that already has a row in `user`
signs in by code exactly as before (`server/email-otp-login.ts:584`).

---

## 3. Provider setup (outside the repo)

1. Create a Resend account and issue an API key.
2. Verify a sending domain (or a single sender address) in that same account.
3. Pick `EMAIL_FROM` from what you verified — a `noreply@` address on the
   verified domain.
4. Confirm the receiving mailbox accepts mail from that sender. Deliverability
   to the specific test inbox (SPF/DKIM alignment, spam folder) is a
   provider-and-receiver property; no amount of server configuration settles it.

---

## 4. The demonstration, step by step

Use an isolated port and an isolated `HOME`/data dir. **Never** point this at
`127.0.0.1:8845` — that is someone's running demo server.

```bash
# Run this block in a new subshell from the checkout, with the supported
# Node runtime and frozen dependencies installed. Build first: pnpm build.
# Reserve BOTH ports; stop if either is occupied. Never reuse demo8845.
(
  DEMO_ROOT="$(mktemp -d)"
  printf 'Owned acceptance root: %s\n' "$DEMO_ROOT"
  DEMO_PORT=39117
  DEMO_WEBHOOK_PORT=39118
  mkdir -p "$DEMO_ROOT"/{data,home,companion}
  # Supply real authorized test credentials privately; do not print them.
  export RESEND_API_KEY='...'
  export EMAIL_FROM='Muster <noreply@your-verified-domain>'
  export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
  export HOME="$DEMO_ROOT/home"
  export OMB_HOST="127.0.0.1" OMB_PORT="$DEMO_PORT"
  export OMB_WEBHOOK_PORT="$DEMO_WEBHOOK_PORT"
  export OMB_PUBLIC_URL="http://127.0.0.1:${DEMO_PORT}"
  export OMB_PUBLIC_HOST="127.0.0.1:${DEMO_PORT}" # turns on the session gate
  export OMB_DATA_DIR="$DEMO_ROOT/data"
  export OMB_COMPANION_DIR="$DEMO_ROOT/companion"
  export OMB_STATIC_DIR="$PWD/dist"
  node --experimental-strip-types server/index.ts 2>&1 | tee "$DEMO_ROOT/server.log"
)
# Run the following curls in a SECOND shell against the same owned listener.
# Set DEMO_PORT=39117 there. Keep the printed test path privately for teardown.
# Stop only this test child after acceptance; preserve receipts and user data.
```

```bash
# 4. Confirm the flow is OFFERED (this is the check that fails today by default).
curl -s "http://127.0.0.1:${DEMO_PORT}/api/auth-capabilities" | grep -o '"emailOtp":[a-z]*'
# expect: "emailOtp":true        <- if false, stop: RESEND_API_KEY is absent/blank
```

```bash
# 5. Ask for a code for the REAL test mailbox.
curl -s -i -X POST "http://127.0.0.1:${DEMO_PORT}/api/auth/email-otp/send-verification-otp" \
  -H 'content-type: application/json' \
  -H "origin: http://127.0.0.1:${DEMO_PORT}" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"email":"REAL-MAILBOX@example.com","type":"sign-in"}'
# expect 200 and {"success":true}. 429 RESEND_COOLDOWN means one already went
# out in the last 60s — wait, or reuse the same idempotency-key (it replays).
```

```bash
# 6. Read the 6 digits out of the REAL inbox. Then verify.
curl -s -i -X POST "http://127.0.0.1:${DEMO_PORT}/api/auth/sign-in/email-otp" \
  -H 'content-type: application/json' \
  -H "origin: http://127.0.0.1:${DEMO_PORT}" \
  -d '{"email":"REAL-MAILBOX@example.com","otp":"123456"}'
# expect 200, a Set-Cookie: better-auth.session_token=..., and a body with
# { token, user }. Keep the cookie for step 7.
```

```bash
# 7. The session is live; also prove the gate on the actual protected route.
# Keep the received cookie private. Do not publish response/session tokens.
curl -s -b "better-auth.session_token=COOKIE_FROM_STEP_6" \
  "http://127.0.0.1:${DEMO_PORT}/api/auth/get-session"
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://127.0.0.1:${DEMO_PORT}/api/bots"  # expect 401, no cookie
curl -s -o /dev/null -w '%{http_code}\n' \
  -b "better-auth.session_token=COOKIE_FROM_STEP_6" \
  "http://127.0.0.1:${DEMO_PORT}/api/bots"  # expect 200, correct signed account
```

### Step 8 — the same thing in a browser (the required demonstration)

1. Open `http://127.0.0.1:39117` served from this checkout's built `dist`
   by the isolated listener above. Keep the deployed app and its accounts
   separate from this test.
2. Confirm the email-code form is visible (it renders only when
   `capabilities.emailOtp` is true — `src/pages/LoginPage.tsx:169`).
3. Type the real mailbox address, submit, and confirm the UI moves to the
   six-digit stage.
4. **Open the real inbox in the same browser** and read the code from the
   Muster message.
5. Type the six digits, submit.
6. Confirm you are signed in (the app reloads auth state after a successful
   verify — `src/components/EmailOtpSignIn.tsx:297-299`).
7. Confirm the account you land in is the account you expect: a brand-new
   mailbox creates the account **verified** (`emailVerified=1`), with an owner
   membership and its own organization. Verify directly:

```bash
sqlite3 "$DEMO_ROOT/data/auth.db" \
  "SELECT u.email, u.emailVerified, m.role FROM user u LEFT JOIN member m ON m.userId=u.id;"
```

### Evidence to capture

- The Resend dashboard message list showing delivery to the real mailbox
  (this is the part no stub can fake).
- A screenshot of the inbox holding the code.
- A screenshot of the signed-in browser session.
- The server log — confirm it contains **no** six-digit code (see §6).

---

## 5. What "email delivery failed" looks like

The server never reports a refused or undelivered send as success. The wrapper
reads the recorded outcome at `server/email-otp-login.ts:651` and answers
**503** with `code: "EMAIL_DELIVERY_FAILED"` plus `retryAfterSeconds: 20`
(`DELIVERY_RETRY_SECONDS`, `server/email-otp-login.ts:123`). Nothing is armed:
no cooldown, no replay entry, so a retry is admitted immediately
(`server/email-otp-login.ts:654-657`).

The UI has **no dedicated case** for `EMAIL_DELIVERY_FAILED`
(`src/components/EmailOtpSignIn.tsx:46-70`), so it falls through to the
server's own `message` and renders it in the red `auth-notice auth-error`
alert. The three strings, straight from `deliveryRejection()`
(`server/email-otp-login.ts:131-149`):

| Provider verdict | HTTP | `message` the user reads |
|---|---|---|
| answered, refused | 503 | `We could not send your code. Please try again in a moment.` |
| never answered (DNS/TLS/socket/timeout) | 503 | `We could not reach the mail service. Please try again in a moment.` |
| no transport configured | 503 | `Email is not available on this deployment, so no code was sent.` |

In all three cases the UI also arms a **20-second** resend countdown from the
server's `retryAfterSeconds` (`src/components/EmailOtpSignIn.tsx:267`). The
server itself would accept an immediate retry; 20s is a client courtesy window
so a struggling provider is not hammered.

Other rejections you may see on the same form, all priced in
`retryAfterSeconds` with `retry-after` and `x-retry-after` headers:

| `code` | HTTP | Shown as |
|---|---|---|
| `RESEND_COOLDOWN` | 429 | `A code was already sent to this address. Try again in N seconds.` |
| `RATE_LIMITED` | 429 | `Too many code requests. Please wait N seconds and try again.` |
| `SIGNUPS_CLOSED` | 403 | `Sign-ups are closed on this deployment.` |
| `GOOGLE_ONLY_SIGNUP` | 403 | `Sign up with Google — manual sign-up is turned off on this deployment.` |
| `EMAIL_SEND_BUSY` | 503 | `Code requests are busy. Please try again in a moment.` (≥64 mailboxes in flight) |
| `INVALID_OTP` | 400 | `That code isn't right. Check the latest code and try again.` |
| `OTP_EXPIRED` | 400 | `That code expired. Request a new one.` (10-minute life) |
| `TOO_MANY_ATTEMPTS` | 403 | `Too many attempts. Request a new code.` (3 per code) |

**The honest distinction.** A 503 `EMAIL_DELIVERY_FAILED` is the server telling
the truth about the mail. A 200 `{"success":true}` with no code in any inbox
means the request was accepted but delivery is unproven — treat that as a
failure of the demonstration, not a pass.

---

## 6. Two things to check while you are there

1. **The code must not be in the server log.** With a mailer configured the dev
   `[otp]` sink is unreachable, so the code should exist only in the provider
   and as a hash in `auth.db`. Pinned by
   `server/email-otp-acceptance.test.ts` →
   *"keeps the code out of the server's own output once a mailer is configured"*.

   ```bash
   grep -Eo '\b[0-9]{6}\b' "$DEMO_ROOT/server.log" | sort -u   # expect: no code
   ```

   Note for the owner: `server/email.ts:210` **does** print the code when no
   mailer is configured — that is the documented dev channel, and it is dead
   code the moment `RESEND_API_KEY` is set. It is not a leak on a
   mailer-configured deployment, but it means "no code in the log" is a
   property of the configuration, not of the source.

2. **The code is in the email subject.** `server/email.ts:224` sets
   `subject: "Your Muster sign-in code: <code>"`. Not an API response and not a
   log, so it is outside the "no secrets in responses or logs" requirement as
   written — but it does put the code in a notification preview. Flagged for the
   owner as a judgement call, not changed here (that file is outside this lane).

---

## 7. Cleanup

```bash
# terminate the isolated server, then
rm -rf "$DEMO_ROOT"
```

Leave `127.0.0.1:8845` untouched.
