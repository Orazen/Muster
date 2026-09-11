# Muster companion (Android)

The companion pairs with a running Muster desktop sidecar to read transcripts,
answer approval cards and send tasks. Its Expo 52 / React Native 0.76 implementation
contains manual address/code pairing, roster and chat screens. QR scanning and
deep-link handling remain unimplemented. Native installation and real-device
streaming require separate device verification; passing the tests below
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

Metro's parent process and complete Expo transform worker disable ICNS, HEIF
(including AVIF), JXL and JXL-stream dimension parsing, including content renamed
with a supported extension such as `.png`. Use PNG or JPEG for companion images.
The worker retains Expo's transforms and cache key, adding the local policy bytes
so a policy change invalidates cached transforms. This uses the installed parser's
`disableTypes` API and does not edit its dependency files.

The policy is reviewed for Expo Metro config 0.19.12, Metro 0.81.5 and image-size
1.2.1; a version change stops Metro until the policy is reviewed. Detection still
runs before the disabled-format check. The bounded child-process checks exercise
the known ICNS/JXL loops and rejection through Metro's buffer and file asset APIs,
alongside ordinary PNG/JPEG dimensions. They are a build-tool mitigation, not a
general image sanitizer or a device-runtime check. Asset plugins and a Babel-only
transformer are too late to apply this policy.

The two upstream image-size advisories still have no published fixed version.
They remain tracked even with this local mitigation; this is not a whole-project
security assessment. Native packaging may use other image tools and requires its
own verification.

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

## Native development gates

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
does not manage desktop API keys or drive the computer. Camera dependencies and
a pairing-URL parser exist, but neither a scanner UI nor deep-link delivery is wired.
