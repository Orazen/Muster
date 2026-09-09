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

## Loop 2 — 2026-09-09 — Preserve approval and liveness states in fleet waits

Audit findings: **P1** `wait_for_conversation` returned `working` for real human
approvals because the store derives `busy: true` for `waiting-on-you`. **P2** the
same ordering hid `no-signal` as `working`. Both were reproduced through the MCP
protocol; the previous approval fixture covered an idle bot only.

Fix: prioritize explicit dead, waiting, and no-signal states before the generic
busy fallback. A pending approval returns `needs-user` on the first observation,
even when its card falls outside the transcript excerpt; no-signal returns
`stalled`. Existing idle-card and actively-working behavior remains covered.

Shipped files: `server/fleet-mcp.ts`, `server/fleet-mcp.test.ts`, and this log.
Four new regressions cover store-generated busy states, missing card excerpts,
and a working-to-waiting transition. No approval is answered by the waiter.
Before the fix: four targeted failures (`working` instead of `needs-user` or
`stalled`). Final scoped run: 24 tests passed, zero failures. Server typecheck
passed. Full suite: 179 files passed, 1761 tests passed, eight skipped, zero
failures (175.76 seconds). Independent diff review found no actionable issues.

Open **P3** audit item: scoped oxlint reports 18 pre-existing findings in the
fleet MCP module and its tests (unparsed boundary types, unchecked assertions,
and object-construction rules). The reported lines are outside this state-order
change; lint is not recorded as passing. The broader lint debt remains open.

Commercial implication: external fleet operators can surface human approvals
and liveness interruptions promptly instead of spending the full wait window
polling. This is a correctness improvement, not measured revenue uplift.

Next pick, confirmed **P2**: `scoreFleetCapture` checks receipt start time but
ignores its duration. A capture ending at 10:01 with a receipt starting at
10:00:01 and lasting one hour incorrectly passes and exposes receipt metrics.
The next slice must reject a derived receipt end after the capture (including
non-finite sums) and retain the exact-end boundary. This is internal timing
consistency, separate from the documented limits on provenance.

Hourly continuation is active in the current task under the standing mandate;
paid activation and other board-level actions remain gated.

## Loop 3 — 2026-09-10 — Use and improve the account entry experience

The board requested hands-on use of the live app and a UI improvement. The live
landing-to-app flow reached sign-in; the existing Google tab still awaited user
authentication. This slice covers sign-in, signup, and recovery. Authenticated
fleet use remains unverified; no production account or provider session was changed.

Findings fixed: **P2** the auth surface could clip content on short screens
because the surrounding app disables body scrolling; **P2** signup advertised
eight characters while the server requires twelve; **P2** desktop OAuth support
was dropped while loading capabilities. Also restored the capability-gated
password recovery link, persistent input labels, readable account/error text,
password visibility controls, and keyboard submission of the separate pairing
form. Return destinations now remain local after URL normalization, including
the dot-segment edge case caught during review.

The visual update uses a warm two-column workspace introduction on desktop and
a focused single-column form on mobile. The illustration is decorative and
contains no invented activity, customer metrics, or benchmark results. Operator
environment-variable instructions were removed from customer-facing entry forms.

Shipped areas: `AuthShell.tsx`, scoped `auth.css`, `AuthPasswordField.tsx`, the
four auth pages, `src/lib/auth.tsx`, `auth-navigation.ts`, and two regression test
files. Google account selection, referral redemption, and approval ownership
retain their existing behavior.

Verification: 13 hands-on browser checks passed against a disposable local API
fixture: show/hide password, Enter-to-sign-in with error feedback, recovery
confirmation, 390px layout, short-password rejection, 320px scrolling, desktop
capability hydration, unavailable recovery, Enter-to-pair, missing-token
recovery, mismatched reset passwords, and keyboard reset submission with error
feedback. Fixture logs contain method/path only; no real email or account was
created. Focused tests: **2 files / 27 passed / 0 skipped**. Final full suite:
**181 files / 1788 passed / 8 skipped**, 183.62 seconds, after the final redirect
correction. This exceeds the handbook baseline of 172 files / 1689 passed / 8 skipped.
Both typechecks, scoped lint, and the Vite production build passed. Vite still
reports large chunks; this slice makes no bundle-size improvement claim.

Commercial implication: account entry now explains the product, keeps controls
readable and reachable on phones, and exposes available recovery paths. No
conversion improvement is claimed without usage data.

Next pick: resume the confirmed receipt-timing audit defect from Loop 2; review
the authenticated fleet UI when a user session is available. The board's UI
request took priority for this cycle.

Release follow-up: UI commit `3ee3a9d` was pushed. GitHub CI and autodeploy
failed before running any steps; their annotations report failed account
payments or a spending limit. The local test numbers above remain the verified
results. Board action is needed to restore hosted Actions billing. Used the
existing `.deploy-trigger` mechanism documented in the autodeploy workflow to
request the same release through Dokploy's GitHub App webhook. Production was
still serving the previous UI when the fallback trigger was requested; live
rollout confirmation remains pending. No billing settings were changed.
