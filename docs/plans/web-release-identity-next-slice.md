# Next slice: identify the web and server build without changing the workspace

Loop81 audited handoff, 12 September 2026. Read current-state.md and the web stability
contract first. This is proposed work, not an implemented release capability.

## Reproduced diagnostic gap

The live app entry filenames differ from this Mac's build. That alone cannot tell
us whether production is old: build inputs/environment may differ. Health GET,
git push, Actions state and desktop version also do not identify the serving web
and backend revision. One registered webhook fails404 while another path delivered
the Loop79 static repair and Loop80 recovery UI. Do not replace the layout or trigger repeated deploys to
guess which revision is running.

## Bounded implementation

1. Inspect vite.config.ts, scripts/bundle-server.mjs, server/index.ts, Dockerfile
   and Dockerfile.cloud. Produce one explicit, non-secret build identity for both
   web and backend outputs. Include the intended source revision and a content
   fingerprint; do not label a dirty build as that clean commit. Development,
   missing Git metadata and legacy artifacts must report unknown/unverified
   honestly. A Docker context may exclude .git, so do not assume it exists.
2. Provide read-only JSON diagnostics for the actually served web generation and
   actual running backend artifact. Separate intended source metadata from observed
   artifact hashes. Avoid self-referential manifest hashing. No access tokens,
   environment values, usernames, paths or credentials in the public response.
3. Keep the normal UI unchanged. Any diagnostic belongs in existing troubleshooting
   surfaces. A mismatch must never automatically reload the page, clear a draft,
   reset a session, replace the mascot or switch /app and /os.
4. Reconcile build identity with packaged server and Electron resource lookup.
   An unknown older installation must remain usable. Do not call this signed
   attestation, a secure supply chain, or native runtime acceptance.
5. Repair deployment configuration only after authenticated Dokploy access exists.
   Identify its real active application and trigger path before editing the failed
   hook. Do not invent an endpoint, rotate secrets or run the unsafe deploy script.
   Keep Actions billing failure distinct from local verification and live GET proof.

## Audited integration points

The parallel Loop81 source audit changed no runtime files and ran no tests.
These references describe the existing implementation, not completed identity work.

| Integration | Required behavior |
| --- | --- |
| `vite.config.ts` | Add a build-only producer, inert during development and Vitest. Test configuration lives here; there is no separate root Vitest config. Preserve preview process pinning and HMR exclusions. |
| `scripts/bundle-server.mjs` | Hash emitted JavaScript only after the final `rewriteSpecifiers` pass (currently line179). Bake package version and a validated build identifier into the bundle; the runtime cannot assume package.json exists beside it. |
| `server/proxy-paths.ts` | Reuse the existing module-relative `SERVER_ROOT` convention. Bundled helpers can inherit the entry module's import.meta URL; never resolve metadata from CWD. |
| `server/index.ts` | Keep loaded backend identity fixed for the lifetime of that process; separately observe the actual `OMB_STATIC_DIR` generation and disk changes. Health currently reports process/protocol data, not build identity. |
| `server/auth.ts` | Public API exceptions are explicit. If diagnostics are public, allow only the exact read-only route, retain host/origin checks and reject other methods. Do not add a broad public prefix or expose settings/account state. |
| `server/legal-pages.ts` | `withVerificationMeta` changes served HTML. Label a raw index.html digest as an on-disk artifact hash; it is not necessarily the GET response hash. |
| `electron-builder.yml`, `electron/main.mjs` | Existing resource rules copy dist to Resources/ui and dist-server to Resources/server. The fork supplies that static root; sidecars inside those outputs need no extra resource rule. |
| `build/prepare-electron-native.mjs` | afterPack rebuilds copied SQLite files. A backend JavaScript fingerprint does not identify the complete installed native artifact or prove its ABI works. Never rewrite shared dist-server for each target architecture. |
| `.dockerignore`, `Dockerfile`, `Dockerfile.cloud` | Git metadata is excluded. No revision build argument or verified Dokploy revision injection was found. Missing source provenance stays unknown until explicit wiring is verified. A webhook payload's commit ID is not proof of a Docker build argument. |

