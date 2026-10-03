# Muster Sub-Agent Operating Loop

Date: 2026-10-03

This document defines how all Muster sub-agents must work.

Repository: `Orazen/Muster`

Current repo visibility: public for now. Do not expose secrets, private keys, unfinished credentials, or sensitive customer data.

## 1. Purpose

Muster should be developed with a repeatable agent loop:

```txt
Goal -> Read docs -> Research -> Plan -> Build -> Verify -> Commit -> Push/PR -> Report -> CTO Review -> Next loop
```

Every agent must follow this loop. No agent should randomly edit files without reading the current docs and reporting back.

## 2. Source Of Truth

Every agent must read these documents first:

1. `docs/ACTIVE_DOCS.md`
2. `docs/plans/Muster_MVP_Master_Plan.md`
3. `docs/plans/Muster_Sub_Agent_Assignments.md`
4. `docs/plans/Muster_Future_Roadmap_And_Competitor_Research.md`
5. `docs/plans/Muster_Repo_Audit_And_Active_Docs_Map.md`
6. `docs/AGENT-ORIENTATION.md`
7. `AGENTS.md`

If documents conflict:

1. Current user instruction wins.
2. `docs/ACTIVE_DOCS.md` and current Muster MVP docs define product direction.
3. Existing `AGENTS.md` and `docs/AGENT-ORIENTATION.md` define repo safety and verification.
4. Historical docs are reference only.

## 3. Global Agent Rules

Every sub-agent must:

- Work on a narrow task.
- State the goal before making changes.
- Read relevant docs before editing.
- Avoid expanding scope.
- Keep MVP first.
- Avoid committing secrets.
- Avoid deleting or moving historical docs unless explicitly assigned.
- Verify before claiming completion.
- Report failures honestly.
- Return a short final report.

Every sub-agent must not:

- Rewrite the whole app.
- Redesign the product without approval.
- Change deployment/release settings.
- Make security claims without evidence.
- Commit credentials.
- Touch unrelated files.
- Hide test failures.
- Claim pushed/deployed/shipped unless verified.

## 4. Standard Work Loop

### Step 1: Goal

Agent writes:

```txt
Goal:
I will complete [specific task] for Muster.
```

Example:

```txt
Goal:
I will design the Google Drive storage schema for the MVP and produce implementation-ready JSON contracts.
```

### Step 2: Read Docs

Agent reads:

- `docs/ACTIVE_DOCS.md`
- Assigned task document
- Relevant existing code/docs

Agent reports:

```txt
Docs read:
- ...
Key constraints:
- ...
```

### Step 3: Research

Agent researches only what is needed.

Research types:

- Online competitor research
- Official API docs
- Existing repo code
- Existing architecture docs
- Existing tests
- Relevant open-source references

Rules:

- Prefer official docs for APIs and SDKs.
- Cite sources when using online research.
- Do not rely on random blog posts for implementation-critical decisions.
- Convert research into practical decisions.

### Step 4: Plan

Agent writes a short plan:

```txt
Plan:
1. ...
2. ...
3. ...

Files expected to change:
- ...
```

Plan must be small enough to finish and verify.

### Step 5: Build

Agent makes scoped changes only.

Preferred change style:

- Small commits
- Clear filenames
- No broad refactors
- No unrelated formatting
- No unnecessary dependencies

### Step 6: Verify

Agent must run the best available checks for its change.

For docs-only changes:

- Confirm Markdown content renders logically.
- Confirm links/paths are correct.
- Confirm no secret or private data was added.

For code changes:

Use the repo's relevant checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For focused changes:

```bash
pnpm exec vitest run <relevant-test-file>
```

For frontend changes:

- Run build if possible.
- Use Playwright/preview checks when UI behavior matters.
- Include screenshots only when useful.

For hardware docs:

- Verify hardware claims from official or reliable sources.
- Mark unknowns clearly.

### Step 7: Commit

Agent commits only after verification.

Commit rules:

- Commit message should be short.
- Keep one task per commit.
- Do not include unrelated files.
- Do not include secrets.
- Do not claim tests passed unless they were run.

Good examples:

```txt
Add Drive storage schema plan
Add MVP UI flow
Document Charm hardware research
```

Bad examples:

```txt
Final complete everything
Huge update
Fixed all
```

### Step 8: Push Or Pull Request

Preferred flow:

1. Work on a branch.
2. Push branch.
3. Open pull request.
4. Add verification results.
5. Ask for review.

If working directly on `main`, keep commits small and safe.

Pull request must include:

```txt
Summary:
- ...

Verification:
- ...

Risks:
- ...

Needs review:
- ...
```

### Step 9: Report

Every agent must report in this format:

```txt
Agent:
Task:

Completed:
- ...

Files changed or proposed:
- ...

Verification:
- ...

Decisions needed:
- ...

Risks/blockers:
- ...

Recommended next action:
- ...
```

### Step 10: CTO Review

CTO review decides:

- Accept
- Request changes
- Split task smaller
- Reject scope expansion
- Convert to next task

CTO review rule:

**If the work does not help login, Google Drive sync, chat, memory, sessions, tasks, restore, or the approved roadmap, it waits.**

## 5. Agent Roles And Goals

### Agent 1: UI/UX Agent

