# Muster companion (Android)

The companion pairs with a running Muster desktop sidecar to read transcripts,
answer approval cards and send tasks. Its Expo 52 / React Native 0.76 implementation
contains manual address/code pairing, pasted invitation pairing, roster and chat
screens. QR scanning and automatic deep-link delivery remain unimplemented.
Native installation and real-device streaming require separate verification;
passing the tests below
does not establish those results or Play Store availability.

## Standalone development and checks

This npm package is outside the repository's pnpm workspace. Use its committed
`package-lock.json`; the root web/server tests and typechecks do not cover it.
Use Node 22 or newer, npm, and an Android SDK/JDK for native builds.

```sh
cd android-companion
npm ci
npm run verify:toolchain
npm run verify:metro-assets
npm run verify:autolinking
npm test
npm run typecheck
npm run lint
```

Jest 29 runs the pure protocol and session-controller tests in Node using the
SDK-compatible Babel preset. HTTP, byte readers and credential persistence are
injected fixtures. Native Expo modules are composed in `useCompanion`; they are
not mocked as evidence that an Android device works. The package declares its
own test tools and Zod parser dependency. The repository's additional custom
lint rules are checked separately from its root.

The tests cover wire parsing, HTTPS and IPv6 addresses, pairing responses,
HTTP acceptance, stream status and cancellation, replay cursors, and session
isolation during delayed requests and credential writes.

## Pairing with your computer

In the desktop app, open **Settings → Companion → Set up a phone** (or
**Pair another phone**). Copy the pairing link into the phone's first field,
or enter the displayed address and six-digit code. The desktop's cloud/account
sign-in codes are a separate flow and do not pair this companion.

Pasting never sends a request. The screen shows the destination and waits for
**Pair with computer**. Current token invitations and explicit legacy code-only
invitations are supported. A malformed token never falls back to an embedded or
typed code. Leading zeros in codes are preserved. Immediate repeated submits
share one pending attempt; fields stay fixed until it settles, and failures keep
the input for retry. The form scrolls and uses native safe-area insets; native
keyboard/layout acceptance is separate from its React host tests.

## Pinned toolchain dependencies

The lockfile uses tar 7.5.22, PostCSS 8.5.28 and UUID 11.1.1. Expo's older
xmldom branch is overridden to 0.8.15; the existing 0.9.12 branch is retained.
The unused React Navigation packages are removed, including their old URI
decoder dependency. The remaining native support packages are unchanged.

Expo CLI 0.22.28 expects tar's old CommonJS default export. The patched tar
release exposes a namespace instead, so `npm ci` runs a local `postinstall`
step that adjusts exactly two generated Expo archive imports. The preparation
script verifies the package versions and original or already-prepared file
hashes before writing. Unexpected upstream bytes fail installation and require
review; it does not silently patch a newer Expo release. Revisit this small
compatibility patch when upgrading Expo.

