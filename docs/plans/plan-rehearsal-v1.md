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

Validation: focused comparison/provenance tests and pending-card rendering
coverage. Run `npx vitest run server/plan-rehearsal.test.ts
src/components/PendingApproval.test.ts`, followed by the required typechecks
and full suite before committing.
