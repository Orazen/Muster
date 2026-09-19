# Foreground call foundation — Loop139

The paired-host call foundation uses the normal task runner. It requires explicit
acceptance, preserves message request identities, and cancels only its captured
dispatch. Capabilities live only in client memory and server hashes. Paired
approvals-only devices cannot use call routes.

A foreground read renews a 45-second lease; expiry ends the call. Ambiguous
provider results remain uncertain and are never automatically replayed. Calls
use the selected provider only until fallback-chain cancellation is implemented.
Ordinary chat fallback behavior is unchanged.

## Scope and remaining acceptance

This implements host routes/dispatch tracking, companion proxy restrictions, and
Swift client/coordinator contracts. It does not add Watch views, microphone
streaming, background incoming calls, device selection or durable offline queues.
Real wrist audio and cross-device Google/Drive acceptance remain open.

Swift: 14 new focused tests; full 370/370 passed (previous 356). Watch, Companion
and Widget simulator Release builds each passed with exit 0. These are compile
checks, not native UI interaction. Logs are in
`.omb-scratch/verification/loop139-native/` and
`/tmp/muster-foreground-call-full.log`.

GitHub audit: zero open Dependabot alerts. One historical Telegram-token alert
remains open with unknown validity; no credential revocation or full security
clearance is asserted. GitHub CI run35464095664 for desktop fixf5907bd passed. Production GET
still returned backend build 7632065f-88c9-4614-8faa-42adb590f61b and web build
453b2f23-e6ce-4963-ad5b-c5d09ac598a6, both version1.12.3 with null revisions.
A successful deploy trigger has not proved a rollout.

## Integration evidence

The real host fixture passed3/3 checks in9.69s: explicit acceptance, one provider
prompt and one user message across duplicate submissions, completed response,
exact cancellation once, a newer ordinary task surviving repeated old-call End,
and hosted account/origin/capability isolation. Providers were owned offline
fixtures; no user credentials or real work were sent. Initial fixture errors
(optional seeded-bot activity and a non-hosted fixture configuration) were
corrected before this receipt.

Packaged server smoke passed14/14 after a fresh bundle, including owned HTTP,
proxy paths, native database, build identity and app/root delivery. Runtime was
Node22.22.3 arm64 macOS; package metadata asks forNode>=23.4, so this receipt
is not a Windows/Linux runtime claim.

Browser regression:39/39 passed in4.1minutes with owned fixture cleanup.
Electron lifecycle/updater:28/28 passed. Broker:2/2 passed. Both TypeScript
checks, full lint, Electron syntax and diff whitespace checks passed.
These checks do not exercise an installed Windows/Linux/Android app.

Full Vitest: **313 files /4632 passed /8 skipped /0 failed**,485.90seconds,
exit0. Previous baseline309/4556/8: four added test files and76 added passing
tests, no decrease. Log:`/tmp/muster-loop139-unit.log`.
