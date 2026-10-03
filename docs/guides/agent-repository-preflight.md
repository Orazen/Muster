# Repository-first startup and audit handoffs

The Muster repository is **https://github.com/Orazen/Muster**. Instructions may
have changed since a local checkout was created. Check the repository before
asking the owner to attach documents or choosing another task.

## 1. Identify and refresh the checkout

In an existing checkout, inspect:

```sh
git remote -v
git status --short --branch
```

Confirm that **origin's fetch and push URLs** identify `Orazen/Muster` on GitHub;
HTTPS and SSH remotes are both valid. A correct `upstream` does not establish
that `origin` is correct. If origin identifies another repository, stop and
locate the correct checkout. Do not rewrite its remote or search unrelated
home/temp directories. Once confirmed, fetch without changing working files:

```sh
git fetch origin
```

If no checkout is available, clone into an available, intended project location:

```sh
git clone https://github.com/Orazen/Muster.git
cd Muster
```

After fetching or cloning, capture the document revision once:

```sh
git rev-parse HEAD
muster_docs_revision=$(git rev-parse origin/main)
printf '%s\n' "$muster_docs_revision"
```

Record the local branch, local HEAD and reviewed `origin/main` SHA separately.
Fetching updates remote-tracking references; it does not update local source.
Inspect the working tree before an update. Preserve modified, untracked and
staged files. Never use a blind pull, reset, clean or stash to make a shared
checkout match main.

Use a separate task branch, as directed by the owner. On a clean, exclusively
owned checkout, create it from the reviewed `origin/main`. If the checkout is
shared, dirty or occupied by another task, use an isolated worktree from that
revision. Do not switch another agent's branch. Existing claims and integration
ownership still apply; a task branch does not authorize merging shared main.

## 2. Read the current repository documents

Read `AGENTS.md` if present, then these files from the fetched main revision:

1. [Active documents](../ACTIVE_DOCS.md)
2. [Agent communication](../AGENT_COMMUNICATION.md)
3. [Operating loop](../plans/Muster_Sub_Agent_Operating_Loop.md)
4. [Assignments](../plans/Muster_Sub_Agent_Assignments.md)
5. [MVP master plan](../plans/Muster_MVP_Master_Plan.md)
6. [Future roadmap and research](../plans/Muster_Future_Roadmap_And_Competitor_Research.md)

For example, `git show "${muster_docs_revision}:docs/ACTIVE_DOCS.md"` reads the
pinned version without overwriting local changes. Read every required file at
that same full SHA or from a clean task checkout at that revision. Remote-tracking
refs are shared across worktrees and another fetch can move `origin/main`; do
not resolve it again between document reads. Assess relevant changes before
claiming another task, rather than rereading unchanged material in a loop.

Keep the task checkout's instructions consistent with that revision. If a local
document differs, distinguish an intentional task change from stale content or
another agent's edit. Preserve the latter and report the conflict. Do not copy
remote documents into an old checkout and then commit them as newly authored
work. A clean worktree from the reviewed revision avoids this ambiguity.

If Git is unavailable, read the same files through the GitHub connector or
browser at a pinned commit. If access fails, report the operation, exact error
with credentials redacted, and whether authentication, network access or a
checkout is missing. A local missing-file result is insufficient to claim the
repository lacks a document.

Current owner instructions take precedence over conflicting document templates.
Report scope conflicts before implementation. Preserve the accepted product,
data, sessions and active claims; a roadmap is not evidence that existing work
must be rebuilt or that its acceptance gates have passed.

## 3. Check claims and submit one bounded task

Review available GitHub issues, open PR descriptions, changed files, comments
and reviews. Inspect relevant repository claim records and known local handoffs
as well. For example:

```sh
gh issue list --repo Orazen/Muster --state open --limit 100
gh pr list --repo Orazen/Muster --state open --limit 100
gh pr view PR_NUMBER --repo Orazen/Muster --json files,comments,reviews
```

Replace `PR_NUMBER` with the relevant number. Follow pagination when a listing
reaches its limit. A quiet local folder or an empty public list does not release
another agent's claim or establish that every private task has been discovered.

Before editing, report the repository URL, checkout, reviewed branch/SHA,
required docs found or missing, relevant claims, and the proposed unclaimed task
with its verification plan. Submit **AGENT CLAIM** using the communication
protocol, including exact owned paths and exclusions.

Use the relevant existing PR discussion first. If no relevant PR exists and
issues are disabled, record a scoped claim under `docs/plans/agent-claims/` on
the task branch and publish a draft task PR before implementation. Never post
claims to an unrelated PR. If publication is unavailable, leave an explicit
owner/coordinator handoff with delivery marked pending; do not treat it as an
acknowledged reservation or start overlapping edits. Only publish task-safe
information. Credentials, private receipts and user data stay out of GitHub.

On overlap, send **CONFLICT REPORT** and pause the affected edits. Preserve both
agents' work. Continue only a separately authorized, disjoint task while the
conflict is resolved. Silence does not count as agreement.

## 4. Execute, verify and hand off

Follow the owner's loop:

**Research → Plan → Build → Verify → Commit/PR → Report → Audit → Improve → Next task**

Research only what informs the current decision, using dated primary sources
for technical or competitor claims. Record findings and proposed scope changes
before implementing them. Voice, hardware and broader ecosystem research do not
automatically become new feature assignments.

For code, use the repository's required checks and an independent review of the
actual candidate. For documentation, verify paths, links, logical rendering,
command safety, scope and absence of private data. Report actual commands,
exits, failures, skips and limitations. Do not rerun unchanged accepted suites
without changed inputs, a failure or unresolved evidence.

Commit only the reviewed task changes. The completion report must include what
changed, verification evidence, commit/PR link, blockers, next action and the
next audit assignment. Separate local checks, commit, push, CI, deployment and
real-user acceptance. A push or green CI does not prove an installed app or a
Google Drive restore works. Do not make a blanket security claim.

## 5. Assign the next-day audit

Record an **audit owner**, **due date/time and timezone**, **source revision**,
**scope**, and **handoff location**. Review product fit, concrete security/privacy
risks, simplicity, usefulness, documentation and whether another agent can
continue. Reuse unchanged verified evidence; inspect changes and unresolved
gates instead of repeating all tests automatically.

If scheduling is supported, arrange the audit through the existing coordinator
and record its confirmation. Do not create duplicate schedulers. Otherwise
leave a clearly pending handoff for the owner or another session. A due date is
not proof that a reminder was configured or the reviewer accepted the task.

After auditing, record findings and disposition, then select the next ready
authorized dependency. If none is ready, preserve the exact blocker and wait
for a change. Do not invent work, repeat prompts or claim unobserved activity.
