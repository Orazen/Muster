# OpenBot integration study — feature-by-feature mapping onto Muster

Owner instruction: "checkout github.com/nightly-labs/openbot … login with email code
same login needed in muster … onboarding is good on desktop … all systematically same
I need in muster."

- **Sources studied (both verified 2026-09-23 — see the verdict in §1):**
  - **The owner's URL, `github.com/nightly-labs/openbot`** — the *canonical* repo for
    both asks (it is the owner's installed desktop app; it holds the email-code account
    API and the onboarding source). Studied read-only via the GitHub tree/raw API:
    `apps/auth-api/**` (routes, migrations, `auth-service.ts`), `src/renderer/src/
    features/onboarding/**`, `src/renderer/src/features/account/AccountLogin.tsx`, and
    the README's license/auth/data-boundary sections. **License: PolyForm Noncommercial
    1.0.0** (README attested: "Copyright 2026 Norbert Bodziony … Commercial use requires
    a separate license … versions up to and including 0.1.11 remain available under
    Apache-2.0") — this is NOT the MIT the owner expected; see §7.
  - **`github.com/CopilotKit/openbot`** — a *different* project sharing the name, and
    the identity of the local clone `/Users/ramagiritharun/.jcode/scratch/rival-openbot`
    (remote `CopilotKit/openbot`; tree `app/ server/ agent-bot/ agent-computer/
    agent-langgraph/ supervisor/ spire/ worker/` matches CopilotKit's listing exactly;
    last commit `2251ad2` "…deployment reaches an agent on its own network (#215)",
    2026-08-23 snapshot; root `package.json` name `openbot` v0.0.4, license MIT).
    `LICENSE` verified verbatim: "MIT License / Copyright (c) 2026 CopilotKit".
  - The **owner's installed app** state files under
    `~/Library/Application Support/OpenBot` were used as behavioral evidence — only the
    small versioned JSON files (`openbot-setup-v2.json` = the onboarding completion
    record the owner quoted, plus the window/approval/browser/remote-server state files
    showing the same one-file-per-concern `{"version":…}` pattern). Cookie and key
    stores are out of scope for this study by rule (§7 guardrails).
- **Method:** both GitHub READMEs (declared inventory) → canonical-repo tree listing →
  the actual route/service/migration/onboarding sources → the owner's installed-app
  state files → Muster's shipped auth/onboarding files (`server/email-otp-login.ts`,
  `server/auth.ts`, `src/pages/LoginPage.tsx`, `src/components/EmailOtpSignIn.tsx`,
  `src/components/Onboarding*.tsx`, `src/state/onboarding-*.ts`, `src/lib/analytics.ts`).
  Every claim below is bounded by what those sources prove.
- **Status of this doc:** research/planning only. No code was changed, no tests were run,
  no app or network service was started, no git command of any kind was run. Verification
  plans are written for the implementing agent that picks a slice up.
- **Hard constraints for any future slice (owner brief for this study, binding):**
  - **Excluded parallel-session files — never touched:** `www/*`, `.commandcode/`,
    `.freebuff/`, `.zcode/`, `docs/research/glm/*`, `marketing-video/`, `www/fonts/`,
    `www/templates.html`.
  - **Login stays additive:** existing sessions, saved choices and user sessions are
    preserved; no sign-in path may be removed or hidden behind another.
  - **Mascots, route shells, layout, theme, drafts preserved** per the web-app
    stability contract, `docs/guides/web-app-stability.md` (an audit is not permission
    to redesign the interface).
  - **Credentials from env/secrets only — never literals. No security claims. No
    `npx muster` anywhere. Work on `main` only. No git mutations at all this pass.**
  - Never stop/revoke anything on the demo server at `127.0.0.1:8845`; production checks
    are GET only; a push is not a deployment receipt.

---

## 1. What OpenBot actually is, and what it has proven

**The name covers two live, unrelated repositories — no transfer, no redirect.** Both
URLs were fetched on 2026-09-23 and each resolved to its own repository with its own
README, license and tree:

