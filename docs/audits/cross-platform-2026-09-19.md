# Cross-platform acceptance — 19 September 2026

Audit started from main `29c395f` at the owner's request, before further Watch
call implementation. This is a version-specific receipt, not release approval.

## Installed desktop

The initial inspection of `/Applications/Muster.app` showed a blank main document; its
accessibility URL is `chrome-error://chromewebdata/`. The main process remained
alive after its backend and companion exited at 15:38:11 UTC. No backend listener
remained on the app's three configured ports. The exit trigger is unproven.
A later read-only observation showed the app restored at `127.0.0.1:8799/app`
and an active pairing flow, without this audit restarting it. User activity was
left untouched. The initial blank state is not its final observed state.

Installed version 1.12.3 represents older source `7bb7c0e` with dirty-build
metadata. Executable, app archive, server and UI hashes match the existing ARM64
release package. That package's isolated runtime smoke passed 14/14; current
source Electron syntax passed for 8 files and updater tests passed 14/14.
These checks do not establish that the installed GUI works or that current source
has been packaged. Signing is ad-hoc; notarization is not verified.

Current source logs post-start backend exits but does not clear `serverReady` or
provide recovery for failed main-document navigation. Next desktop slice should
track the owned child, suppress recovery during intentional shutdown, preserve
loaded drafts, and offer an explicit same-port retry with child identity checks.
Never adopt/kill a foreign listener, clear storage, or resend tasks on retry.

## Production web

Authenticated `https://muster.today/app` loads the existing conversation. Its
saved onboarding answer reports that the task did not start. Connected apps are
unavailable and their connect buttons disabled. Providers still displays old
copy about keys never leaving the machine; the new fallback preference is absent.
No credentials, permissions, tasks or preferences were changed during inspection.

GET `/api/build-identity` at 18:31 UTC still reported backend `7632065f` and web
`453b2f23`, null source revisions and `attestation: false`. This is the same older
artifact pair as before the latest successful deployment-trigger runs. Production
rollout therefore remains unverified; an accepted trigger is not deployment.

## GitHub

Main matched the local checkout. Latest code-parent CI `35461205899` finished successfully at 18:35 UTC:
lint, typecheck, tests and build passed. Autodeploy trigger succeeded. Xcode Cloud
reported the generated `ios/MusterCompanion.xcodeproj` missing from the checkout.
This cycle adds an executable post-clone script beside the project, using pinned
XcodeGen 2.46.0 and a checked archive SHA256. Installed-tool and fresh-download
generation, local path discovery, shared Release archive scheme, and five failure
fixtures passed. The next real Xcode Cloud run is still required.

Dependabot returned **0 open alerts**. Secret scanning returned **1 open alert**
for a historical Telegram-shaped fixture token, validity unknown. The current
fixture uses generated values and the historical literal was removed in
`36372e6`; no revocation evidence was found. No secret was retrieved or displayed,
and the alert was not dismissed. The owner must establish whether it ever was a
live credential and revoke it if applicable. Code scanning returned no analysis;
this is not a passing scan. The full Mimosa rerun remains outstanding.

The latest published 1.12.3 release contains macOS and CLI artifacts but no Windows
or Linux artifacts. Its September 16 workflow was blocked before jobs started by
billing. Current successful CI runs mean that historical failure cannot establish
a current billing block.

## Native and source verification

The first Swift run passed 355/356: one test raced a second 10 ms timeout under
load. Its follow-up response is now prepared before dispatch, preserving the
original held-request timeout and lock assertions. Fresh full Swift: **356/356**.
Browser suite: **39/39 passed** (9.6 minutes). Both TypeScript checks and lint
passed. The full unit run initially hit a signup harness readiness timeout; its
server later became healthy but was orphaned. The repaired harness probes both
ports, checks its own child, isolates its environment, and cleans failed boots.
The original 15-second deadline and five signup assertions are unchanged. Focused
rerun: **5/5 passed** in 11.08 seconds. Fresh full unit rerun: **309 files /
4,556 passed /8 skipped /0 failed**, 689.64 seconds; no baseline decrease.

Watch, Companion and Widget simulator builds succeeded. The owned Watch launched
to its pairing screen; paired Watch interaction is not verified. The first iPhone
pairing phase failed while CoreSimulator installed the test runner, before app
assertions executed. The fresh-simulator retry reached the app but failed because its two-minute
invitation expired during Xcode runner startup: the screenshot explicitly says
no pairing is in progress. The rig now mints from the running test immediately before opening the invite,
keeping product expiry unchanged. Its first verification exposed a helper expecting
200 instead of the control API's 201; corrected to the exact contract. The final
verification stopped before tests at the 180-second simulator boot-readiness
bound (CoreLocation migration). Owned services and simulators were cleaned up.
Final generic simulator build-for-testing of the corrected helper succeeded.
Simulator preservation check: 0 extra devices, 0 missing devices, 0 changes to
original device states; owned processes exited.
**iPhone pairing/identity/Walkie end-to-end acceptance remains unverified.**
Build success alone is not acceptance. Real iPhone/Watch hardware, Google
account round trips, cloud recovery, Windows/Linux runtime and tester-day beta
acceptance remain separate gates. A simulator build does not prove those flows.
Existing automation stays paused.

## Desktop recovery slice queued after this audit

Use a lifecycle coordinator with explicit starting/running/stopped/quitting phases
and an owned-child generation. Set quitting before intentional child termination.
An unexpected exit, including code 0, must invalidate readiness exactly once.
Keep a loaded renderer intact so drafts survive; if its main document cannot
load, display a packaged recovery page. A user-triggered retry starts only the
original port and verifies the new child's PID/static identity. Refuse foreign
listeners and stale async completions. Restore only a validated same-origin route.

Required tests: intentional shutdown has no recovery prompt; startup/retired child
exits cannot invalidate a newer child; concurrent retries collapse to one; an exit
during readiness cannot report success; foreign occupied ports are never adopted;
subresource errors, aborted navigations and external OAuth do not replace the app;
retry preserves storage and never resends a task. Owned Electron acceptance must
kill only its recorded child, exercise retry, and verify a changed child PID with
the same session and unsent draft. This remains planned, not implemented here.
