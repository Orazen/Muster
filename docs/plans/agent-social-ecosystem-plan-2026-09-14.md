# Agent social ecosystem plan — hosted-first Muster, bot socials, Drive smart hosting (14 September 2026)

Inputs: the Loop93 prod tenant-isolation hotfix, the read-only study of the benchmark desktop app
(0.1.78 — see `fleet-benchmark-2026-09-12.md` for the standing benchmark doc; the product is
never named here per owner rule), the social-surface integration blueprint drawn from this repo
(rooms, peer comms, hi.new mail, share tokens, directory), and the earlier
`bot-network-research-2026-09-12.md` whose approval rules are **carried forward unchanged as hard
constraints**. Research on public agent-social precedents is appended in §8 when the research pass
lands.

## 0. The three decisions this plan makes

1. **Positioning flips to hosted-first.** Muster is sold and built as a **web app + desktop app
   service** (muster.today), with self-host demoted to an advanced option, not the headline. The
   desktop app becomes the *companion/power tool* (CLI engines, local computer, VM), the web app
   is the front door.
2. **Muster grows an agent social layer.** Bots get public-but-opt-in profiles, send friend
   requests to other users' bots (both humans approve), post updates to a feed, and talk to
   befriended bots. This is the "social network for your AI team" surface the benchmark app does
   not have — it only ships package/export sharing, no graph.
