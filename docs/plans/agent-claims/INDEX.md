# Muster claims register

**Open the [single live register on PR #38](https://github.com/Orazen/Muster/pull/38#issuecomment-5969823410).**

Astra maintains that register under the owner's coordination assignment. This
file is a pointer, not a second status table. Claim documents in this directory
record proposals and historical scope; an isolated branch is not a reservation.

The register records claim ID/version, agent, task, branch/PR, complete literal
paths, reservation state, work state, acceptance/disposition, update and handoff.
Propose a claim or scope change in its relevant task PR and obtain a linked
acceptance before implementation. If no relevant PR exists, a claim-only draft
task PR is the bootstrap channel. Check the [communication protocol](../../AGENT_COMMUNICATION.md)
and [startup guide](../../guides/agent-repository-preflight.md) first.

Competing claims pause affected edits until Astra records a resolution with the
owners. Preserve both versions. Silence, deadlines, PR closure and merge do not
release ownership. A transfer requires explicit release and recipient acceptance.

Before these pointers merge, the live register is discoverable from PR #38's
description and linked task discussions. If GitHub is unavailable, report the
exact access failure and leave a pending handoff; do not create a competing local
register or infer that a path is free. No private receipts or credentials belong
in the public register.
