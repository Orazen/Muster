# Watch foreground experience — Loop140

The bot conversation now links to an explicit foreground call screen. Start and
Connect do not send a task. Plan my day fills a reviewable draft requesting
actual calendar data, three priorities and proposed time blocks, with an explicit
unavailable-calendar response. System text entry supplies dictation; playback
requires a separate Listen tap. This is not microphone streaming or background
incoming calling.

Every action belongs to a view/account context. Leaving the screen, changing
account/thread, losing the live connection, or backgrounding invalidates that
call. End remains available while another request is pending. Ending never
replays an uncertain message. A host404 permits explicit local dismissal with
a warning that prior work may still be running.

## Defects addressed

A focused regression reproduced two End requests for concurrent taps/lifecycle
callbacks. Capturing one End task fixes the duplication and preserves the first
receipt. The synchronous lifecycle fence prevents deferred background work from
ending a replacement call. The Watch view now also captures account and view
identity so old-screen cleanup cannot end a new call to the same bot/thread.

A failed End no longer offers a nonfunctional Check status button: reads remain
disabled after End to avoid renewing the host lease, while Retry End remains
available. Unknown host calls require explicit local dismissal before a new call.

## Verification

Full Swift suite:376/376 passed, zero failures (previous370, six added tests).
Call coordinator:18/18. Original duplicate-End reproduction:
`/tmp/muster-loop140-call-repro.log`; full receipt:
`/tmp/muster-loop140-swift-full.log`. Both TypeScript checks and full lint passed.

An owned Watch UI acceptance target and helper exercise real pairing through
the companion proxy and an isolated offline provider. Native interaction results
must be recorded separately from compilation. No real Google account, external
calendar, wrist microphone/audio or installed release is proven by the fixture.

## Calendar boundary and next slice

Watch Plan my day currently prepares a prompt; it does not call the account-linked
calendar reader. Normal runner connector tools may have independently configured
calendar access, but that is not the new Google Calendar grant. The web planner
uses `/api/calendar/plan` and `GoogleCalendarReader`; the Watch has neither an
explicit calendar/date/timezone selection nor an account session for that route.
Next implement an explicit owner-bound prepare-plan operation reusing the reader
and consent guards, returning an unsent evidence-backed draft. Pairing must never
resolve to an arbitrary account. No calendar-backed Watch planning claim yet.

Full Vitest:313 files /4632 passed /8 skipped /0failed,533.07seconds,exit0.
Counts unchanged from Loop139; this slice adds native tests and UI only.
Log:`/tmp/muster-loop140-unit.log`.

Native attempt history: attempts 1, 4 and 5 failed in fixture scrolling/focus;
attempts 2 and 3 were explicitly cancelled after diagnostic evidence, not passed.
Attempt 6 entered and submitted pairing but never reached the fleet. The helper
had disabled simulator signing, conflicting with the existing native rig's
Keychain requirement; the causal diagnosis awaits the signed rerun. Every
completed attempt cleaned its owned simulator and servers. Attempt 7 uses normal
local simulator signing, fail-fast assertions, bounded scrolling and sanitized
request receipts. No test result is inferred from a successful build.

Final-source Companion and Widget Release simulator builds passed. Watch signed
build-for-testing also passed. These are compilation receipts, not interaction
acceptance or installed-device verification.

## GitHub and delivery

CI and autodeploy for e59b6e9 both report success. Fresh GitHub reads show
0 open Dependabot alerts and 1 historical Telegram-token secret alert, validity
unknown. Mimosa remains incomplete; no blanket security claim.
Production GET still returns backend7632065f-88c9-4614-8faa-42adb590f61b and
web453b2f23-e6ce-4963-ad5b-c5d09ac598a6, version1.12.3, null source revisions
and attestationfalse. Source changes are not verified as deployed or installed.

Signed attempt 7 paired and connected successfully (pair201, call201, accept200),
then fixture dragging inside the TextField opened the system keyboard. No message
was dispatched. Attempt 8 paired successfully but failed selecting the destination
scroll container immediately after navigation. The helper now waits for the
observed destination container and drags the call screen's empty right gutter.
These failed tests remain failures; they are not included in any passing count.

## Final native interaction receipt

Final signed attempt9: **1 XCTest /1passed /0failed**,89.884s, helperexit0.
Paired through the owned proxy, Start/Connect, exact planning draft, system
keyboard open/Done stillConnected, zero user messages before explicitSend,
real offline-provider reply, exactlyone message, then End->Callended.
Host counts: POSTcall1,accept1,messages1,end1; GETcall6. Owned simulator
6FFC22F0 was removed and owned servers stopped. Prior eight attempts retain
the failure/cancellation status above; successful result does not erase them.

Evidence: `/var/folders/j2/99fjlfmx07l3vvgrky5lp96m0000gn/T/muster-watch-call-8EFAqS/acceptance.xcresult`.
Reproduce with `node --experimental-strip-types scripts/owned-watch-call-acceptance.ts`.
Use normal local simulator signing: disabling signing prevents this rig from
completing pairing through the app's Keychain. Do not add provisioning updates.
