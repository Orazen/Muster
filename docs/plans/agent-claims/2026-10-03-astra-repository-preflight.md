# AGENT CLAIM — Astra — 3 October 2026

Agent: Astra, coordination and independent review.

Claim: C38, scope version 2. The [live register](https://github.com/Orazen/Muster/pull/38#issuecomment-5969823410)
is authoritative for current reservation/work status; this file records scope.

Task: Document repository-first startup, local document synchronization and a
dated audit handoff for Muster agents.

Goal: Agents read current instructions from the correct repository, preserve
local work and check current claims before selecting a task.

Repository: https://github.com/Orazen/Muster

Reviewed base: `origin/main` at
`30670099582476ce31099038c852e022b5685fa9`.

Task branch: `codex/agent-repository-preflight`, explicitly requested by the
owner for this task; shared main is not an editing target.

Files I plan to touch:

- `docs/guides/agent-repository-preflight.md` — new guide.
- `docs/AGENT_COMMUNICATION.md` — link to the guide and audit report fields.
- `docs/plans/agent-claims/2026-10-03-astra-repository-preflight.md` — this claim.
- `docs/plans/agent-claims/INDEX.md` — pointer to the single live register.

Files I will not touch:

- Product source, tests, dependencies, UI and other agents' claimed files.
- Existing MVP plans, repository safety instructions or reconciliation reports.
- Deployment, release, signing and repository settings.

Expected output: a short, actionable startup guide and a reviewable documentation
PR, including evidence and the next audit assignment.

Verification plan: check all six required paths against the fetched base,
validate relative links and documented Git commands, inspect the diff for scope
and private data, and obtain an independent documentation review. No product
test result will be inferred from documentation checks.

Claim check: open PR #32 owns a restore test; #33–36 own dependency manifests.
Their file lists and comments/reviews were checked; none claims these paths.
Other known local claims remain reserved. This is not proof that every agent's
private or unpushed work has been discovered.

Communication: GitHub Issues returned
`the 'Orazen/Muster' repository has disabled issues`. There is no relevant
existing PR to receive this claim. Following the communication protocol's
fallback, this scoped claim is recorded on the task branch before the guide is
edited; its resulting PR will be the task's public discussion channel. Do not
post to unrelated PRs.

Original status: claim published before implementation. Version 2 is accepted
in the live register under the owner's explicit request to establish a register.
[Coordination request to Buffy](https://github.com/Orazen/Muster/pull/39#issuecomment-5969755684)
preceded edits. [Buffy's subsequent scope statement](https://github.com/Orazen/Muster/pull/39#issuecomment-5969765846)
explicitly leaves protocol/index implementation to Astra or the owner and keeps
its work in separate proposal/reconciliation files. This is scope coordination,
not a claim that Buffy reviewed or approved the resulting implementation.

Verification for version 2: validate links and complete scope; manually exercise
new claim, path expansion, competing claim and handoff rules; obtain independent
review of the frozen diff. No product tests are needed for these prose changes.

Next-day audit owner: Astra coordinator.

Audit due: 4 October 2026, 09:00 Europe/Rome. Check repository instructions,
claim overlap, review/CI state and whether another agent can follow the guide.
Scheduling evidence and the completion report belong in the resulting PR;
this due date alone is not evidence that a scheduler has been configured.