When deliberately disabling all dependency install scripts, run the reviewed
local preparation step explicitly:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run prepare:toolchain
npm run verify:toolchain
```

The offline compatibility checks exercise Expo's JavaScript archive fallback,
local template extraction, plist parsing, UUID consumers and Metro's PostCSS
path with owned fixtures. They complement the app tests and Android export;
they do not prove native installation or device behavior.

Metro's `image-size` dependency **is the owned parser in `vendor/image-size/`**,
declared as an npm workspace so `node_modules/image-size` links to it and the
registry package is never installed. It has no ICNS, JXL, HEIF (including AVIF),
JP2 or AVIF parser at all; the formats it reads are PNG, JPEG, GIF, BMP and WebP.
Metro's parent process and complete Expo transform worker additionally disable
ICNS, HEIF, JXL and JXL-stream dimension parsing through `disableTypes`,
including content renamed with a supported extension such as `.png`, so a refused
format is named before any parser is consulted. Use PNG or JPEG for companion
images. The worker retains Expo's transforms and cache key, adding the local
policy bytes so a policy change invalidates cached transforms.

The policy is reviewed for Expo Metro config 0.19.12, Metro 0.81.5 and image-size
1.2.1, and it requires Metro to resolve that parser from `vendor/image-size/`;
a version change **or** a resolution that lands anywhere else (including outside
the repository) stops Metro until the policy is reviewed. The bounded
child-process checks exercise refusal of the known ICNS/JXL/HEIF/JXL-stream
inputs through Metro's buffer and file asset APIs — with the policy loaded and
with no policy at all — alongside ordinary PNG/JPEG dimensions. They are a
build-tool mitigation, not a general image sanitizer or a device-runtime check.
Asset plugins and a Babel-only transformer are too late to apply this policy.

The two upstream image-size advisories are still reported by `npm audit` even
though the vulnerable implementations are no longer in the tree: the alert keys
on the package name and on Metro's declared range, and npm cannot compare a
non-registry version (it renders the range as `*`). Whether the Dependabot
alerts close on the linked workspace entry has **not been observed** — no scan
has run since the change. Nothing here is a whole-project security assessment,
and native packaging may use other image tools that require their own
verification. See `vendor/image-size/README.md` for the full record.

Native autolinking is confined to this package's installed dependencies,
including Expo's nested SDK modules. Expo 52 runs parts of discovery from the
generated Android directory, so the local config plugin gives Gradle absolute
paths derived from that project's root. Keep both the package search paths and
the registered plugin when regenerating native projects. The plugin rejects
unrecognized templates instead of silently linking unrelated ancestor packages.
The standalone autolinking checks complement actual Expo prebuild/native builds;
they do not establish device behavior.

## Runtime transport

The native composition explicitly imports `fetch` from `expo/fetch`, available
in SDK 52 with download streaming. Its response body provides a reader; the
SDK 52 React Native global fetch is not assumed to do so. See the
[Expo SDK 52 release notes](https://expo.dev/changelog/2024-11-12-sdk-52).

Unsuffixed hosts and explicit HTTP addresses default to the local sidecar's
port 8810. HTTPS addresses default to 443. Explicit ports are preserved. Use
brackets around IPv6 input, for example `https://[2001:db8::1]:8443`.
Addresses contain a host and optional port, without credentials or URL paths.
Previously saved connections without a scheme retain HTTP behavior.

The UI becomes connected only after a successful event-stream response with
an available reader. EOF and failures show a disconnected state before retry.
Stopping aborts the request, cancels/releases its reader, and clears retry timers.
An authentication failure is distinct from an unknown wire event. Unknown event
kinds remain harmless; malformed REST envelopes fail instead of erasing the
current roster. Valid neighboring messages and bots survive malformed entries.

Read status follows the visible conversation's bot or room ID. Android sends
the owner's read endpoint an explicit JSON object, which Expo's native POST
transport requires. An unread owner stays unread until the server broadcasts
the change or accepts the still-current request. Other owners keep their flags,
including owners sharing a thread ID.

Leaving the conversation, backgrounding the app or losing Android window focus
ends that active view and cancels pending reads. Returning, reconnecting or
receiving new work while viewing reconciles read status again. Pending events
share one request at a time per target; a newer event cannot be cleared by an
older response. Each request has a ten-second deadline. Transient errors get
at most three attempts, with 500ms and 1s retry delays, then wait for explicit
retry or a new foreground/reconnection. The screen explains a failed read sync
and offers **Retry read status** independently of the message composer. Losing
the connection's authorization returns to pairing. This is shared owner-level
read state, not per-message read receipts.

## Questions and permissions

Live questions show their actual choices and accept a custom answer. An option
named Allow or Deny is still answer text; custom text preserves whitespace.
Tool permissions use explicit **Allow once** and **Deny** decisions. Pending
operations disable repeated actions, and a delivery outcome is kept until the
server's settled card arrives. An unavailable request is shown as undelivered,
even when its HTTP response was successful.

