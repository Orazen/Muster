# Saved welcome answers

A bot's welcome question uses a durable answer receipt. It is separate from a
live engine question or permission request. A successful HTTP acknowledgement
means the answer is saved; consult the receipt for task startup status.

## API

These routes require access to the bot and its current conversation. `threadId`
must match that conversation, and the card must be on its active branch.

| Method and route | Input | Meaning |
| --- | --- | --- |
| `POST /api/bots/:botId/cards/:cardId/answer` | `{threadId, answer}` | Save the first answer and request its initial startup. |
| `GET /api/bots/:botId/cards/:cardId/answer?threadId=...` | Query only | Read the saved answer and startup status. Never starts work. |
| `POST /api/bots/:botId/cards/:cardId/answer/start` | `{threadId, expectedAttempt}` | Explicitly start an already saved answer after a confirmed setup failure, or when recording succeeded without a startup claim. |

The answer must be nonblank text of at most 4,000 UTF-16 code units. Leading,
trailing and multiline whitespace is preserved. Request bodies reject extra
fields. The seed card ID identifies its one durable answer: an identical replay
returns the original message; a different answer conflicts.

POST returns HTTP 202 with `{ok: true, outcome, cardMessage, userMessage}`.
`outcome` is `starting`, `already-requested` or `already-recorded` for the current
server; the shared client contract also accepts `recorded`. GET returns
`{ok: true, cardMessage, userMessage}`, with a null user message before recording.
The card's `seedAnswer` contains the linked `messageId`, integer `attempt`,
`status`, and an optional startup error.

| Receipt status | Meaning | Available recovery |
| --- | --- | --- |
| `recorded` | The answer is saved; startup has not been claimed. | Explicit Start saved task. |
| `starting` | This attempt was durably claimed; acceptance is pending. | Check status or inspect the conversation. |
| `started` | The driver accepted the turn. This does not establish task success. | Follow the conversation. |
| `not-started` | Startup failed before driver invocation. | Resolve the reported issue, then explicitly start the saved task. |
| `uncertain` | Driver invocation may have had effects, or Muster restarted before acceptance was recorded. | Check status and inspect the conversation; no automatic replay. |

Recording starts at attempt zero. A startup claim increments it before invoking
the driver. A repeated older `expectedAttempt` returns the current receipt
without a new invocation. Only the current attempt in `recorded` or
`not-started` may be claimed. Newer user work, a busy bot, a different thread or
branch prevents a new claim. Late callbacks cannot overwrite another attempt.

## Persistence and clients

The card settlement, linked user message and active branch head are committed in
one SQLite transaction before memory or SSE publication. Startup claims and
results are also persisted before publication. The coordinator sends the saved
user message to the existing turn harness; it does not append another bubble.
Interrupted `starting` receipts become `uncertain` at server startup. This is
durable answer recording and guarded dispatch, not exactly-once provider work.

New cards carry `purpose: "onboarding-v1"`. Old cards are recognized only by the
canonical question/options and original root greeting/second-message position.
That legacy rule is a bounded heuristic, not proof of provenance. Unknown
historical cards and cards carrying live request/tool metadata remain inert.

Web controls preserve an unsent draft during recoverable request failures and
fence callbacks by account, connection, bot, conversation and visible branch.
They do not settle the answer optimistically or resend on reconnect. Check
status only reads. General error retry and reply regeneration cannot fork a
saved user message while its startup is recorded, starting, not-started or
uncertain; recovery stays on the versioned card. Already-started turns retain
ordinary explicit regeneration. Legacy answers without receipts remain readable
history and do not offer status or startup actions.

The generic card PATCH endpoint now returns HTTP 405; clients
must use the dedicated seed route or the existing live-request response route.
The companion proxy exposes these exact three routes. Android implements the
direct-bot controls described below. iOS and Watch still require their own
welcome-card implementation and native verification.
An older cached web page or desktop binary that still uses split PATCH/message
writes does not gain the new client recovery flow; it needs an updated bundle.

The browser/server tests use synthetic accounts and offline provider fixtures.
They do not verify Google OAuth, real model execution or a published native
release. Current run evidence and counts are recorded in the CEO ledger.

## Android welcome answers

Android uses a separate seed operation ledger and card component; live questions
and permissions keep their existing request-ID protocol. Choice and custom
answers preserve exact text. A failed request retains the draft and offers
Check status, with Retry same answer when the card remains unanswered. Only a
recorded or not-started receipt offers Start saved task, using the current
attempt. Reconnect, refresh and foreground changes never resend an answer.

The decoder records invalid original metadata before ordinary display decoding
can discard it. A malformed purpose, receipt, sender or legacy greeting cannot
become an actionable unanswered seed. Legacy recognition requires the original
root greeting and second message to be loaded. Room seeds and already-answered
legacy cards without receipts remain readable history.

A narrow receipt/echo fold preserves later attempts, replies, branch selection
and live streams. Replayed SSE user echoes cannot rewind the conversation after
an HTTP acknowledgement inserted that same saved answer. Invalid echo linkage
leaves the receipt unconfirmed and exposes recovery. Account, connection, view,
thread, card signature and foreground changes fence stale callbacks. If a
cancelled transport continues running, its physical request lock remains until
it settles; controls explain the wait and prevent another dispatch. Custom
answers use a keyboard-aware editor with normal scrolling in the chat's own
window. Its state lives outside the virtualized transcript, so row recycling
cannot discard the draft. Back and Close retain the draft for that account,
conversation and card. Closing the editor does not cancel a request already
sent. Android window-focus and background guards remain active; a native Dialog
cannot be used here because it blurs the Activity before Send can run.

Android's standalone Jest suite is separate from root Vitest. Emulator checks
use a fresh paired fixture, actual server/proxy/SQLite, and an offline provider.
They do not establish real Google OAuth, model work, physical-device behavior,
release transport policy or Play Store distribution. The ledger records exact
source hashes, native acceptance and cleanup evidence.

iOS needs its own typed models/session/UI slice; do not broaden its live
`isPending` predicate, which also feeds Watch and approval lists.
