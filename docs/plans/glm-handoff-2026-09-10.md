# Muster execution handoff — 10 September 2026

This is the live handoff for **GLM 5.3 Flash**, as requested by the board.
Read `AGENTS.md`, `astra-ceo-mandate.md`, the latest `ceo-log.md` entry and git
status first. The latest log and commit supersede any historical numbers here.
Continue one verified slice at a time on `main`; do not restart the audit.

## Current direction and evidence

The board selected the orange five-lobed mascot shown in the attached image
and [musterbot](https://musterbot.vercel.app/) as the default Muster identity.
Make setup approachable, show a working approval/evidence loop before signup,
make computer access truthful and recoverable, and turn `/os` into a useful
workspace. A prettier interface or broader provider list does not demonstrate
AGI, universal model capability, competitor superiority or conversion uplift.

Two parallel studies provide source paths and acceptance criteria:

- [Landing reference study](landing-reference-study-2026-09-10.md): x.ai/bot,
  Rakazo, OpenMausBot, Sintra and Vellum. Their strongest reusable pattern is
  an understandable job and an explorable product moment before signup.
- [Computer, OS and native roadmap](computer-os-native-roadmap-2026-09-10.md):
  pinned OpenMausBot `ca61118787f687749eb1251bc3007e4d7d7bdd93` and Rome
  `2f79d9158982851608d97d305984fe7a10ab5b7f`; existing implementation versus
  actual runtime gaps, with native prerequisites and eight bounded slices.
- [UI/E2E program](ui-e2e-program.md): the route/state/device coverage matrix.
- [Astra brief](astra-gpt6-mvp-brief.md), [win plan](muster-win-plan.md) and
  [plan rehearsal](plan-rehearsal-v1.md): harness priorities and benchmark.

At this request's start, main was clean at **f006fa9** and pulled up to date.
Loop 13 passed **192 files / 1964 tests / 8 skipped in 199.09s**, with eight
manual evidence checks and six responsive layouts. Those are historical
results, not tests of the work below. Its approval snapshot remains readable
after Allow/Deny and reload under “Evidence when requested.”

Production GET at 07:43:52 UTC returned `/pair` and its bundle with HTTP 200,
but that marker was absent. Exact-SHA Actions jobs failed before starting
because of the previously escalated account payment/spending-limit issue.
Do not conflate a push, local build or workflow trigger with deployment.
Do not retrigger unchanged failures or repeat the same board notification.

## Budget and continuity

The account usage check at the start of this request showed **24% remaining**
in the weekly Codex window. Reported reset: **16 September 2026, 21:16:18 UTC
(23:16:18 Europe/Rome)**. This is account-wide, not a per-task token balance.
Check current usage before each new slice; never infer remaining allowance
from response length or these historical numbers. Do not consume reset
credits, buy credits, or select another paid service to bypass the limit.

At **1% remaining or less**, stop starting builds/research, finalize this
document with exact git status, active processes, failing commands, latest
verified counts and the next bounded slice; notify the board and pause the
existing `muster-ceo-loop` heartbeat to avoid duplicate work while GLM owns
the checkout. Do not claim that GLM was launched: the board will assign it.
There is no need to spend the remaining allowance artificially.

## Mascot integration contract

Reference source is pinned at **3ce3658a5d6c0aff0f2f03746bb08cb2866b3923** in
[musterbot](https://github.com/tharunramagiri/musterbot/tree/3ce3658a5d6c0aff0f2f03746bb08cb2866b3923).
Read-only clone: `/Users/ramagiritharun/.codex/musterbot-reference-20260910`.
Its `src/bot/skins.ts` constructs a soft five-lobed radial star, and its
animation engine samples time without owning a clock. The app uses Vue;
Muster uses React. Port a narrowly needed behavior, not the full customizer.

Use one shared vector shape, flat `#f08a24` as the brand default, and offwhite
capsule eyes. Keep user-selected teammate colors and explicit alternative
characters. Use the mascot for identity and acknowledgement; retain textual
status, error and approval labels. Static navigation marks must not allocate
animation loops. Motion must stop under reduced-motion settings. Decorative
backgrounds cannot intercept input; an interactive mascot needs keyboard and
touch access. Retain applicable upstream notices; its MIT code license does
not establish ownership of the visual design or trademarks it references.

The first active slice unifies `MusterBloom`, `MusterbotMark` and default
`StarTeammate`, then adds a brief onboarding background entrance and a wave
interaction. Update the completion ledger below only after verification.

Remaining brand surfaces require deliberate export and review:

| Surface | Files / next check |
| --- | --- |
| Public web and favicon | `public/app-icon.svg`, `www/app-icon.svg`, `index.html`, `www/index.html`, PWA manifest/favicon references. Existing icons use a different network-of-agents design. Produce from the canonical vector; verify transparent/light/dark use and favicon legibility. |
| Electron | `electron/resources/app-icon.png` and packaging icon references. Build platform icon sets from the same source; inspect a packaged app before claiming distribution. |
| iPhone and Watch | `ios/App/AgentAvatar.swift`, asset catalogs and Watch views. Keep state semantics and color identity; app icons and in-app avatars have different export requirements. |
| Android | `android-companion/app.json`, its missing icon/splash/adaptive assets and avatar views. Fix source/build prerequisites first; mobile web is not Android verification. |
| Landing / auth / OS | Existing React marks inherit the shared renderer. The separately served `www/` landing does not automatically inherit React component changes. Verify each route's actual entry point. |

## Ordered build queue

Each row is an independent commit with its own scoped ownership, verification
and CEO-log entry. Do not merge all rows into a redesign branch. Prioritize a
newly reproduced functional blocker over decoration, and update this order
when evidence changes.

| Order | Slice / intended boundary | Required acceptance |
| --- | --- | --- |
| 1 | Canonical mascot and onboarding; renderer/wrappers, Onboarding, scoped CSS | Shared body/eyes/default color; custom colors preserved; static marks without JS loops; keyboard/touch wave; reduced motion; onboarding controls reachable at 320/390/768/1440 widths; full signup-to-first-task fixture. |
| 2 | Browser preview truthfulness; `BrowserPanel.tsx` and narrowly related tests | Remove pause/takeover promises unless an actual ownership fence and input transport exist. Navigation, bot/guest profiles, stop/retry and errors still work. Current server boolean is not agent pause. See computer study row 1. |
| 3 | Restore selected bot/room; store hydration and selection helper | Non-first bot and room survive reload, stale/hidden IDs fall back, reconnect preserves current choice, accounts do not share selection, unavailable storage does not crash. Existing approval data is intact; hydration currently chooses the first bot. |
| 4 | Consistent exported brand assets | Canonical vector to favicon/public/desktop assets, then native catalogs in separately verifiable slices. Check small size, both themes, loading, packaging references and missing assets; preserve required notices. |
| 5 | Interactive landing approval preview; `www/` only | Explicit simulation label, task → proposed action → Allow/Deny → sample receipt/evidence → reset. No production mutations or paid model. Deny never claims completed work; keyboard/touch, responsive layout and reduced motion pass. |
| 6 | First-task onboarding reliability | Check creation responses, preserve input and show recovery, reuse eligible greeting bot, prevent duplicate creation/send, do not mark failure as success. Keep job drafts through auth with an allowlisted template ID and explicit send. |
| 7 | Local VM guided setup and recovery | Explain runtime/download/storage, observable phases and actionable retries. Fixture failures plus one owned cold/warm runtime run and a durable-file round trip. Colima was stopped at audit; no actual VM has been validated. |
| 8 | Per-bot VM inventory | Discover after restart/destination change; distinguish unmanaged/stale targets; prove two isolated workspaces, cap enforcement, lease behavior, collision recovery and injected-clock idle cleanup. |
| 9 | `/os` workspace layout and task targeting | Open/focus/minimize/restore/close, bounds after resize, compact phone presentation, keyboard/focus return, reload persistence, exact bot/thread command and approval targets. Reuse server contracts. |
| 10 | Engine capability/readiness guide | Per driver: install/account/model/tool/computer support and a recoverable next action. Credentials remain in existing secrets paths. A registered driver is not a passed compatibility cell. |
| 11 | Real shared browser control | One explicit agent/viewer adapter; same profile and target, actual takeover fence, no stale agent input, deliberate release/resume, disconnect/navigation/profile races. No attachment to the user's logged-in session for tests. |
| 12 | Remote access clarity | Separate hosted account, self-host pairing, phone companion and desktop host/client roles; expiry/reuse/reconnect/identity tests. Local work survives remote failure. New external wiring remains a board item. |
| 13 | Electron, iOS, Watch, Android acceptance | One client at a time using the computer study's exact prerequisites. Report unit/core tests, build, simulator/browser checks and physical-device evidence separately. Never revoke demo sessions. |
| 14 | One useful durable `/os` app | Start with approvals/evidence or routine scorecards. Persist real data and thread identity, show useful results beyond chat, retain human approval requirements. Rome is architectural reference, not a mandate to replace the runtime with Lima. |
| 15 | Harness benchmark and model matrix | Execute the brief's five-step eval against owned fixtures, then available real engines. Record model/version, tools, task, outcome, human decisions, retries, duration and observed usage. Keep absent cost absent; weaker models must fail/recover clearly. |
| 16 | Packaging and measured conversion | Reconcile current landing “unlimited free bots” with `FREE_BOT_CAP=2`; prepare exact copy/entitlement options for the board. Measure first useful task and repeat use before proposing broad packaging. No live price/payment switch or invented customer proof. |

“Any model becomes AGI” is not an acceptance criterion. The product contract
is bounded tasks, observable tool execution, explicit human decisions,
durable results and honest recovery on supported capabilities. Use benchmark
results to choose model routing; do not hide failed work behind mascot motion.

## Verification and safe continuation

Use focused tests during implementation; full `npx vitest run` once before
each final commit. Run relevant `tsc --noEmit -p` configurations, scoped lint
and builds. Count skipped tests separately. A test list is not an executed
browser suite. Current desktop tool instructions require CUA for actual UI
actions; the Playwright specs can be discovered/typechecked without claiming
their runner executed.

`e2e/pairing-harness.ts` supplies real local cloud/desktop servers with fresh
temporary data, synthetic credentials and happy/permission/rehearsal fake ACP
engines. Use its readiness and cleanup helpers. Model replies remain fixtures;
do not count them as real Google, model-provider or native-device tests.
Never stop or revoke anything on demo **127.0.0.1:8845**. Earlier owned audit
servers at 18861 and Vite at 15199 are separate; verify ownership before use.

Pull before beginning; inspect all unexpected changes. After tests settle,
pull with rebase (stash only known slice paths if needed), inspect the exact
diff, `git add -A`, commit with a pathless message and push. Never force-push.
Verify deployment with GET and an exact marker after rollout; HEAD returns
404 on static routes. Preserve dirty work and record blockers instead of
performing destructive cleanup to make status look clean.

## Completion ledger

- Loop 13: `f006fa9`, historical verification above; production marker absent
  at last check.
- Loop 14: canonical web mascot and small-screen onboarding verified;
  **193 files / 1976 passed / 8 skipped in 239.35s**, frontend/server
  typechecks and scoped lint pass; final build 6.49s. Seven functional
  browser checks and seven measured layouts passed. Twelve focused component
  tests passed. No OS reduced-motion toggle, native app, real model or VM
  runtime check is claimed. Commit and rollout follow this verification.

Next bounded file set: `src/components/BrowserPanel.tsx`, narrowly related
`server/browser-panel.ts` behavior/tests only if needed to remove the cosmetic
takeover claim. Loop 14 fixtures, data and tabs were cleaned up; no active
Loop 14 process remains. Full suite has no failures. Latest usage snapshot:
19% remaining. Native CUA access is blocked by pending OS permissions; do
not count its attempted inspection as a UI check. Update this ledger again
before transferring ownership; the CEO log remains the latest evidence.
