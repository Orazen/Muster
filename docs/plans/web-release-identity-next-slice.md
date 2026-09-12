# Next slice: identify the web and server build without changing the workspace

Loop80 handoff, 12 September 2026. Read current-state.md and the web stability
contract first. This is proposed work, not an implemented release capability.

## Reproduced diagnostic gap

The live app entry filenames differ from this Mac's build. That alone cannot tell
us whether production is old: build inputs/environment may differ. Health GET,
git push, Actions state and desktop version also do not identify the serving web
and backend revision. One registered webhook fails404 while another path delivered
the Loop79 static repair. Do not replace the layout or trigger repeated deploys to
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

## Acceptance and handoff

Use explicit ports, isolated data and owned process/browser fixtures. Prove that
built web and server report their actual identities; deliberately mismatched,
missing and dirty metadata must remain distinguishable. Test packaged lookup and
real GET bytes, not only a serializer. Browser acceptance must retain an exact
unsent draft and current navigation when diagnostics detect a mismatch. No forced
reloads. Run focused checks, types/lint, the full suite and packaged server gate;
report actual counts and native/production limitations.

Current full baseline:254 files/3862 passed/8 skipped. Loop80 cleanup browser 3/3;
its receipt-based Stop recovery does not survive refresh/server restart. Preserve
all 12 inherited files and original stash using the Loop80 receipts. Preserve the
existing paused automation. Update the ledger, CEO log and current state after
one verified slice, then commit/push on main and verify production with GET only.

Other release gates remain: durable Stop/crash recovery; the outstanding peer
owner-merge/setup/restart acceptance; real Google consent; complete sync/backup;
VM execution; native signing and physical-device acceptance; Mimosa; and the two
Android Metro/image-size high alerts with no fixed published upgrade at this audit.
