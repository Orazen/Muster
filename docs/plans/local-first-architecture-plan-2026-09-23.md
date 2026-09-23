# Local-first, user-owned architecture — assessment and plan (2026-09-23)

**Status:** design/assessment document only. Study-only session: one file written,
no code changed, no git commands, no tests run, no server started, port 8845
untouched. Every claim below points at a real file inspected on 2026-09-23.
Where the owner's brief assumes something that does not exist, this document
says **"does not exist — build in phase N"** rather than implying it ships.

---

## TL;DR

The brief's central principle — *Muster Cloud coordinates, the user's device
computes, the user's storage remembers, connected services provide
capabilities* — is **already the shipped architecture of the desktop/self-host
build**, and it is roughly 60% built even where this document says "refactor":

1. **The local-first spine exists.** The agent runtime, chat/session
   management, memory engine, task engine, tool execution, caching, agent
   configuration and provider calls all run in one local Node process
   (`server/index.ts`, ~9,637 lines) whose data root is `~/.muster/`
   (`server/config.ts:170`). Electron, the CLI and the fleet MCP server are
   control surfaces over that same local process. SQLite (`node:sqlite`, WAL,
   0600) already backs transcripts (`server/message-db.ts`) and auth
   (`server/auth.ts:238`).
2. **The event-based sync system the brief asks for already exists** —
   shipped as DESIGN §38 phases S0–S3 + B1 + K1-format (Loops 177–186, 188):
   a rev/checksum change journal (`server/sync-journal.ts`), a per-object
   encrypted envelope + encrypted manifest (`server/sync-objects.ts`), a full
   verify-then-apply sync pass (`server/sync-pass.ts`), real Drive wiring
   (`server/sync-wiring.ts`), a boot-wired engine (`server/index.ts:432–446`)
   and an encrypted `appDataFolder` object layout (DESIGN §9). **The honest
   gap: only one object type is produced today — `memory`
   (`server/sync-memory.ts:104`).** Chats, agents, SOUL, preferences and tasks
   do **not** sync yet — build in Phases 3–4.
3. **Email → OTP → session is shipped** (better-auth `emailOTP` +
   `server/email-otp-login.ts`, Loop188). **Google sign-in exists but is
   env-gated and desktop-routes through the cloud's OAuth dance**
   (`server/auth.ts:402–408`, `/desktop-auth/start`); **Drive connect exists
   and is already logically separate from sign-in with an appdata-only scope**
   (`server/drive-sync.ts:13–21`), while the login-scoped account-Drive
   push/pull is deliberately 501-contained pending Google subject/scope
   verification (`DESIGN.md:194–197`). The brief's assumption that Google
   sign-in and Drive connect are "not yet built" is **partially wrong** — the
   mechanisms exist; the outstanding parts are real OAuth credentials
   (owner gate), subject/scope verification, and acceptance.
4. **What genuinely must change** is the *hosted* shape: on muster.today the
   server-side store is authoritative per tenant (DESIGN §8 "Web hosted").
   That is the one place where "Muster Cloud computes and remembers" is true
   today. The plan moves it to transient hydration + wipe-on-end (Phase 6),
   keeps the relay as an opt-in transport capability (reconciliation below),
   and never routes normal Drive/AI traffic through Muster servers.
5. **Recommended Phase 1:** extract the `StorageProvider` seam (brief §13)
   behind the already-injected `SyncTransportDeps` and ship a
   `LocalStorageProvider` — a pure, test-covered refactor that touches no user
   data, no UI, and unblocks every later storage and device-restore slice.

Priorities applied throughout, in the owner's order: **local-first → privacy →
portability → low server usage → reliability → extensibility → performance.**

---

## Reconciliation (explicit): local-first vs. the owner-locked cloud-relay strategy

