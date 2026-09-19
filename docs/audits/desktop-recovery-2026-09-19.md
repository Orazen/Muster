# Desktop recovery acceptance — Loop138

This slice follows the installed desktop's blank-window observation in Loop137.
It changes current source; it does not update the user's installed app or publish
a signed release.

## Behavior

An owned backend exit invalidates readiness and offers Retry or Later. A loaded
renderer stays alive, retaining its unsent draft. Retry starts only the original
port and accepts only the newly spawned PID with the expected static-server
identity. A failed main-document load shows a local recovery page; recovery
restores its same-origin route. Aborted or superseded navigation does not replace
a newer page. Initial startup may select an available configured port, but a
workspace never silently moves ports on recovery.

Renderer requests to the local app addresses are cancelled until the owned
backend is verified. This prevents automatic reconnects from sending session
headers to an unrelated listener after a backend exit. No task is replayed.

Normal Quit also needed repair: the real menu action killed the backend but left
the app alive. Deferring the final quit to the next event-loop turn after bounded
cleanup resolved the reproduced behavior. Repeated first-phase quits share cleanup;
quitting invalidates startup/retry immediately, and late children cannot be adopted.

## Verification

- Full Vitest: **309 files / 4,556 passed / 8 skipped / 0 failed**, 488.05 seconds.
- Lifecycle Node tests: **14/14 passed**; updater regression tests **14/14 passed**.
- Both TypeScript checks, Electron syntax and lint passed.
- Actual ARM64 Electron candidate used an owned bundle and disposable profile,
  current main/coordinator code and existing built server/UI resources. Remote
  outbound traffic was blocked by test-only guards. The installed app and demo
  server were not replaced or restarted.

Four GUI scenarios were exercised: explicit retry after backend exit; Later then
menu retry with an unsent draft; failed reload/local recovery page then route
restoration; foreign-port refusal and recovery after that listener exits. The
same account (Recovery Audit), bot (Rocket), origin (127.0.0.1:18799), and exact
unsent draft remained visible after recovery. Only recorded owned backend PIDs
were terminated. An initial foreign-listener test exposed missing renderer
fencing; after the fix its receipt recorded **1 main health probe, 0 renderer
requests, no cookies**. The unrelated listener was neither adopted nor killed
by Muster.

Final normal menu Quit completed with process exit 0. Logs at 19:20:12–13 UTC show
cleanup started, cleanup completed, quit resumed on the next turn, final quit
accepted, and backend exit 0. This supersedes the failed same-turn quit attempts.

Evidence: `/tmp/muster-loop138-unit.log`,
`/tmp/muster-loop138-electron-final.log`, and
`.omb-scratch/verification/loop138-electron-0cy8ytwb/` (owned package, process
receipts and redacted request counts). No real provider, Google account,
Windows/Linux runtime, notarization or production deployment acceptance is claimed.

Final cleanup: all 19 recorded owned main/child/foreign-listener PIDs were absent;
ports 18799 and 53478 refused connections. Read-only fixture database inspection
found **0 user messages**, confirming that recovery never sent the draft.
