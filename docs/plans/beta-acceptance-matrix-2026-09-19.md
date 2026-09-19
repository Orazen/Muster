# Personal-assistant beta acceptance matrix

Owner contract: [beta decisions](personal-assistant-beta-decisions-2026-09-19.md).
This is an evidence checklist, not a declaration of production readiness.

## Core journeys

| Journey | Available evidence | Required next acceptance |
|---|---|---|
| Sign-up, sign-in, onboarding, return visit | Loop126–128 owned browser suite; completion/connect fixes | Real Google consent on installed app and web; current release, session persistence and error recovery |
| Owner claim link | New owned Chromium tests: session identity, one redemption, fragment removal, replay rejection, malformed input; cloud code namespace rejection | Native/phone browser on intended served artifact; do not conflate claim with cloud or companion pairing |
| Calendar-backed Plan my day | Product direction accepted; no acceptance receipt in this slice | Real selected calendar yields overview, three priorities and suggested blocks; timezone/empty calendar/offline/auth-expired cases; no calendar writes without approval |
| Watch calling | Native builds and prior walkie fixture receipts; not proof of true calling | Ring/accept/end, planning result, interruption/backgrounding and failed/reconnected transport on hardware |
| Optional connections | Existing connector surface and owned harness checks recorded | Calendar, email, files, Telegram, browser, tasks/notes: connect, cancel, revoke, unavailable and least-required permissions; do not require all to onboard |
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
| Apple Watch | Build and simulator evidence; no true-call acceptance here | Watch + watchOS + paired phone/build, calls and approvals on hardware |

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
