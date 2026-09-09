# Fleet eval: three probes and stored scorecards

`muster eval capture.json scorecard.json` grades a captured benchmark locally
and writes a versioned JSON scorecard. It does not send tasks, answer
approvals, read pairing credentials, or kill engines. Exit codes: 0 = all
checks passed; 1 = failed or missing probes; 2 = invalid input or output.
Output must be a new file; existing runs are never overwritten.

This is the docs-run option in the Astra brief. The command grades evidence
collected with the six fleet MCP tools. It is not an autonomous benchmark
runner, task-quality judge, or independent verification of capture provenance.

## Collect evidence

Use a disposable bot and a fresh task thread for each probe. Record
`startedAt` immediately before creating the fresh task thread, so its receipt
starts within the probe window. Record `capturedAt` after collecting all
observations, including the later human decision for the approval probe.
Never reuse a running task: a queued send fails the scorecard. Record the
engine/model and task specification in the capture's `label` or a companion
experiment note so comparisons use the same workload.

1. Pair using the installed private CLI, then connect a client with
   `muster mcp`. Save the initialize/tools-list responses alongside the
   captures. `fleet_status` supplies bot ids.
2. **Completion:** `send_task` a concrete task with a predetermined expected
   result. Save the send response, then `wait_for_conversation` until it
   settles. Save `get_receipt` for the returned thread. Separately judge the
   substantive answer against the task's expected result; the scorecard
   checks only that a reply and a fresh receipt exist.
3. **Escalation:** arrange a permission-gated action on a disposable bot with
   auto approval off and no remembered grant. Save `needs-user` before the
   human acts, plus the original pending card's message id, title, options,
   and tool from Muster. Relay it verbatim. The human answers in Muster.
   Then save `get_approval_history` and identify the resulting decision id.
   Never answer the card through an external agent or make auto approval
   appear human. Preserve the original pending-card snapshot, not its later
   answered version.
4. **Failure:** on a separate disposable engine, the operator terminates
   that engine mid-turn and records the exact engine pid, signal, time,
   and setup in the experiment note. Save the resulting `failed` wait and
   `dead` activity. Never stop/revoke a session or kill the server. The
   existing demo on `127.0.0.1:8845` is excluded from destructive probes.
   If a disposable engine is unavailable, omit this probe: the result must
   stay incomplete, not silently pass.
5. Store the capture outside the repository with restrictive permissions.
   Run `muster eval capture.json scorecard-YYYYMMDD-HHMMSS.json`. Retain the
   original captures and experiment note beside the scorecard.

## Capture format

Top-level fields are `version: 1`, a descriptive `label`, `source` (`live`
or `simulated`), and `probes` with optional `completion`, `escalation`, and
`failure` members. Missing members produce an incomplete scorecard. Start
with this valid, intentionally incomplete capture:

```json
{"version":1,"label":"Engine / model / task / run identifier","source":"live","probes":{}}
```

Each present probe contains:

| Field | Source |
|---|---|
| `botId`, `threadId` | ids of this probe's bot and fresh task thread |
| `startedAt`, `capturedAt` | UTC ISO timestamps surrounding the probe |
| `send` | `{ "messageId": "...", "queued": false }` from `send_task` |
| `wait` | decoded `wait_for_conversation` result, including `threadId`, `outcome`, and any `reply` / `needsUser` |
| `receipt` (completion) | `{ "requestedBotId": "...", "requestedThreadId": "...", "receipt": <get_receipt.receipt> }` |
| `card` (escalation) | `{ "messageId": "...", "title": "...", "options": ["Allow", "Deny"], "tool": "..." }` from the original pending card |
| `audit` (escalation) | `{ "requestedBotId": "...", "entries": <get_approval_history.entries>, "humanDecisionId": "..." }` |
| `activity` (failure) | the observed bot activity, expected `dead` |

Decode MCP content text into JSON before embedding it. Do not paste cookies,
keys, or full credential-bearing transcripts into captures. The schema
allows the real receipt fields; id routing is recorded separately because
the receipt body has no bot/thread ids. Audit entries likewise have no
request id: the evaluator identifies the decision and the scorer checks bot,
tool, human decision type, and time window. That is corroboration, not proof
that the decision belongs to that exact request.

## Interpret and compare

Each probe records named Boolean checks, a status, elapsed wall time, and
receipt tokens/cost when a matching fresh receipt exists. Unknown cost or
missing receipt usage remains `null`. Receipts aggregate a task thread; do
not compare runs made in reused threads as per-task measurements.

All three probes must be present and pass for an overall pass. A supplied
failed probe takes precedence over missing probes. Keep `source: simulated`
for fixture captures: a simulated pass is never evidence of a live benchmark.
Compare like-for-like task specifications and engine configurations, alongside
manual task-quality scores. No competitive claim follows from these checks
alone.
