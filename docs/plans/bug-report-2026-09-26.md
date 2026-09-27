# Bug report — 2026-09-26 sweep (read before picking up a fix)

**Status update (2026-09-27, second).** Fixed and on main, each with tests: items
**1's stale-bundle enabler** (the runtime resolver now runs newer source
over an older bundle with a warning), **4** (pair --redeem retired
honestly — it no longer touches the network, so it cannot burn a code;
both copy surfaces point at working flows), **5** (sessions --json
carries a display prefix, never a raw token), **8** (inbox reads the last
activity chip like the mascot), **9** (a carried /pair code no longer
rides a query string — the gate stashes the return path in same-tab
session storage and restores the fragment after sign-in), **10, 12, 13,
14, 15** (eval trend and graders), **19**, and **21's** org-name cap,
operator-gated Organization card, and the no-change branding blur that
used to send a config PUT (the most accidental trigger of item 2) on
every blur. Items **6 and 7** were claimed and landed by the lane that
owns workspace-brain. Item **20** is left as pinned: the
throttle-counts-successes behavior is deliberately locked by a security
test, so changing it is an owner decision.

**Open, with the file occupied as of this writing:** items **1, 2 (the
server-side reload gate — the integrator has it staged mid-commit), 3,
17**, and **21's** canvas-tile label — all `server/index.ts`, integrator
lane. **18** stays with the auth lane. Do not race the shared file: the
sweep's own history has one index-corruption incident from concurrent
staging, and the fix list is not worth a second.

Four parallel hunts over the freshest surfaces, all evidence live: an
isolated boot per the repo's own harness pattern (owned data dirs, owned
ports, never port 8845), the real CLI against a fixture cloud, the real
client module against a live server, and code-level traces of every recent
commit. Every finding below is CONFIRMED (reproduced with commands and
output) or SUSPECTED (code-proven, exact lines cited, not yet exercised).
Severity: P1 breaks users today; P2 wrong behavior; P3 rough edge or
latent until another fix lands. Nothing here is a claim about overall
posture — it is a list of reproduced defects, each with a suggested fix
and the lane that owns the file.

**Fixed during this sweep (one item):** the brain-facts panel shipped
yesterday with client decodes that did not match the server's actual
envelopes — every withdraw/restore/revert succeeded server-side and then
threw client-side, and the history expander could never open. Root cause:
the client tests mocked invented shapes instead of the routes' real bodies.
Fixed by decoding the real envelopes and re-pinning the tests to them
(8/8, both typechecks clean). Lesson recorded for every mock-based client
test in this repo: the mock must be transcribed from the route, not from
the interface.

## P1 / HIGH — fix first

**1. Parallel-thread width > 1 is unreachable; the shipped feature is a
no-op. CONFIRMED (isolated boot, `parallelThreads: {default: 3}`).**
Every dispatch funnel hits the `bot.busy` 409 (`server/index.ts:2290`,
`startTurn` sets `working` synchronously at `:2324` before any await) and
`POST /api/bots/:id/tasks` 409s at `:8330` — both fire *before* the slot
ledger is consulted (`:2376` check, `:2584` claim). The `parallelWidth > 1`
admission path at `:2381` is dead code; the Settings copy
(`src/components/SettingsModal.tsx:525-554`) promises "the server admits
extra DIRECT threads up to the width". Live: first send 202 → second send
409/queued-same-thread, never a second thread. The width-1 invariant is
intact (the reachable 409 is byte-identical to the dead one).
*Fix:* make the slot ledger the admission gate — consult
`configuredWidth`/`hasSlot` in `startTurn` before the busy check, align the
tasks-route guard with the same check, keep busy as the composer lock.
*Lane:* `server/index.ts` (integrator; the turn-slots owner).
**Related latent leak (fix with this one):** the superseded-dispatch early
return at `:3020-3029` returns before `releaseSlot` at `:3039` — harmless
while width is unreachable, a permanent serialize-once-activated after it.
And Stop's interrupt loop (`:8244-8247`) abandons remaining threads on the
first rejection — use per-target catch / `Promise.allSettled`.