The owner locked `docs/plans/cloud-relay-strategy-2026-09-18.md` on 18
September ("cloud-relay flagship, BYOK free forever, Drive/Telegram-only
storage"), referenced by `docs/AGENT-ORIENTATION.md` §3 as the product-direction
doc. That file itself states the governing rule: **"latest owner request
outranks every older plan"** — and its own 19 September supersession note points
at `docs/plans/personal-assistant-beta-decisions-2026-09-19.md` first. This
local-first brief (23 September) is the newest owner request, so it governs
where the two conflict; everything below records exactly where that lands.

**They agree on the load-bearing decisions:**

| Cloud-relay lock (09-18 / 09-19) | Local-first brief (09-23) | Verdict |
|---|---|---|
| Decision 5: BYO-computer relay — bots run on the user's machine; muster.today is "control plane + relay, near-zero hosted compute" | §1: the user's device performs agent runtime, memory, tasks, context, tools | **Identical.** The brief names the same topology with more granularity. |
| Decision 14: storage sovereignty — chats/memory/files live ONLY in the user's Drive/Telegram; muster.today keeps NO stored workspace copy | §3: Muster Cloud must not become primary storage for conversations, memories, SOUL, agent states, tasks, knowledge, attachments, embeddings | **Identical.** §3 is the general form of decision 14. |
| Decision 4/8: BYOK free forever, all providers BYOK, no pooled inference | §8: provider abstraction, prefer BYOK, direct client→provider calls | **Identical.** |
| Decision 6: Desktop/self-host stay first-class; "the relay is an additional front door, never a dependency" | §1, §4: work locally even if Muster Cloud is unavailable | **Identical.** This sentence in the lock is already the brief's §4 requirement. |
| Decision 12: route to any online paired device; otherwise queue as intents server-side (routing, never hosted execution) | §12: multi-device through versioned events; §14 server-cost rule | **Compatible.** Queued *intents* are minimal coordination metadata (brief §3), not user data storage. |

**Where the brief refines or supersedes the lock — stated head-on:**

1. **Cloud-relay flagship vs. minimize Muster servers.** Resolution: *relay as
   opt-in capability, local-first as the default spine.* muster.today remains
   the flagship **front door** (decision 1) — but a front door is a routing and
   identity surface, not a compute or storage surface. The brief's §14
   Server-Cost Rule governs every new relay feature: if the work can run on a
   paired device, the relay transports the intent and never executes it. The
   lock already says this ("routing, never hosted execution"); the brief
   elevates it from a deployment preference to a **rule every feature must pass
   before it is built**. Where the lock's "cloud-hosted first" implied hosted
   features defaulting to server-side state, the brief supersedes: server-side
   state for user data is now presumptively forbidden (§3).
2. **Decision 14's hard storage gate vs. additive onboarding.** The lock makes
   Drive/Telegram connect a required first-run gate before any workspace. The
   brief (§4, §7) requires the app to *work locally first*, with Drive as
   preferred user-owned sync/backup discovered at restore/onboarding. Resolution:
   keep the connect step first-run and prominent (it is already enforced at
   hire-time and work-start: `server/index.ts:7226,7692`), but a local-first
   install must not be bricked without it — offline/local operation outranks
   the gate for desktop/self-host, while the hosted front door may keep the gate
   as decided. Record this as one open owner confirmation in Phase 6, not a
   unilateral change: **this document does not edit the lock.**
3. **"Drive/Telegram-only storage" vs. brief §3's minimal cloud metadata.**
   Compatible: the cloud keeps `user_id`, auth identity, license, device
   registrations, minimal sync metadata, public config, and encrypted OAuth
   material where unavoidable — none of which is "stored workspace copy".
   Telegram stays a secondary *backup transport* (DESIGN §13: "Telegram is never
   the primary database"), consistent with the 19 September "Google Drive first;
   Telegram storage after reliable recovery is verified".
4. **Transient hydration (lock §2, sub-decision a) vs. brief §3.** Hydration
   creates a server-side working copy *during a browser session*. The brief
   permits only minimal persistent cloud state. Resolution: hydration is a
   **cache, not a store** — created from the user's online paired device or
   latest Drive snapshot, continuously pushed to Drive, wiped on
   sign-out/timeout (lock's own wording), never the system of record, never the
   restore source. That machinery does not exist yet — **build in Phase 6.**
5. **Topology law (brief §5) applied to the relay.** Allowed: Device →
   Google Drive / AI provider / GitHub / Telegram directly (already true for
   desktop: the local server *is* the device, so `server/drive-sync.ts` and
   `server/drivers/*` are direct calls, not proxies). Forbidden: Device →
   Muster Server → Drive / AI — except where security or API restrictions
   genuinely require it. The one genuine-requirement case is a **browser**
   session (it holds no keys, cannot safely call providers on the user's
   behalf) — that is exactly why the browser must be a thin client of a paired
   device (Phase 6/7), not of hosted compute.

**Net:** no reversal of the lock is needed. The brief converts three of the
lock's deployment preferences (near-zero hosted compute, no stored workspace
copy, BYOK) into standing architectural law with a pre-flight test, adds the
storage abstraction and sync object coverage the lock assumed, and is
superseded-by-nothing-older. The single behavior change to owner-flagged
decisions is item 2 above (gate vs. local-first boot), queued for explicit
owner confirmation before Phase 6.

---

## 1. Current architecture assessment

### 1.1 Deployment shapes that exist today

| Shape | Who computes | Who stores | Evidence |
|---|---|---|---|
| **Electron desktop** (Mac; Windows/Linux packaged) | local Node server spawned by `electron/server-lifecycle.mjs` | `~/.muster/` only | `server/config.ts:170`, `OMB_DATA_DIR` override |
| **Self-host / CLI host** (`muster up`, Docker) | local/own box | its own `DATA_DIR` | `cli/muster.mjs`, `Dockerfile*` |
| **Hosted web (muster.today)** | the Muster server does everything | server-side multi-tenant store is authoritative | DESIGN §8 "Web hosted" |
| **Muster Cloud (identity bridge)** | — | identity only, opt-in | `server/muster-cloud.ts` header: "does NOT sync bots, threads, or messages" |

Desktop and self-host are already local-first in fact: DESIGN §8's first line
is "`DATA_DIR` is the whole truth … UI actions NEVER touch the network for
state." **The hosted shape is the entire remaining gap** for §1 and §3 of the
brief.

### 1.2 `~/.muster/` — read-only inventory (inspected 2026-09-23, never modified)

| Entry | Size | What it is |
|---|---|---|
| `messages.db` + `-wal` (4.1 MB) + `-shm`, mode 0600 | 128 KB | transcripts — `server/message-db.ts` (`messages`, `thread_state`, `stop_cleanup_receipts` tables; `node:sqlite`; WAL; owner-only perms repaired at open) |
| `auth.db` + WAL + shm | 192 KB | better-auth schema + **`sync_journal`** table (`server/auth.ts:238`; journal passed this handle at `server/index.ts:433`) |
| `auth.secret`, 0600 | 44 B | login-signing secret; also v1 bundle KDF input (`docs/plans/portable-backup-contract-2026-09-12.md`) |
| `config.json`, 0600 | 2.7 KB | provider keys, Drive token, settings — env-first with env fallbacks (`server/config.ts:260–267`) |
| `bots.json`, `groups.json` | 3.1 KB / 2 B | fleet + groups records (`server/store.ts:366–368`) |
| `cli.json`, `claim-codes.json`, `pairing-codes.json`, `onboarding-gate.json`, `license.json`, `team-context.json` | ≤ 3 KB each | CLI session cookie; pairing/claim state; gates |
| `events/*.ndjson` | 220 KB total | **thread runtime evidence**, not sync events (`EVENTS_DIR`, `server/config.ts:172`; read at `server/index.ts:8213`) |
| `data/` | 536 KB | **a second, nested data root with its own `auth.db`, `messages.db`, `bots.json`** — a real ambiguity on this machine (migration hazard #1, §12) |
| `workspaces/` | 373 MB | per-bot `MEMORY.md`, `memory/*.md` topics, `.memory-history/`, SOUL content, cwd files |
| `native/`, `bin/` | 1 MB / 90 MB | engine binaries/profiles |
| `vm-home/`, `vm-secrets/` (0700), `run/`, `snapshot-state/` | small | local VM + snapshot bookkeeping |
| `cua-connection.json` | **absent today** | Electron writes it when a CUA connection exists; not present in this listing |
| `routines.json`, `goals.json`, `decisions.json`, `social.json`, `attachments/` | **absent today** | created lazily at first write (`server/routines.ts:319`, `server/goals.ts:110`, `server/attachments.ts:21`) |

Not observed and therefore **does not exist on this install**: `muster.db`,
`identity/`, `memory/memory.jsonl`, `chats/`, `agents/`, `tasks/`,
`knowledge/`, `cache/` — the brief's §4 tree is a **target**, not current
state (see §4 for how it is adopted without breaking anything).

### 1.3 Backup/restore mechanics — precise inventory

- **v2 portable bundle — shipped.** `server/workspace-bundle-v2.ts` (2,766
  lines): `BUNDLE_SCHEMA = 2`; passphrase-only scrypt KDF with recovery-code
  MEK slots (K1 format half, Loop177); AES-256-GCM with canonicalized header as
  associated data; 11 named verify checks; safe-relative-path confinement; a
  staged **all-or-nothing** restore (`stageRestoreV2` → `commitRestoreV2` →
  `restoreBundleV2`) that backs up covered paths, rolls back to the byte on
  failure, strips permission/connection grants and returns
  `reconsentRequired[]`; transcripts snapshotted via `VACUUM INTO` with branch
  heads preserved; eight selective restore categories (S3, Loop186).
  **Excluded by construction:** `config.json`, `auth.secret`, `auth.db`,
  attachments, provider keys/connections (DESIGN §11).
- **Boot-applied restore — shipped.** `server/restore-apply.ts`: staging lives
  in a sibling of `DATA_DIR` (the commit guard refuses inside), a
  pre-mutation safety snapshot is captured *synchronously* before
  `PRAGMA wal_checkpoint(TRUNCATE)` (`restore-apply.ts:199,236`), commit
  happens before Store/message-db open, then **de-weaponization** (restored
  routines never fire, goals never resume) and a `last-restore.json` receipt;
  any failure rolls back and never deletes.
- **Automatic snapshots — shipped (B1, Loop188).**
  `server/snapshot-runner.ts` gate order: desktop-only → Drive connected →
  Keychain passphrase store available (`server/keychain-store.ts`, argv-array
  `/usr/bin/security`, never logs the value) → readable passphrase ≥ 8 chars;
  `server/snapshot-scheduler.ts` nightly 02:00 local with per-day attempt
  budget; retention ladder 7/7/4/6 under the **never-delete-the-last-healthy**
  invariant; pre-migration/pre-restore captures.
- **Routes — shipped.** `server/workspace-backup-routes.ts` (ordered route
  table, registered at `server/index.ts:5139` inside the session gate, above
  the multi-tenant guard): `/api/workspace/export|restore`,
  `/api/workspace/drive/{url,connect,push,pull,sync}`,
  `/api/workspace/telegram/{connect,disconnect,push,pull}`, plus
  `GET /api/devices` (`workspace-backup-routes.ts:674`).
- **Drive transport — shipped.** `server/drive-sync.ts` writes
  `muster-workspace.enc` (v1) and `muster-workspace-v2.enc` into
  **`appDataFolder`** (`drive-sync.ts:13–17`, scope
  `…/auth/drive.appdata` only, `drive-sync.ts:21`; asserted in
  `server/drive-transport.test.ts`). Sequential update of one file — "neither
  retained snapshot history nor conflict-aware sync" (portable-backup contract).
- **Login-scoped account-Drive — contained, not live.** `server/account-drive.ts`
  holds per-login `drive.appdata` tokens; its routes answer 501 until Google
  subject/scope verification passes (DESIGN §9); Loop144 added consent
  isolation (one-use state, identity/scope check, separate Drive credentials
  that preserve login/Calendar tokens). Hosted installs 403 the installation
  backup/vault families for every account — **preserve these denials.**
- **What does not exist:** no route or UI consumes a v2 bundle for *merge*
  (covered paths are replaced, not merged), no re-consent UI for
  `reconsentRequired[]`, no cross-installation acceptance against real
  production data, no real Google provider calls in any test (owned fixtures
  only).

### 1.4 Server route groups vs. the Server-Cost Rule (§14)

All routes below live in `server/index.ts` (9,637 lines; 113 `POST` branches)
plus the extracted `workspace-backup-routes.ts` family. Verdict legend:
**Stays** = genuine Muster coordination/ops · **Device** = runs in the local
server process, which *is* the device (no topology violation) ·
**Thin-coordination** = keep the endpoint, shrink what it persists ·
**Hosted-move** = today server-side on muster.today; must move or become
transient (the refactoring work).

| Group | Representative routes | Verdict |
|---|---|---|
| Auth/session/identity | `/api/auth/*` (better-auth + OTP wrapper), `/api/auth-capabilities`, `/api/pair/{create,verify,redeem,claim*}`, `/desktop-auth/*`, `/api/account/merge/*` | **Stays** (cloud) + local better-auth on device; brief §3 allow-list |
| Fleet/chat runtime | `/api/bots*`, `/api/threads/*`, `/api/groups`, `/api/events` (SSE), `/api/rooms`, `/api/dispatch`, `/api/search`, `/api/attachments` | **Device** already; **Hosted-move** on muster.today (→ Phase 6 transient hydration) |
| Memory/knowledge | `/api/brain{,/facts,/query}`, `/api/bots/:id/soul.md`, memory routes, M1 retrieval routes | **Device**; **Hosted-move** |
| Sync/backup | `/api/workspace/*` + backup family (incl. `/api/devices`) | **Device → Drive directly** (already true on desktop); hosted keeps 403/501 containment |
| Tasks/automations/evidence | `/api/routines`, `/api/goals`, `/api/receipts/*`, why-journal, scorecards | **Device**; **Hosted-move** |
| Providers/BYOK | `/api/instances`, `/api/providers`, `/api/custom-providers*`, `/api/user-keys`, `/api/engines/doctor`, `/api/tts/*`, `/api/models/free-best`, `/api/usage/providers` | **Device** (direct client→provider); `/api/user-keys` = brief §3 "encrypted key storage when unavoidable" → **Stays** hosted only for hosted sessions |
| Relay/control | `/api/pair/*`, `/api/desktop-auth/exchange`, `/api/control/*`, `/api/local-computer*`, `/api/vms/*` | **Stays** — the relay's real job (routing, never execution) |
| Integrations | `/api/connectors*`, `/api/mcp-servers*`, `/api/calendar/*`, `/api/telegram-channel`, composio/webhooks/whatsapp | **Device** where bots run; webhook ingress necessarily **Stays** |
| Muster ops/infra | `/api/billing/*`, `/api/health`, `/api/build-identity`, `/api/diagnostics`, `/api/vps/status`, `/api/security-scan`, `/api/internal/*`, `/api/scout`, `/api/vault/*` | **Stays** (Muster-operated; vault family already 403-walled for hosted) |
| Social/public surfaces | `/api/social/*`, `/api/directory/*`, `/api/wrapped*`, `/api/referral/*`, `/api/team-library/github` | **Stays** as coordination for *shared* content only; private-by-default per 09-18 decision 11; `social.json` writer is server-side single-writer today (DESIGN §33) → later object sync |

`server/contracts.ts` (431 lines) remains the canonical wire-shape file;
no new shape should be invented outside it.

### 1.5 Surfaces

| Surface | Local-first implications (honest) |
|---|---|
| **Web** (`src/`, React, same-origin `fetch` + SSE to `/api/events`) | A browser **cannot run `node:sqlite`** and the app has no wasm/OPFS storage today. DESIGN §8 explicitly rejected IndexedDB as primary state. So today the web app is a thin client of whichever server serves it — local Vite preview → local server (local-first ✔), muster.today → hosted store (brief §1 ✘ until Phase 6/7). Two honest paths: (6) thin client of a paired device over the relay; (7) wasm-SQLite/OPFS spike, explicitly a spike with a go/no-go. DESIGN §32's Phase O2 (read-only cached transcript + queued composer) is the near-term offline step. |
| **Electron** (`electron/`) | Already the local-first host: spawns the local server, owns Keychain/safeStorage future, tray/updater/UA. Unchanged by this plan except as the future OS-keystore home. |
| **CLI** (`cli/muster.mjs`) | Loopback session, Node built-ins only, `~/.muster/cli.json` cookie; `muster mcp` runs the fleet server over stdio. Already local. Unchanged. |
| **Companion** (`companion/`, `ios/`, `android-companion/`) | Control surfaces over the user's server (LAN pair or cloud pair); state via app group. **Frozen:** `com.muster.companion`, `com.muster.companion.watchkitapp`, widget IDs, `group.com.muster.companion` (`ios/project.yml:63,207,287,349`, `android-companion/app.json:18`) — Loop188 explicitly kept "project.yml/entitlements/bundle IDs untouched". This plan never touches them. |
| **Fleet MCP** (`server/fleet-mcp.ts`) | 11 bounded tools over the CLI session; header comment is the contract (no approvals/deletes/credentials/engine changes/memory writes). Stays exactly as is. |
| **Drivers** (`server/drivers/`) | Local compute, BYOK, 20+ adapters incl. `local.ts` (Ollama/LM Studio/vLLM keyless via OpenAI-compatible) and `openai-compatible.ts` (any OpenAI-shaped endpoint — this is the LM Studio/MLX/OpenAI-compatible story). Stays. |
| **MCP client/proxies** (`server/mcp-client.ts`, `*-proxy.ts`) | Tool execution on device. Stays. |

### 1.6 Does NOT exist yet (honest ledger)

Typed sync events of the brief's shape · sync object producers for anything
besides `memory` · a `StorageProvider` interface · a real device registry with
hardware identity/key envelopes/reachability (S0 is a session-row *view*,
`keyEnvelopeStatus` honestly `"none"`) · hosted transient hydration/wipe-on-end
· wasm/OPFS browser storage · embeddings of any kind (M1 is BM25 keyword,
`server/memory-retrieval.ts:1–10`) · automatic memory extraction,
classification, deduplication or importance scoring · brain auto-capture from
settled turns (planned, not built) · retrieval mounted into system prompts
(`memory-retrieval.ts:29–31`: "Prompt assembly does not call any of this yet")
· OAuth token rotation/revocation UI · a verified Google subject/scope check ·
per-user sync metadata on Muster servers (by design it lives on Drive) ·
merge semantics for overlapping restores · real-provider sync acceptance.

---

## 2. Components that can remain unchanged

Do-not-touch list; each is either already brief-compliant or frozen by the
stability contract:

1. **The local harness core** — `server/store.ts`, `server/message-db.ts`,
   `server/workspace.ts`, `server/model-context.ts` (chained compaction
   summaries = brief §10 "conversation summaries"), SSE bus, approval/
   OptionCard spine, receipts, why-journal, routines/goals engines, budgets.
   They already run on-device with no Muster dependency.
2. **v2 bundle + restore machinery** — `workspace-bundle-v2.ts`,
   `restore-apply.ts`, `snapshot-runner.ts`, `snapshot-scheduler.ts`,
   `keychain-store.ts`. This *is* the brief's backup-integrity and
   corruption-recovery layer; extend, never rewrite.
3. **Sync engine core** — `sync-journal.ts`, `sync-objects.ts`,
   `sync-pass.ts`, `sync-wiring.ts`, `sync-memory.ts`, `sync-hooks.ts`.
   Their invariants (rev-guarded completion, dead-letter at 12, verify-before-
   apply, unopenable manifest halts, no conflict auto-resolution, no apply
   ping-pong) are exactly brief §6's requirements. Work = *more producers*,
   not a new engine.
4. **Auth policy wrapper** — `server/email-otp-login.ts` + `auth.ts` emailOTP
   config: the brief's §2 primary flow, already shipped with sign-up gates,
   per-mailbox cooldown and password-account preservation.
5. **Separation of sign-in and Drive connect** — already structural:
   `authCapabilities()` advertises Google sign-in independently of
   `driveAuthUrl()`'s appdata-only scope; Loop144's consent isolation keeps
   Drive credentials separate from login/Calendar tokens. Brief §2's "a user
   signing in with Google does NOT mean Muster requests Drive" is satisfied by
   design; only acceptance/verification work remains (Phase 2).
6. **Provider/driver layer** — `server/drivers/*`, `server/contracts.ts`
   `ModelSelection`, custom-providers SSRF guard, env-first key config,
   `decision-client.ts` (env-gated, never decides), `auto-approve.ts`
   (destructive/sensitive backstop, never on the AI's say-so — and explicitly
   "NOT a security boundary"). Brief §8/§10 satisfied; add providers only.
7. **Fleet MCP bounded surface, CLI, MCP client/proxies** — no reason to move.
8. **Companion identifiers and pairing grammar** — bundle IDs, entitlements,
   App Groups, `muster://pair` grammar: frozen.
9. **Stability-contract surfaces** — `/app` + `/os` shells, Flower mascot,
   responsive layout, theme, selected conversation, saved choices, drafts,
   sessions (`docs/guides/web-app-stability.md`). Every phase below is
   additive to these.
10. **Hosted denial behaviors** — 403 on installation backup/vault for hosted
    accounts, 501 on unverified account-Drive, HEAD→GET normalization, per-user
    ownership choke point. These are already correct under the brief; changing
    them is a regression.
11. **`server/muster-cloud.ts`** — opt-in identity-only bridge whose header
    already states the brief's data-locality rule. Keep as the thin
    coordination pattern for §3.
12. **Reference docs** — `web-app-stability.md`, `portable-backup-contract-…md`,
    `cloud-relay-strategy-…md`, `AGENT-ORIENTATION.md`: referenced, never
    edited by this plan.

---

## 3. Components that need refactoring

Ordered by risk (lowest first). Each maps to a phase in §13.

| # | Component | Defect vs. brief | Refactor | Phase |
|---|---|---|---|---|
| R1 | Drive-hardwired sync transport | §13 forbids hard-coding to Google Drive | Extract `StorageProvider` (read/write/delete/list/sync/getManifest/putEvent/getEvents/createSnapshot/restoreSnapshot) at the existing `SyncTransportDeps` injection seam; Drive becomes implementation #1 | P1 |
| R2 | Account-Drive 501 containment | §5 wants user-owned sync tied to the *user's* Google, verified | Verify returned Google subject + scope on connect; consume state once; only then enable login-scoped push/pull (keep installation transport + hosted 403s) | P2 |
| R3 | Sync object coverage = `memory` only | §6 requires chats, agents, tasks, SOUL, preferences to sync | Add producers at each write choke point (the `writeMemoryFile`/`sync-hooks.ts` pattern); no file moves | P3 |
| R4 | No conversation sync | §5 lists chats first | Per-thread transcript objects (reusing the v2 `VACUUM INTO` snapshot + branch heads) or periodic transcript snapshots; reconcile with bundle categories | P4 |
| R5 | No typed events / device_id on the wire | §6 event schema, §12 device identity | Map brief event types onto journal enqueues; emit a per-device `events/` receipt stream (audit-grade, local + synced); introduce stable `device_id` | P5 |
| R6 | Hosted store authoritative (DESIGN §8 web hosted) | §1/§3: cloud must not compute/remember user data | Transient hydration from paired device or Drive snapshot + continuous Drive push + wipe-on-end; browser becomes thin client of *user* resources | P6 |
| R7 | Web has no local storage | §1 "local model execution / local search" impossible in-browser today | Honest spike: wa-sqlite/OPFS vs. relay-thin-client; ship O2 read-only cache meanwhile; do **not** promise PWA as the local-first answer before the spike reports | P7 |
| R8 | Memory pipeline incomplete; retrieval unwired | §10 extraction→classification→dedup→importance→index→sync; only relevant memories in context | Add extraction/classification/importance stages behind approval (memory history/rollback is the recorded prerequisite); mount M1 retrieval into context assembly with the budget; local-embeddings eval (currently zero embeddings) | P8 |
| R9 | `server/index.ts` monolith | Not a brief requirement, but every phase above touches routes | Continue the proven ordered-route-table extraction pattern (`workspace-backup-routes.ts` precedent) family-by-family, only when a phase needs it — never as a big-bang refactor | with phases |
| R10 | Secrets at rest: `config.json` 0600 only; cloud `user-keys.json` under auth secret | §11 encryption at rest, secure OS credential storage | Move provider keys to OS keystore (Electron `safeStorage` — already the recorded roadmap, DESIGN §8) with env-first precedence preserved; keep `user-keys` vault for hosted only | P9-adjacent |
| R11 | Logical layout ≠ brief §4 tree | §4 names `identity/`, `memory/`, `chats/`… | Adopt as a **logical data-layer namespace first** (API over existing paths); physical re-layout last, optional, reversible | P9 (optional) |
| R12 | Device registry = session view | §3 device registrations, §12 multi-device | Stable device IDs + key envelopes (`keyEnvelopeStatus` producer), reachability for relay routing, device revocation that actually revokes | P5 |

---

## 4. Proposed directory/module architecture

### 4.1 Code layout — evolve, don't reorganize

The repo's flat `server/*.ts` style and the ordered-route-table extraction are
working; a folder reshuffle would burn the stability contract for no user
value. Proposed **additive** structure (each new module appears only when its
phase ships):

```text
server/
  index.ts                 # orchestrator + remaining routes (shrinks as families extract)
  contracts.ts             # canonical wire shapes (unchanged role)
  auth.ts · email-otp-login.ts · muster-cloud.ts     # §5 auth design (unchanged)
  storage/
    provider.ts            # StorageProvider interface (P1)
    local-provider.ts      # LocalStorageProvider — filesystem mirror (P1)
    google-drive-provider.ts# wraps drive-sync/drive-transport (P1, no behavior change)
    webdav-provider.ts · s3-provider.ts · onedrive-provider.ts · dropbox-provider.ts  # later, only on demand
  sync/                    # P3+: producers per object type (soul.ts, agents.ts, tasks.ts, prefs.ts, transcript.ts)
  sync-journal.ts … sync-wiring.ts    # existing engine, stays put until a real reason moves it
  data-layer.ts            # P2+: logical namespace (identity/ memory/ chats/ agents/ tasks/ …) as functions over existing paths
  workspace-bundle-v2.ts · restore-apply.ts · snapshot-*.ts · keychain-store.ts   # unchanged
  workspace-backup-routes.ts · devices.ts                                    # unchanged pattern
src/ … electron/ … cli/ … companion/ ios/ android-companion/                 # untouched except additive P6/P7 surfaces
```

Rule inherited from the route-table precedent: *extraction is mechanical and
happens at the exact current registration position, first-match-wins, one call
from `index.ts`* — so every phase's diff stays reviewable.

### 4.2 Data layout: logical namespace over the real tree (brief §4 adopted honestly)

Do **not** move `DATA_DIR` files in early phases — v2 bundle paths, restore
categories, sync object IDs, e2e fixtures and the 373 MB `workspaces/` tree all
pin the current layout. Instead the data layer presents the brief's tree as a
stable API, with a physical migration reserved for optional P9:

| Brief §4 path | Actual today (inspected) | Adopted how |
|---|---|---|
| `~/.muster/muster.db` | split: `messages.db` + `auth.db` (+ `sync_journal` in `auth.db`) | logical views first; consolidation only in P9 with copy-forward dual-read (§12) |
| `identity/` (soul.md, user.md, preferences.json) | per-bot SOUL in `workspaces/<id>/` + `bots.json` persona fields; user prefs scattered (`onboarding-gate.json`, localStorage per-device prefs DESIGN §30) | `data-layer.identity.*` API; new `preferences.json` written additively when P3 lands `preference.updated` |
| `memory/` (memory.jsonl, index/, summaries/) | `workspaces/<id>/MEMORY.md` + `memory/*.md` + `.memory-history/`; top-level `memory/` = user Brain; BM25 computed on read (no index dir) | keep files; `memory.jsonl` **not** introduced — the journal + history already carry the append semantics; index/ only if P8 embeddings win |
| `chats/` `agents/` `tasks/` `knowledge/` `attachments/` `events/` `cache/` | `messages.db`; `bots.json`/`groups.json`; `routines.json`/`goals.json`/receipts; brain facts; `attachments/`; `events/*.ndjson` (thread evidence); no dedicated cache | one sync object + data-layer accessor per bucket (P3–P5) |
| `~/.muster/data/` (nested second root) | observed duplicate | inventory + owner-confirm which root is live; **never delete**; fold findings into P1 diagnostics |

---

## 5. Authentication design

### 5.1 What ships today (verified)

- **Email → 6-digit OTP → session — SHIPPED (Loop188).** better-auth
  `emailOTP` plugin configured in `server/auth.ts` (TTL 600 s,
  `auth.ts:435`; rate windows `auth.ts:626–628`) behind the Muster policy
  wrapper `server/email-otp-login.ts`: intercepts
  `/api/auth/email-otp/send-verification-otp` and
  `/api/auth/sign-in/email-otp`; mirrors both sign-up gates
  (`OMB_GOOGLE_ONLY_SIGNUP`, `OMB_SIGNUPS_CLOSED` + allowlist) so a closed
  deployment cannot leak sign-ups through OTP; per-mailbox 60 s resend
  cooldown; and the load-bearing unverified-user promotion that validates the
  code **before** delegating so a pre-existing password account is never
  revoked. `authCapabilities().emailOtp === true` always — with no mailer the
  code is logged for local finishing. **This is the brief's §2 primary flow,
  already live.**
- **Continue with Google — EXISTS, env-gated.** `auth.ts:402–408` registers
  the better-auth Google provider only when `GOOGLE_CLIENT_ID` +
  `GOOGLE_CLIENT_SECRET` are set (owner's outstanding OAuth-credential unblock,
  09-18 decision 16). Desktop obtains it via the cloud's OAuth dance +
  loopback one-time code (`/desktop-auth/start`, `/api/desktop-auth/exchange`;
  Loop117 fixed the cookie landing in the wrong jar). `authCapabilities()`
  advertises `socialProviders`, `desktopOAuth`, `cloudPairing` honestly. The
  brief's "not yet built" is therefore **not accurate for the mechanism** —
  what is missing is credentials + acceptance, not code.
- **Drive connect — EXISTS and already separate.** `driveAuthUrl()` requests
  **only** `https://www.googleapis.com/auth/drive.appdata`
  (`server/drive-sync.ts:21`) through a paste-back device-lite flow at
  `/api/workspace/drive/url|connect`; account-Drive consent (Loop144) binds a
  one-use state, verifies identity/scope, and keeps Drive credentials separate
  from login/Calendar tokens. Signing in with Google never triggers this flow.
  **Gaps:** returned-subject/scope verification is still pending (routes 501),
  and real consent needs live Google credentials.
- **Sessions/devices.** better-auth session rows are the device material
  (S0 `server/devices.ts`, `GET /api/devices` in the backup route table);
  `muster sessions --revoke <prefix|other|all>` is the revocation control
  (revoke *UI* does not exist — S0 is view-only).

### 5.2 Target design (brief §2 + §3)

1. **Identity providers on the device:** local better-auth remains the session
   authority for desktop/self-host (works with zero internet — brief §4).
   Email OTP stays the default path; Google is an *additional* button,
   advertised only when configured; password sign-in preserved unchanged
   (additive login is a hard constraint).
2. **Muster Cloud's minimal record (§3):** `user_id`; auth identity
   (email/verified flags, provider links); subscription/license; device
   registrations (session-derived + future key envelopes); minimal
   sync-metadata pointers (which manifest generation a device last published —
   **not** the manifest itself, which lives on Drive); public/global config;
   encrypted OAuth/token material **only** where a server-side refresh is
   genuinely unavoidable (hosted Drive-on-behalf-of is explicitly *not*
   pursued; the device holds its own tokens). Conversations, memories, SOUL,
   agent states, task history, knowledge, attachments, embeddings and user
   documents: **never** in the cloud record.
3. **Auth vs. Drive authorization stay disjoint grants:** different scopes,
   different consent screens, different token stores (login tokens in the auth
   DB, Drive tokens in `config.driveSync` / `account` row), revocable
   independently. A Google sign-in must never widen into Drive scope — the
   code already guarantees this; Phase 2's subject/scope verification hardens
   it from "assumed" to "checked".
4. **Muster Cloud identity bridge** (`muster-cloud.ts`) becomes the canonical
   "coordinates, never stores data" implementation to point at when reviewing
   any new cloud endpoint under §14's rule.
5. **Device revocation (§11):** extend `muster sessions --revoke` semantics to
   paired companion tokens + future device keys in P5; logout clears local
   session only, never remote data (DESIGN §29).

---

## 6. Local database schema

### 6.1 What exists (grounded)

**`messages.db`** (owner-only, WAL, `synchronous=NORMAL`; `server/message-db.ts`):

```sql
messages(thread_id, id, at, role, kind, text, json, PRIMARY KEY(thread_id,id));
CREATE INDEX messages_thread ON messages(thread_id);
thread_state(thread_id PRIMARY KEY, active_leaf_id);
stop_cleanup_receipts(bot_id PRIMARY KEY, owner_id, …);
-- plus stop_cleanup_snapshots (journal schema from stop-cleanup.ts)
```

Legacy `messages-<threadId>.json` imports lazily on first read; the JSON file
is left behind as a one-time backup.

**`auth.db`** (better-auth tables + org plugin migrations, `server/auth.ts:119+`)
**plus the sync journal** (module-owned table created on this handle,
`server/index.ts:433`):

```text
sync_journal(objectId PK, rev, checksum, state, attempts, claimedAt, …)
  — queue-of-latest-rev: enqueue idempotent; higher rev supersedes in-flight;
    rev-guarded completion; backoff 5s→5min; stale reclaim 60s; dead-letter 12
```

**JSON stores at `DATA_DIR`** (versioned envelopes, atomic writes via
`server/atomic.ts`): `bots.json` (fleet, thread→instance bindings, resume
cursors), `groups.json`, `routines.json` (`{version:1, routines, runs}`),
`goals.json`, `decisions.json`/`social.json` (on write), `config.json` (0600,
env-first), `sync-state/<userId>.json` (last push/pull stamps — written only
after transport success), `snapshot-state/automation.json`.

**Files:** `workspaces/<botId>/{MEMORY.md, memory/*.md, .memory-history/}`,
top-level `memory/*.md` (Brain facts + topics), `attachments/` (10 MB cap),
`events/<threadId>.ndjson`.

### 6.2 Target schema (brief §6) — honest delta

Additive only; every "does not exist" is a build item, never implied shipped:

| Need | Status | Where/when |
|---|---|---|
| Primary local DB per brief (`muster.db`) | **Does not exist** — three logical stores already (transcripts, auth+journal, JSON files) | P9 optional consolidation, copy-forward dual-read, never destructive |
| `preferences.json` | does not exist as a file | P3 (writes additively; sync object `preferences`) |
| Sync event log with `device_id` (brief's `evt_uuid` JSON) | **does not exist**; journal rows are rev/checksum, no typed events, no device_id | P5 (map event types → journal enqueues; local `events/sync-*.ndjson` receipt stream) |
| Device registry | S0 view exists (UA grouping, **no** hardware identity, `keyEnvelopeStatus:"none"`) | P5 stable `device_id` + key envelopes + revocation |
| Knowledge/brain | exists as facts with provenance (`/api/brain*`, withdrawal-aware) | sync object in P3 |
| Cache bucket | not needed yet | create only if measured |
| Embeddings/index | **none** (BM25 on read) | P8 spike |

Schema-change law (DESIGN §34, repo law): versioned envelopes, **additive-only
migrations in prod**, guarded create + loud health, newer-than-app refused
semver-style, every migration reversible and never deleting user data.

---

## 7. Google Drive storage design (user-owned cloud storage)

**Layout — already implemented exactly as DESIGN §9 specifies (inspected):**

```text
appDataFolder/                         # scope: drive.appdata only (drive-sync.ts:21)
├── muster-workspace.enc               # v1 legacy bundle — keep for downgrade
├── muster-workspace-v2.enc            # v2 portable bundle (passphrase-only)
├── muster-manifest.json               # ENCRYPTED object index: versions, checksums, fileNames
└── muster-<object>-<rev>.enc          # per-object encrypted sync payloads (S2a)
```

Filenames as constants: `drive-sync.ts:13–17` (folder + both bundle names);
canonical object filename derivation `sync-objects.ts:88–89`.

- **`appDataFolder` is real and tested** (`drive-transport.test.ts` asserts
  `parents:["appDataFolder"]` and `spaces=appDataFolder`; scope constant
  `drive-sync.ts:21`). It is invisible in
  the Drive UI, app-scoped, counts against the user's quota, and is
  user-deletable — the portable-backup contract's caveats stand: *it is not an
  immutable backup service*.
- **Two token paths, both device-held:** installation-configured refresh token
  (`cfg.driveSync`, `drive-sync.ts:114–117` uploads with
  `parents:["appDataFolder"]`) and per-login account tokens
  (`account-drive.ts`). Login
  path gated 501 until subject/scope verification (P2). No Muster server proxies
  Drive traffic on desktop/self-host — topology rule satisfied today.
- **Who writes:** `sync-wiring.driveSyncTransport` (stat-before-download
  `modifiedTime` guard, base64 byte bridge, verify-before-write — Drive v3 has
  no If-Match, and that residual window is documented, not hidden) for the
  object/manifest stream; `drive-sync.ts` upload/download helpers for the v1/v2
  whole bundles; `snapshot-runner.ts` for nightly snapshots under the
  retention ladder.
- **Encryption:** every object and the manifest ride the v2 envelope
  (scrypt KDF, AES-256-GCM, authenticate-then-parse, associated-data header);
  recovery codes wrap the MEK (K1 format shipped). Raw secrets never enter any
  sync file — enforced by construction for bundles; `redact.ts` guards text
  paths.
- **What §5 additionally requires (phased):** P2 verifies Google
  subject/scope so the *user's own* login grant is trustworthy; P1's
  `StorageProvider` makes the layout provider-neutral (WebDAV/S3/OneDrive/
  Dropbox later without touching the engine); P4 extends the object set to
  conversations; P5 adds tombstone/recovery events; **never** bulk-upload the
  database (the object stream already prevents this — only changed revs move).
- **Telegram** stays an encrypted-document *backup transport* only
  (20 MB Bot-API cap, 24 h expiry, ownership-selection caveat from the
  portable-backup contract) — after Drive recovery is proven (19 Sep
  decision).

---

## 8. Synchronization protocol

### 8.1 What exists — the brief's §6 requirements, one by one

| Brief §6 requirement | Status | Evidence |
|---|---|---|
| Event-based, not full-DB upload | **Shipped** (for produced objects) | queue-of-latest-rev journal; only changed `<object>-<rev>.enc` moves (`sync-journal.ts` header, `sync-objects.ts:88–89`) |
| `manifest.json` | **Shipped** | encrypted `muster-manifest.json` with versions/checksums/fileName derivation (`sync-objects.ts`) |
| `events/` | **Does not exist as sync events** | `~/.muster/events/` is thread runtime evidence (unrelated). Typed sync events → **P5** |
| `snapshots/` + periodic compaction | **Shipped as bundles** | v2 bundle = full snapshot; nightly B1 snapshots + retention 7/7/4/6; per-object rev *is* the compaction unit. Snapshot-of-snapshots is unnecessary until P4 measures it |
| Offline operation | **Shipped** | local journal drains whenever online; engine holds rows when passphrase gate closed (`sync-wiring.ts`) |
| Retries | **Shipped** | exponential 5s→5min, dead-letter at 12, stale-claim reclaim, idempotent drain |
| Atomic writes | **Shipped** | `writeFileAtomic` (`server/atomic.ts`) for JSON; staging/commit swap + rollback for restore |
| Version numbers | **Shipped** | `rev` per object + `schemaVersion`/appVersion in envelopes |
| Checksums | **Shipped** | SHA-256 per payload; verify-before-apply recomputes |
| Conflict detection | **Shipped** | pure rev-reconcile: equal rev + different checksum = **conflict, nothing auto-resolves** (`sync-objects.ts:299–323`); local-fail-loud manifest store |
| Multi-device sync | **Partial** | engine + manifest are device-neutral; only one producer (`memory`) and no device identity yet → **P3–P5** |
| Recovery after interrupted sync | **Shipped** | rev-guarded callbacks, boot `syncEngine.flush()`, WAL checkpoint discipline, restore rollback receipts |
| Incremental upload/download | **Shipped** | per-object revs; pull ignores upload plan (journal owns push) |
| Brief's typed event JSON (`type:"memory.created"`, `device_id`, `object_id`) | **Does not exist** | **build P5**: event types map 1:1 onto journal enqueues (`chat.created`→object `chat-<id>` rev bump etc.); events are the *receipt/audit* stream, the journal remains the transport queue — one system, two views, no second queue |

### 8.2 Protocol target (P3–P5)

1. **Producer rule:** every durable write goes through a choke point that (a)
   bumps the local object's rev in the manifest, (b) enqueues the journal row,
   (c) emits the typed local event with stable `device_id`. The
   `writeMemoryFile → sync-hooks.ts → createMemoryProducer` chain is the
   template; new producers must reuse it so apply-side writes never
   ping-pong (the no-pushback rule in `sync-memory.ts` is universal).
2. **Pass (unchanged):** load remote manifest → claim journal → read local
   object (reader must agree with its own row) → pack → upload → local
   manifest commit → publish merged remote → reconcile → download → verify
   rev+checksum+tombstone against the naming entry → apply → commit. An
   unopenable remote manifest halts before anything is claimed.
3. **Ordering/compaction:** per-object supersede gives natural compaction;
   whole-bundle snapshots (nightly) are the restore base; events older than
   the snapshot generation they are subsumed by can be dropped at P5's
   compaction step (bounded, receipted).
4. **Identities:** `device_id` stable per install (P5; S0's
   `sha256(userId+ua)` stays a *view* key, never the sync identity),
   `ownerId` on every object, tombstones as ordinary newer revs with empty
   payloads.

---

## 9. Memory architecture

### 9.1 Brief §10 layers → what Muster actually has (DESIGN §15 + inspection)

| Brief layer | Muster today |
|---|---|
| `SOUL.md` | per-bot persona at `workspaces/<id>/` + `/api/bots/:id/soul.md` export/import (`server/soul-md.ts`) — sync object **P3** |
| `USER.md` | **does not exist as a file**; nearest = Brain user-level `memory/*.md` + account profile. Decide shape in P3 (additive; do not invent before owner sees it) |
| `preferences.json` | **does not exist**; per-device UI prefs live in validated localStorage (DESIGN §30 — per-device by design, never identity) → P3 writes the cross-device file |
| `memory.jsonl` | **not adopted** — see §4.2: `MEMORY.md` + topics + `.memory-history/` already provide append + rollback; journal carries deltas |
| `projects.json` / `relationships.json` | nearest = Brain facts with provenance + withdrawal (zero-LLM edges by design); no separate files |
| agent state | `bots.json` fields + resume cursors + transient boot sweep |
| conversation summaries | **shipped** — chained compaction records in `server/model-context.ts` (cached, chunk-merged, full history retained) |
| index/ | **none** — BM25 over facts+MEMORY.md computed per query (`memory-retrieval.ts`), deterministic, offline |

### 9.2 Memory Engine pipeline (brief §10) — honest stage ledger

| Stage | Status |
|---|---|
| Conversation → memory extraction | **does not exist** (brain auto-capture from settled turns is planned, unbuilt) → P8 |
| Classification / deduplication / importance evaluation | **do not exist** → P8, behind approval: *memory history/rollback is a recorded prerequisite for any automated memory change* (19 Sep reconciliation) |
| Local persistence | **shipped** (files + history + atomic writes) |
| Indexing | BM25 shipped (M1–M2, Loop188); embeddings **zero** → P8 spike |
| Drive synchronization | **shipped for memory** (the one live producer) |
| Only relevant memories enter active context | **partially** — budget + topic selection + SOUL mount exists; M1 retrieval is deliberately **not yet wired into prompt assembly** (`memory-retrieval.ts:29–31`) → P8 mounts it behind the budget |
| Grants | **shipped** — default-deny `memory-grants.ts` with revoke/expiry (Loop188), four session-gated routes |

Design invariants to keep: bounded context (MEMORY_BUDGET gauge), history
preserves every distinct past state with origin tags, human picks on conflict
(DESIGN §33 — never silent overwrite), redaction (`redact.ts`) before any
sync/echo, and raw secrets never in SOUL/exports/sync files (brief §11).

---

## 10. Provider abstraction

**Already the brief's §8 shape:**

- **Driver layer** (`server/drivers/`): `anthropic`, `openai`, `google`,
  `grok`, `mistral`, `cohere`, `deepseek`, `groq`, `fireworks`, `together`,
  `openrouter`, `claude`, `codex`, `acp`, `antigravity`, `grokagent`,
  `boxagent`, `opencode-zen`, **`local.ts` (Ollama / LM Studio / vLLM —
  keyless, dynamic `GET /v1/models`, ping-verified availability)**,
  **`openai-compatible.ts` (any OpenAI-shaped endpoint — the LM Studio /
  MLX / self-hosted catch-all)**, `custom-openai`, plus retry/effort/catalog
  policy modules. Contracts in `server/contracts.ts` (`ModelSelection`,
  `ProviderError`, effort levels) — routing is a *data value on the request*,
  never a service binding.
- **BYOK seams that exist:** per-install `config.json` `providers` map
  (env-first fallbacks, 0600); `/api/custom-providers` with SSRF-guarded base
  URLs (hosted refuses loopback/private/reserved — the law any future
  URL-fetching feature must follow); cloud-only `/api/user-keys` vault
  (AES-256-GCM, per-file scrypt salt, flags-only reads — brief §3's
  "encrypted keys when server-side storage is unavoidable");
  `/api/instances` availability/model menus; `free-best` routing for capped
  included allowance (19 Sep decision) with pause-then-guide-to-BYOK default.
- **Non-decision seams:** `decision-client.ts` (env-gated
  `MUSTER_DECISION_URL`/`MUSTER_DECISION_TOKEN`; may suggest, never decides;
  fails open to rules byte-identically) and `auto-approve.ts` (regex
  destructive/sensitive backstop; **never on the AI's say-so**, explicitly not
  a security boundary). Both keep their contracts under any refactor.

**Topology rule applied (brief §5/§8):** API calls go device → provider
directly on desktop/self-host (the local server *is* the device) and on the
hosted path once P6 routes execution to a paired device. **Browser → provider
direct is deliberately not proposed:** it would place raw BYOK keys in an
untrusted session for marginal gain; the browser is a thin client (P6/P7),
keys live where the agent runtime lives. What does **not** exist: pooled
inference (forbidden by decision 4/8 anyway), an Ollama-specific UI affordance
beyond the OpenAI-compatible/local drivers, and an MLX-specific driver (an MLX
server exposing an OpenAI-compatible endpoint is covered by `local.ts` today;
a native MLX integration is unbuilt and unclaimed).

---

## 11. Security / threat model (design — NO security claims)

> **Explicit non-claim.** This section is a *design* document. **The Mimosa
> scanner full re-run remains outstanding** (last full run failed with
> scanner_enobufs; owed per AGENTS.md, the Astra brief §6, DESIGN §36 and the
> 09-18 lock). Nothing here states or implies that Muster is secure, audited,
> encrypted end-to-end, loss-proof, or immune to reverse engineering. No
> release attests otherwise until the re-run lands.

**Controls that demonstrably exist** (for design context only): single
ownership choke point + `ownsRecord` filters on every record route; write-only
provider keys at the wire; `redact.ts` outbound redaction; token/USD caps;
signed receipts with public verification; rate buckets on every public path;
v2 bundle authenticate-then-parse with secrets excluded by construction;
staging outside the live tree; WAL checkpoint discipline; 0600 perms with
repair on open; default-deny memory grants; de-weaponized restores; SSRF law
for any server-side fetch; XML pre-parse DOCTYPE/ENTITY refusal.

**Threat model for the local-first design (ranked, design-level):**

1. **Stolen/lost device = full local state exposure.** Local-first concentrates
   chats, memory, tasks and (some) keys in one place. *Design response:*
   encryption at rest (§11 brief) — transcripts are currently **0600 but not
   encrypted**; plan OS-keystore-backed encryption for `messages.db`/`config.json`
   (R10/P9), full-disk assumptions documented honestly, device revocation (P5)
   so a lost paired device's sessions/tokens can be killed cloud-side.
2. **Passphrase/recovery-key custody.** The v2 key is passphrase (+ optional
   recovery-code MEK slots); Keychain stores it as a convenience gate only.
   *Design response:* env-first → Keychain → null (already implemented);
   user-held recovery key with the 19 Sep warning ("losing every device and the
   key makes encrypted data unrecoverable") shown only after verification;
   never the auth secret beside ciphertext.
3. **Drive account compromise.** Ciphertext + manifest are AEAD-bound; residual
   metadata leakage (filename, sizes, timing) accepted and stated; Drive is
   revocable independently of sign-in.
4. **Sync-integrity attacks / corrupted manifests.** Verify-before-apply,
   unopenable-manifest halts, conflict never auto-resolved, local manifest
   store fails loudly. Keep these invariants when adding producers.
5. **OAuth token handling.** Least-privilege scopes (`drive.appdata` only for
   storage; sign-in scope never implies Drive), one-use consent state
   (Loop144), subject/scope verification pending (P2), rotation + revocation
   are **design requirements, not existing features** (build P5).
6. **Relay/transport trust (P6).** Hosted hydration copy must be session-scoped,
   wiped on end, and must never be the restore source; relay transports intents,
   never executes or durably stores user data.
7. **Browser exposure (P6/P7).** No raw provider keys in browser storage ever
   (DESIGN §30's localStorage-secrets ban is law); thin-client only.
8. **Prompt injection via inbound content** (social/Telegram/MCP results) —
   existing untrusted-content firewall + human approval gate stays the answer;
   the bounded fleet MCP surface (no approval/delete/credential tools) is the
   differentiator and must not be widened by this plan.
9. **Approval laundering / eval gaming** — auto-approve remains rules-only and
   never trusts the model's self-report; any new autonomy feature must pass
   `auto-approve.ts`'s destructive/sensitive backstop *and* keep the human card.
10. **Backup exfiltration / tampering** — zero-knowledge v2, eleven verify
    checks, hash-chained staging, rollback-on-failure; integrity receipts
    (`last-restore.json`, sync stamps only after completed pipelines).

Raw secrets never appear in SOUL.md, conversation exports, or synchronization
files — enforced for bundles by construction, by `redact.ts` for text paths,
and re-checked as a test in every producer phase.

---

## 12. Migration strategy (all migration risks, explicit)

**Iron rules:** additive-only; reversible; **never delete user data**; never
migrate *through* a Muster server (device-local or Drive-direct only);
stability contract holds during every dual-write window; downgrade always
possible to the previous release (older builds read older formats; newer
bundles are refused semver-style, not half-applied).

| # | Risk | Why it's real (evidence) | Mitigation / downgrade path |
|---|---|---|---|
| M1 | **Two candidate data roots on this machine** — `~/.muster/` *and* `~/.muster/data/` each hold `auth.db` + `messages.db` + `bots.json` | inspected 2026-09-23 | Before ANY consolidation, a read-only inventory phase identifies the live root (open handles, mtimes, `OMB_DATA_DIR`); the other is preserved byte-for-byte with a receipt. Never delete, never merge silently. Owner confirmation gate. |
| M2 | **`sync_journal` lives in `auth.db`** (passed `getDb()` at boot) | `server/index.ts:433`, `auth.ts:238` | Moving it to a consolidated DB risks losing queued/dead-lettered rows. P9 = copy-forward dual-read (read old, write new, keep old until one full successful sync cycle), old table retained read-only for N releases. |
| M3 | **Dual-write period JSON ↔ tables** if `bots.json`/`groups.json`/`routines.json`/`goals.json` become tables | `store.ts:366–368`, `routines.ts:319`, `goals.ts:110` | JSON stays source of truth until the table layer has passed one full release; table writes are mirrors; rollback = ignore table. Never flip authority without a receipts-bearing loop. |
| M4 | **v2 bundle paths pin the current layout** (restore categories, LIMITS, fixtures, `workspace-bundle-restore-v2.test.ts` exact-path assertions) | `workspace-bundle-v2.ts:85+`, RESTORE_CATEGORIES | Physical re-layout (P9) only behind a format version with an explicit path map applied on restore; old bundles restore via legacy map; new bundles readable by nothing older than N (refused cleanly). |
| M5 | **Drive filenames are a cross-device contract** — `muster-workspace.enc`, `muster-workspace-v2.enc`, `muster-manifest.json`, `muster-<object>-<rev>.enc` | `drive-sync.ts:13–17`, `sync-objects.ts:88–89` | Never rename; new layouts = new names alongside (as v1/v2 already coexist). Deleting or rewriting a remote manifest in place is forbidden without a published-manifest receipt. |
| M6 | **Hosted transient hydration could destroy data if wipe logic is wrong** | hosted store is authoritative today (DESIGN §8) | Wipe scope = server-created session copies ONLY; a user's Drive/local copy is never a wipe target; hosted 403/501 denials preserved throughout; Phase 6 ships behind an explicit owner-confirmed gate (reconciliation item 2) with a read-only canary before any write path. |
| M7 | **Legacy root rename precedent** — `.opengrokbot` → `.muster` auto-rename exists | `config.ts:231–233` | Reuse exactly that guarded pattern for any root move; snapshot before rename (already wired via `capturePreMigrationSnapshot`). |
| M8 | **Downgrade across a schema version** | repo law DESIGN §34 (Printora lesson) | Every migration carries a version; old builds keep reading old JSON; a downgrade after P9 must be declared unsupported for the *consolidated* DB only, with JSON export retained as the escape hatch — no user data loss either way. |
| M9 | **Login migration must be additive** | `email-otp-login.ts` already protects password accounts from OTP-side revocation | New identity methods only add links; sessions/saved choices preserved (stability contract); no flow may invalidate an existing session cookie as a side effect. |
| M10 | **Companion identifiers frozen** | `ios/project.yml`, `android-companion/app.json`, Loop188 receipt | Any auth/device work touching companion payloads must leave bundle IDs, entitlements, App Groups byte-identical; protocol additions are additive fields the old clients ignore. |
| M11 | **Selective-restore category semantics change** when objects multiply (S3 eight categories) | Loop186 | New object types enter the category map additively; a category that names nothing still refuses (never a silent no-op — keep S3's refusal contract). |
| M12 | **Real-provider sync has never run** (all Drive tests are owned fixtures; no real Google calls in any suite) | portable-backup contract evidence boundary | The first real Drive round-trip is its own verification slice with GET-only expectations and receipts before any claim of sync/restore capability. |
| M13 | **Excluded parallel-session files** must not be swept into any migration commit | see Hard constraints | Review `git status --short` before staging; explicit paths only. |

---

## 13. Phased implementation plan

Every phase: independent, shippable, smallest-risk-first, gated by
**typecheck (`npx tsc --noEmit -p tsconfig.server.json` + `npx tsc -b`) → focused
tests → full suite vs. the latest accepted baseline → oxlint 0/0 → stability
contract** (layout/mascot/route shells/saved choices/sessions intact), with the
ledger updated only with real numbers. Current accepted baseline for comparison:
**363 files / 5407 passed / 8 skipped / 0 failed** (Loop189, accepted by
Loop190); e2e 40/40 and swift 457/0 from Loop188. Any decrease must be reported
explicitly. Phases P0's shipped items are receipts, not work.

### P0 — Already shipped (receipts, no work): S0–S3 sync engine · B1 snapshots+Keychain · K1 recovery-code format · S3 selective restore · email OTP
*Gate: none needed — cite Loop177–186/188 numbers when building on them.*

### P1 — StorageProvider seam + LocalStorageProvider (RECOMMENDED FIRST SLICE)
- Extract brief §13's interface at the existing `SyncTransportDeps` seam; wrap
  current Drive transport as `GoogleDriveStorageProvider` **with zero behavior
  change**; add `LocalStorageProvider` (filesystem mirror under
  `DATA_DIR/storage/`) so sync has an offline/no-Google target and every later
  provider has one contract to implement.
- *Why first:* pure refactor behind injected seams (no user-data path, no UI,
  no auth, no bundle format touched), unlocks §13, §7 restore targets, and the
  P4 transcript mirror; lowest risk in the whole plan.
- *Risks:* transport guard semantics (stat-before-download) must carry over
  verbatim; base64 bridge stays Drive-only detail inside its provider.
- *Gate:* interface + both providers under existing `drive-transport` /
  `sync-wiring` / `sync-pass` test patterns; full suite vs. 363/5407/8/0;
  rollback = revert commit (no data written by the interface itself).

### P2 — Account-Drive verification (clears the 501 honestly)
- Verify Google subject + scope on connect, single-use state consumption,
  correct token replacement (never keep an old refresh token while swapping an
  access token — the recorded defect), then enable login-scoped
  push/pull **alongside** (never replacing) the installation transport; hosted
  403/501 walls untouched except the now-verified path.
- *Blocked until:* owner's Google OAuth credentials land (09-18 decision 16).
- *Gate:* owned-fixture consent harness (Loop111/144 style) + **one real
  Drive round-trip receipt (M12)** before any capability claim; downgrade =
  env/capability flag re-closes the routes to 501.

### P3 — Sync object coverage: soul · preferences · agents · tasks · knowledge
- One producer per write choke point using the `sync-hooks` template
  (`preference.updated` also creates `preferences.json` additively);
  objectIds namespaced by owner; grants/permissions **never** become objects
  (re-consent stays local, matching v2's `reconsentRequired[]`).
- *Risks:* producer must fire after durability; apply-side must not push back
  (no ping-pong); byte-identical rewrites must not burn revs.
- *Gate:* per-producer focused suites (idempotence, offline→sync, conflict at
  equal rev/different checksum), restore-equivalence vs. current layout, full
  suite green; **no UI change** (stability contract safe by construction).

### P4 — Conversation sync
- Per-thread transcript objects (v2's `VACUUM INTO` snapshot + branch heads as
  payload) or bounded snapshot cadence; reconcile with the eight selective
  restore categories so conversations restore identically from bundle or
  object stream; attachments follow as separate objects (size caps first —
  Drive/Telegram 20 MB ceilings apply).
- *Risks:* largest data class — bandwidth, partial-thread visibility, M4/M11;
  must prove byte-identical round-trip on the existing A→destroy→B harness
  (`workspace-bundle-restore-v2.test.ts` pattern).
- *Gate:* round-trip identity on message ids/roles/text/branch heads/file
  hashes; incremental-bytes measurement (changed-thread sync must not move the
  whole DB); full suite.

### P5 — Event protocol + device identity + revocation
- Map brief event types onto journal enqueues; emit per-device typed
  `events/` receipts (local file + sync object) with stable `device_id`;
  key-envelope producer so `keyEnvelopeStatus` stops being `"none"`;
  OAuth token rotation/revocation + device revocation wired to
  `muster sessions --revoke` semantics; bounded event compaction against
  snapshot generations.
- *Gate:* multi-device harness (two installs, one owner): write → event →
  other device replays; interrupted-sync recovery test; revocation test kills a
  device's access; no event ever carries a secret (redaction test).

### P6 — Hosted transient hydration + wipe-on-end (the §1/§3 hosted move)
- muster.today hydrates a browser session from the owner's online paired
  device (relay) or latest Drive snapshot; mutations push to Drive
  continuously; wipe on sign-out/timeout; server holds **no durable user data
  at rest**; queued intents only when no device is online (09-18 decision 12).
- *Prerequisites:* P1–P4 (Drive as system of record), reconciliation item 2
  **owner confirmation** (storage gate vs. local-first boot), relay foundation
  (09-18 build order step 3).
- *Risks:* M6 (wipe scope), M12 (real-Drive reliance), SSE/session
  compatibility with the stability contract (route shells unchanged).
- *Gate:* read-only canary first (hydrate + read, no write) with GET-only
  production verification; then write path; explicit "server-side copy wiped"
  receipt test; hosted 403 walls proven intact.

### P7 — Web-surface honesty slice
- Spike report (doc + measured prototype): wasm-SQLite/OPFS vs. relay
  thin-client vs. PWA O2 cache — bundle size, offline read/write, session
  model, maintenance cost — with a go/no-go. Ship O2's read-only cached
  transcript meanwhile if it passes the gate.
- *Gate:* the spike's own numbers; **no promise of in-browser local-first
  before this reports.**

### P8 — Memory engine completion
- Extraction → classification → dedup → importance behind approval with
  history/rollback prerequisite honored; mount M1 retrieval into context
  assembly under MEMORY_BUDGET (the currently-unwired seam); embeddings spike
  (local model eval, honest size/latency numbers) — adopt only if it beats
  BM25 on owned fixtures; `USER.md` shape proposal for owner review (additive).
- *Gate:* retrieval parity/quality on owned fixtures, no-secret-in-memory test,
  default-deny grants intact, full suite.

### P9 — Optional: physical data-layer consolidation
- Only if P1–P8 prove the logical namespace insufficient: `muster.db`
  consolidation per §6.2 with M1/M2/M3 dual-read procedure, OS-keystore
  encryption for transcripts/config (R10), brief §4 tree as a reversible
  physical layout behind format version + path map.
- *Gate:* A→B disaster-recovery acceptance with only the recovery kit;
  downgrade rehearsal documented; every migration reversible and
  non-destructive; **explicit owner sign-off required** (this is the
  highest-blast-radius phase and the last one scheduled).

**Ordering rationale:** each phase's risk rises; P1 touches no data, P2 needs
an owner gate, P3 adds producers to proven seams, P4 moves the heavy data,
P5 adds identity, P6 moves the hosted contract (owner-confirmed), P7 is a
spike, P8 changes memory behavior (approval-sensitive), P9 moves files (last,
optional).

---

## 5-step eval (Astra style — run before claiming this plan works)

Modeled on `docs/plans/astra-gpt6-mvp-brief.md` §4: same probes, JSON results,
trendable; record evidence per step, then score.

1. **Offline/local-first probe (§1/§4).** On an owned desktop rig (explicit
   free port, throwaway `OMB_DATA_DIR`), boot with Muster Cloud unreachable
   (cloud URL unset) and the network down: start a chat turn against a local
   engine (Ollama/`local.ts` or the fake-ACP harness), write memory, create an
   approval card, answer it, restart. Expect: everything settles; receipts and
   why-journal entries appear; the sync queue holds rows without erroring;
   nothing routes to a Muster server. Evidence: rig log + journal rows.
2. **New-device restore without Muster's database (§7).** Fresh throwaway
   `HOME` → email OTP sign-in → connect Google (owned consent stub or real,
   P2+) → discover state → download latest snapshot → replay newer events →
   verify SOUL, memories, agents, tasks and conversations match the source
   install (ids/roles/text/branch heads/hashes per the v2 contract). Expect:
   de-weaponized automations off until re-enabled. Evidence: A→B harness
   receipt, byte-comparison output.
3. **Multi-device sync + conflict (§6/§12).** Two owned installs, one owner:
   write on A (memory + one P3 object) → journal → sync → B applies and does
   **not** push back; then edit the same object offline on both → equal rev +
   different checksum must surface a conflict with nothing auto-resolved;
   kill sync mid-upload → restart → no corruption, counted retry/dead-letter
   behavior. Evidence: manifest diffs, conflict report, journal states.
4. **Server-Cost Rule audit (§14).** Sample 10 routes touched this plan
   (5 chat/memory, 2 sync, 3 relay/ops), run the five questions on each, and
   confirm verdicts match §1.4's table; GET-only probe of the hosted surface
   (never POST in audit sessions) verifies no durable user copy exists outside
   a live session after P6. Evidence: classification table + GET receipts.
5. **Score.** Record per step: completion (pass/fail), correctness (exact
   match vs. conflict-handling expectations), evidence completeness (receipts
   with file:line and real test numbers — full suite against the 363/5407/8/0
   baseline), and cost per sync (bytes moved for a 1-message edit vs. full DB;
   expect orders-of-magnitude smaller). Publish trendable JSON for reruns.

---

## Hard constraints (non-negotiable for every phase of this plan)

1. **One-file study-only session:** this deliverable wrote exactly
   `docs/plans/local-first-architecture-plan-2026-09-23.md`. No git commands,
   no code changes, no tests run, no server started, **port 8845 and every
   existing user session/service untouched**; `~/.muster/` inspected read-only
   (no credential/key file opened, nothing modified).
2. **Excluded parallel-session files — never staged, never edited, preserved
   byte-identical:** `www/*`, `.commandcode/`, `.freebuff/`, `.zcode/`,
   `docs/research/glm/*`, `marketing-video/`, `www/fonts/`,
   `www/templates.html`.
3. **Credentials env/secrets only, never literals** in any file, fixture,
   test or doc; test-shaped tokens stay split-string so scanners never flag
   them.
4. **No security claims anywhere.** Section 11 is a threat-model *design*;
   the **Mimosa scanner re-run is outstanding** and nothing may assert
   security posture before it lands.
5. **Never surface `npx muster`** (squatter package) and **no github.com
   links in user-facing UI**; repo stays private, BSL 1.1, no npm publishing.
6. **Additive login only** — existing password accounts, sessions, saved
   choices, drafts, selected conversation, cookies/localStorage and the
   stability contract's layout/mascot/route shells (`/app`, `/os`) are
   preserved through every phase; audits fix reproduced defects, never
   redesign the app.
7. **iOS/Watch/Android bundle IDs, entitlements and App Groups are FROZEN**
   (`com.muster.companion*`, `group.com.muster.companion`).
8. **Migrations are reversible and never delete user data** — additive-only,
   versioned, guarded, with documented downgrade paths (§12 M1–M13).
9. **Honest reporting:** phases claim only what their gate proves; "does not
   exist — build in phase N" for every unbuilt assumption; a push is not a
   deployment; production checks are GET-only; baseline decreases are reported
   explicitly; documentation-only work reruns zero tests and says so.
10. **Reference-only docs:** `cloud-relay-strategy-2026-09-18.md`,
    `AGENT-ORIENTATION.md`, `web-app-stability.md`,
    `portable-backup-contract-2026-09-12.md`, `astra-gpt6-mvp-brief.md`,
    `current-state.md` and `DESIGN.md` were read, never modified.
