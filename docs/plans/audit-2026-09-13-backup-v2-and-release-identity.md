# Backup v2 prototype and release-identity audit — 13 September 2026

Read-only audit of this checkout at `22a7011a23a43c289c7b21fd594ef592fefce27e` plus the
uncommitted working tree, followed by one implementation slice. No git state was mutated:
the tree is left as found plus the two new files and three documentation files named below.
Nothing here is a production observation, and nothing here is a security assessment.

## Scope and method

The audit read the v1 backup module, its routes, the transcript store, the uncommitted
release-identity slice and the plan documents that describe them. It ran no provider, no
packaged app and no production request. The implementation slice that follows from it is
`server/workspace-bundle-v2.ts` plus `server/workspace-bundle-v2.test.ts`, both inert: no
route imports them (`grep -rn "workspace-bundle-v2" server/index.ts` is empty).

## What the audit found

**Build identity is implemented, uncommitted, and validated only locally.** The slice exists
as untracked files and edits: `server/build-identity.ts` (Zod-parsed observer),
`scripts/build-identity.mjs` (build-time producer), `scripts/bundle-server.mjs` (defines
`__MUSTER_BUILD_IDENTITY__` and writes the manifest), `vite.config.ts` (web plugin),
`server/index.ts:6753` (`GET /api/build-identity`) and `server/auth.ts:731` (public path).
Its tests are `server/build-identity.test.ts` (5 cases) and
`server/build-identity-producer.test.ts` (11 cases). `docs/plans/current-state.md:43-47`
already records it as implemented, locally tested and not deployed.

**The lint state of that slice was cleaned up in the same working tree, and the cleanup is
load-bearing.** Removing the three `oxlint-disable-next-line anti-slop/no-runtime-typeof`
comments from a copy of `scripts/build-identity.mjs` (lines 12, 32, 58) reproduces 3
`anti-slop/no-runtime-typeof` errors under the repository config. This pass could not
re-derive the pre-cleanup revision itself — the files are untracked and carry no history —
so the claim "lint was red before the rewrite" rests on that reproduction and on the rewrite
in `server/build-identity.ts:20-49`, not on a captured log. Current state: `npx oxlint .`
exit 0, one pre-existing warning (`server/index.ts:3440`).

**The v1 backup cannot leave its installation.** `server/workspace-bundle.ts:39-40` derives
the key from `scryptSync(\`${passphrase}:${secret}\`)`, where `secret` is
`BETTER_AUTH_SECRET` or `DATA_DIR/auth.secret` — the same signing secret as
`server/auth.ts`. Losing that secret makes a bundle unreadable with the correct passphrase
(`docs/plans/portable-backup-contract-2026-09-12.md:26`). Restore is incremental with no
transaction across the fleet and the files, keeps whichever side exists first
(`workspace-bundle.ts:242-263`), and validates records loosely
(`workspace-bundle.ts:193-199`, `183-190`). Transcripts are absent from v1 entirely: the
live store is `messages` / `thread_state` in `server/message-db.ts:40-56`, which no v1
bundle reads (`docs/plans/portable-backup-contract-2026-09-12.md:14`).

**Documentation counts and capability rows had drifted from the code**, and the working
tree corrects them: `docs/plans/current-state.md` (the baseline restated as 258 files /
3899 passed / 8 skipped at `22a7011` plus the identity slice, and the identity slice moved
from "next" to "implemented, undeployed"), `docs/plans/astra-gpt6-mvp-brief.md` (Fleet MCP
6→8 tools, 13/13→67 tests, approval hotkeys A/B/C/D→A–F, routine shapes),
`docs/plans/portable-backup-contract-2026-09-12.md:31` (Google pull now stamps success only
after download, decrypt, restore, provider reload and broadcast, `index.ts:7319-7341`).
Two smaller truth edits ride along: `.gitignore` (agent tool-state directories) and
`package.json` (`engines.node` `>=22` → `>=23.4`, matching the `node:sqlite` dependency in
`server/message-db.ts:15`).

## What this slice adds

`server/workspace-bundle-v2.ts` (1124 lines) implements the portable format the contract
asks for and stops short of the destructive half:

| Piece | Line | Behaviour |
|---|---|---|
| `LIMITS` | `:57-65` | the seven declared bounds, checked before allocation |
| `isSafeRelativePath` | `:90-100` | the single rule every stored path must satisfy |
| `buildPayloadV2` | `:585-607` | reads the v2 subset; writes only its own temp snapshot |
| `encryptBundleV2` | `:619-660` | passphrase-only KDF, header as associated data |
| `decryptBundleV2` | `:839-852` | statuses, never throws |
| `verifyBundleV2` | `:925-1003` | 11 named checks, `VERIFY_CHECKS` at `:880-892` |
| `planRestoreV2` | `:1030-1071` | dry run; `writesNothing: true` |
| `selftest` | `:1083-1124` | four invariants, no I/O |

`server/workspace-bundle-v2.test.ts` (540 lines, 15 cases) builds fixtures with the real
`messages`/`thread_state` schema, including a thread whose newest row (`m4`) is not its
recorded head (`m2`).

## Format decisions and why

- **Passphrase-only recovery.** The installation secret may be recorded for diagnostics at
  most; it is not a KDF input. Test two deletes `auth.secret` and `messages.db` after export
  and still verifies the bundle, which is the property v1 cannot have.
- **KDF parameters in the envelope.** `{name, N, r, p, keyLen, saltB64}` is authenticated
  header data (`:256-279`), so the default can move without orphaning old bundles, and a
  hostile envelope cannot ask for an unbounded scrypt run (`kdfProblem`, `:296-304`).
- **Header as associated data.** The canonical sorted-key header minus `ciphertextB64` is
  the AAD (`:256-279`, `:646`, `:797`). `cipher.tagB64` is also excluded because the tag
  does not exist when the AAD is set; it is covered by the tag itself.
- **`VACUUM INTO`, then read the copy.** A snapshot is the only consistent read of a WAL
  database another process is writing (`snapshotTranscript`, `:548-583`), and a database
  outside the data directory is refused before it is opened (`:550-552`). A snapshot or row
  failure records `unsupported:<reason>` with an empty transcript rather than a torn one.
- **Strict schemas at the boundary.** Envelope, payload, transcript rows and thread state
  are Zod-parsed (`:113-199`, `:499-522`); rows come from a database this module did not
  write, so they are parsed rather than asserted.
- **A skipped file is never a silent drop.** Every entry the scan walks past is listed with
  a reason (`:342-395`), symlinks included — and a symlink is reported, never followed.
- **The restore writer is deliberately absent.** v1's incremental, loosely validated,
  non-transactional restore is the exact thing the contract says must not be reused. The
  staged all-or-nothing restore (stage, verify, swap, roll back) is the next slice; until it
  exists this format has no way to change a live installation, which is why it is safe to
  land first.

## Open, not done

No restore writer; no route wiring (the module is inert); no cross-installation restore
acceptance; no UI; no production verification of anything in this document; no verification
of the uncommitted release-identity slice beyond its own tests. `counts-declared` and
`limits-respected` are never exercised as *failing* checks: both can only fail for a bundle
this module did not produce — a producer that holds the passphrase can also keep its own
declarations consistent — so the coverage for those two is weaker than for the rest and is
stated here rather than implied by a green suite. The `decryptBundleV2` branch that reports
`truncated` after a *successful* authentication is reachable only from a producer that seals
an unreadable compressed body, which the public API cannot construct, so the suite covers the
two truncation shapes it can build. No security claim is made about the format, the
installation, or the release identity work.