**2. Saving a cosmetic config section kills every in-flight turn
fleet-wide. CONFIRMED (live: gated turn running → `PUT /api/config
{branding:{orgName:"Acme"}}` → turn interrupted).**
`server/index.ts:9543` reloads providers when any key besides
`profile`/`tts` changes; `reloadProviders()` (`:4179-4255`) disposes all
engines on purpose and settles busy bots with "turn interrupted — provider
settings changed". But `branding` (landed today), `parallelThreads`,
`eventLogRetention`, and `bots.defaultEffort` are equally unread by
drivers, and `BrandingCard` (`src/components/SettingsModal.tsx:266-271`)
PUTs on every org-name blur even with no change — clicking into the field
and away mid-turn destroys a running turn.
*Fix:* gate the reload on the sections drivers actually read (extend the
profile/tts exemption to `branding`, `parallelThreads`, `eventLogRetention`,
`bots`); make BrandingCard a no-op save when unchanged.

**3. A signed-in account can read another account's receipt and mint a
public share link for it. CONFIRMED (isolated boot, two accounts; Bob reads
Alice's receipt — bot name, job title, usage, summary — and gets a 201
public URL for it).**
`GET /api/receipts/:botId/:threadId` (`server/index.ts:6586-6603`) and
`POST /api/receipts/share` (`:6183-6212`) call `store.bot()` /
`store.taskByThread()` with no `ownsRecord` check, and the multi-tenant
choke point (`:5497-5520`) only guards `/api/bots`, `/api/groups`,
`/api/threads` prefixes — its own comment claims ownership is enforced at
"this single choke point". The session gate covers anonymity (401), so
exposure is any signed-in tenant. The fleet-MCP path is not directly
reachable (its pre-check hits the owner-guarded `/api/bots/:id` first).
*Fix:* add `/api/receipts/` to the choke-point prefix list (or check
`ownsRecord(bot)` in both handlers) plus a two-account regression test.
*Lane:* `server/index.ts` (integrator).

**4. `muster pair --redeem CODE` always fails on a valid code AND burns
it. CONFIRMED (deterministic across two harness boots).**
`pairRedeem` (`cli/muster.mjs:143-160`) POSTs the code to
`/api/pair/verify` and requires a `better-auth.session_token` Set-Cookie
the verify route never sends (it returns `{email,name}` after consuming
the code). Result: exit 1 "Redeem failed — the code may be consumed or
expired", and the single-use code is gone — a redeem-browser on the same
code right after fails with invalid-code. Two surfaces still advertise the
broken command: `cli/muster.mjs:139` and the /pair carried-code
instruction (`src/lib/pairing-link.ts:79`).
*Fix:* point pairRedeem at a redemption surface that mints what it
consumes (the desktop-local `/api/pair/redeem`, or a cloud mode that keeps
its sign-in cookie), or make verify optionally mint a session; until then
stop printing the suggestion, because every run destroys the code it
prints. *Lane:* `cli/muster.mjs` + `src/lib/pairing-link.ts` copy.

## MEDIUM

**5. `muster sessions --json` prints full session tokens. CONFIRMED
(live boot: raw `token` field for every session).** The human view
truncates to 6 chars (`cli/muster.mjs:323`); the JSON mode dumps the raw
`/api/auth/list-sessions` body (`:315`). Not the cookie by itself
(better-auth cookie is `token.signature`) but credential material entering
shell history/CI logs.
*Fix:* project JSON output to `{id, createdAt, expiresAt, ipAddress,
userAgent}`; keep raw-token matching inside the revoke path only.

**6. One off-enum `kind` breaks its writer's list and silently wipes the
entire shared brain file on restart. CONFIRMED (live: `POST {kind:"robot"}`
→ 201; writer's list throws client-side; restart on the same data dir →
`{facts:0, withdrawn:0}` — total cross-account loss, no error logged).**
`POST /api/brain/facts` passes `body.kind` through unvalidated
(`server/index.ts:5886`); the enum is enforced only at load
(`server/workspace-brain.ts:88,98`), and a failed load discards everything
(`:171-179`). Control restart without the bad fact preserved everything.
*Fix:* 400 on off-enum kind at the route (mirror `factKindSchema`), and
make `load()` per-fact tolerant (drop invalid records, keep valid ones).
*Related:* stats `"kinds"` accumulates NaN→null for off-enum kinds
(`:329-331`); `supersedes` pointing at a nonexistent id is accepted 201
with a dangling chain (`:208-210`) — 400 it like revert does.

