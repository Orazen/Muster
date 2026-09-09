# Verified slice log

## 2026-09-09 — AGI harness sequence

Full-suite results below are actual Vitest runs before each slice's commit.
Each run had eight skipped tests. Server typecheck passed for each slice.

| Slice | Commit | Full-suite files passed | Tests passed |
| --- | --- | ---: | ---: |
| Ordered plan evidence on approval cards | `c917461` | 174 | 1703 |
| Offline fleet evaluation and durable scorecards | `bd07727` | 175 | 1717 |
| Bounded why-journal and scorecard MCP reads | `5ba9217` | 176 | 1728 |
| Delegation with authenticated receipt context | `8b3a54f` | 177 | 1737 |
| Previous-run why evidence on companion approvals | `527e082` | 178 | 1743 |

Shipped areas: approval cards and thread evidence; fleet evaluation and CLI
bundle; fleet MCP evidence reads and delegation; companion models and iOS/Watch
approval views. Detailed scope and limits are in `plan-rehearsal-v1.md`,
`fleet-eval-playbook.md`, `fleet-evidence-tools.md`,
`fleet-receipt-delegation.md`, and `watch-approval-history.md`.

Companion verification: 91 Swift tests passed, zero failures; unsigned iOS and
Watch simulator builds succeeded. Web and server typechecks passed. Scoped lint
passed; the repository-wide lint run still reported pre-existing failures.

Evidence limits: rehearsal checks ordered tool names from successful prior
runtime evidence, not arguments or current screen state. The evaluator grades
supplied captures and does not independently attest provenance or task quality.
Watch evidence is explicitly from the previous run; this slice adds no new
background push delivery. No live five-step competitor benchmark was performed.

Commercial implication: these slices make fleet behavior inspectable by an
operator and produce repeatable evaluation records. They establish product
capabilities, not evidence of customer demand or measured revenue.

## Loop 1 — 2026-09-09 — Mistral Vibe verification and ownership handoff

Slice: register the eleventh CLI/ACP engine with confirmed session model and
approval mode, and retain prior tool metadata for sparse permission callbacks.
Implementation was included in concurrent commit `6de16e8`; this follow-up adds
the regression tests, config precedence correction, and verification record.
The board assigned sole ownership to Astra. The inherited coordination-rule
edit is reconciled in `AGENTS.md` and `astra-ceo-mandate.md`; there is no longer
an active ZCode handoff dependency.

Shipped files: `server/drivers/acp/vibe.ts`, `tool-context.ts`, `core.ts`,
`vibe.test.ts`, `server/drivers/builtIn.ts`, `server/config.ts`,
`server/config.test.ts`, `server/testing/fake-acp-cli.ts`, and
`docs/plans/engine-parity-vibe.md`.

Verification: 76 focused tests passed across three files; server typecheck and
scoped lint passed. Full suite: 179 files passed, 1757 tests passed, eight skipped,
zero failures (204.25 seconds). This adds 14 tests to the preceding slice.
Production GET checks returned 200 for `/` and 401 for `/api/instances` without
credentials. This confirms public reachability only; the authenticated engine
catalog and a live Vibe turn remain unverified.

Commercial implication: Vibe users can retain their configured model while
joining the same fleet approval workflow. Eleven registered engines is an
inventory count, not live task-quality parity. No paid provider turn was run.

Next pick: audit the end-to-end harness against the five-step evaluation and
record concrete failures; live evaluation remains outstanding.
