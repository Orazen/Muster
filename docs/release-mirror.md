# Desktop and CLI download publication

The Release workflow publishes validated desktop and CLI downloads without replacing
the public download directory or copying new bytes over active feeds. This
document describes the filesystem contract; a passing local fixture does not
prove production routing, native installation or updater behavior.

## Inputs and gates

The workflow pins a source SHA and version, verifies that commit, builds and
checks the native artifacts, and publishes only the appropriate release state.
Mirror deployment requires a matching published stable release and a complete
payload. Drafts, prereleases, dry runs and failed gates do not deploy downloads.

`scripts/release-payload.mjs mirror` requires `ASSETS_DIR`, `RELEASE_VERSION`,
the full lowercase `RELEASE_SHA`, `REQUIRE_COMPLETE=true`, and
`RELEASE_PUBLISHED_AT` from the matching GitHub release's `published_at` field.
The timestamp is authoritative and deterministic across retry attempts.

The producer validates updater YAML, all referenced bytes, checksums and stable
aliases. Every updater URL must name a versioned immutable artifact. It writes:

- `latest.json`: version, source SHA, publication timestamp and stable hashes.
- `mirror-manifest.json`: schema version 1, version, SHA and a sorted list of
  `{name, size, sha256}` records for every transferred public payload file,
  including feeds and `latest.json`. The manifest cannot reference itself.
- `mirror-files.txt`: the exact transfer list, including the transport manifest.
  The list itself is a local transfer instruction and is not served.

Every new complete payload also requires `muster-cli.mjs`, the identical
`Muster-<version>-cli.mjs`, and `SHA256SUMS-cli.txt` containing exactly those two
file hashes. A partial draft may omit the CLI entirely, but cannot contain an
incomplete or unchecked CLI set. The checksum text is a validation input; the
served manifest contains both bundles and the stable CLI's metadata.

The macOS arm64 job runs `node scripts/build-cli.mjs` in both dry and real
builds, with pinned `RELEASE_VERSION`/`RELEASE_SHA` and `CLI_OUT_DIR=release`.
The builder checks the source package version, creates a standalone Node 22
bundle, verifies its syntax/help/version and isolated no-log behavior, then
writes the two aliases and checksums. The bundle's `--version --json` reports
its embedded version/SHA. A direct checkout reports its package version and
`sha:null`; the helper does not independently attest Git provenance.

After downloading and hash-checking staging assets, publication reruns
`node scripts/build-cli.mjs verify` with `CLI_OUT_DIR=assets` whenever the CLI
job's macOS platform succeeded. A wrong identity or failed command blocks
publication. This confirms the transferred executable, not merely a build
command's exit status. The standalone CLI still needs an existing Muster
runtime for commands that start the server; it is not a bundled server installer.

The remote command receives the locally calculated manifest SHA256 separately
from the transfer. The Python standard-library helper rechecks the manifest,
every file's bytes, current publication state and immutable filename collisions
before switching the active release. It requires Unix Python 3.9+ and `flock`;
it has no adjacent-file or third-party dependency and can execute via stdin.

## Fixed public root

The workflow uses the existing, canonical, writable `/opt/muster-downloads`
directory. It refuses symlink ancestors before creating staging. It does not
create/chown a new public root or replace the root directory inode, which could
break a bind mount. Below that directory:

```text
.incoming/<run-id>-<attempt>/      isolated candidate transfer
.generations/<kind>-<version>-<id>/ immutable snapshot and .mirror-state.json
.current                         relative link to one generation
.promotion.lock                  kernel flock; released when the process exits
latest.json                      -> .current/latest.json
latest-mac.yml                   -> .current/latest-mac.yml
latest.yml                       -> .current/latest.yml
latest-linux.yml                 -> .current/latest-linux.yml
Muster.dmg, other stable names    -> .current/<stable name>
Muster-<version>-<target>          independent immutable regular files
muster-cli.mjs                    -> .current/muster-cli.mjs
Muster-<version>-cli.mjs           independent immutable regular CLI file
```

The lock spans current-state validation, version comparison and publication.
Installers are streamed when hashing/copying. Complete versioned targets are
published before the pointer switch, and older targets are retained. Stable
aliases and feeds change through one `os.replace` of `.current`, followed by
directory synchronization. The public root inode remains unchanged.

