# Fleet MCP: read-only evidence

The fleet MCP surface now includes `get_why_journal` and `get_scorecard`
alongside its original six tools. Both take a required `botId` and optional
integer `limit` (default 10, range 1–100). Unknown arguments are rejected;
there is no write mode. They reuse the existing paired session and HTTP
ownership checks.

- `get_why_journal`: GET the bot's `/why` endpoint with the requested limit.
  Returns newest-first recorded intent, decisions, outcome, and optional
  hypothesis/findings. A missing journal is an empty list, not a success.
- `get_scorecard`: first GET the bot to verify access, then GET the current
  owner's routine history. Project only the requested bot's run ids, routine
  names, scheduling timestamps, status, optional thread ids, and recorded
  checks. Return at most the requested limit and `hasMore`. Routine prompts,
  definitions, and full run output are omitted.

A completed routine can have failed checks; a failed routine can have no
checks. These are independent fields. Missing `scorecard` means no recorded
checks and must never be interpreted as a pass. Results only describe the
retained history; they do not certify a future action.

Example MCP arguments for either tool:

```json
{"botId":"the-bot-id","limit":10}
```

Validation covers protocol listing, GET-only routing, bot access failure,
strict arguments, bot scoping before limiting, newest-first ordering,
missing evidence, failed checks, malformed responses, and removal of prompt
and output fields. Approvals, deletes, credentials, engine changes and
memory writes remain outside the MCP tool set.
