# Plan rehearsal v1: ordered tool evidence

A bot states a multi-step computer plan in an assistant message, ending with:

```text
PLAN TOOLS:
- browser_open
- screenshot
```

Use exact provider tool identifiers, including MCP prefixes where present.
There must be 2–20 steps, with no arguments or prose after the list. The
normal bot prompt teaches this convention. An approval summary can also carry
this block. Assistant plans must belong to the current turn; user text and
reasoning text cannot supply a plan.

When an existing permission card appears in the bot's dedicated thread,
Muster compares the plan with recent normalized runtime events. Both the
transcript card and pending approval panel show the longest contiguous
prefix match within one successful run, full-sequence matching run count,
and reviewed successful run count. The persisted card retains that snapshot.
It does not trigger additional approvals or execute a rehearsal.

The permission transcript displays this frozen snapshot under **Evidence
when requested**, alongside prior approval history and a previous-run
disclosure when available. It stays readable after Allow or Deny and after
reloading the conversation. Those historical counts are not recomputed to
include the decision just made.

The evidence covers exact tool names and order only. It does not validate
arguments, intent, environment, screen states, or future success. It is not
a statistical confidence score or the full transition replay envisioned in
the ARC roadmap. Full state-based rehearsal still needs normalized action
arguments and observations across drivers.

Scope and exclusions:

- Latest 2,000 runtime records in the requesting bot's dedicated thread.
  Shared-room and other-thread histories are excluded.
- Only turns with a start, successful completion, and paired successful
  sequential tool events count. Failed, overlapping, incomplete, or
  unidentified events cannot establish a successful sequence.
- Names and ordering must match exactly. Separate runs never combine to
  supply a match; repeated plan steps require repeated recorded actions.
- Missing/malformed plans or unreadable history leave approval handling
  intact. An eligible plan with no matching history explicitly reports zero.
- Engines that omit turn/item identifiers cannot contribute those runs.

Validation: comparison/provenance tests, pending and transcript-card
rendering, and `server/approval-rehearsal-harness.test.ts` cover real local
HTTP/ACP runtime evidence and persisted card snapshots. The deterministic
fixture states a plan, emits successful ordered tool events only after Allow,
and supplies explicit WHY/HYPOTHESIS/FINDINGS for server extraction. Denied
plans supply no matching tools. These are simulated engine events, not real
browser actions or model completions. `e2e/approval-rehearsal.e2e.spec.ts`
declares the browser regression; see the CEO log for executed checks versus
runner discovery, and the separate bot-selection-on-reload gap.
