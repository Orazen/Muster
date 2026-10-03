# Proposal — a discoverable claims channel for Muster agents

Date: 2026-10-03
Author: Buffy (Freebuff lane)
Status: **proposal for review.** Not implemented. Touches no existing document.

## The problem with what I did

My claim is `docs/plans/agent-claims/2026-10-03-buffy-…md`, committed on
`task/docs-reality-reconciliation`. That has three real weaknesses:

1. **It is not discoverable.** Nothing points an agent at that directory. A new
   agent following `docs/AGENT_COMMUNICATION.md` would not know it exists.
2. **It does not establish ownership.** A file on a branch records intent; it
   does not stop another agent from editing the same paths. Two agents can both
   hold "valid" claims and still collide.
3. **It is write-once.** Claims need status changes (claimed → in progress →
   done → abandoned). A committed file on a branch does not update when the
   work finishes, so the directory fills with stale claims that later read as
   current.

Astra's PR #38 independently lands a claim at
`docs/plans/agent-claims/2026-10-03-astra-repository-preflight.md`, which
confirms the directory is becoming a convention. Good — but it is emerging by
convention rather than by decision, and #38 also touches
`docs/AGENT_COMMUNICATION.md`, which I have not touched.

## What already exists, and why it is not enough

| Mechanism | State | Why insufficient |
| --- | --- | --- |
| GitHub Issues | **disabled** on this repo | Cannot be the channel |
| PR descriptions | working (#32, #35–#38) | Per-PR, no central index; a claim with no code has no natural PR |
| `docs/plans/agent-claims/` | emerging (#38 + mine) | Undiscoverable, write-once, no status lifecycle |
| Shared mailbox (`.omb-scratch/…/messages/`) | working locally | Not in the repo; invisible to a fresh clone or a GitHub-only agent |

## Options

**Option 1 — keep `docs/plans/agent-claims/`, add an index.**
Add `docs/plans/agent-claims/INDEX.md` listing claims, owners, paths and status;
require updating the index line when a claim changes state.
*Pros:* smallest change, fits Astra's #38. *Cons:* still manual; index drifts;
concurrent edits to one index file collide.

**Option 2 — one open PR per claim, labelled, closed on completion.**
A claim is a PR; closing it marks completion; labels carry owner and paths.
*Pros:* uses native GitHub affordances; discoverable via the PR list; status is
the lifecycle. *Cons:* noisy — claims and code PRs compete; the PR list becomes
the board.

**Option 3 — CI-enforced path claims.**
Claims live as JSON in `docs/plans/agent-claims/`; a workflow fails when a PR
touches a path claimed by a different owner.
*Pros:* collision becomes a hard build failure rather than a merge-time
surprise — the strongest form of ownership. *Cons:* most work; needs care with
stale claims; modifies CI, which is outside my lane and needs its own approval.

## Recommendation

**Option 1 now, Option 3 later.**

Option 1 is proportionate: it makes claims discoverable and gives them a status
field, for the cost of one index file. It does not touch CI, does not touch
`docs/AGENT_COMMUNICATION.md` (reserved for Astra in #38), and does not require
enabling Issues.

Option 3 is the only thing that genuinely *enforces* non-overlap rather than
merely announcing it. It should follow once the convention has settled, and it
needs a separate claim and review because it changes CI.

## Suggested index shape

```md
| Date | Agent | Task | Paths claimed | Status |
| --- | --- | --- | --- | --- |
| 2026-10-03 | buffy | MVP pillar reconciliation | docs/plans/Muster_MVP_Master_Plan_RECONCILIATION_2026-10-03.md | done — PR #40 |
| 2026-10-03 | astra | Repository preflight guide | docs/guides/… , docs/AGENT_COMMUNICATION.md | claimed — PR #38 |
```

**Status vocabulary:** `claimed` → `in progress` → `done` → `abandoned`.
An expired claim (owner silent for a defined period) reverts to `abandoned`
rather than blocking the path forever.

## Decision needed

Owner or Astra to choose between the options. **I have not created the index
file and have not modified `docs/AGENT_COMMUNICATION.md`** — implementing this
would touch a path Astra has claimed in #38, which is exactly the collision this
document is meant to prevent.

Until then: treat PR #37, #38 and my PR as the current claim set, and check
`gh pr list` before starting work.