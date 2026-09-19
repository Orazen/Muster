# Personal-assistant beta acceptance matrix

Owner contract: [beta decisions](personal-assistant-beta-decisions-2026-09-19.md).
This is an evidence checklist, not a declaration of production readiness.

## Core journeys

| Journey | Available evidence | Required next acceptance |
|---|---|---|
| Sign-up, sign-in, onboarding, return visit | Loop126–128 owned browser suite; completion/connect fixes | Real Google consent on installed app and web; current release, session persistence and error recovery |
| Owner claim link | New owned Chromium tests: session identity, one redemption, fragment removal, replay rejection, malformed input; cloud code namespace rejection | Native/phone browser on intended served artifact; do not conflate claim with cloud or companion pairing |
| Calendar-backed Plan my day | Loops133–135: separate consent, complete selected-day reads, deterministic planning draft; isolated provider/browser fixtures only | Real selected calendar yields overview, three priorities and suggested blocks; timezone/empty calendar/offline/auth-expired cases; no calendar writes without approval |
| Watch calling | Loops139–140 foreground protocol and owned Watch simulator call flow: pair/start/connect/review/edit/send/reply/end, exactly one dispatch | Ring/accept/end, planning result, interruption/backgrounding and failed/reconnected transport on hardware |
| Optional connections | Loop130 reproduces and fixes runtime-only tool mounting and calendar-card backend selection; owned runtime fixture, not real consent | Calendar, email, files, Telegram, browser, tasks/notes: connect, cancel, revoke, unavailable and least-required permissions; do not require all to onboard |
| Memory permissions and action approvals | Existing approval tests; owner defaults recorded | Verify memory controls and draft-first defaults across surfaces; allow/deny reaches intended task exactly once |
| Capable-device routing and queue | Direction recorded; no current acceptance receipt here | Offline preferred device, another capable device, no device, reconnect, cancellation and duplicate prevention |
| Drive restore and cross-device consistency | Prior encrypted bundle/fake-provider round trips | Real consent, fresh-device recovery, interrupted restore, concurrent edits, deletion and stale-device behavior; exact coverage of transcripts/files/memory |
| Included allowance and BYOK fallback | Loop136 default-off account-scoped opt-in fallback and owned fixture acceptance; included allowance remains unimplemented | Cost proposal; per-user/global limits; concurrent usage accounting; default pause preserves work; opt-in fallback; no surprise billing |
| Live and installed update delivery | Recent CI and Dokploy trigger succeed; GET still returns older unattributed artifacts | Verified artifact/source mapping, platform distribution/install/update receipts and preservation of sessions/preferences |
| Result/template sharing | Owner-approved direction | Preview, explicit publication, personal-data exclusion, cancellation and private-by-default behavior |

## Device coverage

| Surface | Current evidence boundary | Beta receipt still needed |
|---|---|---|
| Web | Owned Chromium automation, not all real browsers | Browser/version, deployed build, core journeys |
| Mac | Loop138 actual owned Electron recovery/Quit/draft-retention acceptance; not user-installed update | Signed artifact/install, real OAuth, calls/relay, updates |
| Windows | No current release acceptance receipt; historical billing gate needs fresh verification | Artifact/install, execution, auth/pairing, updates |
| Linux | No current release acceptance receipt; historical billing gate needs fresh verification | Distribution/desktop environment, artifact/install, execution, auth/pairing, updates |
| iPhone | Loop141 fresh owned signed simulator acceptance: pairing1/1, identity1/1, Walkie1/1; offline provider, no real Google/audio | Device + OS + TestFlight/build, real pairing/auth, planning/calling/recovery |
| Android | No fresh evidence in this slice | Device + OS + artifact/build, pairing, planning, permissions, reconnect |
| Apple Watch | Loop140 signed simulator build and real UI test 1/1 passed; foreground call protocol, system text/dictation and manual reply TTS | Watch + watchOS + paired phone/build, calls and approvals on hardware |

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

### Calendar grant implementation notes (19 September research)