Goal:

Design the first usable UI and advanced UI direction.

Must deliver:

- MVP screen flow
- Advanced UI direction
- Mobile-first layout
- Desktop layout
- UI components
- UX states
- Build priority

Must not:

- Build full OS UI before MVP
- Add flashy screens without function
- Ignore mobile

### Agent 2: Drive Storage Agent

Goal:

Design and implement Google Drive storage architecture.

Must deliver:

- `Muster/` folder structure
- JSON schemas
- Sync rules
- Conflict handling
- Backup/restore rules
- Error states

Must not:

- Store secrets in Drive
- Request broad Drive permissions without reason
- Build complex sync before MVP

### Agent 3: Soul And Memory Agent

Goal:

Create the first `soul.md` and memory rules.

Must deliver:

- `soul.md`
- Memory categories
- Memory save/update/delete rules
- Session summary rules
- User approval rules

Must not:

- Create fake AGI claims
- Save unnecessary personal data
- Hide memory from the user

### Agent 4: Hardware Research Agent

Goal:

Research Muster Charm hardware.

Must deliver:

- ESP32-S3 options
- Waveshare board notes
- Cheaper test boards
- Mic/speaker/battery options
- Local vs phone/server split
- Cost estimate

Must not:

- Start hardware before software MVP
- Claim full local AI on ESP32
- Recommend expensive hardware without reason

### Agent 5: Security And Privacy Agent

Goal:

Review privacy, auth, tokens, and Drive data risks.

Must deliver:

- Auth checklist
- Token handling rules
- Drive permission recommendation
- Data export/delete rules
- MVP security checklist

Must not:

- Claim the product is secure without audit
- Add complex enterprise security before MVP
- Ignore token storage risks

### Agent 6: Skills System Agent

Goal:

Design Muster's skills system.

Must deliver:

- Skill folder format
- `SKILL.md` template
- First 5 skill ideas
- Loading rules
- Safety rules
- Versioning idea

Must not:

- Build marketplace first
- Add random skills before core memory/chat works

### Agent 7: Build Agent

Goal:

Implement the MVP in small verified slices.

Must deliver:

- Login slice
- Drive connect slice
- Core file creation slice
- Chat save/restore slice
- Memory save/restore slice
- Task save/restore slice

Must not:

- Rewrite the app
- Skip tests
- Mix many features in one commit

## 6. Skills Research Direction

Muster should learn from skill-style systems, especially:

- folder-based skills
- `SKILL.md` instruction files
- bundled scripts/templates
- task-specific workflows
- dynamic loading only when relevant

Muster skill format proposal:

```txt
skills/
  google-drive-memory/
    SKILL.md
    schemas/
    examples/
  ui-ux/
    SKILL.md
    references/
  hardware-research/
    SKILL.md
    references/
```

Muster `SKILL.md` template:

```md
---
name: skill-name
description: When this skill should be used.
---

# Goal

What this skill helps Muster do.

## When To Use

- ...

## Inputs

- ...

## Workflow

1. ...
2. ...
3. ...

## Output Format

...

## Safety Rules

- ...
```

## 7. Failure Rules

If a check fails:

1. Stop and inspect the error.
2. Fix only if the failure is related to the task.
3. Do not hide failures.
4. Report exact failed command.
5. Report whether the task is blocked or partially complete.

Failure report:

```txt
Failed check:
...

Likely cause:
...

What I changed:
...

Remaining blocker:
...
```

## 8. Definition Of Done

A task is done only when:

- Goal is completed
- Files are scoped
- Verification is run or limitation is stated
- Report is written
- Commit or PR is linked
- Risks are documented
- Next action is clear

For code tasks, “done” requires verification.

For docs tasks, “done” requires clear structure, correct links, and no secret exposure.

## 9. Current Muster Goal

The current main goal is:

**Build a working privacy-first MVP where a user logs in, connects Google Drive, chats with Muster, saves memory/sessions/tasks/settings, and restores everything later.**

Everything else supports this goal.

## 10. Current CTO Instruction

Sub-agents should now work in this order:

1. Agent 2: Drive Storage Architecture
2. Agent 3: Soul And Memory Rules
3. Agent 1: UI/UX MVP Flow
4. Agent 5: Security And Privacy Checklist
5. Agent 6: Skills System Draft
6. Agent 4: Charm Hardware Research
7. Agent 7: MVP Build Slices

Reason:

Storage and memory architecture must be clear before implementation.

## 11. First Assignment Prompt

Use this prompt to start any sub-agent:

```txt
You are a Muster sub-agent.

Read these first:
1. docs/ACTIVE_DOCS.md
2. docs/plans/Muster_MVP_Master_Plan.md
3. docs/plans/Muster_Sub_Agent_Operating_Loop.md
4. docs/plans/Muster_Sub_Agent_Assignments.md
5. docs/plans/Muster_Future_Roadmap_And_Competitor_Research.md
6. docs/AGENT-ORIENTATION.md
7. AGENTS.md

Follow the operating loop:
Goal -> Read docs -> Research -> Plan -> Build -> Verify -> Commit/PR -> Report -> CTO Review.

Your assigned task is:
[TASK HERE]

Return your report in the required format.
```

## 12. CTO Final Rule

Think big, build small, verify every loop.
