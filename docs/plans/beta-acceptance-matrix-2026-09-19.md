# Personal-assistant beta acceptance matrix

Owner contract: [beta decisions](personal-assistant-beta-decisions-2026-09-19.md).
This is an evidence checklist, not a declaration of production readiness.

## Core journeys

| Journey | Available evidence | Required next acceptance |
|---|---|---|
| Sign-up, sign-in, onboarding, return visit | Loop126–128 owned browser suite; completion/connect fixes | Real Google consent on installed app and web; current release, session persistence and error recovery |
| Owner claim link | New owned Chromium tests: session identity, one redemption, fragment removal, replay rejection, malformed input; cloud code namespace rejection | Native/phone browser on intended served artifact; do not conflate claim with cloud or companion pairing |
| Calendar-backed Plan my day | Loop131 adds personal-assistant hiring and reviewable first-task draft; no real-calendar result receipt yet | Real selected calendar yields overview, three priorities and suggested blocks; timezone/empty calendar/offline/auth-expired cases; no calendar writes without approval |
| Watch calling | Native builds and prior walkie fixture receipts; not proof of true calling | Ring/accept/end, planning result, interruption/backgrounding and failed/reconnected transport on hardware |
| Optional connections | Loop130 reproduces and fixes runtime-only tool mounting and calendar-card backend selection; owned runtime fixture, not real consent | Calendar, email, files, Telegram, browser, tasks/notes: connect, cancel, revoke, unavailable and least-required permissions; do not require all to onboard |
| Memory permissions and action approvals | Existing approval tests; owner defaults recorded | Verify memory controls and draft-first defaults across surfaces; allow/deny reaches intended task exactly once |
| Capable-device routing and queue | Direction recorded; no current acceptance receipt here | Offline preferred device, another capable device, no device, reconnect, cancellation and duplicate prevention |
| Drive restore and cross-device consistency | Prior encrypted bundle/fake-provider round trips | Real consent, fresh-device recovery, interrupted restore, concurrent edits, deletion and stale-device behavior; exact coverage of transcripts/files/memory |
| Included allowance and BYOK fallback | Decision only | Cost proposal; per-user/global limits; concurrent usage accounting; default pause preserves work; opt-in fallback; no surprise billing |
| Live and installed update delivery | Commits exist; production identity lacks source revision | Verified artifact/source mapping, platform distribution/install/update receipts and preservation of sessions/preferences |
| Result/template sharing | Owner-approved direction | Preview, explicit publication, personal-data exclusion, cancellation and private-by-default behavior |

## Device coverage

| Surface | Current evidence boundary | Beta receipt still needed |
|---|---|---|
| Web | Owned Chromium automation, not all real browsers | Browser/version, deployed build, core journeys |
| Mac | Electron syntax/build history | Signed artifact/install, real OAuth, calls/relay, updates |
| Windows | Inherited release gate: Actions billing | Artifact/install, execution, auth/pairing, updates |
| Linux | Inherited release gate: Actions billing | Distribution/desktop environment, artifact/install, execution, auth/pairing, updates |
| iPhone | Swift/core tests, simulator pairing/walkie history | Device + OS + TestFlight/build, real pairing/auth, planning/calling/recovery |
| Android | No fresh evidence in this slice | Device + OS + artifact/build, pairing, planning, permissions, reconnect |
| Apple Watch | Build/simulator evidence; inspected WatchVoice is manual reply TTS, not a ring/accept call implementation | Watch + watchOS + paired phone/build, calls and approvals on hardware |

Device parity means a coherent supported experience, not identical execution
capabilities. Unsupported actions must show a clear handoff or queue state.

## Real tester launch gate

Recruit 5–10 people. At least five distinct testers must complete daily planning
on three distinct days each, and every core journey above must pass applicable
platform acceptance. Do not substitute fixture users, invented dates, or repeated
same-day sessions. No qualifying tester evidence has been recorded here yet.

Record with permission: pseudonymous tester ID, date/timezone, platform/build,
completion outcome and issue reference. Do not copy private calendar contents,
tokens or recovery keys into the repository. Keep raw private feedback in an
owner-approved location; repository evidence can summarize consented outcomes.

## Calendar acceptance preparation (19 September)

Use the selected user's calendar and a read-only event scope for the first
planning experience. Google documents event listing with explicit time bounds,
response timezone, recurring-instance expansion and pagination; an empty page
with a next-page token is not proof of an empty calendar. Handle these before
claiming a complete day. References: [events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

Connector tool availability is only a prerequisite: it does not prove the
connected account is the intended beta user's calendar, that a model chose the
correct read action, or that suggested blocks respect busy/all-day events.
Verify those through a real account and bounded fixtures in the next slice.

## Calendar ownership prerequisite (Loop131 source audit)

The generic connector currently selects installation-wide credentials:
`server/openconnector.ts` uses one configured runtime URL/token,
`server/composio.ts` uses the configured user/session, and connector routes/MCP
relay in `server/index.ts` pass global configuration. That is usable in a
single-owner installation; it is not evidence of hosted per-account Calendar
isolation. Before beta use, reproduce and close any non-owner access to that
installation connection, then implement the account-scoped Calendar journey.

Use the session-bound route-family pattern in `workspace-backup-routes.ts` for
status/connect/callback/day-read, with separate Calendar grant storage and
purpose-bound, single-use OAuth state. Basic Google sign-in does not grant
Calendar access. Do not overwrite login or Drive credentials: the existing
`account-drive.ts` exchange writes the shared Google account row, so its storage
semantics must not be copied for Calendar. Verify returned Google identity and
granted scopes before persisting a grant.

Next visible result: choose a calendar, date and timezone, review its complete
read-only agenda, then explicitly prepare a planning task from that evidence.
Tests must cover two-account separation, Drive preservation, revoked/missing
permissions, malformed/partial responses, pagination, recurrence, DST and all-day
events, plus no write calls or automatic submission. Follow with deterministic
free-slot checks and grounded priorities; persona text alone is insufficient.
This is a source-audit finding and implementation plan, not provider acceptance.
