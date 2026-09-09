# Receipt-based fleet delegation

`send_task` accepts an optional `receiptRef` identifying a source bot and
task thread:

```json
{
  "botId": "reviewer-bot-id",
  "text": "Review the source report and identify missing evidence.",
  "receiptRef": { "botId": "researcher-bot-id", "threadId": "source-task-thread-id" }
}
```

The MCP server verifies access to the source bot with GET, fetches its
receipt with GET, validates the receipt, then sends the requested task plus
a snapshot to the destination through the existing message endpoint. If
source access or receipt validation fails, nothing is sent. Plain tasks
continue to work without a reference. The returned send result includes
the source reference so callers can retain the handoff in their own audit.

The receiving task's stored message contains the snapshot and source ids,
so later changes to the source receipt do not silently change the context
already delivered. The snapshot includes receipt fields only, never full
transcripts or arbitrary response properties. It is explicitly labeled
untrusted historical data; it grants no permissions and does not change
human approval handling. A referenced receipt may record `no-reply`; that
outcome remains visible rather than becoming success.

This is receipt context attached to a task, not an unattended workflow
scheduler. Existing queuing, task budgets, provider behavior, and approval
rules continue to apply. Receipts are thread aggregates; callers should
select the intended historical task thread. Their result field records
whether there was a final reply, not whether that reply was correct.