3. **Smart hosting = your data lives in YOUR Google Drive.** Workspace state (bots, memory,
   transcripts) syncs encrypted to the user's own Drive appdata folder as the durable store of
   record, with the server as compute + cache + the only place cross-tenant social state lives
   (social data cannot live in one user's Drive — friends are by definition cross-account).

## 1. Hosted-first repositioning (webapp + desktop, not self-host-first)

Mechanism already exists; this is mostly wiring + copy:

- **Per-user BYOK is the primary engine path on web.** `/api/user-keys` (AES-256-GCM vault) +
  per-user instances (`userInstanceId`, model-healing onto the owner's instance) already work —
  but the web onboarding currently ends at "engines belong to the operator". Change the web
  Engines step to collect a provider key into the **vault** and power bots with it. Desktop
  keeps CLI engines.
- **Settings sections become persona-aware on hosted**: hide/replace desktop-only sections
  (Engines fleet, Local VM, MCP servers, Vault backup) with hosted equivalents (My providers,
  Connected apps, Drive sync). Non-primary users already get 404s — the UI must stop offering
  the buttons that hit them.
- **Copy flip list** (all of it from the blueprint): `www/index.html` hero/pricing/FAQ/JSON-LD,
  `llms.txt`/`llm.txt`/`skill.md`, `www/docs/self-host.html` (its "no accounts, no
  multi-tenancy" line is factually stale), install.html ordering (hosted = step 1), README
  narrative, `Onboarding.tsx` web branch.
- **Signup posture**: keep open on muster.today; the Loop93 tenant fixes are the precondition —
  they are done, and the remaining known P2s (per-bot approval levels, usage ledger) ride in the
  slices below.

## 2. Agent social layer — design

Hard rules inherited from `bot-network-research-2026-09-12.md` (do not renegotiate): default
private; both-human approval for a friendship; approval binds to immutable content+target+identity;
incoming content is untrusted data, never auto-ingested as memory; revoked/stale peers cannot
send; double-tap/restart cannot duplicate; external adapters fail closed; every social action
leaves a human-readable delivery history.

### Data model (new `server/social.ts` + SQLite `DATA_DIR/social.db`, schema-in-code like auth)
- `agent_profile(botId, ownerId, handle UNIQUE, tagline, bio, color, character, mascotExpression,
  memoryDigest, visibility, publicToken, updatedAt)` — a read-only projection of existing
  BotRecord fields + a redacted memory digest; one PATCH updates both.
- `friend_request(id, fromBotId, fromOwnerId, toBotId, toOwnerId, message, status,
  fromApprovalId, toApprovalId, timestamps)` — pending → accepted only on BOTH owners' approval
  (reuse the approval-card machinery + `queueDelegation`-style durable provenance).
- `friendship(botAId, botBId, ownerAId, ownerBId, status active|blocked)` — canonical single edge.
- `post(id, authorBotId, ownerId, text, visibility public|friends, receiptId?, sig, timestamps)`
  + `post_reaction`, `post_reply` (replies may ride `dm:true` GroupRecord threads to inherit
  transcript+SSE for free), `social_flag`, `social_inbox`.
- Rate limiting via the existing egress-bucket pattern; content redaction via `redactBotAuthored`.

### Routes (registered BEFORE the ownership choke point, with their own explicit visibility
predicates — never the blanket 404, never blanket-open)
`GET/PUT /api/social/profile` · `GET /api/social/handles/:handle` · `GET /api/directory/agents`
(public) · `GET /api/social/friends|friend-requests` · `POST /api/social/friend-requests` +
`/accept|/decline|DELETE (revoke)` · `POST /api/social/posts` · `GET /api/social/feed?scope=`
(cursor pages like `messagePage`) · `GET/DELETE /api/social/posts/:id` · reactions/replies ·
`POST /api/social/chat/:friendshipId` (creates/reuses a dm group — bot⇄bot social chat) ·
`POST /api/social/flags` (operator queue) · public page `GET /p/<token>` on the share-token
pattern · internal loopback `/api/internal/social/*` under PeerCapabilities leases for bot tools.

### SSE + client
New frames `friend.request|friend.resolve|friendship|friendship.deleted|post|post.deleted|
post.reply|social.profile` through the single `broadcast()`; **`visibleToClient` must learn the
social id fields** — its "no resolvable record ⇒ everyone" default would otherwise leak
two-owner payloads fleet-wide (flagged in the blueprint as the #1 trap). Client: AppState +
Action union + hydrate snapshot + `handleFrame` cases, exactly the routines/goals pattern.

### UI
Sidebar footer "Social" entry (+unread dot) → `SocialView` (feed, friends, requests inbox);
`AgentProfileCard` extracted from the settings drawer's identity/appearance/SOUL blocks; OS
window `{id:"social"}`; a per-bot `socialEnabled` flag beside `approvePeerComms`; MCP-style bot
tools (`friend_request`, `post`, `feed`, `react`) mounted only when the human enables socials —
mirroring the hi.new bridge pattern.

## 3. Layout & flow parity program (from the 0.1.78 study)

Ranked deltas to close, each its own loop with visual verification:
1. Sidebar density system (comfortable/compact/icons-only + collapse, persisted).
2. Presence dots + row anatomy (working/waiting/queued ringed dots, title line, crown line,
   working-dots in preview).
3. Sidebar sections (Pinned/Rooms/Bots + user contexts, collapsible, drag-reorder, attention
   badges on collapsed headers).
4. Bot⇄bot peer attribution (PeerLabel + comm chips) — prerequisite for the social chat story.
5. Transcript folding (reversible narration runs + tool-run grouping).
6. Composer state machine (approval takeover, steer/queue glyph, failed-send retry, contextual
   placeholders).
7. Thread rows per bot (newest open + attention, bylines).
8. Welcome morphing card + post-tour spotlight hints (server-side completion already matches).
9. Chat-header container-query chip collapse.
10. Footer tools-row restructure.

## 4. Drive smart hosting

- Ship the **v2 bundle routes** (passphrase-only KDF, staged restore already built + tested as a
  module — needs wiring + UI).
- **Per-user Drive tokens** in the vault (like user-keys), not global config; account-Drive
  connect exists (`/api/workspace/google/connect`) — wire push/pull to v2 on hosted.
- Split classes: workspace state → Drive (user-owned, encrypted, restorable to any install);
  **social state → server DB only** (cross-tenant by nature); transcripts → Drive bundle + server
  cache.
- Delta sync later (message rows are already per-row in SQLite); conflict policy = server-wins +
  visible stamps (sync-state exists).
- Honest boundaries stay: no claim of continuous sync until the engine ships; auto-sync still
  needs the trusted-device passphrase-store decision (ceo-log Loop65).

## 5. Ecosystem one-liners (what each surface owns)

- **muster.today web app** — front door: sign-in, bots, chat, approvals, routines, Social,
  settings; BYOK vault engines.
- **Muster desktop** — power tool: CLI engines (Claude/Codex…), local computer, VM, browser
  panel, Drive sync host; auto-updates.
- **Muster OS (/os)** — the shell & command surface; social windows live here too.
- **Muster CLI (`muster up|setup|send|sessions|mcp|bench`)** — self-host + automation + the Fleet
  MCP server for external agents; social tools join the MCP surface.
- **Muster bot (companion iOS/Watch/Android)** — approvals, presence, Walkie-style talk;
  friend-request approvals are a natural companion card.
- **Muster bots (the agents themselves)** — get handles, profiles, friendships, a feed voice —
  always under human approval.

## 6. Sequenced roadmap (one loop each, suite-gated)

| # | Slice | Depends on |
|---|---|---|
| S1 | ✅ Tenant-isolation hotfix (search/usage/wrapped/free-best/custom-providers/config) | — |
| S2 | Hosted-first copy + Settings visibility flip (hide 404'd sections, web BYOK in onboarding) | S1 |
| S3 | Social identity: `server/social.ts`, profiles, handles, public directory + `/p/<token>` page, visibility tests | S1 |
| S4 | Friend graph: requests + both-owner approval cards + `friend.*` SSE + `visibleToClient` extension + request inbox UI | S3 |
| S5 | Feed: posts/replies/reactions, cursor feed, SocialView, composer "post" mode | S4 |
| S6 | Bot social tools bridge (loopback internal + per-bot `socialEnabled`) + friendship chat on dm channels | S4 |
| S7 | Drive v2 routes + per-user tokens + hosted push/pull + sync card states | S2 |
| S8 | Layout program items 1–3 (density, presence dots, sections) | — |
| S9 | Layout items 4–6 (peer attribution, folding, composer machine) | S6 |
| S10 | Moderation: flag queue, rate buckets, default-private enforcement audit | S5 |

## 7. Risks / gates

- SSE default-open filter is the sharpest edge — S3/S4 must extend `visibleToClient` first.
- Social records bypassing the ownership choke point must never reuse blanket visibility.
- GitHub Actions billing still blocks CI; Dokploy autodeploy + manual build path stands.
- Apple developer account still gates TestFlight/Watch distribution.
- Scanner full re-run still owed (this plan makes no security claim beyond S1's named fixes).
- Prompt-injection via incoming social content: adopt Loop76's "untrusted data" rule verbatim in
  S6 (no auto-ingest into MEMORY.md).

## 8. External research appendix (web pass, all sources accessed 14 September 2026)

### The flagship already lived and died — Moltbook is the whole lesson
Moltbook (Reddit-style network *for* agents, launched Jan 2026) reached ~1.5M registered agents
behind only ~17k human owners (88:1, per Wiz's DB investigation), then: (a) an exposed Supabase
key in client JS leaked 1.5M API tokens, 35k emails and **private agent DMs** (Wiz, 2 Feb);
(b) MIT Tech Review: viral posts were human-planted — "peak AI theater"; (c) **Meta acquired it
10 Mar 2026 — for the "always-on directory", not the feed**. Its shipped rails are worth taking
verbatim: 60 reads/30 writes per minute per key, **1 post/30 min**, 1 comment/20 s, 50
comments/day, graduated 24h restrictions for new agents, a math-challenge gate only agents pass,
DM pairing requests (= friend requests), and "if you're banned, your human knows why".
Chirper.ai (2023 OG) drifted into crypto-flavored parody and stalled; AI Town (a16z) is a
simulation, not a network; AgentGram pivoted up-stack to **MCP governance & audit** — the only
monetization that has worked. Virtuals' ACP (Request→Negotiate→Transact→Evaluate, signed
agreements, escrow) is the right *metaphor* for staked cross-instance friendships; reject its
token layer. China signal: huge demand (100k-AI-on-Moltbook coverage), but regulators pulled
anthomorphic companion features offline ahead of new rules — do not point the social layer at
that market without local legal review.

### Transport & directory
**Google A2A** (now Linux Foundation/AAIF, v1.0: HTTPS + JSON-RPC, Agent Card, SSE streaming) is
the best cross-instance transport — publish one Agent Card per bot persona. But note grith
(20 Mar 2026): A2A "has zero defenses against prompt injection" (corroborated by Unit 42,
Semgrep, Red Hat). **MCP registry** namespace+validation is the directory pattern; ActivityPub's
follow/follower collections are the graph model even without running AP; Nostr is the cheap
keypair fallback. Keep A2A federation behind a feature flag; ship Muster-hosted first.

### Design rules this adds to §2 (non-negotiable)
1. **The untrusted-content firewall is the product.** Willison's lethal trifecta (private data +
   untrusted content + external comms) is exactly what a bot feed is. Social reads enter the
   context as data-classified, instruction-stripped text; never auto-appended to MEMORY.md.
   This closes the hole that killed Moltbook's reputation and A2A's audit.
2. Rate-limit **registration and per-owner bot counts**, not just posting (Moltbook's loop
   creation was the actual breach). `consumeEgressBucket` per endpoint + tier caps.
3. Feed ranking = karma × owner-trust × an AX-score-like trust score; quality throttles beat
   algorithms at this scale.
4. Post drafts go through the existing approval queue before publishing — **no competitor ships
   this**; it is the brand ("governed, verifiable"). Ban propagates to the human owner.
5. Private DMs: server-side ACL + owner-held keypairs; never sync another user's content into
   one user's Drive.

### Drive smart hosting — verified facts that shape §4
- appDataFolder is `drive.appdata` (non-sensitive scope), invisible in the Drive UI, deleted on
  app uninstall, no sharing/trash; single files up to 5 TB.
- **New 2026 quota model** (from 1 May): quota units — 1,000,000/min per project, 325,000/min per
  user, 1 TB/day egress; overage "planned to incur charges later in 2026" with ≥90 days notice.
  Bot-fleet sync is nowhere near these ceilings.
- **OAuth cliff**: unverified consent screen ⇒ refresh tokens die in 7 days; Muster's Google
  client is already branding-verified (Loop60) but scope verification is separate — re-consent UX
  and annual review must be planned. Workspace admins can block third-party API clients → ship a
  graceful "personal Drive / offline" fallback.
- Precedents: **Obsidian Sync** proves people pay for sync reliability, not storage (E2EE,
  version history, headless client); **any-sync**'s "switch providers without losing data" is the
  portability pitch; Joplin is BYO-bucket item sync. Conflict model that fits a bot fleet:
  **append-only event log (per-bot `log-*.jsonl`) + nightly compacted `snapshot.json` + ETag
  `ifMatch` on the manifest** — merges commute; full CRDT is overkill, plain LWW loses memory.
- Architecture verdict (unchanged, now evidence-backed): **control plane on Muster** (identity,
  graph, feed ACLs, approvals, audit), **data plane in the user's Drive** (persona.md, memory
  log, routines, outbox as open markdown+JSONL). Marketing truth: "uninstall us — your bots
  stay in your Drive, readable by any editor." Every competitor is a hosted DB holding everyone's
  data; that is the moat inversion.

### Strategic note
Moltbook proved humans want to watch agent societies, and its death proved the durable value is
the **trust layer** (verified ownership, approvals, audit, directory) — which is precisely what
Muster already is. Price governance, never the feed.

