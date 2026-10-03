# Muster Agent Communication Protocol

Date: 2026-10-03

This document defines how Muster agents communicate so they do not duplicate work or edit each other's files.

**Before claiming work, open the [canonical live claims register](https://github.com/Orazen/Muster/pull/38#issuecomment-5969823410).**
It is maintained by Astra and records exact paths, branch/PR, reservation status,
work status, acceptance evidence and handoff. The [repository index](plans/agent-claims/INDEX.md)
points to that same register; it is not a second task board.

Before choosing work, follow the [repository-first startup guide](guides/agent-repository-preflight.md).
Verify the remote, fetch current main, preserve local changes, read the required
documents and inspect GitHub claims. Include the reviewed revision in your claim.
Use a separate task branch under the owner's current instruction; preserve
existing file claims and shared-main integration ownership.

## 1. Core Rule

Every agent must claim a narrow work item before starting.

No two agents should work on the same files at the same time.

If an agent sees another agent already working on a file or task, it must choose a different task or ask for CTO review.

## 2. Preferred GitHub Communication

Use this order when possible:

1. Pull request comments
2. Issue comments
3. Commit messages
4. Repo docs
5. Final report to CTO/user

If GitHub Issues or PR comments are unavailable, use the report format in this document.

Publish a versioned claim in the relevant task PR, then wait for the coordinator's
linked acceptance in the register before editing its implementation paths.
A branch-local claim or published PR is a proposal, not an accepted reservation.
If no task PR exists, a claim-only draft PR may be created first; no product or
shared-protocol implementation belongs in that bootstrap commit.

Only Astra edits the live register. Agents post updates in their own task
discussions. Reservation states are `PROPOSED`, `ACCEPTED`, `CONFLICT`, `RELEASED`
and `WITHDRAWN`; work states are `not-started`, `working`, `blocked`,
`ready-for-review` and `completed`. Do not infer live activity from a posted
handoff. Changing a claim's paths requires a new scope version and acceptance.

## 3. Agent Claim Format

Before starting, every agent should write:

```txt
AGENT CLAIM

Agent:
Claim ID and scope version:
Task:
Goal:
Repository and checkout:
Reviewed branch/commit:
Task branch:
Files I plan to touch:
- ...

Files I will not touch:
- ...

Expected output:
- ...

Verification planned:
- ...

Status:
Reservation state / work state:
Register acceptance or pending handoff:
```

Illustrative proposal, not an actual reservation:

```txt
AGENT CLAIM

Agent: Agent 2 - Drive Storage
Claim ID and scope version: EXAMPLE / 1
Task: Google Drive storage architecture
Goal: Define folder structure, JSON schemas, sync rules, and restore flow.
Files I plan to touch:
- docs/plans/drive-storage-architecture.md

Files I will not touch:
- src/
- server/
- docs/plans/Muster_MVP_Master_Plan.md

Expected output:
- Implementation-ready storage plan
- JSON schemas

Verification planned:
- Check file paths
- Check JSON schema examples
- Check no secrets included

Reservation state / work state: PROPOSED / not-started
Register acceptance or pending handoff: pending coordinator acceptance
```

## 4. Work Update Format

While working, agents should report short updates:

```txt
AGENT UPDATE

Agent:
Task:
Current status:
Completed:
- ...

Next:
- ...

Blocked:
- yes/no

Blocker details:
- ...
```

## 5. Handoff Format

When one agent needs another agent to continue:

```txt
AGENT HANDOFF

From:
To:
Task:
What I completed:
- ...

What remains:
- ...

Files touched:
- ...

Do not touch:
- ...

Recommended next step:
- ...
```

## 6. Completion Report Format

Every finished task must end with:

```txt
AGENT COMPLETION REPORT

Agent:
Task:

Completed:
- ...

Files changed or proposed:
- ...

Verification:
- ...

Commit/PR:
- ...

Decisions needed:
- ...

Risks/blockers:
- ...

Recommended next action:
- ...

Next-day audit:
- Owner:
- Due date/time and timezone:
- Source revision and scope:
- Scheduling confirmation or pending handoff:
```

## 7. Conflict Rules

If proposed or actual scopes overlap, pause edits on the intersecting paths and
publish a CONFLICT REPORT linking both scope versions. Preserve both versions;
unaffected accepted work may continue. Astra marks the conflict in the register
and resolves it with the affected owners by narrowing, sequencing or explicitly
transferring the reservation. Record the disposition permalink before resuming.

A transfer needs the releasing owner's acknowledgement and the recipient's
acceptance. Silence, elapsed time, green CI, PR closure and merge never release
paths automatically. A stale claim stays reserved until explicitly resolved.
Escalate unresolved scope decisions to the owner; do not invent authority.

Conflict report:

```txt
CONFLICT REPORT

Agent:
Conflicting file:
Other agent/task:
My intended change:
Risk:
Recommended resolution:
```

## 8. Communication Quality Rules

Agent communication must be:

- Short
- Specific
- Actionable
- Honest about failures
- Clear about files touched
- Clear about next action

Agent communication must not be:

- Vague
- Overconfident
- Long without decisions
- Missing verification
- Missing file ownership

## 9. Task Board Recommendation

If GitHub Issues are available, create one issue per work item:

- `[Agent 1] UI/UX MVP flow`
- `[Agent 2] Drive storage architecture`
- `[Agent 3] Soul and memory rules`
- `[Agent 4] Charm hardware research`
- `[Agent 5] Security and privacy checklist`
- `[Agent 6] Skills system draft`
- `[Agent 7] MVP build slices`

Each issue should contain:

- Goal
- Files owned
- Deliverables
- Verification checklist
- Report format

## 10. Pull Request Recommendation

Every PR should include:

```txt
Summary:
- ...

Files changed:
- ...

Verification:
- ...

Agent report:
- ...

Risks:
- ...

Needs CTO review:
- yes/no
```

## 11. Current Agent Work Split

Use this split to avoid overlap:

| Agent | Owns | Avoids |
| --- | --- | --- |
| Agent 1 UI/UX | UI flows, wireframes, design docs | Storage schemas, security claims |
| Agent 2 Drive Storage | Drive folders, schemas, sync/restore docs | UI design, hardware |
| Agent 3 Soul/Memory | `soul.md`, memory rules, summaries | Auth implementation, hardware |
| Agent 4 Hardware | Charm research, ESP32 notes | MVP code implementation |
| Agent 5 Security | Auth/privacy/token checklist | Full app redesign |
| Agent 6 Skills | skill format, `SKILL.md` template | Marketplace implementation |
| Agent 7 Build | MVP implementation slices | Broad refactors |

## 12. CTO Rule

If communication is unclear, work stops until the agent clarifies:

- goal
- files touched
- verification
- next action

No unclear work should be merged.
