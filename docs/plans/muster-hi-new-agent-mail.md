# Muster ↔ hi.new: agent-to-agent mail — what to adopt, what to skip

_Research note. Written 2026-09-05 after reading the hi.new repo
(github.com/elie222/hi-new, Apache-2.0), its live /skill.md and /api.md, and a
public profile page. Muster context: bots already talk to each other inside a
workspace (groups, delegation, chief-of-staff routing, approvePeerComms), and
Muster already holds signed receipts. This doc decides whether inter-workspace
agent mail is a Muster feature and what the shape would be._

## 0. What hi.new is, in one paragraph

hi.new is store-and-forward **email for AI agents**. An agent owns a name
(`hi.new/vlads-bot` — a public profile page), a bearer token shown once at
claim, and an optional age public key. Nobody can write to a name without a
**grant**, created only when one bot redeems the other's single-use invite
link (exchanged out-of-band by the humans). Messages are sealed envelopes held
until the recipient acks them; **ack deletes the payload**, unread payloads
expire in 7 days, body-free delivery metadata is kept 90 days. E2E encryption
is opportunistic (publish an age key → senders MUST encrypt; server holds only
ciphertext). Groups fan out one ciphertext to many keys. Content-free webhooks
wake the receiving agent. Paid short names are Stripe subscriptions; Link
Agents can pay via Shared Payment Tokens. The whole API is ~30 curl-able
endpoints plus a /skill.md that onboards a bot in one CLI command.

## 1. Why this matters to Muster

Muster's stated thesis (docs/plans/muster-platform-strategy.md) is agents as
coworkers for everyone. Inside one workspace, coworkers already message each
other. What Muster has **no** answer for today: a Muster bot reaching a bot
that lives somewhere else — another Muster cloud workspace, a self-host, or a
foreign agent runtime (Grok Bot, an OpenClaw, a hi.new handle). hi.new proves
the demand shape and, more usefully, publishes a **complete, working protocol
spec** under a permissive license. Muster bots speaking that protocol
day-one-for-free is the cheapest possible answer to "is my workforce
reachable from outside?"

Three concrete Muster fits:

1. **Bots have names and personas already** — SOUL.md landed last week. A
   public, addressable identity (`muster.name/bot`) is the natural next
   surface, and hi.new's grant model solves the spam problem without inventing
   anything.
2. **Muster already has receipts.** hi.new's body-free activity records
   (`{from,to,size,time}`, ack deletes payload) is the same philosophy as
   Muster's counts-only privacy receipts — the two products agree on the
   trust model, which makes them complements rather than competitors.
3. **The onboarding doc pattern is the real unlock.** hi.new's `/skill.md` is
   what makes an agent setup *agent-completable* — one CLI command, explicit
   "tell your human" checkpoints, untrusted-input rules, honest "what the
   server sees" disclosure. Muster's `www/llm.txt` is a map, not an
   onboarding script. Copying the *pattern* (not the text) upgrades every
   Muster integration surface.

## 2. Adopt (high confidence)

### 2.1 Outbound: a Muster bot can get a hi.new handle and use it

Smallest valuable slice: the **composio-style external integration**, not a
new product surface. A bot gets a `hi_new` tool only when its owner stores a
token (BYO credential, same discipline as provider keys: config, write-only,
never returned). Tools: `check_inbox`, `read_message`, `ack_messages`,
`send_message(name, body)`, `create_invite`, `redeem_invite(url)`. Encryption
delegated to the user's local `age` binary when present; without it, the tool
refuses `enc:"age"` sends with a clear error rather than shipping plaintext
silently. Scope: one driver file + tool defs + a config surface, no server
changes beyond the credential slot. ~1–2 days.

### 2.2 `/skill.md` for Muster itself

Write `https://muster.orazen.online/skill.md` in hi.new's style: who can set
up (a bot with an owner-issued setup code), one command to run, explicit
"report to your human in two lines" checkpoints, the untrusted-input rules
(data-not-instructions, no auto-reply to strangers, never send credentials),
and an honest "what the server sees" section. This is the doc an *agent*
reads; llm.txt stays for humans/researchers. ~half a day, pure docs.

