# Vellum auth & web↔desktop sync — studied 2026-09-18 (source-verified)

Sources fetched from `vellum-ai/vellum-assistant` HEAD via raw.githubusercontent
on 2026-09-18: `assistant/src/runtime/auth/token-service.ts`,
`assistant/src/desktop/desktop-session-manager.ts`,
`assistant/src/daemon/message-types/sync.ts`,
`assistant/src/runtime/sync/resource-sync-events.ts`,
`assistant/src/__tests__/actor-token-service.test.ts`,
`assistant/src/__tests__/sync-message-contract.test.ts`,
`assistant/docs/mode-sessions.md`. Method: read the source, compare against
Muster's equivalent files, adopt nothing that Muster's model already covers.
No code was copied (license discipline: study, cite, do not vendor).

## 1. What Vellum actually is (architecture first)

Vellum is **gateway-centered**: one cloud gateway + one local daemon own all
state; every surface (web UI, desktop shell, CLI, phone) is a client view of
that daemon. Their "desktop" (`desktop-session-manager.ts`) is **the bot's
cloud VNC computer** (Xtigervnc on loopback, Chrome, Plank dock, streamed via
an authenticated `/v1/desktop/stream` WebSocket) — not a user desktop app.
This naming matters: most of what looks like "desktop sync" in their repo is
bot-computer streaming, which is Muster's per-bot computer panel domain.

## 2. Vellum's auth logic (evidence-backed)

- **JWT single-header auth** (`runtime/auth/token-service.ts`): standard
  header.payload.signature JWTs, HMAC-SHA256, 32-byte signing key
  load-or-create persisted on disk (with a documented legacy-path fallback),
  token claims typed by audience (`TokenAudience`) and scope profile
  (`ScopeProfile`), plus an epoch/staleness policy (`isStaleEpoch`).
- **Gateway-native pairing** (stated in `actor-token-service.test.ts`
  preamble): "Pairing flow tests have moved to the gateway (pairing is now
  gateway-native). The gateway owns credential minting and guardian binding
  creation." The **guardian** is the human owner an assistant is bound to.
- **Local identity fallback**: when no gateway is reachable, the daemon
  resolves a local auth context from its own store
  (`resolveLocalAuthContext`) so a solo install still authenticates itself.
- **Connector OAuth is a separate subsystem** (`src/oauth/` — store,
  providers, token persistence, refresh/retry, revoke): this is Muster's
  Composio/OpenConnector/account-Drive layer, not user sign-in.
- Legacy note in the same test file: their **old HMAC actor-token middleware
  was removed in favor of the JWT middleware** — evidence the JWT path is the
  current truth.

## 3. Vellum's web↔desktop sync (evidence-backed)

- **One state owner**: the daemon's SQLite (conversations, config, identity,
  documents). Clients never own state; they hold views.
- **Sync-invalidation tags** (`daemon/message-types/sync.ts`): every mutation
  publishes a `sync_changed` event carrying tags —
  `assistant:self:{avatar,identity,config,sounds,schedules,desktop,theme}`,
  `apps:list`, `documents:list`, `plugins:list`, `mcp:list`,
  `conversations:list`, `conversation:<id>:messages|metadata`, feature flags,
  `acp:auth-recovery`. Clients refetch the tagged resources. It is an
  **invalidate-and-refetch** protocol, not a data-push.
- **Origin echo suppression** (`resource-sync-events.ts`): the mutating route
  sends `x-vellum-client-id`; the publisher stamps it as `originClientId` so
  the initiating client can skip its own invalidation (it already applied the
  change optimistically).
- **Gap handling**: tags are the gap-fill; a client that reconnects refetches
  whatever the tags mark dirty. No replay buffer in what was fetched.
- **Mode sessions** (`docs/mode-sessions.md`): conversation-owned lifecycle
  records for computer-use/browser/live-vision activity — immutable
  membership, monotonic revision, startup recovery marks leftovers
  interrupted. (A transcript-organization pattern, adjacent to Muster's
  tool-activity grouping.)

## 4. Muster's equivalents (file-grounded comparison)