Separate three concepts: declared source revision/dirty status, a build identifier
embedded in loaded code, and measured artifact bytes. A supplied SHA is a provenance
claim, not proof of an identical build context. Do not call inherited dirty files
clean by silently excluding them. Do not export raw git status, environment values,
host paths, remotes, identities or secrets.

Exclude the manifest itself from its fingerprint inputs. Bound manifest size,
entry count and file sizes; reject escaping paths and symlinks outside the artifact
root. Avoid hashing an unbounded tree on every anonymous GET. Cache only with an
explicit observation time/scope and bounded change detection: replacing served
web files must not leave an old generation labelled verified. Missing, malformed,
legacy or inconsistent metadata must remain usable but visibly unknown/mismatched
in diagnostics. Reading a mutable sidecar cannot identify already-loaded code.
Even startup disk hashes are observations, not cryptographic runtime attestation.

## Acceptance and handoff

Use explicit ports, isolated data and owned process/browser fixtures. Prove that
built web and server report their actual identities; deliberately mismatched,
missing and dirty metadata must remain distinguishable. Test packaged lookup and
real GET bytes, not only a serializer. Browser acceptance must retain an exact
unsent draft and current navigation when diagnostics detect a mismatch. No forced
reloads. Run focused checks, types/lint, the full suite and packaged server gate;
report actual counts and native/production limitations.

Minimum real-fixture cases for the implementing agent:

1. Run `npm run build` and `npm run build:server`; independently hash final outputs
   after rewriting. The same declared SHA with different artifact bytes must be
   distinguishable. Check missing Git, dirty inputs and malformed metadata.
2. Extend `scripts/smoke-packaged-server.mjs` with an owned Resources-like tree
   containing both server and UI, no adjacent package.json, and explicit static
   root. The existing smoke stages only the server and does not exercise web lookup.
3. Hold that owned process open, replace only its staged web generation, and prove
   the backend identifier stays fixed while web observations change. Missing old
   metadata must not break the app. Include traversal, oversized metadata and the
   HTML verification-meta transformation in actual GET acceptance.
4. Browser-check that reading diagnostics and observing a mismatch preserve the
   exact unsent draft, selected task and route; no reload, sign-out or shell switch.
5. Run focused tests, types/lint, E2E types, browser acceptance and full `npm test`.
   The latter includes broker, updater and rebuilt packaged-server checks. Report
   each count. Node smoke is not installed Electron/native or container acceptance.

Do not broaden this slice into Docker repairs. `Dockerfile.cloud` currently omits
e2e files imported by build-time server tests and uses Alpine user-management flags
on a Debian base. Those separately recorded defects prevent claiming that cloud
container path validated. Likewise deployment billing/hook repair needs its own
verified configuration and receipt; build metadata alone does not repair it.

Current full baseline:254 files/3862 passed/8 skipped. Loop80 cleanup browser 3/3;
its receipt-based Stop recovery does not survive refresh/server restart. Preserve
all 12 inherited files and original stash using the latest Loop81 preservation/
restoration receipts (Loop80 remains the original hash baseline). Preserve the
existing paused automation. Update the ledger, CEO log and current state after
one verified slice, then commit/push on main and verify production with GET only.

Other release gates remain: durable Stop/crash recovery; the outstanding peer
owner-merge/setup/restart acceptance; real Google consent; complete sync/backup;
VM execution; native signing and physical-device acceptance; Mimosa; and the two
Android Metro/image-size high alerts (see ceo-log Loop92). The vulnerable code is
now replaced in-repo — the parser at `android-companion/vendor/image-size/` is
wired in through the workspace link and the registry copy plus `queue` left the
lockfile — but `npm audit` still reports both, and whether Dependabot closes them
has not been observed from this machine. If it does not, the fallbacks are a
documented dismissal or Metro ≥ 0.87.1 via the Expo/RN upgrade.
