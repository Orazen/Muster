# Scoped internal peer capabilities

## Loop80 update — cleanup-only recovery implemented

The formerly proposed UI slice below is now implemented. Failed Stop503 returns
an owner/bot/generation-bound receipt; `/api/bots/:id/stop-cleanup` clears only its
captured queue IDs and cannot interrupt a provider. Later direct/room starts,
owner/deletion/reload changes invalidate it. The persistent-in-session ChatView
notice and synchronous lock survive idle/task navigation and fence late auth
responses. Browser3/3 verifies real503/retry, two-tab stale409 and sign-out; full
254files/3862passed/8skipped. See the latest ledger for exact gates and limitations.

Refresh/server-restart recovery is not implemented. The remaining runtime
acceptance recipe below (owner merge, queued crash restart, held target setup)
is still outstanding; do not interpret the historical proposal as new work to
reimplement the already shipped receipt/UI boundary.


## Loop78 implementation and acceptance — 12 September 2026

The dispatch registry, internal-route checks and durable delegation provenance are
implemented. Credentials bind the effective owner, bot, durable task/thread, depth
and one dispatch generation. They rotate on provider resume, expire after 24 hours,
and retire on exact completion, interruption, deletion, owner reassignment and
provider reload. Connector credentials cannot authorize any of the three peer
operations. The connector endpoints themselves retain their prior authority model.

Peer requests revalidate after request-body reads, human approval and target setup;
reply mirroring checks current participants and channel ownership. Setup refusal
settles the waiting ask promptly. Stop finds detached task queues even after the
live credential is gone. Queues persist validated provenance, never bearer tokens,
and refuse legacy or recursive records. Failed durable removal prevents dispatch;
failed Stop retires in-process work and returns 503 with a retry instruction.

Focused acceptance: **18/18 real hosted HTTP cases**, **40/40 credential tests**,
**56/56 delegation tests**, and **22/22 comms/unattended tests**. HTTP acceptance used
genuine credentials injected through offline ACP, real sign-up sessions, a connector
descriptor, provider session/load, interruption and a fresh server process. Its
cleanup proved both servers and 23 provider processes exited, both ports closed and
zero outbound attempts. Final acceptance: **248 files / 3748 passed / 8 skipped /
0 failed**, 320.21s Vitest (321.349s command). All **959 source hashes match**
`source-freeze-repaired.json`; the result is in
`.omb-scratch/verification/loop78-peer-capabilities/full-repaired-result.json`.
Server types pass; lint passes with one intentional watch-snapshot warning. The
rebuilt packaged server passes **9/9** under Node 22.22.3, not a native Electron launch.
The first full run had **3744 passed / 2 failed / 8 skipped**. It exposed hidden
webhook-source refusal and a lost provider-reload failure receipt. Hidden senders
now retain authorized dispatch; terminal reporting is separate from launch
permission and still checks the original owner/task/channel audience. The corrected
22-case comms/unattended and 56-case delegation gates passed before the full rerun.

**Evidence limits:** HTTP covers held target deletion and source Stop; ownership
mutation during held approval and post-setup validation are covered by delegation
module tests and source review, not those exact real-server races. Queue reload
acceptance is same-process disk reload; the real server restart case rejects old
credentials. A failed nondurable Stop may reload accepted work after restart if the
user ignores the 503 retry instruction. Durable dequeue is at-most-once dispatch,
not guaranteed task completion after a crash. This is neither a process sandbox
nor a comprehensive security review. Mimosa and two high dependency alerts remain
release gates. Complete the remaining real-server race/restart acceptance before
claiming the original acceptance list below in full.

**Recovery UI still required:** source review of `ChatView.tsx` and `Composer.tsx`
shows Stop is rendered only while the bot is busy. The 503 reaches the shared error
handler, but after the turn settles those controls disappear. The HTTP retry is
verified; a nontechnical user's persistent retry action is not implemented or
browser-tested. Add that recovery surface before treating failed-stop handling as
an end-to-end release capability.

### Next UI slice: retry the original cleanup only (proposed)

Do not replay the generic interrupt endpoint: it stops whichever dispatch is now
current and cancels queues across all the bot's tasks. A local busy/thread check
cannot protect against another tab starting a newer turn on the same thread.
Issue an owner-bound failed-stop receipt for the original dispatch generation.
Invalidate it at every later start, and retry only the original queue cleanup;
the retry must never invoke the provider interruption method. Missing or stale
receipts must direct the user to inspect current work rather than offer a stale
Stop action. This server receipt and endpoint are not implemented in Loop78.

Keep recovery separately from the six-second shared error message, scoped by
account and bot. ChatView must show an accessible alert and named retry action
after idle. Both initial Stop controls share a synchronous pending lock. Fence
late responses on sign-out/unmount, and test task changes, duplicate clicks,
failed retry, successful cleanup and stale receipt refusal in owned HTTP/browser
fixtures. Do not claim refresh restoration until its chosen persistence behavior
is implemented and tested.

