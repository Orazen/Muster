# AGENT CLAIM — Buffy (Freebuff lane) — 2026-10-03

```txt
AGENT CLAIM

Agent: Buffy / Freebuff lane (sole shared-main Git integration captain)

Task: Docs-vs-code reality reconciliation of the five MVP pillars, recorded as one
      bounded documentation audit. NOT a rebuild, NOT a new architecture, NOT a
      replacement of the existing plan documents.

Goal: The six newly-added process documents describe a build order that the
      repository has already overtaken. Establish, from cited evidence, which of
      "Login -> Drive -> Chat -> Memory -> Sessions -> Tasks -> Restore" is
      already implemented and gated, and record it once so the next agent does
      not rebuild finished work or read a green document as a finished product.
      Supports the CTO rule that work must serve login, Drive sync, chat, memory,
      sessions, tasks or restore.

Branch: task/docs-reality-reconciliation (from origin/main 3067009)

Files I plan to touch:
- docs/plans/Muster_MVP_Master_Plan_RECONCILIATION_2026-10-03.md   (NEW, mine)
- docs/plans/agent-claims/2026-10-03-buffy-docs-reality-reconciliation.md (this claim)

Files I will not touch:
- docs/ACTIVE_DOCS.md
- docs/AGENT_COMMUNICATION.md
- docs/plans/Muster_MVP_Master_Plan.md
- docs/plans/Muster_Sub_Agent_Assignments.md
- docs/plans/Muster_Sub_Agent_Operating_Loop.md
- docs/plans/Muster_Future_Roadmap_And_Competitor_Research.md
- AGENTS.md, docs/AGENT-ORIENTATION.md
- server/**, src/**, electron/**, companion/**, macos/**, ios/**,
  cloudflare/** (all product code)
- .deploy-trigger, release/signing settings, repository visibility
- docs/plans/handoff-next-agent.md, docs/plans/astra-handoff-2026-09-19.md
- PR #32 and the codex/cue-restore-process-restart branch (Cue's)
- Any other agent's claimed paths

Expected output:
- One new document recording, per MVP pillar: implemented / partially
  implemented / unevidenced, each row citing a real path verified on
  origin/main.
- An explicit list of what remains genuinely unevidenced.
- Explicit non-claims: no security claim, no beta-readiness claim, no claim
  that documented behaviour works on a real device or in a user's Drive.

Verification planned:
- Every "implemented" row cites a path verified to exist on origin/main via
  git cat-file / git ls-tree, not from memory.
- Docs-only change, so per the operating loop section 6 the verification is:
  correct links/paths, logical rendering, and an explicit no-secrets check.
- Confirm zero product paths in the commit via git show --name-status.
- No test run is claimed, because no product code changes.

Status:
Claimed
```

## Findings raised BEFORE building, per the loop's scope rule

**1. The documents' build order is already overtaken.** Operating loop section 10
orders `Agent 2: Drive Storage Architecture` first. That architecture exists and
is gated on main — `server/account-drive.ts`, `server/drive-oauth.ts`,
`server/drive-sync.ts`, `server/drive-access.ts`, plus
`server/workspace-bundle-v2.ts`. Claiming it as greenfield would duplicate
accepted work and risk a conflicting rewrite. This is why the claim is a
reconciliation, not an Agent 2 architecture.

**2. The master plan's file layout does not match the code, and one difference
matters for privacy.** Master plan section 3 specifies a visible `Muster/`
folder containing `soul.md`, `memory.json`, `sessions.json`, `tasks.json`,
`settings.json`. The code does not do this:

- `server/drive-oauth.ts` requests `drive.appdata` — Drive's **hidden**
  per-application private space — not a user-visible folder.
- Actual bundle entries are `bots.json`, `groups.json`, `MEMORY.md`,
  `routines.json`, `goals.json`, `decisions.json`, `social.json`
  (`SUBSET_ROOT_FILES`, `server/workspace-bundle-v2.ts:496`), not
  `memory.json` / `sessions.json` / `tasks.json` / `settings.json`.
- `soul.md` exists as `server/soul-md.ts` (122 lines) but is not one of those
  bundle entries.

The appdata choice is **more private** than the plan's visible folder, and it is
deliberate: `server/google-auth.ts:18` keeps sign-in on
`openid email profile` because `drive.appdata` is a RESTRICTED scope and
requesting it at login triggers Google's unverified-app interstitial. I am
recording the divergence; I am not "fixing" the code to match the plan, and I am
not editing the plan.

**3. `sessions.json` in the master plan means CHAT HISTORY, not authentication
sessions.** Master plan section 3 defines it as session id / date / messages /
responses. `server/auth.db` separately holds auth sessions and per-user Drive and
Calendar grants. Conflating them would be a security-design error. Flagged so no
agent builds on the conflation.

**4. "Optional local encryption" conflicts with an accepted requirement.**
Future roadmap section 5 lists local encryption as optional. Accepted work in
this lane treats encrypted backup and credential custody as a requirement. I am
**not** treating the roadmap line as authority to weaken it, and I will not act
on it. This needs an owner decision; recorded, not resolved.

**5. Repo visibility conflict, recorded not acted on.** `AGENTS.md` line 20 calls
the repo private (BSL 1.1); GitHub reports it **public**, and the new documents
ask to make it private. Visibility, release, signing and doc restructuring are
owner decisions outside my lane. Not changed.

## Conflict check

No overlap with OpenCode (native Mac, UI), Cue (mobile, Drive, Watch, PR #32) or
Astra (review, coordination). This claim touches **no product path** and edits
none of the six governing documents — it adds two new files and reconciles
against them. A CONFLICT REPORT will be sent immediately if one appears.

## Note on the communication channel

`docs/AGENT_COMMUNICATION.md` section 2 prefers PR comments, then issue
comments. This repository has **issues disabled** (`gh issue list` →
"the 'Orazen/Muster' repository has disabled issues"), and PR #32 belongs to
another lane, so commenting there would pollute their thread. The claim is
therefore submitted as a committed document on a dedicated task branch, which
is transport-independent and reviewable in the same way. Open PRs #33-#36 are
Dependabot dependency bumps with no agent claim attached.