# Performance & heavy-user study — server + webapp

**Date:** 2026-09-23 · **Scope:** owner instruction "make Muster lightweight, smart and
faster; handle heavy users on server + webapp; research all."
**Method:** evidence-first, read-only. Every finding below carries `file:line`
evidence from the working tree, numbers measured this session, or a GET-only probe of
production. No code was modified, nothing committed, port 8845 never touched, no
builds run, no `dist/` writes. Measurements are listed in §1; things I deliberately
did **not** measure (and why) are in §7.

**Baseline for verification gates** (from the handoff ledger, Loop128/129 — not re-run
this session): unit **296 files / 4,341 passed / 8 skipped / 0 failed**, browser
29/29, e2e 26/26, both typechecks 0, oxlint 0/0 (827 files).

---

## 1. Measured baseline (this session — future slices prove against these)

### 1a. Web bundle reality (`dist/`, fresh build 2026-09-23 01:34, buildId
`ea6096f2…`, version 1.15.0, `source.dirty: true`)

| Initial-load file | raw bytes | gzip bytes |
|---|---:|---:|
| `dist/index.html` | 702 | 386 |
| `dist/assets/main-B3qqCDsL.js` | **1,520,854** | **477,599** |
| `dist/assets/flower-DuGHrICv.js` (modulepreload) | 67,180 | 28,425 |
| `dist/assets/main-C4kERoy_.css` | 170,777 | 30,125 |
| **total first paint (JS+CSS+HTML)** | **1,759,513 (1.68 MiB)** | **536,535 (≈524 KiB)** |

- The server sends these **uncompressed** (static handler sets only `content-type`
  + `x-content-type-options`; see §2.3), so real first-load transfer today ≈ **1.68 MiB**,
  not the 524 KiB gzip figure.
- **dist weight:** 331 JS chunks, `dist/assets` = 13 MB (JS 12,142,860 B + CSS
  176,281 B); 20 chunks >100 KB total **6,346,669 B**. These are lazy shiki grammar
  chunks (dep-map lives in `index-CmbpT5pD.js`, 198,080 B raw / 62,257 gzip) — loaded
  per language on first code block (`src/components/ChatMarkdown.tsx:46`), never
  eagerly. Largest grammars: `emacs-lisp` 790,007 (199,376 gz), `cpp` 785,490
  (53,244 gz), `wasm` 622,336 (231,176 gz), `wolfram` 262,391. Plus
  `dotlottie-player.wasm` 1,222,210 B at dist root.