- **`github.com/nightly-labs/openbot` (the owner's URL, 197★/620 commits)** is a
  **local-first Electron desktop workspace for persistent AI teammates**: SolidJS
  renderer, local provider CLIs (Codex/Claude/Grok/OpenCode) each with its own
  workspace, SQLite event log (`openbot.db`), embedded browser, FIFO queues, agent-to-
  agent channels, optional Computer Use driver, and — the part this study is about —
  **"Optional OpenBot accounts through one-time email codes. The account API runs on
  Cloudflare Workers and D1."** This is the app the owner installed, and it is the
  canonical source for asks 1 (email+code login) and 2 (desktop onboarding).
- **`github.com/CopilotKit/openbot` (5.4k★, MIT)** is a **self-hosted AG-UI agent
  platform**: Hono server + React app + one container computer per bot, Better Auth
  with Google/Microsoft/Okta (plus SAML/OIDC), CEL action policy, audit trail. The
  local read-only clone is this repo. It has **no email-code login** (OAuth only, plus
  the explicit single-user dev bypass) and **no onboarding wizard at all** — it is a web
  app whose "onboarding" is `.env.example`'s `OPENBOT_SINGLE_USER=true`. Attribution in
  §7 names each repo for what it actually contributed.

**What the owner's repo demonstrates (bounded to evidence):**

- The full email+code flow runs in production traffic: start/verify routes, a D1
  challenge table with hashed id/code/source-IP, 10-minute expiry, attempt budget,
  resend cooldown, layered rate limits, per-challenge delivery state, and a daily
  retention job — all of it read in source, and the README states "One-time codes
  expire after 10 minutes and are stored only as hashes. A daily maintenance task
  removes expired or consumed authentication records from D1."
- The desktop first-run wizard ships with tests and a Storybook story
  (`OnboardingFlow.test.tsx`, `App.onboarding.test.tsx`, `OnboardingFlow.stories.tsx`)
  and leaves a durable completion record on disk — confirmed on the owner's machine:
  `{"version":2,"preferredProvider":"opencode","completedAt":"2026-09-22T12:05:29.795Z"}`.
- **Explicitly NOT proven / not portable as claims:** the account API's live SMTP
  delivery was never observed here (only the code paths); their desktop warning banner
  says agents run with `danger-full-access` and `approvalPolicy: never` after a
  one-time consent — that posture is the opposite of Muster's and must not be imported;
  their installed-app approval state defaults to `defaultAutoApprove: true` (observed)
  — see §7 guardrails.

**What the local clone (CopilotKit, MIT) demonstrates:** an explicit dev-actor bypass
whose lock is the env flag itself ("the deployment refuses to start unless somebody
wrote down that they meant it", `server/src/auth/dev-actor.ts` — `dev@openbot.local`,
fixed admin id so threads survive restarts), a sign-in screen that prefetches providers
in `beforeLoad` so buttons never paint as "no providers", and audit writes that can
never block a sign-in (`record()` swallows and logs). Useful patterns, all three —
but no email-code flow and no wizard.

---

## 2. Feature inventory → Muster mapping (23 features)

Classes: **AE** = ALREADY-EQUIVALENT (Muster has the capability; cite), **AD** = ADAPTABLE
(their shape → Muster shape), **RG** = REAL-GAP (genuinely new to Muster).
Muster file cites below were verified to exist in this tree during this study.

| # | OpenBot feature (source) | Class | Muster surface (already there, or what it takes) |
|---|---|---|---|
| 1 | Request-code endpoint: `POST /v1/auth/email/start` {email}, invalid_email 400, challenge row created (`apps/auth-api/src/routes/v1/auth/email/start.ts`, `server/auth-service.ts`) | AE | `server/email-otp-login.ts` intercepts `POST /api/auth/email-otp/send-verification-otp` (better-auth emailOTP plugin config in `server/auth.ts`); schema work is the plugin's, policy is Muster's. |
| 2 | Verify endpoint mints the session: `POST /v1/auth/email/verify` {challengeId, code} (`verify.ts`) | AE | `POST /api/auth/sign-in/email-otp` → plugin mints the *same* signed `better-auth.session_token` cookie (HttpOnly, SameSite=Lax) every other Muster path sets (`server/index.ts` pairing/OAuth-finish/redeem all set the identical shape). |
| 3 | Two-step login UI: `email`→`code`, OtpInput, forward/back transitions, field-issue vs local-issue sets, shake/revert timers, countdown clock armed only while a countdown is on screen (`AccountLogin.tsx`) | AE | `src/components/EmailOtpSignIn.tsx`: same two phases, live `Resend code in Ns` ticker mirroring the server, back control, busy/aria states; exported so the SSR contract tests can pin it; rendered by `src/pages/LoginPage.tsx` only when `capabilities.emailOtp` is advertised. |
| 4 | 10-minute TTL; id/code/source-IP stored as sha256 (`CHALLENGE_TTL_MS = 10*60_000`, migration `0002_email_login_codes.sql`) | AE | `OTP_TTL_SECONDS = 600` in `server/auth.ts` (one value consumed by the plugin and the dev-mode delivery log in `server/email.ts`); plugin hashes codes; Muster never stores a plaintext code. |
| 5 | 60-second resend cooldown with `retryAfterSeconds` (`RESEND_COOLDOWN_MS = 60_000`) | AE | Wrapper-level per-mailbox cooldown (`cooldownRemainingMs`) returning `429 {code:"RESEND_COOLDOWN", message:"…Try again in N seconds."}`; client ticker mirrors it; deliberately per-email, not per-IP (`server/email-otp-login.ts:69`). |
| 6 | Attempt budget (`failed_attempts`/`max_attempts`, `too_many_code_attempts` forces a new code) | AE | `emailOTP({ allowedAttempts: 3, … })` in `server/auth.ts`; wrong/expired/exhausted answers relay from the plugin unchanged. |
| 7 | Layered keyed rate limits: 5/email + 20/ip per 15-min window on start, 30/ip on verify, auditable `auth_rate_limits` table, `retryAfterSeconds` on every issue (`RATE_WINDOW_MS`, `#enforceRateLimit`) | AD | Muster leans on Better Auth's per-IP limiter + the wrapper cooldown (the client already *distinguishes* the two 429s — `EmailOtpSignIn.tsx:170`). Adapt: wrapper-tracked send windows keyed per-IP with seconds surfaced → §5 S2. |
| 8 | Idempotent start: optional UUID `Idempotency-Key` becomes the challenge id; replay returns the accepted challenge, consumed → `409 idempotency_key_completed` (`start.ts`, `auth-service.ts`) | **RG** | Nothing equivalent in `server/email-otp-login.ts` — a client retry after a dropped response currently hits the 429 cooldown instead of a success replay → §5 S3. |
| 9 | Delivery-state machine per challenge: `sent`/`failed` recorded (migration `0015_email_challenge_delivery_state.sql`), ambiguous SMTP → `email_delivery_pending` with a countdown budget, distinct `502/503`, UI sets `email_delivery_pending/timeout/unknown`, `auth_api_unavailable` + explicit "Try again / Check again in …" buttons (`auth-service.ts`, `AccountLogin.tsx`) | **RG** | Muster's send path relays the delegated plugin result without a delivery-state taxonomy (`server/email-otp-login.ts` step 5, `server/email.ts` dev log) → §5 S4. |
| 10 | Retention: daily maintenance removes expired/consumed auth rows (`server/auth-data-retention.ts`; README) | **RG** | No Muster-owned sweep was found in the files studied — but first *verify* whether Better Auth's `verification` table already accumulates in an owned fixture before adding anything → §5 S5 (investigate-first). |
| 11 | Challenge-bound two-token verify (`challengeId` + code, `id_hash` lookup) | AD | Their shape is cleaner on paper, but Muster's verify is Better Auth's email-bound plugin route; adopting this means forking the plugin for a problem S3 already solves (double-send). **Superseded — see §7, do not port.** |
| 12 | Env-gated dev bypass: `AUTH_EXPOSE_DEVELOPMENT_CODE=true` → deterministic `developmentCode` returned in start and rendered as "Development code: …" (`auth-service.ts`, `AccountLogin.tsx:506`) | AD | Muster's dev-mode delivery log in `server/email.ts` restates the TTL server-side only — safer default. Only adopt an env-gated response field if an owned e2e fixture genuinely needs it; never default-on. |
| 13 | Sign-up gates standing in front of the OTP door | AE | **Muster ahead:** `otpSignUpBlockReason()` mirrors `OMB_GOOGLE_ONLY_SIGNUP` / `OMB_SIGNUPS_CLOSED`+allowlist (desktop exempt) with the same precedence/error codes as `/api/auth/sign-up/email`, because verify-on-unknown-email *creates* accounts — proven by `server/email-otp-signup-gates.test.ts`. No analog gate seen in their route set. |
| 14 | Password + OTP coexistence | AE | **Muster ahead:** the wrapper's load-bearing promotion fix (non-consuming check → flip `emailVerified` → delegate) stops Better Auth's `revokeUnprovenAccountAccess()` from silently stripping a user's password on an OTP sign-in (`server/email-otp-login.ts:15-25`). Their routes don't face this problem; Muster solved it. |
| 15 | Desktop sign-in paths | AE | **Muster ahead:** four ways in on web *and* desktop — Google OAuth (desktop = loopback handoff from the cloud), pairing-code bridge (`server/pairing.ts`, QR redeem), email+password, email+OTP — "no path here is ever hidden behind another one" (`src/pages/LoginPage.tsx:10-21`), advertised pre-session via `GET /api/auth-capabilities`. Their desktop uses the account API + team/server invites; their `ProviderCodeLoginDialog` is *provider-CLI* device login — a different concern. |
| 16 | Client stores "only an encrypted OpenBot session token" (README) | AE | **Muster keeps the signed HttpOnly cookie** — stronger against XSS than a client-held token. Do not downgrade (§7). |
| 17 | First-run wizard: `OnboardingFlow` steps `meet`/`computer`/`jobs` with back navigation; `InitialSetup` connection choice (local vs invite-to-host), account row, provider picker with live per-provider states, ComputerUse permissions; draft-free (state held in signals); completion via `saveSetup` → `{preferredProvider, preferredModel?, completed}` (`onboarding-context.tsx`) | AD | Muster's classic wizard is the *superset*: 7 steps / 5 stages (`ONBOARDING_STEPS` in `src/state/onboarding-draft.ts`: welcome, tour, engines, phone, teammate, permissions, first-task), per-account versioned draft **backed by the account (server)** with localStorage as fast path, strict engine gate (`engineConnected`), template prefill that never auto-sends. Adapt their *completion record* (§5 S1) and *review mode* (§5 S6) only. |
| 18 | Completion marker + review: `state.completed` gates `AppAccessGate` (null = not configured); Settings reopens the same flow as review; "Only the first completion is onboarding; later saves are a review" (analytics fires once); durable `completedAt` on disk | AD | Muster's gates: `serverGateDone()` **on the account** + `emailGateDone(userId)` (survives switching sign-in methods), returning-user skip on real message history, conversational-first-run done key `muster.onboarding-chat.done` = `"1"` (bare flag, no record), Settings "Replay welcome tour" (`src/components/SettingsModal.tsx:116-138` → `consumeTourReplay()` in `src/lib/analytics.ts`) = tour only. Adapt: a versioned `{version, completedAt, surface}` record + full review → §5 S1/S6. |
| 19 | Versioned one-file-per-concern state (`openbot-setup-v2`, `…-window-state-v1`, `…-browser-state-v1`, `…-remote-servers` at v3, `…-approval-automation-v2` — each carries its own `version`) | AE | Same house pattern already: server = DATA_DIR JSON module per feature (`server/why-journal.ts`, `server/delegations.ts`, `server/atomic.ts`); client = versioned keys `muster:onboarding-draft:v2:<accountId>` (with v1 legacy schema + tombstone that can never revive), `muster:voice-first-run:v1:<botId>`. |
| 20 | Provider picker with live per-provider availability/download/sign-in states during onboarding (`AgentStatus.providers`, `runtimeStatus`, `ProviderCodeLoginDialog`) | AD | Muster's `engines` step + `engineConnected` gate covers *connectivity* (AE); their **CLI runtime download/pinning** (`provider-runtimes` store) is a different architecture Muster does not run → out of scope (§7). |
| 21 | Single-user dev bypass with refuse-to-start flag discipline (`DEV_ACTOR`, `server/src/auth/dev-actor.ts`) | AE | Muster's own explicit-env discipline: `OMB_DESKTOP_APP` (desktop stays session-free — the OS boundary is the credential), `OMB_SIGNUPS_CLOSED` etc. Same philosophy: the flag must be *written down*, never inferred. |
| 22 | Sign screen prefetches providers in `beforeLoad` so buttons never flash "no providers" (`app/src/routes/sign.tsx`) | AD | Muster's LoginPage renders from `capabilities` (server-answered pre-session) — near-equivalent; the prefetch trick is a micro-polish, below the line (§5). |
| 23 | CEL fail-closed action gateway: one path resolves/decides/records/acts, readable audit, deny-before-allow, broken rule refuses (`README`, `server/`) | **RG** | Genuinely good — and a *redesign* of Muster's shipped posture (bounded `server/fleet-mcp.ts` tools + human approval cards + why-journal). Explicitly NOT this pass — see §7. |

**Counts: ALREADY-EQUIVALENT = 12 (#1,2,3,4,5,6,13,14,15,16,19,21), ADAPTABLE = 7
(#7,11,12,17,18,20,22 — of which #11 is superseded and #22 is micro-polish), REAL-GAP =
4 (#8,9,10,23). Total 23.**

Muster-ahead items worth stating explicitly (the owner's repo has none of these):
four-way sign-in incl. desktop pairing + OAuth loopback; sign-up-gate parity on the OTP
door **with tests** (`server/email-otp-signup-gates.test.ts`); the unverified-user
promotion fix; capability-advertised additive login UI; account-scoped onboarding done
flag that survives switching sign-in methods; per-account server-backed wizard draft
with legacy migration + tombstone; transactional wizard finish (dispose/generation
locks, accepted-once semantics — `src/state/onboarding-finish.ts`); and across the
harness at large the items the Astra brief already ships (Watch approval cards,
why-journal, plan rehearsal, routine scorecards, receipts).

---

## 3. Deep dives on the called-out capabilities

### 3.1 Email + code login — the full flow, side by side

**Their flow (evidence: `apps/auth-api` routes + `auth-service.ts` + `AccountLogin.tsx`):**

1. **Request code** — UI step `email` (normalized address) → `POST /v1/auth/email/start`
   with an optional UUID `Idempotency-Key` that *becomes* the challenge id, so a retried
   send replays the accepted challenge instead of erroring. Rate limits: 5 per email and
   20 per source IP per 15-minute window (keyed, hashed, auditable), plus a 60 s resend
   cooldown. The challenge row stores sha256 of id, code *and source IP*; TTL 10 min;
   `failed_attempts`/`max_attempts` columns; an index on `(email, created_at DESC)`.
2. **Delivery** — the send is recorded `sent` or `failed` per challenge; ambiguous SMTP
   errors become `email_delivery_pending` with a countdown budget (the button becomes
   "Check again in …"), hard failures surface `502`, unconfigured mailer `503`.
3. **Verify** — UI step `code` (OtpInput) → `POST /v1/auth/email/verify`
   {challengeId, code}; 30 per IP per window; lookup by challenge hash; wrong codes
   increment `failed_attempts`; expired → `410 sign_in_code_expired`; exhausted →
   `too_many_code_attempts` (both force "new code"); consumed → `409`; success consumes
   the row and issues the session.
4. **Session/retention** — client holds only an encrypted session token; a daily
   maintenance job deletes expired/consumed rows from D1.
5. **Dev bypass** — env `AUTH_EXPOSE_DEVELOPMENT_CODE=true` returns a deterministic
   `developmentCode` that the UI prints ("Development code: …"); mail delivery may be
   null while the flag is on (the flag doubles as the mailer bypass).

**Muster's shipped flow (this program's session/OTP work):**

`EmailOtpSignIn` (email → code, live 60 s resend ticker, back control) →
`POST /api/auth/email-otp/send-verification-otp` / `POST /api/auth/sign-in/email-otp`,
both intercepted by the **policy wrapper** `server/email-otp-login.ts` while every other
auth path falls through to Better Auth untouched. The wrapper owns exactly what their
`auth-service.ts` owns — sign-up gate parity, resend cooldown with seconds in the 429,
the unverified-user promotion fix — and the plugin owns code generation, hashing,
expiry (`OTP_TTL_SECONDS = 600`, i.e. the same 10 minutes), `allowedAttempts: 3`, and
minting **the same signed session cookie** every other Muster sign-in path produces.
Login offers it as one of four ways, only when `GET /api/auth-capabilities` advertises
`emailOtp`; tests: `server/email-otp-login.test.ts`, `server/email-otp-signup-gates.test
.ts`, `server/auth.test.ts`, `server/desktop-auth*.test.ts`.

**The honest delta:**

- **What openbot does that Muster lacks:** (a) **idempotent send** — their retry-after-
  dropped-response is a success replay, Muster's is a 429; (b) an explicit **delivery-
  state taxonomy** (`pending/sent/failed`, `email_delivery_pending/timeout/unknown`,
  `auth_api_unavailable`, distinct 502/503, UI wording that admits "could not confirm
  delivery"); (c) **keyed, auditable rate-limit windows** with `retryAfterSeconds` on
  *every* rejection (Muster surfaces seconds for its own cooldown but lets Better Auth's
  per-IP 429 arrive bare); (d) a **retention sweep** for expired/consumed auth rows
  (existence of accumulation must be reproduced first); (e) an env-gated
  `developmentCode` response for mailbox-less e2e — optional, behind env only.
- **What Muster already has that is equivalent or better:** identical TTL, cooldown and
  attempt-budget semantics; **sign-up gate parity with tests**; the **promotion fix**
  they have no need for but Muster does; **four-way login** including desktop pairing
  and OAuth loopback; the **HttpOnly signed cookie** instead of a client-held token;
  capability-advertised additive UI with the explicit "no path hidden" rule; and a
  server-account-scoped completion gate discipline that already exceeds their
  per-machine file (see §3.2).
- **What Muster should deliberately NOT adopt:** their challengeId-bound verify (would
  fork Better Auth's plugin — S3 covers the real double-send need), their client-held
  session token, and their separate Workers/D1 topology — Muster's in-process Better
  Auth on one server is simpler and already proven here.

### 3.2 Desktop onboarding — structure, state, completion

**Their model (source + the owner's installed-app evidence):**

- **Structure:** three wizard steps `meet → computer → jobs` (`OnboardingStep` in
  `OnboardingFlow.tsx`) with explicit forward/back, per-step avatar variants, a
  `ProviderPicker` showing *live* per-provider states (checking / available /
  error / sign-in-required + runtime download states), optional custom endpoints,
  provider device-code sign-in, `ComputerUseSetup` permissions, and a model choice
  tied to the chosen provider (`keptModel`: a saved model survives only while the
  provider is unchanged). A separate `InitialSetup` screen answers "Where will OpenBot
  run?" (this computer vs invite-to-host) with the account row and sign-out.
- **State persistence:** everything flows through one IPC pair — `getSetupState()` /
  `saveSetup({preferredProvider, preferredModel?})` — into `AppSetupState`
  `{preferredProvider, preferredModel?, completed}`. On disk that becomes the small
  versioned JSON the owner quoted (`openbot-setup-v2.json`: `version`, `preferredProvider`,
  `completedAt`), sitting beside same-pattern files for window, browser, remote-server
  and approval state — **one concern per file, each with its own `version`**.
- **Completion marker:** `completed` (plus `completedAt` on disk) gates the app shell —
  `AppAccessGate` reads `setupLoaded`; a `null` state means "not configured yet" and
  shows the flow. Analytics fires `onboarding_completed` **only on the first
  completion**; reopening from Settings is a *review* whose saves never re-fire it.
  Tests: `OnboardingFlow.test.tsx`, `App.onboarding.test.tsx`.

**Muster's current mechanics (already shipped, cited):**

- **Structure:** 7 steps in a 5-stage arc — welcome, tour, engines, phone, teammate,
  permissions, first-task (`ONBOARDING_STEPS`/`ONBOARDING_STAGES`,
  `src/state/onboarding-draft.ts`), hosted deployments replacing the wizard with the
  conversational first-run (`src/components/OnboardingChat.tsx`, done key
  `muster.onboarding-chat.done`), the desktop/local wizard kept as first-run
  (`src/App.tsx:280-283`).
- **State persistence:** per-account versioned draft `muster:onboarding-draft:v2:<accountId>`
  (zod-validated, v1 legacy schema, poisoned drafts rejected, tombstones never revived,
  storage optional) — **and** the wizard state is additionally backed by the account on
  the server with localStorage as the fast path, so a reload or a sign-in round trip
  cannot wipe fields (`src/state/onboarding-draft.ts`, `Onboarding.tsx:508-572`).
- **Completion marker:** the gate flag doubles as "has seen onboarding" and lives **on
  the account** (`serverGateDone()`) with `emailGateDone(userId)` as the per-browser
  fast path — an account that finished via email sign-in never sees the wizard again on
  a later Google sign-in; a returning user with real message history is auto-skipped
  and marked `"skipped"`; a deliberate Settings "Replay welcome tour" overrides the skip
  exactly once (`Onboarding.tsx:523-543`, `src/lib/analytics.ts:146-172`). Finish is a
  locked transaction: generation/dispose guards, accepted-once semantics, strict
  engine-gate evidence required before a first task can send
  (`src/state/onboarding-finish.ts`).

**The honest delta:**

- **Muster's wizard is deeper and its draft/done mechanics are stronger** (server-
  backed, per-account, migration+tombstone, returning-user skip, transactional finish).
  There is no wholesale port to do — this is parity confirmation, not a gap.
- **What openbot does that Muster genuinely lacks:** (a) a **durable, inspectable
  completion *record*** — `{version, completedAt, chosen provider}` as a first-class
  artifact — where Muster's two surfaces reduce to a bare `"1"` flag or a server bool;
  (b) a true **review mode**: reopening the whole flow to re-audit choices, versus
  Muster's tour-only replay; (c) live per-provider runtime states *inside* the picker —
  Muster's engines step checks connectivity but does not drive download/install states
  (different architecture; out of scope).
- **What Muster must keep:** the mascot/layout/route shells, the seven steps, both
  first-run surfaces, all saved choices and sessions — stability contract applies.

### 3.3 Everything else that is genuinely good — honestly ranked below 1–2

1. **Retention sweep for auth records** (`auth-data-retention.ts` shape) — real hygiene,
   but *verify first* that Muster's verification table actually accumulates (§5 S5);
   never add a deleter without a reproduced accumulation receipt.
2. **`retryAfterSeconds` everywhere + keyed send windows** (their `auth_rate_limits`
   discipline) — small, testable, makes every OTP rejection self-explanatory (§5 S2).
3. **Env-gated `developmentCode`** — only if an owned mailbox-less e2e fixture needs it;
   Muster's server-side dev log is the safer default (§7: never default-on).
4. **CopilotKit clone micro-patterns:** prefetch-before-paint sign-in buttons
   (`sign.tsx`), audit-writes-can-never-block-sign-in (`dev-actor.ts`'s `record()`
   neighbor `auth/index.ts`), and the "flag is the lock, refuse to start unless written
   down" discipline. All cheap; none urgent — Muster already follows the third.
5. **CEL fail-closed gateway + readable audit** — the best single idea in either repo,
   and explicitly **not this pass**: adopting it would redesign Muster's shipped
   bounded-tools + human-approval posture instead of fixing a reproduced defect (§7).

---

## 4. Desktop/Electron angle — mapped, NOT touched (study-only pass)

The owner's installed app is a *different product version* from Muster's Electron
shell; per the stability contract, local preview, production and installed apps are
distinct versions and none of them is edited by this doc. Mapping only:

| OpenBot (owner's repo) pattern | Lands in Muster | This pass |
|---|---|---|
| Email+code account API (Workers/D1) | Muster's in-process Better Auth + `server/email-otp-login.ts` (already shipped) | **Gap slices only** — §5 S2–S5; no new service, no topology copy. |
| `AccountLogin` two-step UI | `src/components/EmailOtpSignIn.tsx` on `src/pages/LoginPage.tsx` | Additive polish only; four-way layout preserved. |
| `OnboardingFlow` meet/computer/jobs | `src/components/Onboarding.tsx` (7 steps) + `OnboardingChat.tsx` | Record + review slices (§5 S1/S6); steps/layout untouched. |
| `openbot-setup-v2.json` completion record | New versioned client record beside existing flags (§5 S1) | New key only — every existing read of `muster.onboarding-chat.done` keeps working. |
| Provider runtime download store, Computer Use driver, channels/queues | Muster's own drivers (`server/drivers/`), cloud box/Local VM, fleet tools | **Map only — not ported** (different architecture). |
| Agents with `danger-full-access` + `approvalPolicy: never`, `defaultAutoApprove: true` | — | **Never** (§7 guardrail; approvals stay human on cards/Watch). |

**Excluded paths (verbatim, binding):** `www/*`, `.commandcode/`, `.freebuff/`,
`.zcode/`, `docs/research/glm/*`, `marketing-video/`, `www/fonts/`,
`www/templates.html`. **Hot files:** `server/index.ts` and `src/App.tsx` already carry
other work — additive hunks only; `src/components/SettingsModal.tsx` (S6's existing
Replay card lives there) must be status-checked with `git status --short` and
coordinated before any hunk. Zero edits under `ios/**`, `www/**`, or any excluded path
in any slice below. Staging/commit is **not** this subagent's job — no git at all.

---

## 5. Ranked implementation slices (smallest-verifiable-first)

### S1 — Versioned onboarding completion record (both first-run surfaces)
- **What:** when either surface finishes (or the conversational first-run is
  deliberately dismissed), write a versioned record mirroring their artifact —
  `muster.onboarding-done:v1` = `{"version":1,"completedAt":…,"surface":"chat"|"wizard",
  "accountId":…}` — **beside** the existing flags, never replacing them (every current
  read of `muster.onboarding-chat.done`, `serverGateDone`, `emailGateDone` keeps
  working; login stays additive, saved choices untouched).
- **Files:** `src/lib/onboarding-chat.ts` (record helpers + existing DONE_KEY),
  `src/components/OnboardingChat.tsx` (chat write site), `src/components/Onboarding.tsx`
  (wizard write site, additive hunk near the existing gate write), tests
  `src/lib/onboarding-chat.test.ts` (extend) + `src/state/onboarding-finish.test.ts`.
- **Verification plan:** extend the two touched tests with: record written once with
  correct surface; second write does not clobber `completedAt`; legacy installations
  (flag only, no record) still count as done; malformed record never blocks the flag.
  Then `npm run typecheck`, `npm run lint`, full `npx vitest run` before any commit —
  report real numbers.
- **CONFLICT FLAG:** none of the excluded paths. Hot file: `Onboarding.tsx` is large
  but unowned in this tree — additive hunks only.

### S2 — Uniform `retryAfterSeconds` on OTP send rejections (keyed send windows)
- **What:** wrapper-tracked send windows (per-email cooldown already exists; add the
  per-IP window Muster currently inherits bare from Better Auth) so *every* send
  rejection carries machine-readable seconds; client arms its countdown from the
  server's seconds instead of assuming, and the bare-429 branch
  (`EmailOtpSignIn.tsx:170`) gets real wording.
- **Files:** `server/email-otp-login.ts` (window bookkeeping around the existing
  cooldown), `server/email-otp-login.test.ts` (extend), `src/components/EmailOtpSignIn.tsx`
  (consume seconds), `server/contracts.ts` only if an error shape is shared — additive.
- **Verification plan:** extend `server/email-otp-login.test.ts` (deterministic clock):
  5/email window boundary, per-IP window distinct from per-email, seconds present on
  both, cooldown rejection still never spends the IP budget (existing invariant stays
  green). Component test follows the existing SSR-contract pin. Then `npx tsc --noEmit
  -p tsconfig.server.json`, `npm run typecheck`, `npm run lint`, touched vitest, full
  `npx vitest run` before commit.
- **CONFLICT FLAG:** none. Login stays additive — no route/flag removed.

### S3 — Idempotent OTP send (Idempotency-Key replay)
- **What:** the client generates one key per user-initiated send attempt and reuses it
  across transport-level retries of *that attempt*; the wrapper maps (email + key) →
  if that key was already accepted recently, replay the accepted response instead of
  429. A **new** key still hits the cooldown/rate windows exactly as today.
- **Files:** `server/email-otp-login.ts` (small in-memory replay map with TTL, house
  pattern like `lastCodeSentAt`), `server/email-otp-login.test.ts` (extend),
  `src/components/EmailOtpSignIn.tsx` (attach header to a send attempt).
- **Verification plan:** tests: same key+email replays once and sends exactly one code;
  different key inside cooldown still 429 `RESEND_COOLDOWN`; replay never bypasses the
  sign-up gates (gate parity invariant); map entry expires. Then typecheck
  (server project), full typecheck, lint, touched vitest, full suite before commit.
- **CONFLICT FLAG:** none. This supersedes their challengeId-bound verify (row #11) —
  no Better Auth fork.

### S4 — Send delivery-state honesty (accepted vs failed vs unconfirmed)
- **What:** make the send path say what actually happened: mailer threw hard →
  explicit failed code; mailer unconfigured → 503-style code; ambiguous/timeout →
  "could not confirm" state with a countdown the client can arm — their
  `email_delivery_pending` taxonomy, adapted to Muster's error codes and wording.
- **Files:** `server/email.ts` (surface delivery outcome — this file is the shipped
  OTP program's mailer; additive result plumbing only), `server/email-otp-login.ts`
  (map outcome → code), `src/components/EmailOtpSignIn.tsx` (wording), tests:
  `server/email-otp-login.test.ts` (extend with delivery-failure fixtures — **no real
  mail in tests**).
- **Verification plan:** fixture-only: hard failure, unconfigured, ambiguous each map
  to distinct codes; success path unchanged; cooldown arms only on accepted sends (the
  existing "a gated or rate-limited attempt arms nothing" invariant stays). Claims:
  "fixture-verified" only — **no security claims, no mail-provider claims.**
- **CONFLICT FLAG:** none of the excluded paths; `server/email.ts` coordination:
  status-check before editing (it is referenced by `server/auth.ts`'s dev log).

### S5 — Auth-record retention sweep (investigate first — reproduce before changing)
- **What:** step 1 (evidence): in an **owned fixture** `OMB_DATA_DIR`, run OTP
  send/expire cycles and prove whether expired verification/challenge rows accumulate.
  Step 2 (only if reproduced): a bounded sweep at boot + interval deleting rows past
  TTL+grace, house pattern (`server/atomic.ts`, one owner, no cross-feature writes).
- **Files (step 2 only):** new `server/auth-retention.ts` + `.test.ts`, wiring additive
  in `server/index.ts`.
- **Verification plan:** the reproduction receipt is the gate for writing any code
  (stability contract rule: reproduce the defect first); sweep test proves expired rows
  go, fresh rows and live sessions stay. Then server typecheck, lint, touched vitest,
  full suite.
- **CONFLICT FLAG:** hot file `server/index.ts` → additive hunk only. If no
  accumulation reproduces, **close the slice with the receipt and change nothing.**

### S6 — Onboarding review mode (full-wizard re-audit, first-completion semantics preserved)
- **What:** extend the existing Settings "Replay welcome tour" path so a user can
  re-open the wizard as a *review* (draft loaded read-mostly, open at the chosen step,
  save = review) while a review can never clear the done flags/record or re-fire
  completion — their `wasCompleted` rule.
- **Files:** `src/components/Onboarding.tsx` (review branch beside the existing replay
  consume), `src/lib/analytics.ts` (replay intent already exists — reuse), existing
  Settings card at `src/components/SettingsModal.tsx:116-138` (**status-check +
  coordinate first**), tests: `src/state/onboarding-draft.test.ts` +
  `onboarding-finish.test.ts` (extend).
- **Verification plan:** tests prove: review opens without touching done flags; save
  during review does not re-write the S1 record's `completedAt`; draft untouched when
  review is cancelled; tour replay still behaves exactly as today (regression pin).
  Then typecheck, lint, touched vitest, full suite.
- **CONFLICT FLAG:** `SettingsModal.tsx` is the one file to coordinate — if it is
  actively owned in the working tree, land the API-only half first and defer the card.

**Deferred / below the line (not scheduled):** env-gated `developmentCode` (only if an
e2e fixture demands it); sign-screen prefetch micro-polish (row #22); CLI runtime
download states (row #20 — different architecture); CEL gateway (row #23 — redesign,
owner rule: audits fix reproduced defects); anything native under `ios/**`; any excluded
path from §4.

---

## 6. The eval to run first (astra-brief style)

Runnable today against an **owned fixture** (own explicit port + own `OMB_DATA_DIR`;
never port 8845, never a user's storage):

1. Start the owned server (`npm run dev:server` on an explicit free port with
   `OMB_DATA_DIR` pointed at the fixture) and open `/login` — confirm all four ways in
   render and `capabilities.emailOtp` advertises the code path.
2. Drive the email+code loop: request → immediate second request expects
   `RESEND_COOLDOWN` **with seconds** → wait it out → resend → wrong code ×3 expects
   the attempt-budget refusal → correct code expects the signed
   `better-auth.session_token` cookie and an authenticated `get-session`.
3. Gate audit: with `OMB_SIGNUPS_CLOSED=true` and an off-list address, the OTP door
   must refuse a *new* account with the same code the sign-up route returns
   (`GOOGLE_ONLY_SIGNUP`/`SIGNUPS_CLOSED` precedence intact); existing accounts still
   sign in — this is the load-bearing parity proof.
4. Onboarding probe on the fixture: fresh state shows the wizard (desktop/local) or
   conversational first-run (hosted); reload mid-wizard → draft restores step + fields;
   finish → done flag + S1 record written once; replay/review → completion never
   re-fires; sign in a second way afterwards → wizard stays done (account-scoped gate).
5. Score: gate parity, draft-restore fidelity, cooldown/attempt UX honesty, **zero
   lost sessions or saved choices**, and the real touched/full test counts vs the
   latest handoff-ledger baseline (report any decrease explicitly).

---

## 7. License + attribution, and what NOT to do

### License verdict

- **Two verdicts, because there are two repos — attribution must name the right one:**
  1. **`github.com/CopilotKit/OpenBot` — MIT = permissive** (local `LICENSE` verified:
     "MIT License / Copyright (c) 2026 CopilotKit"). Verbatim or near-verbatim reuse
     inside Muster (patterns from `server/src/auth/`, `app/src/routes/sign.tsx`, the
     dev-actor discipline) requires an **SPDX-style attribution header in the file
     header**: `Adapted from CopilotKit/OpenBot (github.com/CopilotKit/OpenBot), MIT
     License, Copyright (c) 2026 CopilotKit.`
  2. **`github.com/nightly-labs/openbot` — PolyForm Noncommercial 1.0.0 = NOT
     permissive** (README-attested: "Copyright 2026 Norbert Bodziony … You may use,
     modify, and distribute the code for permitted noncommercial purposes. Commercial
     use requires a separate license … Versions up to and including 0.1.11 remain
     available under Apache-2.0."). Muster is commercial (BSL 1.1, change date
     2030-08-19 → Apache-2.0, prod at muster.today): **no verbatim copying from this
     repo.** Port *flows, semantics and shapes* only, re-implemented in Muster house
     patterns — which this study's deltas already satisfy, since Muster's email+OTP
     exists independently. Verify the LICENSE file text itself before any future reuse
     decision; do not rely on the README alone.
- **Repo docs/file headers only:** per AGENTS rules, **never surface any github.com
  link or the "openbot" name/branding in user-facing Muster UI** — attribution lives in
  source headers and docs like this one. Never `npx muster` anywhere.
- **No security claims and no deployment claims** may ride along with any ported slice:
  their SMTP/retention/delivery paths are "read in source", not verified live; Muster's
  own auth is "tests pass", never "secure".

### What NOT to do (guardrails)

1. **No verbatim copies from the PolyForm repo** (see §7 license) — semantics only; MIT
   CopilotKit reuse gets the SPDX header.
2. **Do not fork Better Auth's emailOTP plugin** to get challengeId-bound verify — S3
   idempotency solves the actual double-send need with zero fork risk.
3. **Do not replace the signed HttpOnly session cookie** with a client-held token, and
   do not remove/hide any of the four login paths (login stays additive; sessions and
   saved choices preserved).
4. **Do not import their autonomy posture** — `danger-full-access`,
   `approvalPolicy: never`, `defaultAutoApprove: true` are observed defaults in their
   product; in Muster approvals stay human on OptionCard/Watch, Goal mode stays
   bounded, and nothing auto-approves by default.
5. **Do not redesign the surfaces:** mascots, route shells, layout, theme, drafts,
   both first-run surfaces and the seven wizard steps are contract
   (`docs/guides/web-app-stability.md`); audits fix reproduced defects.
6. **Do not touch the excluded parallel-session paths** (`www/*`, `.commandcode/`,
   `.freebuff/`, `.zcode/`, `docs/research/glm/*`, `marketing-video/`, `www/fonts/`,
   `www/templates.html`), never `ios/**` in these slices, `server/index.ts`/`src/App.tsx`
   additive only; status-check `SettingsModal.tsx` before S6.
7. **Credentials env-only, never literals. No `npx muster`. No security or deployment
   claims. Work on `main`; this pass ran no git at all —** every future slice reviews
   `git status --short` before staging and commits only its own verified work.
8. **Never point a preview at an unidentified backend, never touch port 8845 or any
   running user session, keep existing automation paused,** production verification
   GET-only, and a push is never reported as a deployment.
9. **Installed-app state files stay evidence-only:** future studies may read the small
   versioned JSON state files; **never read Cookies, Keys, or any file containing
   private keys, and never quote such contents anywhere.**

---

*Written by the research/planning subagent (read-only pass): both repos and the cited
Muster files mined 2026-09-23. No tests executed, no services started, no file
modified, no git command run. License verdicts: CopilotKit/OpenBot = MIT (LICENSE
verified); nightly-labs/openbot = PolyForm Noncommercial 1.0.0 (README-attested,
LICENSE file check required before any reuse).*