Google recommends requesting permissions in context and checking which scopes
were actually granted. Combined authorization can cover scopes granted across
clients in the same project; revoking such a token revokes all of its combined
scopes. Therefore separate Calendar token storage alone does not prove Drive
revocation isolation. Preserve the Drive row, verify granted scopes, and test
Calendar connect/disconnect alongside working Drive recovery before advertising
independent recovery. Source: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

Use the verified Google `sub` as provider identity, not email; validate issuer,
audience, expiry and the flow nonce when accepting an ID token. Source:
[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).
Muster's own session remains the owner of the grant. Bind consent to that session
and a one-use flow; do not copy the Drive helper's reusable timestamp-only state
or its shared login-account token overwrite into the new Calendar adapter.

Implementation order after the connector boundary gate: account-owned consent
and grant storage; calendar selection and complete day reads; deterministic
free-slot validation; explicit planning draft using the verified agenda. Empty
pages still require following nextPageToken. Source: [Calendar event listing](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).
Real consent/refresh/revoke acceptance remains an owner-assisted gate.

### Loop132 prerequisite verification

Hosted installation connector isolation and bot/thread/turn credential lifetime
now pass owned HTTP harnesses: owner cases **9/9**, lifecycle cases **3/3**,
capability unit cases **14/14**. Full suite **300 files / 4371 passed / 8 skipped**;
browser **31/31**, packaged-server **14/14**. Secondary users receive an explicit
unavailable reason; Stop/opt-out cancel queued connector continuations. These
fake-provider receipts close the reproduced installation authority defects;
per-account Google Calendar consent and real daily planning remain unverified.

### Loop133 Calendar consent contract and provider acceptance

Implementation: the existing Connected apps panel exposes Personal Google
Calendar separately from installation app connectors. Consent requests `openid`
and `https://www.googleapis.com/auth/calendar.readonly`; it is explicit, uses
PKCE/nonce and a one-use state bound to the exact Muster account/session.
Calendar token rows are separate from Google login and Drive. Disconnect is
local removal only; it invalidates pending/in-flight consent, not Google's
combined authorization. Existing providers and account sessions stay unchanged.

Deployment prerequisites: configure GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET from
secrets, enable Calendar API in that Google project, and register the exact
served origin plus `/api/calendar/google/callback` as an authorized redirect URI
(e.g. `https://muster.today/api/calendar/google/callback`). Each alternate origin
requires its own registered redirect. Check Google consent publishing/test-user
access and required verification before inviting users. This is not a claim
that the production Google project has been configured.

Real-provider acceptance still required: sign in, open Connected apps, explicitly
connect Calendar, check successful return, confirm the same account's Drive
backup still works, disconnect Calendar and confirm Drive still works. Repeat
with a second Muster/Google account and in an installed desktop build. Browser
fixture tests do not substitute for these checks. Different Google subjects
require disconnect before reconnect; no email-based identity matching.

Next implementation: refresh with generation checks; calendar selection and
complete paginated read-only day events; recurrence/all-day/DST/partial-response
handling; deterministic free slots; explicit unsent Plan my day draft from the
verified agenda. A connected grant alone does not prove daily planning works.