### Remaining runtime acceptance recipe (proposed, not executed)

Reuse the owned HTTP fixture with blocked outbound access and private credential
receipts. Keep all accounts, processes, data and ports disposable.

1. **Owner merge:** as the last case, register a second synthetic account and use
   its real `/api/account/merge/start` token. With the original cookie, hold an ask
   behind approval and complete the merge. Assert source/old-token refusal,
   dismissed card, persisted new ownership and no target prompt or exchange mirror.
   Read back with the surviving account. This transfers every source-owned bot;
   it does not isolate a recipient-only owner change.
2. **Queued restart:** queue through an actually injected credential while the
   source provider is held. Capture the accepted row without changing its bytes.
   Crash only the positively identified fixture server, stop its exact owned CLI
   children and verify ports closed before restarting the same disposable data.
   Graceful shutdown is insufficient because it may complete the source first.
   Require a fresh approval card, explicitly allow it, then prove one target prompt,
   no recursive peer integration, durable acknowledgement and old-token refusal.
   This proves that crash schedule, not exactly-once delivery across all failures.
3. **Target setup:** use a fixture-only Claude wrapper that holds only the
   summarization text command and otherwise delegates to the existing fake CLI.
   Seed a valid oversized active transcript so real context construction awaits
   that summary. While the ask is waiting, enable source peer approval, then release
   the summary. Assert refusal, settled busy state and no target `sendTurn`/stream
   receipt. Request mirrors and user text may already exist before setup; do not
   claim their absence. The current Grok ACP fixture has no `generateText` seam.

The original proposal follows for requirement traceability.

Read-only source map, 12 September 2026; proposed implementation, no tests run.

**Current authority:** [index.ts:318–350](../../server/index.ts) creates one `COMMS_TOKEN`, checks it in `authorizedComms`, and injects it through `agentsIntegration`. `startTurn` mounts that integration when the driver supports `agentsMcp`, another visible bot exists and depth permits. The [session gate](../../server/index.ts) exempts `/api/internal/`. [Peer routes](../../server/index.ts) therefore trust caller-selected `self`, `fromBotId`, task and depth after a global bearer check. Existing task-membership validation does not authenticate that sender.

[agents-proxy.ts](../../server/drivers/agents-proxy.ts) forwards environment identity into GET list and POST ask/delegate. [ACP core](../../server/drivers/acp/core.ts) mounts it in `session/new`/`session/load`; [Claude](../../server/drivers/claude.ts) writes the integration into owned MCP configuration. No reusable peer capability issuer/registry was found in these paths. Existing request IDs and approval grants are consent state, not caller credentials. `connectedAppsIntegration` also passes the boot bearer into [composio.ts](../../server/composio.ts): changing only proxy environment would leave an authority bypass.

**Minimal boundary:** one narrow peer-capability module plus index/proxy wiring. Issue an opaque random token for the exact harness dispatch lease: effective owner, sender bot, source task/thread, driver-session generation, depth, expiry and the three peer operations. Derive all authority from that registry; remove client identity fields or reject mismatches. All three routes must require it explicitly—never fall back to the boot/connector bearer. Keep loopback enforcement. In hosted mode normalize absent owners to the primary account; local mode retains the installation boundary. Filter listing and validate targets identically, before busy/name disclosure. Recheck ownership, task existence and lease after approval/setup awaits and before execution/mirroring.

Revoke on completion, interrupt, setup failure, watchdog/session exit, deletion or owner change; correlate terminal events to their lease so an old completion cannot retire a newer turn. Preserve detached-task identity rather than requiring the bot's current UI-selected task. Test refreshed injection on provider session resume.

**Queued work:** [delegations.ts](../../server/delegations.ts) persists handoffs and drains after completion/restart. Persist validated sender/owner/task/operation provenance, never the bearer; revoke the live token while retaining the accepted queue record. Revalidate both owners and current consent before every drain and after waits. Legacy records lacking provenance require review/refusal. Persistence failures cannot claim durable acceptance; preserve interruption/discard and duplicate-removal tests. Sender approval in [peer-approval.ts](../../server/peer-approval.ts) is not cross-owner recipient confirmation: continue refusing cross-owner contacts.

**Acceptance:** extend `server/comms.test.ts`, `server/testing/fake-acp-cli.ts`, proxy tests and delegation restart tests. Real offline ACP must exercise list/ask/delegate with genuine injected credentials; forged self/from/task/depth, cross-owner/unowned targets and old tokens yield no disclosure, transcript, queue or provider work. Positive same-owner/primary-fallback flows, denial, held-approval owner change, end-of-turn reuse, resume and restart must pass. No generic auth framework or process-sandbox claim; historical mixed-room cleanup remains separate.
