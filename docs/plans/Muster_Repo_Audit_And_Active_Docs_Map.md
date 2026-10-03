# Muster Repo Audit And Active Docs Map

Date: 2026-10-03

This audit organizes the Muster repository documentation before the next implementation phase.

## 1. Executive Summary

The repository already has a strong product/codebase foundation, but the documentation is crowded with historical plans, large ledgers, research notes, release notes, and new MVP planning documents.

The immediate goal is not to delete or rewrite history. The immediate goal is to define which documents are active, which are historical, and which documents agents must read first.

## 2. Current Finding

The repo currently contains:

- Core app code for web, server, Electron, CLI, and companion clients
- A large `docs/plans/` folder with many planning documents
- Existing orientation docs for agents
- New Muster MVP documents created on 2026-10-03
- README that describes the existing product as an AI teammate workspace
- AGENTS.md that says the repo is private

Important mismatch:

GitHub metadata currently shows `Orazen/Muster` as public, while `AGENTS.md` says the repo is private.

Decision needed:

**Make the repository private before serious product development, or update docs to match the public status.**

## 3. Active Documents

These documents should be treated as active from now:

| Priority | Document | Purpose |
| --- | --- | --- |
| 1 | `docs/plans/Muster_MVP_Master_Plan.md` | Current founder MVP plan |
| 2 | `docs/plans/Muster_Sub_Agent_Assignments.md` | Sub-agent tasks and reporting rules |
| 3 | `docs/plans/Muster_Future_Roadmap_And_Competitor_Research.md` | Future roadmap and competitor direction |
| 4 | `docs/AGENT-ORIENTATION.md` | Existing agent orientation and verification rules |
| 5 | `AGENTS.md` | Existing repository agent rules |
| 6 | `README.md` | Product entry point |
| 7 | `docs/plans/current-state.md` | Existing status of record |
| 8 | `docs/plans/ceo-log.md` | Existing loop ledger |

## 4. Recommended Read Order For New Agents

New agents should read in this order:

1. `docs/plans/Muster_MVP_Master_Plan.md`
2. `docs/plans/Muster_Sub_Agent_Assignments.md`
3. `docs/plans/Muster_Future_Roadmap_And_Competitor_Research.md`
4. `docs/AGENT-ORIENTATION.md`
5. `AGENTS.md`
6. Task-specific docs only if needed

Why:

The new MVP docs define Tharun's current product direction. The existing orientation docs define repo safety, verification, and engineering rules.

## 5. Recommended Folder Structure

Target structure:

```txt
docs/
  AGENT-ORIENTATION.md
  ACTIVE_DOCS.md
  guides/
  plans/
    current/
      Muster_MVP_Master_Plan.md
      Muster_Sub_Agent_Assignments.md
      Muster_Future_Roadmap_And_Competitor_Research.md
      Muster_Repo_Audit_And_Active_Docs_Map.md
    archive/
      old-roadmaps/
      old-audits/
      old-research/
  research/
  releases/
  screenshots/
```

Do not move files yet without a second cleanup commit. First commit this audit and let agents align on it.

## 6. Archive Candidates

The following categories should become archive candidates after review:

- Older AGI roadmap drafts
- Old competitor studies superseded by the new future roadmap
- Old release/cross-platform reports that are not current status
- One-off research notes
- Bug reports that have been closed or superseded
- Historical handoff docs that are not the latest source of truth

Examples from `docs/plans/` that likely need classification:

- `agi-generation-master-plan.md`
- `agi-os-eco-platform.md`
- `agi-os-frontier-v2.md`
- `agent-harness-upgrades.md`
- `agent-harness-upgrades-v2.md`
- `agent-social-ecosystem-plan-2026-09-14.md`
- `astra-*`
- `openmausbot-*`
- `openmuse-*`
- `pocketctrl-integration-study.md`
- `tiptour-integration-study.md`
- `bug-report-2026-09-26.md`

These should not be deleted immediately. They may contain useful historical context.

## 7. Keep As Load-Bearing

Do not archive or rewrite these without reading them carefully:

- `docs/plans/current-state.md`
- `docs/plans/ceo-log.md`
- `docs/guides/web-app-stability.md`
- `docs/release-mirror.md`
- `docs/release-runbook.md`
- `docs/plans/remaining-work-plan-2026-09-16.md`
- `docs/plans/portable-backup-contract-2026-09-12.md`
- `docs/AGENT-ORIENTATION.md`
- `AGENTS.md`

These appear to be operational documents, not only ideas.

## 8. README Recommendation

README should eventually be updated with a small “Current Planning Docs” section:

```md
## Current Planning Docs

- [Muster MVP Master Plan](docs/plans/Muster_MVP_Master_Plan.md)
- [Sub-Agent Assignments](docs/plans/Muster_Sub_Agent_Assignments.md)
- [Future Roadmap And Competitor Research](docs/plans/Muster_Future_Roadmap_And_Competitor_Research.md)
- [Repo Audit And Active Docs Map](docs/plans/Muster_Repo_Audit_And_Active_Docs_Map.md)
```

Do not rewrite the full README yet. It contains product and operational details that may still be valid.

## 9. Privacy Recommendation

Before serious development:

1. Make repo private if the product is not ready for public visibility.
2. Keep credentials out of commits.
3. Avoid public exposure of unfinished architecture.
4. Keep public marketing separate from private product planning.

Current blocker:

No safe repo settings update is performed in this audit. The owner should confirm the repository privacy decision before changing visibility.

## 10. Cleanup Execution Plan

### Step 1: Commit Audit

Commit this audit file.

### Step 2: Add ACTIVE_DOCS

Create `docs/ACTIVE_DOCS.md` as the short index for humans and agents.

### Step 3: Update README

Add a short planning-docs section only.

### Step 4: Classify Old Docs

Create an archive classification table before moving anything.

### Step 5: Move Historical Docs

Move old docs into archive folders only after classification.

### Step 6: Start MVP Build

Begin implementation only after docs are aligned.

## 11. CTO Decision

Do not delete documents now.

Do not mass-move documents now.

First create the active docs map, then decide privacy, then clean the README, then classify archives.

The project should stay focused:

**MVP first: login, Google Drive sync, chat, memory, sessions, tasks, restore.**