Day-reader audit: existing routines use server-local Date operations, so do not
reuse them for an account-selected timezone. Resolve consecutive local day
boundaries independently (23/25-hour DST days), preserve all-day exclusive date
ends, and explicitly reject nonexistent dates. Consider a server-only Temporal
adapter ([polyfill source](https://github.com/js-temporal/temporal-polyfill)).
Google event reads should request recurrence expansion, follow every page token,
and fail explicitly on pagination bounds. `timeMin` filters event ends and
`timeMax` filters starts, both exclusive; include overlapping events rather than
only events starting that day. Source: [events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

Treat event titles/descriptions as untrusted external content when preparing the
planning draft. Event text must not change tool permissions or trigger actions;
only the user's explicit reviewed request may submit the planning task.

Loop133 receipts: **303 files / 4427 passed / 8 skipped / 0 failed**,
browser **34/34**, packaged-server **14/14**, focused backend **65/65**.
Calendar UI fixtures include mobile consent/local disconnect, malformed status
recovery, explicit sign-in capability and automatic callback result panel.
Real Google consent and installed-device acceptance remain pending.

### Loop134 read-only agenda and next planning handoff

Reader requests selected-calendar recurring instances and follows all page
tokens, including empty pages; a missing/wrong collection kind, malformed event,
repeated page token or resource bound fails the read rather than yielding an
empty/free day. Boundaries use explicit IANA civil days (including DST and skipped
dates). All-day dates retain exclusive ends; transparent and self-declined
appointments do not block availability. Offset-free timed provider responses
are explicitly rejected rather than guessed. No events are written or sent to
models by the reader. The UI loads only on explicit clicks and invalidates old
results when input changes or the connection is removed.

Calendar refresh uses only Calendar grant rows. Session/consent-generation checks
run around provider requests and before returning results; disconnect or newer
consent wins over in-flight work. Concurrent callers share provider refresh but
retain independent session guards. Real Google refresh/revoke behavior still
needs provider acceptance; fake-provider tests are not that evidence.

Next slice: gather user commitments/durations and selected owned bot; compute
candidate work blocks in selected timezone after merging/clipping busy intervals
(including all-day blocks). Reject ambiguous/nonexistent work-hour boundaries;
for today omit past time. Report unplaced commitments instead of moving meetings.
Then explicitly prepare an unsent draft with calendar evidence, up to three
grounded priorities and suggested blocks. Check evidence freshness before using
an old loaded day. Never infer commitments from event titles alone.

Source audit for that handoff: src/lib/drafts.ts currently reads the initial draft
on mount; seeding a draft for the already-mounted bot may not update its composer.
Reproduce first, then add same-tab notification with preservation of existing
text/attachments. Existing seedDraft + select pattern is in src/state/store.tsx;
reuse src/lib/daily-planning.ts and the existing explicit Send path. Verify no
message POST until Send, refresh persistence, current-bot handoff and busy-day
behavior in personal-assistant/calendar-agenda browser tests. No new send API is
needed. This source finding is not yet a reproduced defect or completed fix.

Loop134 acceptance receipts: full **305 files / 4470 passed / 8 skipped**,
browser **35/35**, packaged-server **14/14**, focused backend **98/98**.
These establish isolated reader/UI behavior, not real Google or device acceptance.

### Loop135 planning proposal acceptance

The Loop134 composer finding is now reproduced and fixed. Same-tab subscriptions
update the mounted composer; preparing a plan appends to the latest text rather
than replacing it, while existing attachments remain intact. A storage failure
retains text for the current session. This is local draft behavior, not a new
cross-device sync claim.

Connected apps → selected agenda → Plan your day collects one to three stated
commitments, durations, work hours and an owned bot. Preparing re-reads the
complete selected calendar under current session/grant checks. Deterministic
first-fit blocks merge busy intervals, honor all-day events, omit elapsed time,
reject ambiguous/nonexistent work boundaries and report unplaced commitments.
Readable drafts preserve exact local time/offset and identify the selected
calendar, freshness and untrusted titles. No calendar mutation is introduced.

The browser contract test verifies stale response rejection, an all-busy day,
current mounted bot handoff, existing text and attachments, reload persistence,
320px layout and zero task sends until explicit Send. Provider data is a fixture.
Real Google consent/refresh/revoke and real-account planning still require
acceptance, as do Watch calling, installed-device behavior, Drive recovery,
allowance and the five-testers/three-days launch gate. No fixture receipt is
substituted for these human/provider/device gates.

### Next bounded slice: explicit provider fallback consent

Loop135 read-only source audit found automatic cross-provider rescue in
server/index.ts (attemptProviderFallback, invoked on runtime error) after quota,
credit or rate-limit errors. server/provider-fallback.ts checks cooldown and
owner-scoped availability, but does not check explicit consent. The chosen
alternate changes the bot model selection and re-dispatches the last user text.
This conflicts with the accepted default-pause/opt-in-fallback decision.

Before funded inference, add persisted account consent defaulting false and an
explicit control in existing ProvidersSection. Guard before mutation and again
after asynchronous registry lookup; revalidate owner, active turn and consent.
Cover default-off zero dispatch, opt-in, revocation during lookup, account
isolation, missing owned key and duplicate prevention in owned server tests.
Audit other model-selection paths before claiming comprehensive fallback control.

Included allowance remains a separate implementation: per-user/global atomic
reservations, idempotent settlement/recovery and explicit funding-source routing.
Existing agent-vault settled-cost caps cannot account for concurrent reservations
or providers that omit cost reporting; cloud-computer billing is not an included
AI allowance. Numerical quota, reset, supported models and global cap still need
a costed owner decision. No funded execution or spending is enabled by this plan.

Loop135 final acceptance receipts: Full unit **306 files / 4505 passed / 8 skipped / 0 failed** (435.55s),
+1 file/+35 passing tests over Loop134; full browser **36/36** (3.7m),
packaged-server **14/14**, focused recovery **52/52**. Project/server/e2e
typechecks, production build, native source import and lint passed.

### Loop136 explicit fallback implementation

Account-owned automatic provider retry now has persisted opt-in, default off.
The existing Providers panel checks/saves the preference explicitly and explains
that another connected provider receives the task and may spend paid credits.
Anonymous, loading, failed or ambiguous saves do not display confirmed consent.
An account/session change discards stale UI responses. Shared installation
providers are excluded from automatic retry.

A quota failure can retry once only after a failed terminal event, no model/tool
progress, and unchanged account, task, message, selection and consent generation.
New work, Stop, revoke/re-enable and stale source-turn events invalidate it.
Missing explicit provider choices no longer silently heal to arbitrary providers.
The retry temporarily selects an owned alternate without changing the saved
provider; the original message identity prevents duplicated provider context.
Active-provider checks preserve retry state against predecessor events; Stop and
approval answers target the active provider. Authentication/permission errors
are not quota signals. No automatic action approval is added.

Owned real-server evidence covers default off, opt-in, revocation, account
isolation, exactly one reply/user bubble, unchanged saved provider, missing
provider refusal, Stop reaching the alternate and zero replay after tool use.
Coordinator fixtures cover concurrent completion, generation changes and stale
turn identity. These are fake-provider receipts, not real paid-provider success.
The included allowance still needs accounting/reservations and a costed owner
choice; this slice does not introduce an included pool or authorize spending.

### Next hero journey: foreground Watch calling

Loop136 read-only audit confirms an implementation gap before hardware testing.
ios/Watch/WatchVoice.swift provides explicit local reply TTS; WatchSession uses
system dictation and disconnects on backgrounding. WatchViews preserves an unsent
draft when disconnected; this is not a durable execution queue. iPhone's
WalkieVoice and CompanionCore/Walkie derive voice state from ordinary messages.
Web CallView/call.ts state is window-local and not a Watch signaling protocol.
Companion routes currently forward messages/interrupts/events to one configured
host; no call-session or Calendar-planning endpoints were found. No incoming
call/accept protocol or capable-device routing was established in this audit.

Next bounded implementation should deliver one foreground Watch call session
against its paired execution host: account/device session identity, explicit
ring/accept/end transitions, duplicate protection, disconnect cancellation and
no task execution before acceptance. Add a native coordinator and foreground
Watch controls, correlate an explicit planning request/result through the
existing message contract and reuse reply TTS. Test owned transports for late
replies, duplicate accept/end, reconnect and cancellation. Define the exact
protocol and device authorization against companion contracts before coding.

This does not establish background incoming calling, automatic host selection
or offline execution. Capability registration/selection and durable queued
requests remain subsequent work. Wrist microphone/audio, suspension, background
delivery and interruptions require real hardware acceptance. No new native tests
were run for this source audit; prior builds do not prove the missing call flow.

Loop136 final receipts: Full unit **309 files / 4556 passed / 8 skipped / 0 failed** (483.77s),
+3 files/+51 passing tests over Loop135; fresh browser **39/39** (4.1m),
packaged-server **14/14**, final focused **6 files / 70 passed**. Build,
project/server/e2e typechecks and full lint passed. No native-device or
real-provider acceptance is claimed by these isolated fixtures.
