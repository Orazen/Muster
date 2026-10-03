# Active Muster Documents

## Owner directive — Nova leads coordination (2026-10-03)

Tharun appoints **Nova (Cue/Nova)** as head coordinator, replacing Astra in the coordination role. Nova manages all PR triage, task assignments, accepted path claims, security issue triage, remediation ownership, review gates and audit handoffs. All agents, including Astra, Freebuff and OpenCode, report to Nova.

The canonical live claims register remains [PR #38](https://github.com/Orazen/Muster/pull/38#issuecomment-5969823410). Nova maintains it from this directive onward. Historical Astra acknowledgements and accepted reservations remain evidence; do not rewrite them or treat this role change as automatic release of implementation paths. Astra hands over pending reviews, blockers and audit obligations to Nova and may continue assigned work.

Nova must arrange independent review of Nova's own U34 changes; coordinator authority is not self-approval. Preserve existing scope, offline-test holds and verification requirements until an explicit evidence-backed disposition. Freebuff remains the shared-main integrator under Nova's coordination. No existing merge, deployment, purchase, account-creation or real-data testing hold is lifted by this appointment.

Claims and completion reports must identify agent role, exact paths, branch/PR, reviewed/tested SHA, commands/results, risks and next owner. Shared GitHub login is not agent identity. Silence or elapsed time never releases a claim. Work in isolated task branches/worktrees; preserve others' changes. Nova escalates product/budget decisions to Tharun and reports security findings precisely, without claiming the whole codebase secure.


Date: 2026-10-03

This is the short active-document index for Muster.

## Read First

1. `docs/plans/Muster_MVP_Master_Plan.md`
2. `docs/plans/Muster_Sub_Agent_Assignments.md`
3. `docs/plans/Muster_Sub_Agent_Operating_Loop.md`
4. `docs/AGENT_COMMUNICATION.md`
5. `docs/plans/Muster_Future_Roadmap_And_Competitor_Research.md`
6. `docs/plans/Muster_Repo_Audit_And_Active_Docs_Map.md`
7. `docs/AGENT-ORIENTATION.md`
8. `AGENTS.md`

## Current Build Focus

MVP only:

1. Login
2. Google Drive sync
3. Chat
4. Memory
5. Sessions
6. Tasks
7. Restore

## Current Product Positioning

Muster is a privacy-first personal AI OS with:

- user-owned memory
- Google Drive storage
- task agents
- skills
- voice
- future Charm hardware

## Agent Rule

Every agent must report:

1. What was completed
2. What files were changed or proposed
3. What decisions are needed
4. What risks or blockers exist
5. Recommended next action

## Communication Rule

Every agent must claim a narrow work item before starting.

Every agent must declare:

- task
- files they plan to touch
- files they will not touch
- verification plan
- current status

Use `docs/AGENT_COMMUNICATION.md` for claim, update, handoff, conflict, and completion formats.

## Cleanup Rule

Do not delete or move old docs until the archive classification is approved.

## Privacy Decision Needed

GitHub metadata currently shows the repo as public, while `AGENTS.md` says it is private.

Decision needed:

Make the repo private before serious development, or update docs to match the public state.
