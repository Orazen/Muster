# Call-bound calendar preparation — Loop142

## Product boundary

The backend and native client can now prepare an unsent calendar-backed proposal
for a connected call. This is a transport/service slice, not completed native
Calendar enrollment: the Watch UI still has the prompt-only shortcut until the
account's permission is deliberately enrolled and a review form is connected.
No automatic model dispatch, calendar writes or account session transfer is added.

POST `/api/bots/:botId/calls/:callId/prepare-calendar` requires the existing call
capability plus a separate selected-calendar permission in
`X-Muster-Calendar-Token`. The body contains date, timezone, work hours and one to
three commitments with durations. It cannot choose an account or calendar, or
supply credentials. The permission resolves the exact account/calendar server-side.
Hosted requests additionally require the permission's account to match the actual
request account; local calls never guess an account from installation ownership.

The call must be accepted and idle. Before and after asynchronous reads, the
route checks account, thread, call state and turn identity. Ending/replacing the
call or starting new work discards the draft. Permission expiry, revocation,
disconnection or reconsent also discards results. Retrieval uses the existing
refresh/complete-day reader and deterministic plan builder. Incomplete or mismatched
evidence is refused; proposals over the call's 8,000 UTF-16 limit are rejected,
never truncated. Preparation does not renew the call lease or send a model task.

Companion forwarding is limited to the exact POST route and full-access devices.
Only lowercase 64-hex Calendar tokens pass; malformed/combined values and tokens
on unrelated routes are stripped. Browser cookies and device Authorization never
become upstream calendar sessions. Swift exposes a typed request/result method;
it neither stores the calendar permission nor modifies an unsent draft implicitly.

## Next slice

Complete explicit native enrollment from the signed-in account, keep permission
in Keychain, add calendar/date/timezone/work-hours/priority review, and call this
operation from Watch. Apply the result only if the same visible account/call/view
and draft revision remain current. Keep Send separate. Test cancellation, stale
responses, permission revocation and zero automatic dispatch through the actual UI.

## Verification

Focused service19/19; call routes28/28; companion boundary154/154. Final combined
unit/type/lint and Swift/native build receipts are recorded below when terminal.
Provider data is an isolated fixture; no real Google calendar or hardware claim.

Independent review found no blocking issue in the bounded server/proxy/native
transport. Client requests use the existing per-task redirect-denial policy;
capabilities must never follow redirected requests. Full Swift suite:380/380,
0failures (previous376, four added transport cases). Focused client6/6.
Logs: `/tmp/muster-call-calendar-swift-full.log` and
`/tmp/muster-call-calendar-swift.log`.

Enrollment implementation direction: a short-lived pending request belongs to
the active call, the signed-in browser explicitly selects/authorizes its calendar,
and only that captured call retrieves the resulting permission. Show a human
confirmation code; do not ask people to copy a 64-character capability or put it
in a URL. Expiry, end, reconnect, account change and cancellation must invalidate
pending enrollment. This is a design direction, not a shipped enrollment flow.

Final native compile gates: Companion, WatchOwnedAcceptance and FleetWidget
normal-signed generic simulator builds each exited0 with BUILD SUCCEEDED. Logs:
`/var/folders/j2/99fjlfmx07l3vvgrky5lp96m0000gn/T/muster-calendar-native-h4053gj5/`.
Initial `MusterWatch` invocation exited65 because that scheme does not exist;
its corrected listed scheme passed. No source failure was hidden, no simulator
was booted, and no user service was touched by these compile checks.

Host-bound enrollment audit: local desktop and muster.today use separate Calendar
grant databases. Approval must occur in Calendar settings on the exact computer
connected to the Watch. A cloud grant cannot silently authorize a local call.
Reuse CalendarConnection/CalendarAgenda for explicit signed-in selection and
WatchCallView for a short-lived approval code. Scope pending requests to the call,
never reuse credential-bearing companion pairing URLs, and retrieve any approved
permission through the authenticated call channel. Wrong-host recovery must name
the connected computer rather than searching other accounts/hosts. Verify code
guessing limits, expiry, duplicate approval/redemption and connection replacement.
A cross-host relay remains separate work; this slice does not solve global sync.

Final packaging review removed an unnecessary new Zod runtime import from the
standalone companion. Header validation follows the existing call-token pattern;
final proxy/routes focused suite154/154 and touched lint passed after that change.
The combined unit process remained running; source behavior and allowlist tests
were independently rechecked on the final header implementation.

Final combined gate: **315 files /4702 passed /8 skipped /0 failed**,513.37s,
exit0; baseline314/4658/8, +44 passing, no decrease. Log:
`/tmp/muster-loop142-full.log`. Both project/server typechecks and full lint
passed. No UI browser/native interaction suite rerun for transport-only changes.