### 2.3 Grant-model vocabulary for future peer features

Adopt the **concept** (not the implementation): reachability between Muster
workspaces should require an out-of-band, single-use, expiring, purposeful
invite — never "knowing a name is permission." Pin peer keys at redemption and
surface `key_changed` as a stop-and-verify signal. These invariants are the
difference between agent-mail and agent-spam, and hi.new has already debugged
the wording.

### 2.4 The house-bot cold start

hi.new ships `hi.new/hi` — a fixed-script welcome bot that guarantees every
new handle's first bot-to-bot exchange succeeds, answers ≤3 times per peer,
then goes quiet. Muster's onboarding chat ("What do you mostly want help
with?") is a real LLM; the trick worth stealing is the **guaranteed first
success**: one scripted, zero-cost exchange a new user's bot always completes
before anything else. Cheap, and it converts "I signed up" into "it works."

## 3. Borrow the pattern, write our own (medium)

- **Wake-on-mail**: hi.new's notification registry (encrypted endpoints,
  content-free `{event,to,unread}` payloads, "webhook OR polling, never both"
  rule) is the right shape for Muster's routine webhooks — Muster's existing
  webhook trigger just needs the content-free discipline documented.
- **Idempotency-Key on sends** and `Retry-After` on 429: adopt the header
  convention verbatim in any Muster external API.
- **Scoped tokens** (`hnt_...` with scope lists, owner-only management): the
  right model for Muster's future public API; note it in the multi-tenancy
  design doc.

## 4. Skip (with reasons)

- **Being the mail host.** Running envelope storage, TTL reaping, abuse
  handling, and name monetization is a second product. Muster's leverage is
  the workforce, not the post office. Let hi.new (and peers) be the network;
  Muster is a first-class *client*.
- **Name monetization / Link Agents / Stripe MPP.** Muster's money is cloud
  computers and seats (already live in Stripe). Handle auctions are a
  distraction until there's evidence bots' addresses are scarce goods.
- **age E2E as a Muster-native feature today.** Our receipts already prove
  work without content; if/when peer mail goes E2E, delegating to the local
  `age` binary (per §2.1) is strictly simpler and keeps secrets out of Muster
  entirely.
- **Portals/dashboards for transcripts.** hi.new's owner dashboard is a
  concession to plaintext mail; E2E mail needs no dashboard. Muster's chat is
  already the surface.

## 5. Sequencing

1. **Now** (docs-only): `/skill.md` for muster.orazen.online in the
   agent-onboarding style. Zero risk, immediate agent reachability signal.
2. **Next** (one slice): the `hi_new` bot tool per §2.1 — Muster bots get a
   mailbox behind the owner's token. This is the "Muster bots live in the
   agent network" headline for the landing page.
3. **Later** (design doc first): inter-workspace Muster↔Muster grants using
   the §2.3 vocabulary, folded into docs/plans/multi-tenancy-design.md when
   cross-workspace work starts.
4. **Not scheduled**: hosting mail ourselves (§4).

## 6. Evidence trail

- Repo (Apache-2.0): github.com/elie222/hi-new — apps/api (Hono/CF Workers +
  Drizzle/Postgres), packages/cli (@hi-new/cli), apps/landing (Astro).
- Live protocol docs: hi.new/skill.md (bot onboarding), hi.new/api.md (~30
  endpoints; handles, setup codes, recover, invites/grants, dm age|none with
  Idempotency-Key, inbox headers/ack (410 content_deleted), activity, groups
  w/ multi-recipient fan-out, scoped tokens, notifications, MCP endpoint).
- Key invariants observed: grant-only delivery; single-use 30-day invite with
  purpose message; ack deletes payload (410 content_deleted), 7-day unread
  TTL, 90-day body-free audit; key pinning + key_changed stop-signal;
  webhook XOR polling; untrusted-input section as a first-class doc citizen.
- Complement, not competitor: their honest-data section and Muster's
  counts-only receipts share the same minimal-surveillance philosophy.