A client can read an old feed and request its installer after promotion: that
versioned URL still resolves to the original bytes. This does not make multiple
requests to mutable stable aliases a transaction. A person can read an old
`latest.json` checksum and later download a newer stable alias. Use versioned
targets when comparing a captured feed to downloaded bytes.

## First migration and retries

An existing flat mirror must contain the complete current metadata/feeds and
platform files. Its stable-file hashes must match `latest.json`. The helper
first snapshots those old bytes, sets an old-generation pointer, and replaces
each managed flat alias with an equivalent link. Interruption during this
conversion continues to expose the old bytes; the next invocation resumes
the partial conversion. A first-ever empty mirror uses a persisted empty
generation so a retry can recognize unfinished initialization.

Older mirrors can have a flat CLI that their `latest.json` never described.
The helper snapshots those actual bytes as an auxiliary legacy file without
adding invented release provenance to the old metadata. This also works when
desktop aliases have already migrated but the CLI is still a separate file.
An equivalent snapshot exposes the old CLI until the final pointer switch;
interrupted conversion resumes from its auxiliary state. Once a release
inventories the CLI, future candidates cannot omit it or change its immutable
versioned bytes.

The next generation is fully copied and synchronized before promotion. If a
transfer, hash check or copy fails, existing feeds keep their old content.
Complete unreferenced versioned files or abandoned generations may remain after
an interruption; they are not made active. No automatic garbage collection
deletes old installer URLs or staging evidence in this implementation.

Lower versions are refused. The same version must have the same source SHA and
identical published bytes, including metadata. An identical retry preserves
the current generation and can repair a missing identical immutable target.
Conflicting target bytes are never overwritten. A candidate cannot remove a
previously published platform: because the current public mirror includes
Intel macOS, its successor must also include the verified Intel payload.

The lock coordinates this helper's writers. Before the first real migration,
ensure no older publisher is still copying directly into the mirror. There is
no override flag for downgrades or conflicting same-version builds. If a newly
published build is defective, stop further publication, preserve evidence and
prepare a higher-version correction under the release mandate. Repointing the
mirror manually is a separate operational action requiring review of actual
client behavior and release state.

## Production acceptance still required

The repository does not contain the actual download server's route or mount
configuration. The production acceptance below was executed against the real
mirror, not assumed from local fixtures.

- 2026-09-22 (v1.15.0, run 35787841535): first complete pipeline release —
  pin, four platform legs, publish and VPS deploy all green; the legacy flat
  metadata was migrated in place from actual on-disk bytes, with the short
  sha and file hashes cross-checked against the v1.13.0 tag before promotion.
- 2026-09-23 (v1.16.0, run 35833992110): second complete release. The deploy
  leg initially failed because GitHub's tag/list release endpoints served a
  stale denormalized asset list for ~20 minutes after publish while
  `releases/{id}` and the assets sub-resource were fresh; the workflow now
  downloads through the assets sub-resource, and the mirror was promoted
  through the same remote helper (generation `release-1.16.0-7d74cc5d…`).

Serving configuration verified from the public edge on 2026-09-23: internal
dot directories and state (`.incoming`, `.generations`, `.current`,
`.promotion.lock`, `.mirror-state.json`) are not served (404), and mutable
feeds plus stable binaries return `cache-control: no-cache`, so every client
revalidates aliases while versioned targets stay hash-verified through the
feeds.

Local tests use inert installer bytes, owned temporary roots, actual subprocess
interruption/locking and an ephemeral loopback HTTP server. Native updater,
installer, signing and platform acceptance gates remain separate. The mirror
does not yet copy uploaded blockmaps, so full-download fallback is expected;
successful differential updating has not been verified. CLI build/verification
runs in the source release workflow, and the mirror currently serves 1.16.0
(two consecutive candidates have passed release and deployment acceptance).
A source version bump or locally built candidate still does not publish an
installer.

References: [GitHub concurrency behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
does not guarantee release dispatch ordering; filesystem promotion therefore
also checks version order. [Linux rename semantics](https://man7.org/linux/man-pages/man2/rename.2.html)
describe atomic replacement and retained open file descriptors. These support
the implementation's local filesystem model, not a broader security claim.
