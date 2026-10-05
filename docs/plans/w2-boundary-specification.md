# W2 boundary specification — inert enrollment contract

Status: implemented and gated by tests. Everything in this document describes
the enrollment contract module, which ships **INERT** — see
[Production enrollment remains disabled](#production-enrollment-remains-disabled).
Line numbers refer to the current state of each file on this branch after this
slice; each row names what this slice changed.

Register requirement (quoted): *"Freebuff's next specification must name
canonical identity provenance, key/namespace, generation allocation/persistence,
conditional writes, absent/unknown/newer-winner cleanup, restart fencing and
race tests"* and, separately, *"protected generation-conditional native custody
and persisted restart fence."* This document is that specification, source-backed
row by row.

## The seven required seams

| # | Seam | Where it lives today (file:line) | What this slice changed |
|---|------|----------------------------------|-------------------------|
| 1 | **Canonical identity provenance** | `server/installation-enrollment-contract.ts:335` (`EnrollmentBinding`: the identity quadruple), `:387-413` (`enrollmentBindingWire`; `cloudSubject` email refusal at `:392-398`), `:218-235` (`isCanonicalIssuer` / `canonicalIssuerWire`), `:288-300` (`protectedEnvelopeWire`; envelope carries `cloudIssuer` `:293`, `workspaceId` `:294`), `:1201-1210` (begin refuses a non-trusted `cloudAuthority`, a non-trusted `cloudIssuer`, and a `clientKey` that contradicts the request), `:1430` (upstream `authority` header must equal the trusted issuer). Recorded identity decision: `docs/plans/beta-acceptance-matrix-2026-09-19.md:99` — use the verified provider `sub` as provider identity, not email; **ID-token validation (issuer/audience/expiry/nonce) stays in the ID-token layer**; only the canonical issuer STRING enters this contract. No JWT parsing exists or was added here. | Added `cloudIssuer` (strict HTTPS origin: lowercase host, no path/query/fragment/userinfo/default port — non-canonical spellings are REFUSED, never normalized) and `workspaceId` to the binding and envelope, alongside the pre-existing `cloudSubject` (still not an email) and `clientKey`. A canonical-but-foreign issuer is refusal `issuer` (`:1206`); a malformed one is refused at the schema (`:1184-1190`); `EnrollmentFailure` gained the distinct `issuer` code (`:113`). The binding now names the full quadruple `{cloudSubject, cloudIssuer, workspaceId, clientKey}` so a custody adapter receives complete provenance. Envelope version 2 → 3 (`:247`). An ENABLED engine cannot be constructed against a non-canonical trusted issuer (`:1150-1152`). |
| 2 | **Client-key namespace** | `server/installation-enrollment-contract.ts:308-313` (`enrollmentRequestWire.clientKey`, 16–256 chars) and `:408` (binding `clientKey`, same bounds); the client key is the ONE namespace every custody row, fence entry, intent and generation is keyed by (`EnrollmentIntent` `:447-477`, `CustodyRequest` `:161-172`, `ProtectedCredentialStore` methods `:184-200`). | The binding now carries `clientKey` itself (`:408`) and begin refuses a binding whose key contradicts the request's (`:1210`, refusal code `client-key`) — a binding can no longer quietly name a different device than the one it is begun for. The namespace itself is unchanged: one flat, caller-chosen, request-provided key; no scoping, prefixing or namespacing operator was added. |
| 3 | **Generation allocation/persistence** | Enrollment custody generations: allocated atomically by the attempt store inside `putIntentWithGeneration` (`server/installation-enrollment-contract.ts:749`, synthetic impl `:790-807` — supersede, allocate, stamp and persist in ONE indivisible step; never inferred from a shared counter afterwards); declared on `EnrollmentIntent.generation: string` (`:458`); newest-generation readable via `generationFor` (`:775`); monotonic announcement via `noteGeneration` (`:609`, monotonic impl `:609-613`). | NOT changed by this slice — deliberately. The three generation domains stay separate (see table below); this slice touched none of them and unified nothing. |
| 4 | **Conditional write / invalidation** | `server/installation-enrollment-contract.ts:169-185` (`ProtectedCredentialStore.commit(request, expectedGeneration)` — the adapter MUST make the write conditional on the generation the caller holds; `invalidate(clientKey, generation)`); compare-and-claim `claimIntent` (`:763`, impl `:821-840` — single-use only for an unclaimed, live, newest row); post-commit guard and cleanup (`:1500-1531`). | NOT changed by this slice. The generation-conditional commit contract is exactly as it was; the persisted fence (row 6) adds a second, durable refusal input on the same paths. |
| 5 | **Absent / unknown / newer-winner cleanup** | `server/installation-enrollment-contract.ts:954-957` (`CustodyRead`: `present`+generation / `absent` / `unknown` — a bare null conflating "absent" with "read failed" is what made a fault look like cleanup), `:959-996` (`cleanupCommittedRecord`: invalidate, re-read EXPLICITLY, accept only explicit absence or a demonstrably different committed generation), `:944-952` (`CleanupOutcome`: `removed` / `superseded-winner-kept` / `unresolved`), `:998-1001` (`unresolved` — the ONE place a fence is armed on every unresolved path). | Signature-only change: `cleanupCommittedRecord(deps, intent, fence)` and `unresolved(fence, clientKey)` now arm the fence through the engine's fence REGISTRY (so a per-engine registry — e.g. a freshly restarted instance — fences into its own durable store) instead of the module-global Set. Semantics unchanged. |
| 6 | **Restart fence (persisted)** | Port: `server/installation-fence-persistence.ts:58-70` (`FencePersistence`: `read(): string[]`, `add(key, {reason}?): void`, `clear(): void`, `readonly degraded: boolean`), file-backed impl `:111-212` (`FileFencePersistence`: lazy single load, build→write→adopt), `:93` (`defaultEnrollmentFencePath()` = `DATA_DIR/enrollment-fence.json`, DATA_DIR per `server/data-root-path.ts:9`), durable write `:251-263` (temp file O_EXCL\|O_NOFOLLOW 0600 → fsync → rename → directory fsync; house pattern from `server/drive-visible-account-restore-journal.ts` `durable()`), reads refuse symlinks and verify the opened inode (`:163-193`). Contract wiring: registry `server/installation-enrollment-contract.ts:1021-1086` (`FenceRegistry`; memory Set = fast path, persistence = authoritative across restarts, fail-closed on degraded/faulted reads), lazy file-backed default `:1088-1095`, injection seam `setEnrollmentFencePersistence` `:1109-1114` (replaces registry AND memory — the restart seam), module API `:1125-1141` (`resetEnrollmentFences` clears both; `isEnrollmentKeyFenced` consults memory AND store; `fenceEnrollmentKey` persists before returning), per-engine injection `EnrollmentEngineOptions.fencePersistence` `:917-928` (factory option, `createEnrollmentEngine` `:1144-1157`), enforcement: begin `:1231`, guard `:1338`, synchronous re-reads with no intervening await `:1399`, `:1458`, `:1508`, adoption boundary `:1523`, adapter-seam defence-in-depth `:634`. | NEW. The fence was an in-memory `Set<string>` cleared by every restart — the exact event the record it guards against survives. Now: `fenceEnrollmentKey`/unresolved-custody persist (synchronously, fsynced) BEFORE returning; a NEW contract instance over the same file observes a prior instance's fences (restart property, proven by tests); `resetEnrollmentFences` clears memory AND the durable store. **Fail-closed choice:** a fence file that exists but cannot be parsed/validated/safely read makes the store `degraded` — contents UNKNOWN — so EVERY key counts as fenced (absent cannot be distinguished from fenced) and the store accepts no writes (overwriting unknown contents would lift invisible fences); only the explicit owner action (`resetEnrollmentFences` → `clear()`) rewrites a valid empty file and heals. A MISSING file is unambiguous and healthy-empty. **No await was introduced on any fence path** — the store API is synchronous, so the LATE-FENCE / COMMIT-WINDOW microtask reasoning in the contract is untouched. |
| 7 | **Planned/proven race tests** | `server/installation-enrollment-contract.test.ts:1819` (`describe("W2 — persisted restart fence and canonical issuer binding")`): (a) fence survives a restart into a fresh engine instance over the same persistence file + module-API restart seam; (b) a completion still holding the NEWEST generation loses to the persisted fence after a restart, and a superseded generation still loses to a newer one after a restart; (c) reset clears the DURABLE fence, not just memory; (d) corrupt fence file fails closed until an explicit reset heals it, for every unparseable/unvalidated shape; (e) issuer mismatch (`issuer`), non-canonical issuer spellings, contradicting `clientKey`, and enabled-engine construction against a non-canonical issuer; (f) a fence written to the durable store by ANOTHER registry instance during a held commit stops adoption. Store-level unit suite: `server/installation-fence-persistence.test.ts` (format, durability discipline, no temp leftovers, cross-instance visibility, corrupt/symlink/oversize fail-closed, heal-by-clear). Pre-existing interleavings retained: `R1-R6`, `B1-B3`, `FENCE`, `LATE-FENCE`, `COMMIT-WINDOW`, `POST-EXCHANGE` (same file, lines 888-2129). | NEW. All race cases use the same harness idioms the existing suites use (held gates, microtask arming, live-context mutation); the 12 W2 cases add only the durable-store dimension, on top of the 76 pre-existing cases. |

## The three generation domains stay distinct

The register's standing rule is preserved: these are SEPARATE domains with
separate types and separate persistence. Nothing in this slice unified them by
name, type or storage, and nothing may.

| Domain | Owner | Type | Persistence | Lives at |
|---|---|---|---|---|
| Installation REGISTRY generation | `server/installation-authority.ts` (device/authority lane) | `number \| null` (`null` = legacy row, first transition mints 1) | Persisted per row inside the installation registry file (`registryPathFor` → `DATA_DIR/installation-registry.json`) | `server/installation-authority.ts:68` (field), `:87` (wire, defaults null), `:125` (path), `:393` (`beginTransition`) |
| Enrollment CUSTODY generation | `server/installation-enrollment-contract.ts` (this lane) | `string` (allocated by the attempt store, stamped on the intent, carried into `commit(request, expectedGeneration)`) | Persisted per INTENT ROW by the injected `EnrollmentAttemptStore` (in this build the only implementation is the synthetic in-memory one; a durable store is the integrator's seam) | `server/installation-enrollment-contract.ts:458` (type), `:749-775` (allocation contract), `:180` (conditional write) |
| Native ATTEMPT counter (macOS sign-in) | `macos/Sources/MusterMacCore/NativeSignInCoordinator.swift` (desktop lane) | Swift `Int`, monotonically increasing, per-coordinator, in-memory | NOT persisted — an app restart legitimately resets it; it orders sign-in ATTEMPTS within one process, it does not fence custody | `NativeSignInCoordinator.swift:66` (`Attempt.generation`), `:105` (`private var generation = 0`) |

They share a vocabulary word and nothing else. A future native custody adapter
must map the ENROLLMENT custody generation (string) into its own protected
storage — it must not read or write either of the other two counters.

## Native (Swift) custody mapping prerequisites

What the native protected-custody adapter must satisfy when it exists (none of
it is implemented or claimed in this slice):

- Conform to `ProtectedCredentialStore` (`server/installation-enrollment-contract.ts:169-185`):
  `commit` must be CONDITIONAL on `expectedGeneration` (a post-write boolean
  check is not enough — a write landing after invalidation must not survive a
  restart); `read` must return the three-way `CustodyRead` (`:954-957`), never a
  bare null, and must report the generation the stored row was committed under.
- The envelope it seals is version 3 (`:247`, wire `:288-300`) and carries the
  full binding quadruple via `CustodyRequest.binding` (`:167`) — the native side
  receives `{cloudSubject, cloudIssuer, workspaceId, clientKey}` plus owner and
  session bindings, and must not accept a record that predates any of them.
- The credential exists ONLY inside the sealed payload (`CustodyRequest.credential`,
  `:161-172`, field at `:165`); it never appears on the envelope, in outcomes, or in logs.
- Fencing: the adapter may keep its own fence, but the contract's fence is now
  durable (`installation-fence-persistence.ts`) and is the cross-restart
  authority; a native implementation must honor `begin`'s persisted-fence
  refusal (`:1231`) rather than re-opening fenced keys.

## Production enrollment remains disabled

`enrollmentEnabled = false as const` (`server/installation-enrollment-contract.ts:59`).
Nothing may import the contract module except its own test file; verified this
slice: the only importer of `server/installation-enrollment-contract.ts` in the
repository is `server/installation-enrollment-contract.test.ts`. No route, no
dispatcher, no wiring was added; `ENROLLMENT_PROTOCOL_VERSION` is still 1
(`:64`) and the inert exports (`beginEnrollment`/`completeEnrollment`) still
refuse with `disabled` on every path. Enabling enrollment remains an explicit
code decision by the integrator, made after native custody is accepted.

## Still NOT claimed (owned by other lanes)

- **No native adapter.** Nothing here implements macOS/Keychain/protected-store
  custody; `MemoryProtectedStore` is a test fake that declares
  `conformsToProtectedCustody = false`. The Swift coordinator was only READ, to
  keep the three generation domains distinct.
- **No live restore.** No account/Drive restore flow, no real cloud exchange,
  no ID-token acceptance — `exchange` is an injected seam and every identity in
  the suites is synthetic.
- **No host-wide exclusivity.** The fence file has no locking, no watching and
  no cross-process writer election: within one process, one shared registry
  instance is the writer; visibility of another PROCESS's write requires a
  freshly constructed instance (a restart). A host-wide exclusive-fence lane
  (single-writer lease, cross-process notification) is not built here and is
  not claimed by the word "persisted".
- **No durability proof under power loss.** The write path fsyncs file and
  directory (process-restart durability, matching the recovery journal's
  stated guarantee); it does not claim anything stronger.

## Verification (this slice)

- `npx vitest run server/installation-enrollment-contract.test.ts server/installation-fence-persistence.test.ts` → 102 passed (88 contract incl. 12 new W2 cases, 14 fence-store units).
- `npx vitest run server/installation-authority.test.ts` → 29 passed (adjacent suite unbroken).
- `npx tsc --noEmit -p tsconfig.server.json` → exit 0.
- `npx oxlint` on all four touched files → 0 warnings, 0 errors.
