# The why-journal — receipts' second layer

Muster bots have always had **receipts** (`server/receipts.ts`): who ran, what the task
was, how long it took, what it cost in tokens, and the bot's final word. A receipt is
proof of work — but it records only WHAT happened. Ask the natural follow-up, "why did
it do *that*?", and the receipt is silent.

The **why-journal** (`server/why-journal.ts`) is the second layer: a per-run decision
journal. When a run settles, the bot states the intent of the run and the key choices
it made along the way, in a fixed format the journal parses mechanically. Together the
two layers turn "the bot spent 42s and 3.1k tokens" into "the bot rolled back the
staging deploy *because* the new image was failing health checks, chose the small diff
over the refactor, and pinned the provider to its fallback."

```
receipts  = WHAT   (who, what, duration, cost, final word)
why-journal = WHY  (intent of the run, decisions made, how it settled)
```

## The prompt contract

The journal is deliberately mechanical, mirroring the sentry digest pattern in
`server/sentry.ts`: the prompt asks the bot to END its reply with structured lines, and
extraction (`extractWhyFromReply`) reads exactly those lines — nothing smarter. Bots
that get `whyPromptSuffix()` appended to their run learn the contract; every other bot
simply produces no journal entries.

A compliant reply ends like this:

```
...prose of the reply...

WHY: restore the staging deploy
DECISIONS:
- rolled back to the last green image
- pinned the provider to its fallback
```

The parser's rules, and their limits:

- The **first** `WHY:` line is the intent (max 1). A later `WHY:` line is ignored —
  a model revising itself mid-reply should not overwrite its stated purpose.
- `- ` bullets under a `DECISIONS:` header are the decisions. At most **10** are kept,
  and each is flattened to one line and clipped to **200 chars**.
- Prose after the header ends the bullet block; blank lines inside it do not.
  Bullets outside a `DECISIONS:` block are never decisions.
- Missing sections are a valid answer, not an error: no `WHY:` → `null` intent, no
  bullets → empty array. A reply that forgot the contract yields no journal data —
  never a guess.

## From receipts to auditable decisions

A receipt pins the outcome; the journal entry pins the reasoning. Each entry carries
the same identifying keys as the run that produced it (`runId`, `botId`, `threadId`,
`at`), so the WHY line can be joined to its WHAT receipt for the same run — that join
is what makes a bot's work *auditable* rather than merely *recorded*:

- **Intent** says what the bot thought the job was. If intent and task title disagree,
  the bot misunderstood the assignment — visible at a glance.
- **Decisions** expose the path taken. "Why did the bot delete that file?" stops being
  archaeology over a chat transcript and becomes a lookup.
- **Outcome** (`done` / `failed` / `partial`) lets an audit separate runs that failed
  from runs that claimed success.

## Storage

The journal persists to `DATA_DIR/why-journal.json` following the house pattern for
per-data-dir state (see `server/whatsapp-threads.ts`):

- Written through `writeFileAtomic` with mode **0600** (journal text is user content).
- Zod-validated on load; a corrupt or unrecognized file starts empty rather than
  wedging the server.
- Bounded at `MAX_WHY_ENTRIES = 1000`; once the cap is exceeded the entry with the
  oldest `at` is evicted.
- `appendWhy(dataDir, entry)` persists immediately; `listWhy(dataDir, { botId?, since?,
  limit? })` returns copies, newest first.