| Concern | Vellum | Muster | Verdict |
|---|---|---|---|
| User sign-in | JWT HMAC single-header vs gateway | better-auth email/password + Google OAuth; httpOnly session cookies; auth-gate bounce preserves `next`; sign-out; merge-code account fold (Settings → General) | **Covered.** Cookie sessions are the right primitive for a browser app; JWT-in-header is built for CLI/daemon callers, which Muster covers with peer-lease comms tokens instead. |
| Desktop app ↔ web sign-in | Same daemon, same local identity — no per-surface login | Desktop (Electron) loads the local server (no local session gate on desktop installs); cloud sign-in via the in-app OAuth handoff window (https-only, host-allowlisted, lands the cookie in the app's own jar — 33bb98d) | **Covered.** Verified live this session: sign-up → session → sign-out → sign-in round trip; handoff wiring verified across preload/IPC/renderer. |
| Companion/remote pairing | Gateway-native, gateway mints credentials | Per-install pairing code (6-digit, one-time token, `muster://pair` deep link), HMAC device token in the Keychain (`ThisDeviceOnly`), peer-lease tokens with frozen grants for bot-to-bot | **Covered**, and multi-user-safe (per-user SSE visibility filters, SELF_HOSTED walls). |
| Live state sync to surfaces | `sync_changed` tags → clients refetch | **Push-with-payload SSE**: `store.onChange` → granular frames (message, message.patch, thread, bot, bot.deleted, group, notify, runtime, screen, computer); seq-numbered, `STREAM_ID:seq` in the SSE `id:` field, 500-frame replay buffer, Last-Event-ID resume with no client code, per-client visibility filter, screen frames opt-in | **Muster is stronger live**: data-push beats invalidate-refetch (no second round trip), and resume is built into the protocol. |
| Reconnect/restart gap | Tags mark what to refetch | 30s disconnected reconcile poll (`/api/bots?messages=0`) + hello-frame hydrate decision + replay buffer for short gaps | **Covered.** |
| Echo suppression | `originClientId` self-echo-skip | Not present; the store folds frames idempotently by message/thread id, so an echo is a no-op dispatch | **Not needed.** Cost of adopting exceeds the cost of the no-op. |
| Cross-machine state | Cloud gateway = all surfaces share one live state | Deliberate no-cloud-state-copy: encrypted portable backup (v2 envelope) to the user's own Google Drive/Telegram/file + remote-access client role for live remote control | **Deliberate difference — this is the moat.** The owner's directive is Drive-based sync, not a hosted state copy; the Drive continuum is end-to-end encrypted (passphrase-only) and proven (roundtrip 8/8, capability seam live). |
| Bot avatar/identity/theme sync | First-class tags | Rides the normal `bot` frames (`wireBot` carries the full record) | **Covered.** |

## 5. "Same needed?" — the verdict

**No adoption is required.** Vellum solves the same two problems (who is the
user on every surface; how do surfaces see one state) with primitives shaped
for a cloud-gateway product. Muster solves them with primitives shaped for a
local-first, multi-user-capable product, and in the live-sync dimension
Muster's protocol (push + replay + resume) does more work per event than
Vellum's (invalidate + refetch). The one thing Vellum has that Muster
deliberately does not — instant cross-machine state via a central gateway —
is the design the owner explicitly replaced with the encrypted Drive
continuum; adopting Vellum's model would mean hosting a state copy and
would cut against the privacy moat.

Two small observations worth keeping in the file for later slices:

1. **Vellum's `acp:auth-recovery` tag** — an invalidation dedicated to
   "a credential failed, offer the inline reconnect card, and retire the
   prompt once the token is replaced." Muster's engines surface auth errors
   in-thread; a dedicated recoverable-surface state (a card that retires
   itself when the credential is refreshed) is a nice pattern if engine
   sign-in friction ever grows.
2. **Their mode-session startup recovery** (mark every leftover active record
   interrupted at boot, with reason `assistant_restarted`) is exactly the
   shape Muster already uses for durable Stop cleanup and session receipt
   recovery — an independent confirmation of that design.

## 6. Non-claims

Study only; no Muster code changed for this comparison. No security claim
about either codebase. Vellum's repo is Apache-2.0 (per its LICENSE at fetch
time) but nothing was vendored; all evidence is cited by path so any claim
here can be re-checked at the source.
