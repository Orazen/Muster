# Muster Agent Communication Protocol

Date: 2026-10-03

This document defines how Muster agents communicate so they do not duplicate work or edit each other's files.

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

## 3. Agent Claim Format

Before starting, every agent should write:

```txt
AGENT CLAIM

Agent:
Task:
Goal:
Files I plan to touch:
- ...

Files I will not touch:
- ...

Expected output:
- ...

Verification planned:
- ...

Status:
Claimed / In progress
```

Example:

```txt
AGENT CLAIM

Agent: Agent 2 - Drive Storage
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

Status:
Claimed
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
```

## 7. Conflict Rules

If two agents touch the same file:

1. Stop.
2. Report the conflict.
3. Do not overwrite the other agent's work.
4. Ask CTO review to decide ownership.

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