- **Lazy route/panel chunks exist** (`src/App.tsx:13–24` + Loop118 route-level lazy):
  SettingsModal 153,237 (largest lazy), RoutinesPage 67,181, Onboarding 45,638,
  SettingsPanel 39,483, PluginsPanel 27,271, ComputerPanel 16,729, SocialView 17,878,
  BrowserPanel 9,803, InspectorPanel 8,484, ApiKeys 7,459, StorageGate 2,927, … The
  boot surface (Sidebar/ChatView/GroupView/auth//app shell) is eager by design.
- **www (marketing):** `index.html` 125,934 B (inline `<style>` blocks 40,356 B; rest
  is content), `hero.png` 490,298 B, self-hosted `www/fonts/` 9 weights ≈ 216 KB total
  (~24 KB each; browser fetches only used weights), `teams.html` still loads a
  render-blocking Google Fonts stylesheet. www total 1.1 MB.

### 1b. Production probe (GET only, no credentials, 2026-09-23 00:43–00:44 UTC)

- `GET /` → 200, `cache-control: no-cache` on HTML; **no `content-encoding`** even
  though the request offered `Accept-Encoding: gzip`.
- `GET /app` → 200 HTML referencing `/assets/index-Lx0UAW6c.js` +
  `/assets/index-Dnt9cp6S.css` — i.e. production still serves the **pre-Loop118 eager
  bundle** (matches the historical "1,882 KB" figure; the local split build is
  `main-*.js`).
- `GET /assets/index-Lx0UAW6c.js` **with `Accept-Encoding: gzip, br`** → 200 with
  **no `cache-control`, no `etag`, no `last-modified`, no `content-encoding`**, body
  **1,887,015 B (≈1.80 MiB) transferred uncompressed**. Every cold visit to
  muster.today re-downloads the whole bundle; the edge does not compress it.
  (Also confirms again: a push is not a deployment.)

### 1c. Micro-benchmarks (pure/in-memory or read-only I/O, this machine)

| Measurement | Result |
|---|---|
| `readFileSync(dist/assets/main-B3qqCDsL.js)`, 50 reads | **0.48 ms/read**, 3,031 MB/s (page-cached) |
| `www/index.html` read+string-transform per request | 0.36 ms over 125,434 B |
| synthetic `bots.json` (80 bots, ~552 KB): `JSON.stringify(x, null, 2)` vs compact | **1.38 ms vs 0.84 ms** (pretty = 1.6× CPU, +17% bytes) |
| synthetic `GET /api/bots` body, 5.73 MB JSON → `gzipSync` | **19.1 ms** (one event-loop stall per request; synthetic text over-compresses) |
| real `main-B3qqCDsL.js` → `gzipSync` level 6 | **40.0 ms** → 478,753 B |
| `gunzipSync` of the above | 5.0 ms |

### 1d. Real data dir (`~/.muster`, read-only `du`/`ls`)

Total 470 MB — `workspaces/` 373 MB, `bin/` 90 MB (agent artifacts, not the API
path). JSON state is tiny today: `bots.json` 3,099 B, `groups.json` 2 B,
`config.json` 2,754 B. `messages.db` 102,400 B but **`messages.db-wal` 4,128,272 B**
(40× the main DB — snapshot observation; checkpoint cadence worth verifying under
sustained writes, see §5-B9). `auth.db-wal` 358,472 B. This install is *light* on
bots — the heavy-user numbers below are derived from code + synthetic payloads, not
from this machine's fleet.

### 1e. What already ships (do NOT rebuild — these are shipped optimizations)

`gzip` on API JSON ≥1 KiB (`server/http-helpers.ts:11–41`); `?messages=n` pagination
params with `MESSAGE_PAGE_MAX=200` / `DEFAULT_PAGE=50` (`server/index.ts:873–905`);
transcript windowing `TRANSCRIPT_WINDOW_SIZE=120` (`src/lib/transcript-window.ts:5`,
wired `src/components/ChatView.tsx:1011–1041`) + memoized `MessagesList`
(`ChatView.tsx:825`) + `WorkingTimer` mutates textContent instead of committing
(`ChatView.tsx:804–817`); token deltas rAF-batched in their own `StreamContext`
outside the reducer (`src/state/store.tsx:1163–1199, 1804–1827`); identical-bytes
save dedup + atomic fsync/rename (`server/store.ts:570–590`, `server/atomic.ts`);
screen-frame prune keeps 4 PNGs per thread (`server/store.ts:813`); SSE resume
cursor + 4 MB slow-client cap + screens opt-in (`server/index.ts:944, 992–1021, 6370–6412`);
sync journal debounce 250 ms / drain 32 / backoff→5 min / dead-letter 12
(`server/sync-journal.ts:18–23`); hard caps: webhook attempts & deliveries 2,000
(`server/webhooks.ts:138–139`), routine runs 2,000 (`server/routines.ts:173`), goals
200 (`server/goals.ts:54`), search limit ≤100 (`server/index.ts:6514`), social posts
cursor-paginated (`server/index.ts:6719`); client reconcile polling is gated on
`!connected` (`src/state/store.tsx:1653–1665`); tray pauses polling when hidden
(`src/tray-main.ts:117–126`); route/panel code-splitting (§1a).

---

## 2. Server findings

### S1 — `GET /api/bots` default = every transcript, including screen PNGs ·
**THE hydrate/tray payload**

- **Evidence:** `server/index.ts:6449–6455` — with no `?messages=`, `pageSize()`
  returns `undefined` → `messagePage()` returns **all** messages **unslimmed**
  (`server/index.ts:900–906`: `if (limit === undefined) return { messages: all }` —
  `slimMessage` only runs on the paginated path). Pruned screen messages still carry
  up to 4 base64 PNGs per thread (~100–500 KB each per `server/store.ts:812`
  comment). Callers that omit the param:
  - **App hydrate:** `src/state/store.tsx:1569–1571` — `loadAll()` → `api("/api/bots")`,
    run at boot **and on every non-resumable SSE hello** (`store.tsx:1620–1640`).
  - **Desktop tray:** `src/tray-main.ts:95` — polls `/api/bots` **every 3 s while
    visible** (`tray-main.ts:108–114`) to render names/activity only.
  - Reconcile already uses `?messages=0` (`store.tsx:1658`) — the slim path is proven.
- **Heavy-user failure mode:** N bots × tasks × full transcripts (+≤4 PNGs/thread) is
  serialized (`JSON.stringify`), then gzipped **synchronously** (measured 19–40 ms per
  multi-MB body, §1c) on the single event loop — per request, per 3-second tray tick,
  per reconnect. Client-side it's a multi-MB `JSON.parse` + full reducer hydrate.
  Thread materialization (`store.ts:699–717`) also loads every thread from SQLite on
  first touch, which this route triggers for all threads.
- **Fix shape:** (a) tray → `?messages=0` (§5-A2); (b) hydrate → slim first page +
  existing scrollback route for older history (§5-B1). Server needs no change for
  either — both params already exist.
- **Test plan:** tray: unit test asserting the poll URL carries `messages=0`
  (new `src/tray-main.poll.test` seam or extract the URL to a const); hydrate: e2e
  (new spec) — boot, open an old thread, assert tail renders + "load older" pulls
  via `GET /api/threads/:id/messages?before=`.
- **Expected win:** tray poll payload multi-MB → KB-scale; boot payload for a heavy
  fleet from tens of MB → ~100 KB/thread page. Biggest single heavy-user win in the
  repo.

### S2 — Static serving: whole-file `readFileSync` per request, **no cache
validators, no compression**

- **Evidence:** packaged-app branch `server/index.ts:9336–9390`: per request
  `statSync` + `readFileSync(file)` of the whole file;
  headers are `content-type` + `x-content-type-options` only — `cache-control:
  no-cache` **only for HTML**; **no `etag`, no `last-modified`, no
  `cache-control` for JS/CSS/images** (`grep etag|last-modified` on index.ts: zero
  hits). Marketing branch `9285–9335` and docs branch `9239–9284` same shape
  (`www/index.html` 125,934 B re-read + `withVerificationMeta` transform per hit —
  measured 0.36 ms, cheap; `hero.png` 490 KB, no cache header). Production confirms
  the gap in the wild (§1b: 1,887,015 B JS with no cache/encoding headers).
- **Measured:** one `readFileSync` of the biggest file = 0.48 ms CPU (§1c) — the CPU
  is fine; **the transfer is the finding**: without validators or freshness, every
  cold visit re-downloads 1.68 MiB locally / 1.80 MiB in prod, forever.
- **Heavy-user failure mode:** every reload, new tab, post-deploy visit, and first
  open of every lazy grammar chunk pays full bytes; slow links stall first paint on a
  1.68 MiB blocking `<script type=module>`.
- **Fix shape:** in the static branch — hashed `/assets/*` →
  `cache-control: public, max-age=31536000, immutable`; other static → `no-cache` +
  `etag` (sha of file, cached mtime→etag map) so revalidation becomes 304; keep HTML
  `no-cache`. Marketing images/fonts same treatment. Purely additive headers.
- **Test plan:** new `server/static-cache-headers.test.ts` (do **not** edit
  `server/docs-static.test.ts`, which is live): boot server on an owned free port →
  GET `/assets/*.js` asserts `immutable` + 304 on `If-None-Match`; GET `/` asserts
  HTML still `no-cache`; HEAD behavior unchanged per Loop116 fix.
- **Expected win:** repeat-visit bytes for the app shell → ~0 (hashed assets);
  304 revalidation for everything else; each lazy grammar chunk fetched once per
  install instead of once per visit. **Effort S.**

### S3 — SSE replay buffer retains screen-frame base64, contradicting its own comment

- **Evidence:** `server/index.ts:1010–1021` — comment says desktop captures are
  "never retain[ed] … base64 payloads", but the code pushes
  `replayBuffer.push({ seq, kind, frame, payload })` unconditionally, and both
  `frame` (stringified payload) and `payload` contain `png` for
  `broadcast({ kind: "screen", botId, ...frame })` (`server/index.ts:2011`, payload
  `{png, mime}` from `2008–2012`). `REPLAY_MAX = 500` (`server/index.ts:992`).
  No other push site, no strip path (grep: single push at 1017).
- **Heavy-user failure mode:** screen frames arrive ≥ every 3 s
  (`SCREEN_POLL_MS=6000`, `SCREEN_MIN_GAP_MS=3000`, `server/index.ts:1984–1987`) at
  100–500 KB each (`server/store.ts:812`). A screen-heavy computer-use session fills
  the ring with screen frames → **worst case ~500 × 500 KB ≈ 250 MB** retained in the
  Node process, plus stale PNGs re-blasted to reconnecting clients (who apply them as
  live `screenFrame` state, `src/state/store.tsx:1829`).
- **Fix shape:** for `kind === "screen"`, push the seq slot with `frame: null` and a
  png-stripped `payload` (the replay loop already skips `frame: null`,
  `server/index.ts:6404–6411`; clients fall back to hydrate for gaps they can't
  replay — same as any other skipped frame).
- **Test plan:** new `server/sse-replay.test.ts` (pattern: existing booted-server
  harness in `server/index.test.ts`): client connects → force a screen broadcast →
  disconnect → reconnect with `since` before it → assert no `png` is replayed and
  seq-gap detection still reports `resumed: false` correctly when the cursor fell off.
  Plus a pure unit on the strip helper if extracted.
- **Expected win:** SSE memory bounded by real event frames; no stale-screen
  rehydration. **Effort S–M.**

### S4 — One megastore context: every state change re-renders every mounted consumer

- **Evidence:** `src/state/store.tsx:1910–1914` — single
  `value = { state, dispatch, refreshInstances, seedCards, stopCleanup }`;
  **86 `useStore()` call sites** across the tree (top offenders: ChatView 8,
  Sidebar 8, SocialView 8, SettingsModal 5, RoutinesPage 4). Any reducer action →
  new `state` identity → all mounted consumers re-render. Frames that land in the
  main reducer include `message`, `message.patch`, `bot` (with full wire bot),
  `group`, `thread`, `hydrate`, **and `screenFrame` carrying a 100–500 KB base64
  string** (`store.tsx:855–861`, dispatched at `1829`, broadcast at
  `server/index.ts:2011`) — so during computer-use, a multi-hundred-KB string churns
  the entire component tree every ≥3 s, and message events do it per activity chip.
- **Credit where due:** token streaming is already isolated (`StreamContext` +
  rAF batching, `store.tsx:1163–1199`; only 3 `useStreaming` consumers) — do not
  re-litigate that.
- **Heavy-user failure mode:** fleet scale — many bots producing events while the
  user reads another thread → whole-tree re-render per event; screen frames make each
  one expensive (new large string in state, deep-equal-ish diffs downstream).
- **Fix shape (staged):** (b-1) move `screenFrame`/`provisioning` into a dedicated
  context like `StreamContext` (touches ChatView/ComputerPanel consumers only);
  (b-2) split StoreContext by domain (roster vs UI flags vs config) — architectural,
  see §5-B5.
- **Test plan:** new render-count harness test (component tree + mocked dispatch,
  assert consumer X does not re-render on unrelated action) + existing reducer tests
  unchanged; e2e smoke that screen panel still updates.
- **Expected win:** fewer commits per SSE frame; noticeable on low-end laptops with
  large fleets. Needs a React Profiler capture before/after to claim numbers.

### S5 — Persistence: whole-array pretty JSON + fsync per *distinct* mutation

- **Evidence:** `server/store.ts:570–590` — every `saveBots()` does
  `JSON.stringify(this.bots, null, 2)` then, if bytes changed,
  `writeFileAtomic` = open + write + **fsync** + rename (`server/atomic.ts:9–40`),
  all **synchronous on the event loop**. ~19 call sites across
  `store.ts`/`index.ts`. Identical-bytes dedup exists and is correct; the pretty
  print costs 1.6× CPU and +17% bytes (measured §1c) — small at today's 3 KB
  `bots.json`, linear in bot count for a heavy fleet. `config.json` same pattern
  (`server/config.ts:312`, operator-facing — leave pretty).
- **Concurrent writers:** none by design — single process per data dir, atomic
  replace, no unlink (documented `store.ts:574–577`). Two processes on one data dir
  is out of contract, not a runtime race.
- **Heavy-user failure mode:** turn churn (busy/activity/unread transitions) ×
  fsync latency × bot count — each distinct save is a durable flush while every
  SSE frame and HTTP response waits behind it on the same thread.
- **Fix shape:** (b) compact stringify for `bots.json` only, and/or coalesce writes
  (micro-debounce) with flush-on-shutdown; long-term (b) SQLite, see §5-B2 — threads
  already made this exact move (`server/message-db.ts:1–14` documents the identical
  O(thread²) problem and its SQLite fix; `node:sqlite` is dependency-free and already
  powers `messages.db`, `auth.db`, sync journal, account-drive).
- **Test plan:** existing `server/store.test.ts` persistence cases must pass
  untouched (they parse, not pretty-print); add a new test asserting `saveBots` →
  valid JSON + dedup skip still holds after format change.
- **Expected win:** −36% stringify CPU, −17% bytes today; SQLite (B2) removes the
  whole-array serialize + per-change fsync class.

### S6 — Receipts, sync drainer, webhooks: measured, not a problem

- Receipts are a **pure composer** recomputed per GET (`server/receipts.ts:1–16`,
  route `server/index.ts:6144–6166`) — no append hot path, no file per receipt;
  cheap relative to S1/S2. The mission's "batched per settled task" shape is not a
  write amplifier.
- Sync journal/drainer is already the model citizen: SQLite rows, 250 ms debounce,
  drain 32/loop, rev-supersedes, exponential backoff to 5 min, dead-letter at 12
  (`server/sync-journal.ts:18–23, 71–120`); engine single-flight + debounce
  (`server/sync-wiring.ts:27–33, 198–244`). Telegram uses offset-based `getUpdates`
  (`server/telegram-sync.ts:147–160`), not a busy loop.
- Webhooks cap attempts & deliveries at 2,000 with splice-on-push
  (`server/webhooks.ts:138–139, 543–546`); full-file rewrite per flush is bounded.

### S7 — In-memory growth: two unbounded maps, one bounded-but-leaky

| Structure | Evidence | Status |
|---|---|---|
| `Store.threads: Map<threadId, ThreadState>` — materialized on first read, **evicted only on thread delete** | `server/store.ts:438–449, 699–717`; sole `delete` at `670` (deleteThread) | **unbounded** — every task a heavy user ever opens stays resident (full message arrays incl. pruned-but-present frames metadata) |
| SSE `replayBuffer` (500 slots, retains screen base64) | `server/index.ts:992, 1017` | **leaky** — see S3 |
| `toolMessageByItem` / `askMessageByRequest` | `server/index.ts:1068`; deletes at `1473`, `askMessageByRequest.delete` on answer | OK — bounded by in-flight tool items |
| `repeat-detector` per-thread key maps | `server/repeat-detector.ts:33–48` | OK — LRU-capped per thread, `settle()` clears |
| foreground-call registry | `server/foreground-call.ts:111–117` | OK — evicts oldest ended / 429s |
| `highlightCache` (client) | `src/components/ChatMarkdown.tsx:21–31` | OK — capped 200 |
| `screenPollers` | `server/index.ts:1965–2026` | OK — per-turn, dropped on end |

- **Fix shape (thread cache):** LRU cap (e.g. 64 threads) evicting threads with no
  SSE subscriber/busy bot — reads rebuild from SQLite on demand (that path exists).
  Test: new `server/store-lru.test.ts` — touch >cap threads, assert older ones
  re-materialize with identical messages and delete-path behavior unchanged.

---

## 3. Webapp findings

### W1 — First load is a blocking 1.68 MiB, and prod ships 1.80 MiB uncompressed
with zero validators
See §1a/§1b. Fix = S2 + (optionally) build-time precompressed `.gz` for static
(§5-B8). Existing lazy split (Loop118) already took the main bundle 1,882→1,509 KB —
that build **is not what production serves** (§1b), so the first "win" for real users
is deployment, then caching.

### W2 — Re-render hot spots
S4 above. Ranked by exposure: (1) `screenFrame` through the megastore, (2) any
roster/message event vs 86 consumers, (3) 1-second `setInterval` ticks — inventory:

| Timer | Site | Cost |
|---|---|---|
| tray `/api/bots` full poll, 3 s | `src/tray-main.ts:108–114` | **server re-serializes all transcripts** (S1) — top offender |
| reconcile `/api/bots?messages=0`, 30 s | `store.tsx:1665` | gated on `!connected` — OK |
| `RoomsPanel` refresh, 5 s | `os/RoomsPanel.tsx:263` | small JSON, only while /os open |
| `BrowserPanel` pull, 900 ms | `BrowserPanel.tsx:43` | only while panel open |
| `ComputerPanel` screenshot/refresh, 2–4 s | `ComputerPanel.tsx:92,294,320,346` | local IPC/endpoint, panel-scoped |
| `LoginPage` OAuth tick 1.5 s / `PairPage` 250 ms | `LoginPage.tsx:82`, `PairPage.tsx:31` | page-scoped, bounded |
| 1 s wall-clock ticks (`TimelineStrip:21`, `CalendarDeviceEnrollment:32`, `ChatView` WorkingTimer:810, `os/DesktopShell:29` 15 s) | various | WorkingTimer = textContent only (no commit) — OK; others setState but render tiny subtrees |
| `Onboarding` perm poll 2 s (`Onboarding.tsx:750`), tour 3.6 s (`:669`) | onboarding-scoped | OK |
| `EmailOtpSignIn` countdown (`EmailOtpSignIn.tsx:142`) | OTP stream — see conflict flags | page-scoped |
| server-side: goals tick 3 s (`goals.ts:232`), routines tick 10 s (`routines.ts:556`), screen poll 6 s, liveness, watchdog, calendar/foreground sweeps, SSE keepalive 25 s/client (`index.ts:6416`) | — | all O(small state), single process |
| companion `/state` poll 1 s paired / 10 s idle (`companion/src/control.ts:395–400`) | companion web page | self-scheduling (no stacking) — OK |

23 `setInterval`/timer sites total in `src/` (excluding tests); none run while their
surface is unmounted. **No timer is a cliff**; the tray 3 s full-payload poll is the
only expensive one (because of S1, not the cadence).

### W3 — Large-list rendering: windowing EXISTS and is good
`TRANSCRIPT_WINDOW_SIZE = 120` tail window anchored per bot+task with render-phase
re-key, derived values from the full list (`ChatView.tsx:1011–1041`), memoized
`MessagesList` so streaming doesn't re-tokenize settled markdown
(`ChatView.tsx:825+`), `GroupView` uses the same window (`GroupView.tsx:642`), expand
loads +120 (`ChatView.tsx:1140`). Shiki settles 250 ms then caches ≤200 blocks
(`ChatMarkdown.tsx:14–31`). **Nothing to do here** beyond verifying with a Profiler
capture if someone claims jank.

### W4 — Fonts (marketing pages)
- `www/index.html` now self-hosts 9 Inter weights via `@font-face` (lines 11–70),
  `font-display: swap` — good; but lines 8–9 still carry **orphaned
  `preconnect` hints to `fonts.googleapis.com`/`fonts.gstatic.com`** with no
  stylesheet referencing them → wasted connection setup on every visit.
- `www/teams.html:15–17` still loads a render-blocking **Google Fonts** stylesheet
  (3 families) — third-party render-block on one page.
- `www/fonts/` is **untracked in git** and `www/*.html` are modified — a font
  self-hosting stream is live right now (§6): the preconnect cleanup belongs to that
  stream, not to a perf slice.
- 9 declared weights ≈ 216 KB potential; only used weights download (swap ⇒ FOUT
  acceptable).

### W5 — API/HTTP shape on the wire
`json()` gzips ≥1 KiB with `Vary` (`http-helpers.ts:11–41`) — good. But **no API
response carries `cache-control`/`etag`** (by design: SSE is the freshness channel).
Keep it that way (§5-C4). Body cap 1 MB (`http-helpers.ts:67`), keep-alive 65 s
(`index.ts:9415` region), `server.keepAliveTimeout = 65_000` — all sane.

---

## 4. Heavy-user / concurrency model

**What the architecture actually is:** one Node process, one event loop, one writer
per data dir; all "concurrency" (HTTP + SSE fan-out + timers + provider events)
shares that thread. Weights of a heavy user's request, in measured order:

1. **Response size** — `GET /api/bots` full hydrate (S1): `JSON.stringify` + sync
   `gzipSync` 19–40 ms **per request** while every other frame waits.
2. **Durable writes** — `saveBots` fsync+rename per distinct mutation (S5).
3. **Static transfer** — no caching/compression (S2/W1): 1.68–1.80 MiB per visit.
4. **Retention** — thread cache (never evicted) + replay buffer (S3/S7).
5. **Fan-out cost** — `broadcast()` serializes **once** per event and reuses the
   frame (good, `index.ts:1010–1021`), but `visibleToClient` does an O(bots×tasks)
   `botByThread` scan **per frame per client** (`index.ts:1029–1060`) — fine for a
   family install, worth an owner-id index if hosted fleets grow.

**Rate limits / budgets (grep `rate|budget|limit` across `server/`):**
inbound throttling exists **only** on auth-shaped endpoints — sign-in 4757, pairing
4838, referral 6094, server-side fetch-models 8737, receipt verify 9158, plus
upstream-4616/4669 passthrough — all keyed by a best-effort client bucket
(`index.ts:4294–4298`). **There is no general request rate limit, no per-session
request concurrency cap, and no per-user payload budget.** The only per-bot
concurrency is semantic (`busy` per bot) and provider-side rate-limit cooldowns
(`index.ts:5602–5667`). Request bodies are capped at 1 MB; SSE clients drop at 4 MB
unflushed. For a self-hosted single-user this is defensible; for hosted multi-tenant
(SSE `userId` filtering already exists) it's the first thing a heavy or abusive
tenant hits — see §5-B10.

**Top-5 unbounded/thinly-bounded list routes** (no `limit` param or unbounded
default):

| # | Route | Evidence | Bound today |
|---|---|---|---|
| 1 | `GET /api/bots` (no `?messages=`) | `index.ts:6449–6455`, `900–906` | **none** — all threads, PNGs included |
| 2 | `GET /api/routines` (no `from`/`to`) | `index.ts:5501–5513`; `routines.ts:352–357`, cap 2,000 runs | 2,000 runs × all routines, copied, every hydrate (`store.tsx:1580`) |
| 3 | `GET /api/bots/:id/why` (no `?limit=`) | `index.ts:7143–7151`; `why-journal.ts:178–189` (`cap = query.limit ?? matching.length`) + whole-journal `readFileSync` parse per request (`:132`) | **none** when param absent (app passes `limit=50`, `WhyPanel.tsx:57`) |
| 4 | `GET /api/webhooks` | `index.ts:6287` → `listAttempts()` copies up to 2,000 attempts (`webhooks.ts:364–365`) | 2,000 attempt objects per poll |
| 5 | `GET /api/goals` / memory history / briefing | goals 200 (`goals.ts:54`) ok; `listMemoryHistory` unbounded `lstatSync` per entry (`workspace.ts:488–500`); briefing O(bots) cheap | mostly OK — listed for completeness |

**The single biggest scaling cliff, stated plainly:**
*Every cold visit re-downloads the entire 1.68–1.80 MiB JS bundle because static
assets carry no cache validators and no compression (S2/W1) — and, on the server side,
every boot/reconnect/tray-tick re-serializes and synchronously gzips the entire fleet's
transcripts (S1) on the same single event loop that serves SSE, timers, and durable
fsyncs. A heavy user's cost is O(entire fleet) per request instead of O(delta).*
Fix order: cache headers (A1) → tray slim (A2) → hydrate pagination (B1) → storage (B2).

---

## 5. Ranked wins

### (a) Safe-now slices — pure perf, behavior-identical, testable

| # | Slice | Files | Verification plan | Expected win | Effort | Conflict flags |
|---|---|---|---|---|---|---|
| **A1** | **Static cache headers + ETag**: hashed `/assets/*` → `immutable` 1y; other static → `no-cache` + ETag/304; HTML keeps `no-cache`; marketing images/fonts too | `server/index.ts` static branch `9336–9390`, marketing `9285–9335`, docs `9239–9284` (headers only); **new** `server/static-cache-headers.test.ts` | new test file: boot on owned port → asset GET has `immutable`, `If-None-Match` → 304, HTML still `no-cache`, HEAD still 200-without-body (Loop116 invariant); full gate | repeat visits ~0 bytes for 1.5–1.9 MiB shell; 304s elsewhere; every lazy grammar chunk once per install | **S** | `server/index.ts` has uncommitted changes (§6 OTP stream) — touch only the static block, rebase before commit; do **not** edit `server/docs-static.test.ts` (live `M`); touches web-app stability surface → additive headers only, note in commit |
| **A2** | **Tray slim poll**: `fetch("/api/bots?messages=0")` | `src/tray-main.ts:95` (new const for the URL) | new unit asserting the URL + render still gets id/name/activity/hidden; desktop check: tray face/lines still update while visible, hidden still pauses | 3 s tray tick: multi-MB → KB; kills the worst O(fleet) hot loop | **S** | `electron/main.mjs` is in the desktop-parity stream but `tray-main.ts` is clean — no file overlap; keep slice to one line + test |
| **A3** | **Replay buffer: never retain screen base64** | `server/index.ts:1010–1021` (push) — strip for `kind==="screen"`, keep seq slot with `frame:null`; optional extracted pure helper | **new** `server/sse-replay.test.ts`: connect → screen broadcast → reconnect with `since` → no png replayed, `resumed` semantics intact; full gate | SSE retention bounded; no stale-screen rehydration; honors the comment the code already makes | **S–M** | `server/index.ts` (live `M`) as above; screen behavior is mascot/computer-adjacent — no file overlap with desktop stream |
| **A4** | **Why-route default cap**: when `?limit` absent, default to ≤100 (param-present path unchanged) | `server/index.ts:7143–7151` | new test: no-param request ≤100 entries; `limit=50` unchanged; existing `server/why-journal.test.ts` untouched | removes an unbounded route + whole-journal parse result copy | **S** | memory stream (`memory-retrieval/grants` untracked) reads journals differently — verify no coupling; app already passes `limit=50` so zero UI change |
| **A5** | **WAL observation follow-up**: assert `messages.db` checkpoint cadence under write load | `server/message-db.ts` (PRAGMA section, `:46–49`) — only if a soak reproduces growth | soak script (owned data dir) counting WAL bytes across N appends; gate unchanged | prevents WAL silently outgrowing the DB (observed 40×, §1d) | **S** (investigate first) | none — but **do not act until reproduced** (§7) |

### (b) Needs-owner-decision — architectural / API-shape / operator-visible

| # | Slice | Files | Verification plan | Expected win | Effort | Conflict flags |
|---|---|---|---|---|---|---|
| **B1** | **Hydrate pagination**: `loadAll` fetches `?messages=50` (or per-thread pages) + wire existing `GET /api/threads/:id/messages?before=` scrollback into ChatView/GroupView | `src/state/store.tsx:1569–1598`, `src/components/ChatView.tsx` (expand path `1140`), `GroupView.tsx`; server route already exists (`index.ts:6460–6487`) | new e2e: heavy fixture (3 bots × 500 msgs) boots, tail renders, scrollback loads older, forks (`branchMessage`) still reachable; full gate + browser suite | boot/reconnect payload: multi-MB → ~KB×threads; THE heavy-user server win | **M–L** | reducer/hydrate shape is shared with seed-card + teach-replay streams (`teach-replay.ts` uncommitted `M` per ledger note — check `git status` before touching `store.tsx`; today it is clean) |
| **B2** | **bots.json/groups.json → SQLite** (`node:sqlite`, same move as threads) | `server/store.ts:460–590`, new `server/bot-db.ts`; callers unchanged via Store API | migrate-on-boot with backup file (pattern: `message-db.ts:10–14` legacy import); `server/store.test.ts` must pass **unedited**; add restart/durability test | kills whole-array stringify + per-change fsync + pretty-print tax (S5); consistent with stack already shipping SQLite in 4 stores | **L** | **backups stream** (`workspace-backup-routes.ts` + `PortableBackupCard.tsx` — note: no `SnapshotsCard.tsx` exists) may enumerate `*.json` files — inventory first; operator docs may reference hand-editing `bots.json` (owner call) |
| **B3** | **Coalesce `saveBots` writes** (micro-debounce + flush on shutdown) | `server/store.ts:570–580` | durability test: crash-immediately-after-mutation harness (existing `persist-failure-store.test.ts` patterns) | fewer fsyncs during turn churn | **M** | trades durability window — owner must accept; prefer B2 instead |
| **B4** | **Split StoreContext / move `screenFrame` out of the reducer** | `src/state/store.tsx:540,855,1829,1910–1914`; consumers `ChatView`, `ComputerPanel`, `Sidebar`, `SocialView`, `SettingsModal` | new render-count test + Profiler capture before/after; full gate | fewer tree-wide commits per SSE frame (S4) | **M–L** | **desktop-parity stream owns `src/App.tsx`, `SettingsModal/Primitives`, `ShortcutsSheet`, `keyboard-shortcuts.ts`** — SettingsModal has 5 `useStore` sites; sequence after that stream lands |
| **B5** | **Cap `GET /api/routines` runs default** (e.g. newest 100 when no `from`/`to`) | `server/index.ts:5501–5513`, maybe `src/state/store.tsx:1580` | UI shows same history window? needs product check; new route test | hydrate sheds up to 2,000 run objects | **S–M** | changes observable history depth → owner call; RoutinesPage is a lazy chunk (Loop118) not a live stream |
| **B6** | **Hosted inbound budgets**: general per-IP/per-user rate limit on expensive routes (`/api/bots`, `/api/search`, `/api/instances`) | new `server/rate-limit.ts` + `index.ts` wiring | new tests per endpoint; must not throttle legit SSE/reconnect | defends multi-tenant hosted mode; single-user self-host unaffected (bypass loopback) | **M** | policy choice (limits, bypasses) = owner; no security claims implied |
| **B7** | **`/api/instances` cost**: `resetPathCache()` + `registry.describe()` per call (`index.ts:8045–8051`), triggered on focus (3 s throttle `store.tsx:1901–1906`) and picker open (`ModelPicker.tsx:108`) | `server/index.ts:8045+`, `server/env-path.ts:89` | measure first (§7) — spawning engine CLIs is side-effectful | fewer PATH rescans/probes under focus churn | **S** after measurement | engines/OTP streams touch adjacent settings UI |
| **B8** | **Precompressed `.gz` static** (build emits, server serves with `content-encoding`) | `scripts/bundle-server.mjs` / build script + static branch | bytes-with-header test; keep A1 first | first-visit 1.68 MiB → ~524 KiB where no edge compresses | **M** | build-script change → packaged-app pipeline (`package:prepare`) — coordinate with release stream; **A1 first** |
| **B9** | **`www` font preconnect cleanup + teams.html self-host fonts** | `www/index.html:8–9`, `www/teams.html:15–17` | GET-verified marketing pages, no broken font loads | kills orphaned preconnect + third-party render block | **S** | **live font stream owns `www/fonts/` (untracked) + `www/*.html` (M)** — hand this to that stream, don't race it |

### (c) Not worth it (with why)

1. **Worker threads / async offload for stringify+gzip** — premature: A1+B1 shrink
   the payloads 10–100×; single-threaded simplicity is a documented feature
   (single-writer store). Revisit only if profiling still shows stalls after B1.
2. **Replacing SSE with WebSocket** — SSE already has cursor resume, sequence-gap
   honesty, keepalives, per-client backpressure cap and screen opt-in
   (`index.ts:921–1021, 6370–6415`). Transport is not the cost; payloads are.
3. **Windowing/memoizing message lists** — **already shipped** (§1e): window 120,
   memoized list, rAF delta batch, textContent timer, separate stream context.
   Re-doing it is how audits "redesign the app" — forbidden by AGENTS.md.
4. **API response caching (`Cache-Control`/ETag on `/api/*`)** — SSE is the
   freshness authority; cached list routes risk stale roster/approvals for pennies
   (gzip already applies). Reject unless a concrete staleness bug appears.
5. **Dropping shiki grammars / replacing highlighting** — grammars are lazy,
   per-language, cached client-side (once A1 lands); highlight cache already capped.
   No evidence of user-facing cost.
6. **SQLite for transcripts** — already shipped (`message-db.ts`); the remaining
   JSON files are B2, not new work.
7. **Poll reductions on LoginPage/PairPage/Onboarding timers** — page-scoped,
   self-limiting; zero heavy-user coupling.
8. **Debouncing `www` `withVerificationMeta` transform** — measured 0.36 ms; not a
   bottleneck.

---

## 6. Conflict flags — streams live in the tree right now (`git status`, 2026-09-23)

| Stream | Live files | Overlaps which slices |
|---|---|---|
| **Uncommitted core-server edits** | `server/index.ts` **M**, `server/auth.ts` **M**, `server/email.ts` **M**, `server/docs-static.test.ts` **M** | **A1, A3, A4, B5, B6, B7** — any index.ts slice must be rebased onto this stream's edits and must not stage them (AGENTS.md: establish origin first) |
| **Desktop parity** | `src/App.tsx` M, `SettingsModal.tsx` M, `SettingsPrimitives.tsx` M, `ShortcutsSheet.tsx` M, `src/lib/keyboard-shortcuts.ts` new, `electron/main.mjs` + updater files M, `docs/plans/openmausbot-desktop-parity.md` new | **B4** (SettingsModal has 5 `useStore` sites); A2 touches `tray-main.ts` only — no overlap, but the tray/desktop check is theirs to eyeball |
| **OTP / auth** | `server/auth.ts` M, `server/email.ts` M, `src/lib/auth.tsx` M, `src/pages/LoginPage.tsx` M, new `server/email-otp-login.ts` + 2 tests, new `src/components/EmailOtpSignIn.tsx` (+ countdown interval) | blocks nothing in (a); B6 rate limits must exempt auth endpoints' own logic |
| **Memory** | new `server/memory-retrieval.ts`, `server/memory-grants.ts` | A4 reads journals — confirm no coupling to retrieval caches |
| **Backups / snapshots** | `server/workspace-backup-routes.ts` (clean), component is **`src/components/PortableBackupCard.tsx`** — **`SnapshotsCard.tsx` does not exist**, e2e `e2e/workspace-backup.e2e.spec.ts` | **B2** must inventory which files backups enumerate before moving `bots.json` |
| **iOS** | **turned live mid-study** — `ios/App/{ChatListView,ChatView,SettingsView}.swift` M + new `Haptics/QuickRepliesEditor/SelectableTextSheet/TypingIndicator/UpdatesViews.swift`, `CompanionCore/{FleetUpdates,QuickReplies}.swift` (appeared during this session; a parallel iOS stream is active) | none of the perf slices touch Swift; do not stage these |
| **www / fonts** | `www/fonts/` **new (untracked)**, `www/index.html`, `download.html`, `switch.html`, `docs/*` **M** | **B9** — belongs to that stream |
| **Other research docs** | untracked/new: `docs/research/glm/*`, `docs/research/stars-study-2026-09-22/`, `docs/plans/{openmausbot-desktop-parity,openmaus-ios-parity,openmuse-integration-study,openmuse-demo-notes,jev-decision-model-study,laya-decision-engine-study,tiptour-integration-study}.md`, `docs/screenshots/{openmuse,tiptour}/`; tracked studies: `openmausbot-design-study.md`, `openmausbot-parity-plan…` — **the tree moved during this session; re-read `git status` before staging anything** | doc-only; this study coexists |

> **Session note:** the working tree changed while this study was written (iOS files
> and several research docs appeared). §6 reflects the end-of-session snapshot, not
> the start. My only write this session was this document.
| **Misc** | `AGENTS.md` M, `src/lib/analytics.ts` M, `.deploy-trigger` M | none |

---

## 7. What I could NOT measure safely, and why

1. **A real `GET /api/bots` payload for this machine** — would require booting the
   server; boot runs `Store` constructor migrations (writes `bots.json`) and may spawn
   provider machinery. Not read-only → refused. S1's numbers are code-derived +
   synthetic (§1c).
2. **`fsync`+`rename` latency per `saveBots`** — requires writing files; my only
   write is this doc. Qualitative only (S5).
3. **React render counts / Profiler trace** — needs a running app + instrumented
   session; e2e runs spawn servers and write temp state, and no perf-shaped test
   exists to run read-only. S4's claims are structural (context identity), not timed.
4. **`registry.describe()` cost** — probing it means spawning engine CLIs
   (side effects on the user's PATH/env) → not measured; listed as B7.
5. **Re-running the full suite** — not perf-shaped and spawn-heavy; I used the ledger
   baseline (Loop128/129) instead. No existing perf-shaped vitest file was found
   (`scripts/bench-trend.test.ts` is a contract test for scorecard trends that writes
   temp fixtures — measures nothing about runtime perf, so not run).
6. **Edge compression behavior beyond the two asset GETs probed** — I verified no
   `content-encoding` on `/` and on the entry JS with gzip offered (§1b); I did not
   probe other paths/levels at the VPS, and no credential-bearing requests were made.
7. **Whether `messages.db-wal` growth (40× main DB, §1d) is steady-state or stale** —
   needs a timed soak in an owned data dir (A5/B9 investigate-first).

---

## 8. Single highest-value first slice

**A1 — Static cache headers + ETag (`server/index.ts` static/marketing/docs header
blocks only) + new `server/static-cache-headers.test.ts`.**

Why first: it is the only finding that is (i) measured in production today
(1,887,015 B redelivered per visit with zero validators, §1b), (ii) behavior-identical
for every client, (iii) effort S, (iv) independent of the live OTP/desktop streams
apart from rebasing `index.ts`, and (v) it makes every later byte of lazy grammar /
panel code fetched once instead of per visit — it compounds every other web win.
Immediately follow with **A2** (tray `messages=0`, one line) and **A3** (replay-buffer
screen strip) as the same day's server batch; B1 (hydrate pagination) is the next
heavy-user cliff and needs an owner call.