**7. The brain's 10,000-fact cap is global, not per-owner — one busy
account silently evicts other accounts' facts. CONFIRMED (live: 10,002
facts across two owners + one add → file trimmed to 10,000, evicting both
owners' oldest).** `server/workspace-brain.ts:211-214`.
*Fix:* enforce the cap per-owner (evict the writing owner's oldest).

**8. The attention inbox ranks a decades-old failed tool as "needs you"
forever, contradicting its own comment. SUSPECTED (code-proven).**
`Sidebar.tsx:1392` scans the whole visible transcript for any
`tool?.ok === false`; the mascot's error face (`src/lib/mascot.ts:182`)
reads only the last activity chip. The comment at `Sidebar.tsx:1385-1386`
promises they "can never disagree". One failed tool anywhere in history
holds rank 1 over every unread item for the life of the thread. Archive is
handled correctly (hidden bots drop out).
*Fix:* feed `failed` from the last activity message only, or from
failures newer than the last successful turn.

**9. An anonymous `/pair#CODE` visit leaks the code into a query string.
SUSPECTED (deterministic URL, not yet log-observed).**
`authGateReturnPath` (`src/lib/auth-navigation.ts:21-24`) puts the hash
into `?next=%2Fpair%23ABCD2345` — the code rides in a GET URL, exactly
what `server/index.ts:5206-5207` declares must never happen ("query
strings land in proxy/CDN access logs").
*Fix:* redirect to `/sign-in?next=%2Fpair` and re-read `location.hash` on
the post-sign-in mount, or stash the code in sessionStorage across the
round trip.

## LOW / hardening

10. **eval-trend flag filter eats real files named `--*`.** CONFIRMED
(`./--jelly.json` → Usage line, exit 2, silent drop). The CLI
(`cli/muster.mjs:872`) drops every `--*` arg; the server entry
(`server/eval-trend.ts:223`) exempts only the exact `--json` token — the
two layers disagree. Fix: treat only the exact token as the flag; error
loudly if a dropped arg names an existing file.
11. **`resolveFleetRuntime` prefers a stale `dist-server` bundle.**
CONFIRMED mixed state in this checkout: the Sep-23 bundle lacks
`eval-trend.js`, so `eval`/`bench` ran the old bundle while `eval-trend`
ran today's source. Nothing stamps or freshness-checks the bundle
(`.gitignore:9`); `gradeCommand`'s spawn-error path fails silently
(exit 2, no message, `cli/muster.mjs:854`). Fix: stamp at build time and
warn when the bundle is older than the adjacent source.
12. **`muster eval`/`bench` one catch-all conflates EEXIST with parse
errors.** CONFIRMED (input==output grades fully, then reports the
generic "Could not grade capture" for a write refusal). Fix: branch on
`error.code === "EEXIST"` with "scorecard already exists — pick a new
output filename".
13. **eval-trend diagnostics quote the fleet schema even for role
scorecards** (`server/eval-trend.ts:113` takes `fleet.error.issues[0]`) —
CONFIRMED. Report each schema's first issue instead.
14. **A body valid under both schemas silently trends as fleet**
(non-strict zod, fleet tried first) — CONFIRMED; hardening, not reachable
from either real grader. Reject bodies carrying both `probes` and `roles`.
15. **Trend schemas accept negative/huge `elapsedMs`** (bare
`z.number()`) — CONFIRMED prints "-5.0s". Use
`z.number().finite().nonnegative().nullable()`.
16. **`attachReceipt` never cross-checks the fetched receipt's `bot`
against `receiptRef.botId`** (`server/fleet-delegation.ts:26-30`) —
CONFIRMED with a stubbed harness. Defense-in-depth only: today's receipt
route builds from the same botId, so no live path. One-line assertion plus
a friendly wrap of the raw ZodError dump; note the snapshot silently drops
`durationHuman`/`findings`.
17. **Withdraw-twice answers 404 "no such fact"** — the fact exists;
"already withdrawn" is the honest answer (`server/index.ts:5900`).
CONFIRMED.
18. **Pairing/claim-minted cookies omit `Secure` on the https cloud**
(`server/index.ts:5362-5365` and the two neighbors) — flag inconsistency
only, stated as such; Better Auth marks its own cookie Secure over https
while the minted one stays unmarked. Set `Secure` when the request is
known-https, keep loopback desktop as-is.
19. **A 200-with-unconfirmed-body redeem tells the user to retry a code
the server already consumed** (`src/lib/pair-redeem-flow.ts:66-73`,
latent — today's bodies match). Check get-session before messaging;
word it "you may already be signed in — reload".
20. **Pairing's per-IP throttle counts successful redemptions; claim's
does not** (`server/pairing.ts:173-184` vs `server/claim.ts:151-184`) —
informational; skip the increment on success to mirror claim.
21. **Cosmetic:** People flashes for non-operators before config loads
(`host-build.ts:64` default-open) and General's BrandingCard renders for
non-operators whose save then 403s; shared canvas tile is labeled with an
arbitrary bot (`server/index.ts:8445-8447` keeps the LAST bot's id for the
shared target) — label it "shared" instead; `branding.orgName` is
size-unbounded while sibling `logo` is capped at 300k
(`server/config.ts:86-93`); a single event-log line larger than the cap
leaves a permanent torn line (`server/event-log-cleanup.ts:77-89`).

## Verified clean (so the next reader does not re-audit these)

Turn-slot pure ledger (9/9); width-1 409 byte-identical at both sites;
DELETE-bot slot clearing; provider-rebuild release path; lost-turn reaper;
group-room turns bypass slots by design; queued/steered sends; effort
default (enum-validated PUT, seed-only-with-instance, actionable dispatch
error); People 403 + payload minimality (no tokens/hashes); Activity
payload (names + token counts, deliberate G14 divergence); canvas endpoint
auth; localStorage zod decodes with corrupt-tolerant fallbacks (no
old-profile crash); why-journal untouched by retention; namespace
discipline between claim and pairing codes, live both directions;
redeem-browser edge cases (empty/lowercase/9-char codes, replay, cross-
consumption, cookie resolves the owner, origin gate, redacted logging);
eval-trend duplicate files, CRLF, 2 MB gate, mixed-kind refusal, 38k-check
truncation; grader round-trips; unauthenticated receipts 401.

## How to work this list

Claim by finding number in the ceo-log before editing (the
platform-boundaries audit's rule: root shell/server edits are shared
bottlenecks — one integrator owns `server/index.ts`). Findings 1, 2, 3,
17 all touch `server/index.ts` — sequence them with the integrator.
Findings 4, 5, 10–15 are CLI/eval files. 6, 7 are `server/workspace-brain.ts`
+ one route. 8, 9, 18–21 are client/server as marked. Repro fixtures for
every CONFIRMED finding can be rebuilt from the harness patterns in
`server/workspace-brain-harness.test.ts`, `server/pairing-harness.test.ts`,
and `server/fleet-mcp.test.ts`.

---

# Second sweep — 2026-09-27 (hunts 5–8: durable delivery, and dogfooding the agent-browsing fix)

Four more hunts were dispatched; two were throttled by the concurrency
limit and never started (routines/approvals/why-journal, and
backup/Drive/snapshots — **still unaudited**, re-dispatch before assuming
those surfaces are clean). The two that ran produced the findings below.
Numbers restart at 1 and do not collide with the sweep above; cite them
as "sweep 2, item N".

## Fixed in this sweep

**S2-1 (was CONFIRMED broken, live): long URLs corrupt the agent-browsing
breadcrumb, so "Open in preview" opens a page that does not exist.**
`server/drivers/acp/core.ts` crops a tool chip to 200 characters for the
chat, then `server/index.ts:1606` re-parsed that *already-cropped* string
to recover the URL the panel should navigate. Any navigate URL longer
than ~175 characters (a search query, a signed link) was stored
truncated — the dogfooding agent reproduced it end to end and watched the
preview land on a 404. The display crop is legitimate; re-deriving a
navigation target from a display string is not. The page now travels as
structured data: the `item.started` event carries a `browserPage` field
computed before the crop, and the fold prefers it. `agentPageForToolEvent`
keeps the title re-parse only for drivers that send no structured field,
and honours an explicit `null` rather than inventing a page. Fixed with
13 new tests, including one that drives a real turn through the fake ACP
CLI with a 300-character URL and asserts the event carries it whole — the
first coverage this pipeline has ever had (`browserChip`,
`agentPageForChip`, and the `/frame` `agent` field had none at all).
Verified: 121/121 across the ACP, browser-panel and panel-view suites,
server typecheck clean, oxlint clean on the touched files.

**S2-2 (hardened in passing): the breadcrumb accepted any URL the engine
sent.** The old parse only checked the `http(s)://` prefix and had no
length bound, so a multi-megabyte URL from a hostile or broken engine
would land in the `/frame` payload. Breadcrumb URLs are now bounded at
8000 characters (matching the client's own schema) and still re-validated
by `isNavigableUrl` before the panel ever navigates.

## Reported, not fixed — the owning lane is mid-flight

**S2-3 (P2, SUSPECTED): an async dispatch failure leaves a delivery
receipt stuck at `dispatched` forever.** The fire-and-forget dispatch in
`server/index.ts:3206-3250` has a catch, but it never reverts the intent,
even though `driverInvoked === false` proves nothing was ever sent. The
drain path has the same shape. A user reads "dispatched" on a message
that was never delivered and has no way to learn otherwise.

**S2-4 (P3, CONFIRMED): the drain flips a receipt, then continues
without running, reverting, or giving up.** `server/steer-queue.ts:206`
flips the state before the `!last` check at line 215; when the queued
message has vanished, the receipt is left in a state that means nothing.

**S2-5 (P3, SUSPECTED): replaying a receipt whose transcript was deleted
returns a raw 410** (`server/store.ts:864`) instead of the documented
duplicate refusal, which breaks client resend — the client cannot tell a
refusal from a broken server.

**S2-6 (P3): a cloud pairing code opened on the desktop `/pair` origin
shows a redeem button that cannot work.** The code's mode is inferred
from the code's alphabet, not from the origin it is opened on, so a user
who pastes a cloud code into the desktop app is offered a doomed button
rather than the working "enter it in Muster Desktop" path. Product call
on what the right fallback is; the honest fix is to detect the mismatch
and show the desktop instruction instead of a button that 400s.

**S2-7 (P3): the agent-browsing breadcrumb is memory-only** — it lives in
a `Map` cleared by any restart, so after a server restart the panel shows
no agent page until the agent happens to navigate again. Documented as
accepted in the code comment; a persisted "last page per bot" would need
its own retention decision.

**S2-8 (P3): the stale-bundle warning prints on every `muster eval`
invocation**, so a permanently-out-of-date `dist-server` turns into
log noise that trains people to ignore it.

**S2-9 (coverage): `SteerDrainIntentHooks` and the batch SQL are
untested, and `server/message-db.test.ts` contains zero intent
references** despite a harness test claiming intent coverage. Anything
the drain path depends on is currently unverified by the suite.

**S2-10 (heads-up, not a defect): the untracked
`e2e/message-recovery.e2e.spec.ts` fails `npm run lint`** — a type
assertion at line 84 has no `SAFETY:` justification, which the
anti-slop rules require. It will fail CI the moment it is committed;
the fix is a one-line comment, but the file belongs to the lane that
wrote it.

## What this sweep changed about how to test here

The truncation defect survived the first sweep because every test that
touched it asserted the display string — the one value that is *meant*
to be lossy. A test that pins a display crop cannot catch a bug in what
the crop feeds. The rule this adds: **when a value is cropped, truncated,
or formatted for a human, the test must assert the un-cropped source of
truth separately**, or the crop silently becomes the contract.