The latest request and streaming reply sit beside the composer. The transcript
remains chronological in storage; older history loads at the far end of the
inverted conversation list.
The roster's waiting count uses unanswered live cards in current conversations,
including the active room speaker. Old notifications remain in history without
being counted as pending approvals.

Failures preserve the question draft and expose **Check status**. Checking only
refreshes the conversation; it never sends the decision again. Retrying an action
requires another explicit choice. Callbacks cannot act on a changed request,
another account, a hidden branch or a different room speaker.
An ambiguous connection failure reports uncertain delivery without claiming the
computer is stopped; a confirmed refusal retains the computer's response detail.

An eligible direct bot may offer **Always allow this tool** with the exact
server-provided grant. The companion saves that preference before sending the
permission decision, then rechecks the current card and foreground conversation.
If the preference is accepted but the following response fails, the screen says
the preference was saved; that accepted change is not automatically rolled back.
Persistent grants are not offered for room requests.

Onboarding cards without a provider request ID currently show their choices as
transcript content and direct the user to the computer. Their persistence and
first-task submission need a separate narrow server/companion contract. Native
why/history/rehearsal evidence display also remains a separate parity slice.

## Native development gates

Loop 38 built and installed the debug APK on an owned Android 14 / API 34 arm64
emulator. Native checks covered the 392.7dp and 320dp pairing layouts, the numeric
keyboard, rejected-code recovery, full invitation copy/paste, pairing, send
failure/retry, event-stream reconnect and connection restoration after a full
app-process restart. The sidecar used the actual pairing registry and proxy with
a synthetic fleet and replies. This is emulator evidence, not real-model,
physical-device, release-variant or store acceptance; see the CEO log for counts
and retained failures.

Loop 39 reproduced the native bodyless-POST failure and verified the corrected
bot/room read routes against actual server persistence and another paired device's
event stream. The owned debug emulator also exercised leaving the chat,
backgrounding, cancellation and bounded failure/retry at 320dp. Synthetic failure
and hold controls surround an unmodified server; successful reads reach its real
store. This does not establish cloud-account isolation or production acceptance.

Loop 40 recorded 58 accepted native card checks: three initial seed/pairing
checks, 49 live-card/recovery checks, and six final roster/error-copy rechecks.
One initial selector failure remains in the raw evidence with its correction.
The real server and permission broker received exact answers and ordered grants;
an offline CLI supplied the requests without real model or tool execution.
The final Android suite passed 367 tests across eight suites. See the CEO log for
source phases, response-loss boundaries, retained setup errors and cleanup.

The generated debug manifest's HTTP allowance does not prove local HTTP pairing
in a release build. Inspect the merged release manifest and test a bundled release
variant before distribution. Live question/permission behavior is distinct from
no-request onboarding cards; the latter still require their write contract.
The development reload also hit a React Native HostTarget assertion during setup;
cold launches worked after selecting the owned Metro address.

```sh
npm start
# With a compatible Android SDK, emulator/device and Expo development setup:
npm run android
```

Use an SDK-52-compatible Expo Go or development build; current Expo Go versions
may require a newer SDK. The local native command generates/builds native projects
and installs the app, so run it only for an owned emulator or selected device.
A real-device check must cover manual pairing, local-network reachability,
HTTPS certificates, streaming reconnect and unpairing. QR permissions and scanning
belong to a future scanner implementation.

The existing EAS configuration and remote build scripts are not release gates
verified by these tests. Signing, EAS project setup and store distribution need
a separate release slice. The obsolete `expo build:android` command is not used.

## Boundaries

Pairing credentials use `expo-secure-store`. The sidecar's route allowlist controls
access: this client reads transcripts, sends messages and answers approvals. It
does not manage desktop API keys or drive the computer. Camera dependencies exist,
but neither a scanner UI nor automatic deep-link delivery is wired. Paste a
pairing invitation or enter the address/code instead.
