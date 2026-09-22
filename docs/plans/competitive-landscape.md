# Competitive landscape — agent-workforce products (September 2026)

**OpenMausBot source re-check: 2026-09-10.** This comparison uses public
v0.1.70 source at commit
[`67336fb2d7139de1b91a8050d9c1ca1215844fea`](https://github.com/milind-soni/OpenMausBot/commit/67336fb2d7139de1b91a8050d9c1ca1215844fea)
(commit timestamp: 2026-09-10 04:13:31 +05:30). It is a read-only source
audit of that snapshot, not an all-branches audit or a runtime benchmark:
**0 competitor executable tests and 0 competitor runtime checks**. The
version is recorded in its
[`package.json`](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/package.json).

The Grok Bot and OpenClaw sections retain earlier strategy hypotheses; they
were not independently refreshed during this UI slice. See also
[openmausbot-design-study.md](openmausbot-design-study.md) and
[robotics-and-ecosystem-research.md](robotics-and-ecosystem-research.md).

## The three that matter

### 1. OpenMausBot — the direct comparison

OpenMausBot describes a local-first **team of bots**, with per-bot models,
channels, connected apps, computer access, and human approval cards. Its
current source includes iOS and Android companions, phone pairing, and
delegation/routine receipts. The earlier claims that it was a single agent,
lacked a mobile approval surface, or had no receipts were incorrect as
blanket comparisons and are withdrawn. These capabilities may predate this
release; this audit does not establish when each was introduced.

Primary evidence:

- [README: bot roster, channels, MCP, and phone access](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/README.md).
- [iOS roster and approval navigation](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/ios/App/ChatListView.swift)
  and [Android onboarding/navigation](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/android/app/src/main/kotlin/com/openmausbot/companion/ui/RootScreen.kt).
- [Delegation receipt tests](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/server/delegations.test.ts)
  and [routine execution cards](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/ChatView.tsx).

**Muster capabilities to evaluate, without assuming exclusive ownership:**

- A persistent fleet with per-bot engines, budgets, tasks, and memory.
- OptionCard approvals, approval history, and phone/Watch delivery.
- Task receipts, why-journal entries, routine scorecards, and plan rehearsal.
- An eleven-tool Fleet MCP surface that excludes approval grants, deletes,
  credentials, and engine changes (`server/fleet-mcp.ts`). OpenMausBot also
  documents a bounded MCP surface, with a different and broader set of team
  operations; tool count alone does not establish product quality. Muster's
  original six tools have since gained read-only why-journal, scorecard and
  session-discovery access; the count here was checked against
  `server/fleet-mcp.ts` (eleven as of 2026-09-22).
- Local execution and device pairing. These are shared category capabilities;
  compare setup effort, failure recovery, and the resulting evidence.

**Source-grounded UX patterns worth testing in Muster:**

1. **Responsive conversation controls and pickers.** OpenMausBot's
   [chat header](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/ChatView.tsx)
   compacts controls using the chat column's width. Test mobile widths and
   desktop layouts with side panels open, not only full-width desktop.
2. **Task-specific attention.** Its
   [sidebar activity rows](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/SidebarBotActivity.tsx)
   and [background activity picker](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/TaskPicker.tsx)
   keep waiting, working, queued, and unread sibling tasks accessible even
   when history is hidden. Muster's approval navigation must open the exact
   task, including when another task on that bot is selected.
3. **Optional phone handoff.** Its
   [onboarding](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/Onboarding.tsx)
   includes optional phone setup; the
   [terminal setup guide](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/docs/cli-onboarding.md)
   distinguishes product identity, AI-provider access, and device pairing.
   Preserve Muster's first-task onboarding and make the subsequent phone
   handoff discoverable, skippable, and recoverable.

Engine breadth and installation friction still deserve a comparison, but
the earlier fixed engine-count and "zero-config" advantage claims are not
current measurements. Compare available models and completed first tasks on
the same machine with the same credentials. Repository popularity is not a
completion or reliability benchmark.

### 2. xAI Grok Bot — distribution hypothesis

Earlier research treated hosted bots, subscriptions, and routine learning as
a distribution threat. This UI audit did not re-check its current offering,
pricing, local modes, approval surfaces, or transcript handling. Do not turn
those historical assumptions into present-tense feature-absence claims.

Muster's strategy remains to make local operation, explicit execution
location, human approvals, evidence, and per-bot economics understandable in
the product. Whether those features differentiate it from a specific Grok
Bot offering requires a dated, like-for-like evaluation.

### 3. OpenClaw — interoperability hypothesis

Earlier research identified persona-format interoperability as strategically
useful. Muster already reads/writes SOUL.md per bot
(`GET/PUT /api/bots/{id}/soul.md`). Preserve that interoperability and assess
actual import fidelity and behavior. This audit makes no fresh claim about
OpenClaw's popularity or the depth of its current harness.

## Product principles to test across the landscape

1. **Bounded control surfaces.** Document what an external agent can and
   cannot do, then verify the contract. A small tool list is useful only if
   it supports the intended workflow and handles failures honestly.
2. **An understandable approval moment.** Show the action, the evidence,
   and its scope; deliver the decision to the intended person and task.
   The benefit must be demonstrated, not assumed exclusive to Muster.
3. **Visible fleet economics.** Per-bot routing and usage should help an
   owner choose engines and budgets with enough context to act.
4. **Evidence after work.** Compare receipt completeness, why-journal
   usefulness, and approval history on the same tasks. A competitor having
   receipts does not establish identical semantics, or inferior semantics.
5. **Clear execution location.** Explain local/cloud capabilities and
   prerequisites accurately at the point of use.

## Exposures to fix next

Current UI audit priorities are the three UX gaps above. The broader
engineering watch list remains:

1. **Mimosa full security re-run** still owed after the scanner_enobufs
   failure. Confirm scanner availability; no security posture claim follows
   from this UI work.
2. **Dependabot triage:** the prior record listed two high alerts. Re-check
   current alerts before reporting a count or remediation status.
3. **Engine access and parity:** compare driver availability, authentication,
   and successful task execution; add integrations based on demonstrated need.
4. **Guided first run:** measure setup-to-first-result, then optional phone
   pairing. Do not require a new user to understand the harness architecture.

## What a credible comparison means

Run the same bounded task and approval/failure probes on both products with
recorded versions, engines, credentials, and environment. Measure completion,
correct escalation, receipt/evidence completeness, tokens/cost, recovery,
and mobile decision usability. Distinguish offline fixtures from live runs.

Muster's existing eval harness can report its own outcomes. It does not prove
that another product stalls, auto-approves, or performs worse. Comparative
claims remain unverified until the matching competitor runs are recorded.
