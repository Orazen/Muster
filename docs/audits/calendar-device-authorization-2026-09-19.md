# Calendar device authorization — Loop141

## Evidence and scope

Companion pairing proves installation/device access, not Google account ownership.
DeviceRecord has no account ID; the proxy strips Cookie and Authorization; local
call ownership is the literal `local`. Calendar routes independently require a
real authenticated account session. Never map a Watch call to primaryUserId,
bot ownership, or the first stored Calendar grant.

This slice adds account-authenticated issuance, listing and revocation of a
selected-calendar permission. It does not yet transfer permission to Watch,
expose an enrollment screen, or consume it to prepare a call draft. Existing
Watch Plan my day remains prompt-only; end-to-end calendar planning is unfinished.

## Contract

- POST `/api/calendar/devices`: same-origin, live account session, strict
  `{calendarId,label}`. Refresh/check the account grant, read the complete current
  calendar list, require the exact selection, recheck session and grant, then issue.
- GET `/api/calendar/devices`: current account's active metadata only.
- DELETE `/api/calendar/devices/:id`: same-origin and account-scoped. Other-account
  and absent records have the same response and are never revoked.
- A 32-byte random capability is returned once; only its SHA-256 digest persists.
  It binds the account, exact calendar, Google subject and consent generation.
  Responses are no-store. No Google access/refresh token is returned.
- Fixed 24-hour expiry and ten active permissions per account bound this initial
  implementation. Issuing never evicts a live permission. Revocation deletes only
  that account's row; reconnect/disconnect invalidates the captured generation.
  This is active-permission management, not an audit-history feature.
- The capability is not a browser session, device identity, or general API key.
  A future consumer must check both its current call authorization and this
  selected-calendar permission before and after asynchronous reads.

## Next implementation

Build deliberate enrollment/transfer from the signed-in account to the native
client; store capability in native Keychain, keep it out of URLs/logs. Require
explicit calendar/date/timezone, work hours and reviewed priorities. Add a narrow
call-bound prepare endpoint using getCalendarAccess, the complete-day reader and
buildCalendarPlan. Return an unsent draft; preparation must dispatch zero model
turns. Extend only the specific companion route/header allowlist. Test revocation,
account/context replacement, incomplete reads and cancellation during retrieval.
No consent inference from ordinary pairing or device proximity.

## Verification

Final gate and independent owned iPhone acceptance receipts follow below.
The iPhone fixture uses fresh data, ports, simulator, normal local signing and
credential-free child environment; provider work is an offline fixture.

Owned iPhone acceptance completed without retries: pairing1/1, identity1/1,
iPhone Walkie1/1; aggregate **3passed/0failed/0skipped**, helperexit0. Normal
local simulator signing, build and install passed. This tests existing iPhone
Walkie, not the new Watch foreground-call screen or actual microphone/hardware.
No real Google account or external provider used. The previous boot blocker did
not recur: this fresh simulator finished within the180second boot bound.

Evidence: `/tmp/muster-ios-rig-3kPaKG/{pair,identity,walkie}.xcresult`; launch log
`/var/folders/j2/99fjlfmx07l3vvgrky5lp96m0000gn/T/muster-owned-iphone-launch-i43_ksuu/run.log`.
Inspected reply screenshot:
`/tmp/muster-loop141-iphone-attachments/91C569C5-ABD1-45CE-8ECB-5EFC9DBFE84E.png`.
Cleanup independently confirmed helper/backend/companion PIDs gone, exact owned
simulator FFEB6C70-1AD8-4389-838A-230441FACD00 absent, ports55621–55624 refused.
Existing user services and simulators were not selected or restarted.

Final unit gate: **314files/4658passed/8skipped/0failed**,506.59s,exit0.
Baseline313/4632/8 -> +1file/+26passing, no decrease. Log:
`/tmp/muster-loop141-full.log`. Focused HTTP27/27, store17/17; both TypeScript
checks and full lint exit0. Independent read-only review found no blocking defect.
No fresh browser suite rerun: no UI was changed by this authorization foundation.
Previous Watch slice ac05ae3 CIpassed; release workflow edits are owned separately.
