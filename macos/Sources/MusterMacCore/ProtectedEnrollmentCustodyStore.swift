// Native protected enrollment custody — the Swift mapping of the reviewed
// W2 enrollment-contract seam.
//
// CONTRACT SOURCE — mapped by the documented contract only. This file is
// written against `docs/plans/w2-boundary-specification.md` (merged via #78)
// and the server interfaces it anchors. NO server code is imported, parsed or
// depended on; the mapping is by shape and semantics, not by a shared module:
//
//   * `server/installation-enrollment-contract.ts:184-200` — the
//     `ProtectedCredentialStore` interface (`commit` at :187, `get`, the
//     explicit three-way `read` at :954-957, `invalidate` at :198, `delete`).
//     `commit` must be CONDITIONAL on the generation the caller holds: "a
//     write that lands after the caller was invalidated is still a usable
//     record after a restart", so a stale completion must never install a
//     credential over a newer winner.
//   * `CustodyRead` (:954-957) — present-with-generation / absent / unknown.
//     A bare null conflating "absent" with "read failed" is refused here too:
//     `get` THROWS on an unreadable record instead of returning nil, and the
//     explicit `read` is the only proof-of-removal primitive.
//   * The binding quadruple provenance (`EnrollmentBinding`, :335, wire
//     :387-413): {cloudSubject, cloudIssuer, workspaceId, clientKey} plus the
//     owner and session bindings and the authority string, carried as plain
//     Swift values. No JWT parsing exists or was added — validating a real ID
//     token is the ID-token layer's job (recorded decision); only the
//     canonical issuer STRING travels through here.
//   * The persisted restart fence (`server/installation-fence-persistence.ts:58-70`):
//     `read(): string[]`, `add(key, {reason}?)`, `clear()`, `degraded` —
//     fail-closed on unreadable contents, healed only by the explicit owner
//     reset, and observed by a FRESH instance over the same durable store.
//   * The custody-unresolved semantics (:998-1001, `unresolved(fence, key)`):
//     an unknown/corrupt custody read is fenced locally, never treated as
//     absence. `fence(clientKey:)` below is that local arming.
//
// SCOPE DISCIPLINE — this type maps the REVIEWED contract for a future,
// separately-authorized integration. Deliberately NOT done here:
//
//   * It does NOT wire enrollment. Nothing calls it; there is no route, no
//     view hook, no `NativeSignInCoordinator`, `SessionKeychain` or
//     `ProviderCredentialBroker` change — those files are untouched and their
//     behavior is unchanged.
//   * It does NOT enable production enrollment. The server contract stays
//     INERT (`enrollmentEnabled = false`, `conformsToProtectedCustody = false`
//     on the synthetic store); no server file was changed by this slice.
//   * It does NOT unify the three generation domains (standing rule, seam
//     table "The three generation domains stay distinct"). This store maps
//     ONLY the enrollment CUSTODY generation — the string the caller carries
//     in and the store persists per key. It never reads or writes the
//     sign-in attempt counter (`NativeSignInCoordinator.generation`, an
//     in-memory Swift Int) or the installation registry generation (a server
//     lane). They share a vocabulary word and nothing else.
//   * `ProviderSecretStore` (`ProviderCredentialBroker.swift:169`) is NOT an
//     enrollment custody adapter and is NOT reused as one; that file is
//     untouched. This file reuses its DISCIPLINES (seam-injected SecItem
//     calls, update-then-add replacement, real OSStatus surfaced, fail-closed
//     refusals) under a dedicated Keychain service so the namespaces cannot
//     collide.
//
// PERSISTENCE CHOICE — Keychain generic-password items, not an
// Application Support file. The server's `FileFencePersistence` uses a
// temp+rename+fsync file because DATA_DIR files are the server's house
// pattern; on macOS the house pattern for durable protected state is the
// login Keychain (`SessionKeychain`, `ProviderCredentialBroker`), so fences,
// custody records and the generation ledger live as generic-password items
// under dedicated services (see `Service`), with
// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` so custody state never
// travels in device backups. Per-key items map 1:1 onto per-key rows and
// fences, and process-restart durability is the Keychain's own guarantee —
// the same process-restart scope the server fence claims (no stronger claim
// is made here either). A fresh store instance over the same Keychain
// observes what a prior instance persisted.
//
// CONCURRENCY — an actor. Every decision (fence check, ledger comparison,
// record read, record write, ledger write) runs inside one actor turn with
// no intervening suspension, so each operation is indivisible with respect
// to the store's own operations: the fence check cannot be raced past, and
// the ledger-first write order cannot interleave. The ledger is written
// BEFORE the custody record so a crash between the two can only
// OVER-ESTIMATE the newest generation — refusing a legitimate re-commit is
// recoverable for the still-current caller; accepting a stale one is not.

import Foundation
import Security

// MARK: - Wire-level value types (plain Swift values; no JWT parsing)

/// The authenticated binding provenance that must travel with the secret —
/// the full quadruple {cloudSubject, cloudIssuer, workspaceId, clientKey}
/// plus the authority string and the owner/session bindings
/// (`ProtectedEnvelope` fields, wire :288-300). Plain strings only.
struct ProtectedEnrollmentBinding: Equatable, Sendable, Codable {
    /// The verified provider subject. Not an email (recorded identity decision).
    var cloudSubject: String
    /// The free-form authorization string the binding carried.
    var cloudAuthority: String
    /// The CANONICAL issuer this enrollment may act under. Carried verbatim;
    /// canonicality is the boundary's job, not this store's.
    var cloudIssuer: String
    /// The workspace the capability is scoped to.
    var workspaceId: String
    /// The local owner binding.
    var localOwnerId: String
    /// The local session binding.
    var localSessionId: String
    /// The ONE custody namespace. Must match the request's `clientKey`.
    var clientKey: String
}

/// What a custody adapter is asked to protect — the native mirror of
/// `CustodyRequest` (:161-172). The credential appears HERE and nowhere else:
/// on commit it moves INSIDE the sealed payload and is never placed on the
/// envelope's own fields, never returned in an error, and never logged.
struct ProtectedEnrollmentCustodyRequest: Equatable, Sendable {
    var clientKey: String
    var installationId: String
    /// The credential issued by the cloud. The adapter's job.
    var credential: String
    var binding: ProtectedEnrollmentBinding
    /// The platform wire value (e.g. "macos"), carried verbatim.
    var platform: String
    var capabilities: [String]
    /// Epoch milliseconds, mirroring the contract's numbers.
    var issuedAt: Int64
    /// Epoch milliseconds: when the issued credential stops working.
    var credentialExpiresAt: Int64
}

/// The versioned sealed envelope (version 3, wire :288-300). `sealed` is the
/// ONLY carrier of the credential and is opaque to callers.
struct ProtectedEnrollmentCustodyEnvelope: Equatable, Sendable, Codable {
    static let currentVersion = 3

    var version: Int
    /// Opaque. What is INSIDE is this store's business — and it is the only
    /// thing that may carry the credential.
    var sealed: String
    var cloudSubject: String
    var cloudAuthority: String
    var cloudIssuer: String
    var workspaceId: String
    var localOwnerId: String
    var localSessionId: String
    var installationId: String
    var clientKey: String
    var platform: String
    var capabilities: [String]
    var createdAt: Int64
    var credentialExpiresAt: Int64
    /// Revocation rides on the envelope so a tombstone survives a
    /// credential-store loss; reattachment must not resurrect it.
    var revokedAt: Int64?
}

/// A present custody row together with the generation it was committed
/// under — the discriminator a caller uses to tell its own record from a
/// newer winner's (:954-957). Never a timestamp.
struct StoredProtectedEnrollmentRecord: Equatable, Sendable {
    var envelope: ProtectedEnrollmentCustodyEnvelope
    var storedGeneration: String
}

/// The explicit three-way custody read (:954-957). `unknown` means evidence
/// exists but cannot be validated — unreadable or corrupt — and is NEVER
/// mapped to `absent`.
enum ProtectedEnrollmentCustodyRead: Equatable, Sendable {
    case present(StoredProtectedEnrollmentRecord)
    case absent
    case unknown
}

// MARK: - Errors

/// Fail-closed refusals. Each means "custody was not established / cannot be
/// proven", never "carry on unprotected". `errorDescription` carries no
/// client key and no credential material.
enum ProtectedEnrollmentCustodyError: Error, Equatable, LocalizedError, Sendable {
    /// A commit for a generation older than the newest this key knows. The
    /// newer winner (announced or committed) is preserved untouched.
    case staleGeneration(expected: String, newest: String)
    /// The key is fenced (persisted restart fence). Begin-again is an owner
    /// action, not a retry.
    case keyFenced
    /// The fence store's contents are UNKNOWN (a faulted read). Every key
    /// counts as fenced until the store is readable again or the owner resets.
    case fenceStoreDegraded
    /// A custody record exists for the key but cannot be validated. The key
    /// has been fenced; `read` reports `.unknown`, never `absent`.
    case custodyUnreadable(status: OSStatus?)
    /// The generation ledger cannot be read, so a commit cannot be proven
    /// conditional. Writes are refused; reads are unaffected.
    case ledgerUnreadable(status: OSStatus?)
    /// A generation that is not an integer string cannot be ordered against
    /// the newest known one. Fail-closed: this build's custody generations
    /// are integer strings (the attempt store allocates per-key counters);
    /// refusing to guess an order beats inventing one.
    case generationUnorderable(String)
    /// The binding names a different device than the request (:1210's
    /// `client-key` refusal, mapped at the adapter seam).
    case bindingKeyMismatch(request: String, binding: String)
    case writeRefused(OSStatus)
    case deleteRefused(OSStatus)

    var errorDescription: String? {
        switch self {
        case .staleGeneration:
            return "A newer enrollment already owns this record. The older attempt was refused."
        case .keyFenced:
            return "This device's enrollment is fenced pending an explicit owner reset."
        case .fenceStoreDegraded:
            return "The enrollment fence state could not be read, so every key counts as fenced."
        case .custodyUnreadable:
            return "Stored enrollment custody could not be validated, so the record was fenced."
        case .ledgerUnreadable:
            return "The enrollment generation record could not be read, so nothing may be written."
        case .generationUnorderable:
            return "The enrollment generation could not be ordered, so the write was refused."
        case .bindingKeyMismatch:
            return "The enrollment binding names a different device than the request."
        case let .writeRefused(status):
            return "Could not protect this enrollment credential (status \(status))."
        case let .deleteRefused(status):
            return "Could not remove this enrollment record (status \(status))."
        }
    }
}

// MARK: - Keychain seam

/// The `SecItem` operations this store makes, behind a seam so every test
/// runs against an in-memory double and never touches the user's Keychain —
/// the same discipline as `SessionKeychainStorage` and `KeychainItemOps`.
protocol EnrollmentCustodyKeychainOps: Sendable {
    func add(_ attributes: [String: Any]) -> OSStatus
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
    /// Single-item read (house pattern: `kSecReturnData` + `kSecMatchLimitOne`).
    func read(_ query: [String: Any]) -> (OSStatus, Data?)
    /// Attribute read over every item matching the query (fence listing).
    func readAll(_ query: [String: Any]) -> (OSStatus, [[String: Any]]?)
    func delete(_ query: [String: Any]) -> OSStatus
}

private struct SystemEnrollmentCustodyKeychainOps: EnrollmentCustodyKeychainOps {
    func add(_ attributes: [String: Any]) -> OSStatus { SecItemAdd(attributes as CFDictionary, nil) }
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }
    func read(_ query: [String: Any]) -> (OSStatus, Data?) {
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result as? Data)
    }
    func readAll(_ query: [String: Any]) -> (OSStatus, [[String: Any]]?) {
        var q = query
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var result: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecSuccess, let items = result as? [[String: Any]] { return (status, items) }
        return (status, nil)
    }
    func delete(_ query: [String: Any]) -> OSStatus { SecItemDelete(query as CFDictionary) }
}

// MARK: - The Swift-side contract

/// The Swift mirror of the server's `ProtectedCredentialStore`
/// (`installation-enrollment-contract.ts:184-200`), mapped by the documented
/// contract. Two deliberate strengthenings over the server's nullable shapes,
/// both removing conflations the seam table calls out:
///
///   * `commit` REFUSES with a typed error (stale generation, fenced key,
///     unreadable custody) instead of returning null, so a caller cannot
///     misread a refusal as success-by-default.
///   * `get` returns nil ONLY for a proven absence and THROWS on an
///     unreadable record, so it cannot conflate "no record" with "the read
///     failed"; the explicit `read` stays the proof-of-removal primitive.
protocol ProtectedCredentialStore: Sendable {
    /// Conditionally seal the credential under protected custody.
    /// Conditionality is enforced INSIDE the store before any write: a stale
    /// generation refuses and the newer winner is preserved. The returned
    /// envelope is informational; a caller may discard it.
    @discardableResult
    func commit(_ request: ProtectedEnrollmentCustodyRequest,
                expectedGeneration: String) async throws -> ProtectedEnrollmentCustodyEnvelope
    /// The envelope for a key, nil only when proven absent, throwing when the
    /// stored state cannot be validated.
    func get(_ clientKey: String) async throws -> ProtectedEnrollmentCustodyEnvelope?
    /// The explicit three-way read. The ONLY absence proof; `unknown` fences.
    func read(_ clientKey: String) async -> ProtectedEnrollmentCustodyRead
    /// Inactivate the record committed under `generation` — and ONLY that
    /// one. A newer winner's record is never deleted by an older caller's
    /// invalidation; explicit removal is `delete`'s job.
    func invalidate(_ clientKey: String, generation: String) async throws -> Bool
    /// UNCONDITIONAL removal of the record for a key. A separate, explicit
    /// operation — invalidation must never be relied on to delete.
    func delete(_ clientKey: String) async throws -> Bool
}

// MARK: - The store

/// The concrete native custody store. See the file header for the contract
/// mapping, the scope discipline and the persistence choice.
///
/// Stored state, one Keychain generic-password item per client key per
/// service:
///   * record  — the sealed envelope + the generation it was committed under;
///   * ledger  — the newest generation this key has announced or committed
///               (monotonic; what makes commits conditional across restarts);
///   * fences  — the persisted restart fence, consulted by every commit as
///               defence in depth and by `isFenced` for callers.
actor ProtectedEnrollmentCustodyStore: ProtectedCredentialStore {
    /// Dedicated services; deliberately distinct from `SessionKeychain`'s and
    /// `ProviderSecretStore`'s so the three namespaces cannot collide.
    enum Service {
        static let record = "com.muster.MusterMac.enrollment-custody"
        static let ledger = "com.muster.MusterMac.enrollment-custody.generation"
        static let fence = "com.muster.MusterMac.enrollment-custody.fence"
    }

    private let ops: any EnrollmentCustodyKeychainOps

    init(ops: any EnrollmentCustodyKeychainOps = SystemEnrollmentCustodyKeychainOps()) {
        self.ops = ops
    }

    // MARK: Queries

    private func recordQuery(_ clientKey: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Service.record,
            kSecAttrAccount as String: clientKey,
        ]
    }

    private func ledgerQuery(_ clientKey: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Service.ledger,
            kSecAttrAccount as String: clientKey,
        ]
    }

    private var fenceListQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Service.fence,
        ]
    }

    private func readRecord(_ clientKey: String) -> (OSStatus, Data?) {
        var q = recordQuery(clientKey)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        return ops.read(q)
    }

    private func readLedger(_ clientKey: String) -> (OSStatus, Data?) {
        var q = ledgerQuery(clientKey)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        return ops.read(q)
    }

    /// The persisted fence, measured on every consultation — no in-memory
    /// cache — so a fence a prior or concurrent instance wrote is honored
    /// immediately, including after a restart (the restart property the W2
    /// seam table requires). Degradation is therefore also measured per
    /// consultation: during a faulted read EVERY key counts as fenced and
    /// writes are refused; there is no corrupt-fence-file state to heal
    /// because the Keychain's own attributes are the fence keys.
    private func fenceState(_ clientKey: String) -> (fenced: Bool, degraded: Bool) {
        let (status, items) = ops.readAll(fenceListQuery)
        switch status {
        case errSecSuccess:
            let keys = (items ?? []).compactMap { $0[kSecAttrAccount as String] as? String }
            return (keys.contains(clientKey), false)
        case errSecItemNotFound:
            return (false, false)
        default:
            // Fail closed: unknown contents, so this key counts as fenced.
            return (true, true)
        }
    }

    /// The monotonic newest generation for a key. Absent means nothing has
    /// been announced or committed yet.
    private func newestGeneration(_ clientKey: String) throws -> String? {
        let (status, data) = readLedger(clientKey)
        switch status {
        case errSecItemNotFound:
            return nil
        case errSecSuccess:
            guard let data,
                  let payload = try? JSONDecoder().decode(GenerationLedgerEntry.self, from: data),
                  !payload.generation.isEmpty else {
                throw ProtectedEnrollmentCustodyError.ledgerUnreadable(status: nil)
            }
            return payload.generation
        default:
            throw ProtectedEnrollmentCustodyError.ledgerUnreadable(status: status)
        }
    }

    // MARK: Writes

    @discardableResult
    private func upsert(_ query: [String: Any], data: Data) throws -> OSStatus {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        // Update in place, never delete-then-add: a refused replacement must
        // leave the stored bytes intact (SessionKeychain's discipline).
        let updateStatus = ops.update(query, attributes: attributes)
        if updateStatus == errSecSuccess { return updateStatus }
        guard updateStatus == errSecItemNotFound else { throw ProtectedEnrollmentCustodyError.writeRefused(updateStatus) }
        let addStatus = ops.add(query.merging(attributes) { _, new in new })
        guard addStatus == errSecSuccess else {
            // A concurrent insert is a failure too; do not overwrite it.
            throw ProtectedEnrollmentCustodyError.writeRefused(addStatus)
        }
        return addStatus
    }

    /// The monotonic generation announcement (:609's `noteGeneration`,
    /// mapped natively): an OLDER generation is ignored, never rolled back.
    /// A first announcement for a key establishes the baseline; a later one
    /// that cannot be ORDERED against the established newest (this build's
    /// custody generations are integer strings — the attempt store allocates
    /// per-key counters, `putIntentWithGeneration` :790-807) is refused
    /// rather than guessed at.
    func noteGeneration(clientKey: String, generation: String) throws {
        if let newest = try newestGeneration(clientKey) {
            guard let candidate = Int(generation), let current = Int(newest) else {
                throw ProtectedEnrollmentCustodyError.generationUnorderable(generation)
            }
            guard candidate > current else { return }
        }
        try upsert(ledgerQuery(clientKey), data: Self.encode(GenerationLedgerEntry(generation: generation)))
    }

    /// Test/review seam: the newest generation the ledger holds for a key.
    func storedNewestGeneration(clientKey: String) throws -> String? {
        try newestGeneration(clientKey)
    }

    // MARK: The persisted restart fence

    /// Arms the durable fence for a key (`fenceEnrollmentKey` / `unresolved`,
    /// :998-1001, mapped natively). Persists BEFORE returning. Refuses to
    /// write while the fence store is degraded: overwriting unknown contents
    /// could lift invisible fences.
    func fence(clientKey: String, reason: String) throws {
        let state = fenceState(clientKey)
        guard !state.degraded else { throw ProtectedEnrollmentCustodyError.fenceStoreDegraded }
        guard !state.fenced else { return }
        let payload = FenceEntry(reason: reason, fencedAt: Self.nowMilliseconds())
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Service.fence,
            kSecAttrAccount as String: clientKey,
            kSecValueData as String: Self.encode(payload),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = ops.add(attributes)
        // Already fenced (a concurrent instance won the add) is success.
        guard status == errSecSuccess || status == errSecDuplicateItem else {
            throw ProtectedEnrollmentCustodyError.writeRefused(status)
        }
    }

    /// Whether a key is fenced — including by a prior process instance
    /// (durable) and while the fence store is degraded (fail-closed: every
    /// key counts as fenced when the contents are unknown).
    func isFenced(clientKey: String) -> Bool {
        fenceState(clientKey).fenced
    }

    /// The explicit owner action: clear EVERY persisted fence and heal a
    /// degraded episode. The only way a fenced key becomes begin-able again.
    func resetFences() throws {
        let status = ops.delete(fenceListQuery)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ProtectedEnrollmentCustodyError.deleteRefused(status)
        }
    }

    // MARK: ProtectedCredentialStore

    @discardableResult
    func commit(_ request: ProtectedEnrollmentCustodyRequest,
                expectedGeneration: String) throws -> ProtectedEnrollmentCustodyEnvelope {
        // Defence in depth at the adapter seam (:634's mapped clause): the
        // load-bearing fence enforcement is the caller's begin/complete flow,
        // but a conforming adapter refuses a fenced key rather than relying
        // on every caller checking first.
        let fence = fenceState(request.clientKey)
        if fence.degraded { throw ProtectedEnrollmentCustodyError.fenceStoreDegraded }
        if fence.fenced { throw ProtectedEnrollmentCustodyError.keyFenced }

        // A binding that names a different device than the request is refused
        // here too (:1210's `client-key` refusal, mapped at the seam).
        guard request.binding.clientKey == request.clientKey else {
            throw ProtectedEnrollmentCustodyError.bindingKeyMismatch(
                request: request.clientKey, binding: request.binding.clientKey)
        }

        // Conditionality, decided BEFORE any write. The newest known
        // generation for the key (announced by `noteGeneration` or
        // established by an accepted commit) is the gate: an older caller
        // refuses, the newest caller proceeds.
        let newest = try newestGeneration(request.clientKey)
        if let newest {
            guard let expected = Int(expectedGeneration), let known = Int(newest) else {
                throw ProtectedEnrollmentCustodyError.generationUnorderable(expectedGeneration)
            }
            guard expected >= known else {
                throw ProtectedEnrollmentCustodyError.staleGeneration(expected: expectedGeneration, newest: newest)
            }
        }

        // An existing record that cannot be validated is unknown custody:
        // overwriting it could destroy evidence, so refuse and fence.
        let (recordStatus, recordData) = readRecord(request.clientKey)
        if recordStatus == errSecSuccess {
            guard let recordData, let stored = Self.decodeRecord(recordData) else {
                armFenceBestEffort(clientKey: request.clientKey)
                throw ProtectedEnrollmentCustodyError.custodyUnreadable(status: nil)
            }
            // Belt and braces: a stored row newer than the caller's is a
            // winner this commit must not displace.
            if let storedGen = Int(stored.storedGeneration), let expected = Int(expectedGeneration),
               storedGen > expected {
                throw ProtectedEnrollmentCustodyError.staleGeneration(
                    expected: expectedGeneration, newest: stored.storedGeneration)
            }
        } else if recordStatus != errSecItemNotFound {
            armFenceBestEffort(clientKey: request.clientKey)
            throw ProtectedEnrollmentCustodyError.custodyUnreadable(status: recordStatus)
        }

        // Ledger first (crash ordering — see the file header), then the record.
        if newest != expectedGeneration {
            try upsert(ledgerQuery(request.clientKey),
                       data: Self.encode(GenerationLedgerEntry(generation: expectedGeneration)))
        }
        let envelope = ProtectedEnrollmentCustodyEnvelope(
            version: ProtectedEnrollmentCustodyEnvelope.currentVersion,
            sealed: request.credential,   // the ONLY carrier of the credential
            cloudSubject: request.binding.cloudSubject,
            cloudAuthority: request.binding.cloudAuthority,
            cloudIssuer: request.binding.cloudIssuer,
            workspaceId: request.binding.workspaceId,
            localOwnerId: request.binding.localOwnerId,
            localSessionId: request.binding.localSessionId,
            installationId: request.installationId,
            clientKey: request.clientKey,
            platform: request.platform,
            capabilities: request.capabilities,
            createdAt: request.issuedAt,
            credentialExpiresAt: request.credentialExpiresAt,
            revokedAt: nil)
        let payload = CustodyRecordPayload(envelope: envelope, storedGeneration: expectedGeneration)
        // If this upsert faults after the ledger write, the ledger already
        // holds this generation, so a retry of the SAME still-current
        // generation is allowed and a stale one is not — the safe failure
        // direction.
        try upsert(recordQuery(request.clientKey), data: Self.encode(payload))
        return envelope
    }

    func get(_ clientKey: String) throws -> ProtectedEnrollmentCustodyEnvelope? {
        let (status, data) = readRecord(clientKey)
        switch status {
        case errSecItemNotFound:
            return nil
        case errSecSuccess:
            // get refuses to conflate: an unvalidatable record THROWS (after
            // fencing) instead of looking like absence.
            guard let data, let stored = Self.decodeRecord(data),
                  stored.envelope.clientKey == clientKey else {
                armFenceBestEffort(clientKey: clientKey)
                throw ProtectedEnrollmentCustodyError.custodyUnreadable(status: nil)
            }
            return stored.envelope
        default:
            armFenceBestEffort(clientKey: clientKey)
            throw ProtectedEnrollmentCustodyError.custodyUnreadable(status: status)
        }
    }

    func read(_ clientKey: String) -> ProtectedEnrollmentCustodyRead {
        let (status, data) = readRecord(clientKey)
        switch status {
        case errSecItemNotFound:
            // Only the confirmed absence of an item is absence.
            return .absent
        case errSecSuccess:
            guard let data, let stored = Self.decodeRecord(data),
                  stored.envelope.clientKey == clientKey else {
                armFenceBestEffort(clientKey: clientKey)
                return .unknown
            }
            return .present(stored)
        default:
            // A faulted read is unknown, never absent — the conflation the
            // seam table calls out — and it fences the key locally
            // (custody-unresolved semantics, :998-1001).
            armFenceBestEffort(clientKey: clientKey)
            return .unknown
        }
    }

    func invalidate(_ clientKey: String, generation: String) throws -> Bool {
        // Conditioned on the row ACTUALLY STORED, not on the newest
        // announcement: a newer intent alone must never shield an older
        // stored record, while a newer COMMITTED winner is never deleted by
        // an older caller's invalidation (the refinement documented on the
        // server store's `invalidate`).
        let (status, data) = readRecord(clientKey)
        switch status {
        case errSecItemNotFound:
            return false
        case errSecSuccess:
            guard let data, let stored = Self.decodeRecord(data),
                  stored.envelope.clientKey == clientKey else {
                armFenceBestEffort(clientKey: clientKey)
                throw ProtectedEnrollmentCustodyError.custodyUnreadable(status: nil)
            }
            guard stored.storedGeneration == generation else {
                // Not the row the caller named — treat as UNCERTAIN, never as
                // proof of cleanup. The caller re-reads and finds either a
                // newer winner (present, different generation) or this row.
                return false
            }
            let deleteStatus = ops.delete(recordQuery(clientKey))
            switch deleteStatus {
            case errSecSuccess: return true
            case errSecItemNotFound: return false
            default: throw ProtectedEnrollmentCustodyError.deleteRefused(deleteStatus)
            }
        default:
            armFenceBestEffort(clientKey: clientKey)
            throw ProtectedEnrollmentCustodyError.custodyUnreadable(status: status)
        }
    }

    func delete(_ clientKey: String) throws -> Bool {
        let status = ops.delete(recordQuery(clientKey))
        switch status {
        case errSecSuccess: return true
        case errSecItemNotFound: return false
        default: throw ProtectedEnrollmentCustodyError.deleteRefused(status)
        }
        // The generation ledger is deliberately NOT removed: a delete must
        // not open the door to a stale completion re-committing an older
        // generation over a future record (the ledger is monotonic).
    }

    /// Arms the fence for an unresolved-custody observation. Best effort by
    /// design: if the fence store cannot be written it cannot be read as
    /// healthy either (everything counts as fenced while degraded), and any
    /// later healthy operation on an unknown record re-arms and refuses —
    /// `commit`, `get`, `invalidate` and `read` all re-check record
    /// validity, so the fence gap cannot be exploited.
    private func armFenceBestEffort(clientKey: String) {
        try? fence(clientKey: clientKey, reason: "custody-unresolved")
    }

    // MARK: Payload codecs

    private struct GenerationLedgerEntry: Codable, Equatable {
        var generation: String
    }

    private struct FenceEntry: Codable, Equatable {
        var reason: String
        var fencedAt: Int64
    }

    /// The stored record payload. Decoding is strict: a record missing ANY
    /// authenticated binding (or the generation it was committed under)
    /// fails to decode and is therefore UNKNOWN custody — a record that
    /// predates a binding must not be accepted (the native-prerequisites
    /// clause), which is stricter than the server wire's parse-only version
    /// shape check and deliberately so.
    private struct CustodyRecordPayload: Codable, Equatable {
        var envelope: ProtectedEnrollmentCustodyEnvelope
        var storedGeneration: String
    }

    private static func encode(_ payload: some Codable) -> Data {
        (try? JSONEncoder().encode(payload)) ?? Data()
    }

    /// Decodes AND validates: the envelope must carry every binding field
    /// non-empty, a positive version, and its own client key must match the
    /// record's. Anything else is not a record this store can vouch for.
    private static func decodeRecord(_ data: Data) -> StoredProtectedEnrollmentRecord? {
        guard let payload = try? JSONDecoder().decode(CustodyRecordPayload.self, from: data) else {
            return nil
        }
        let e = payload.envelope
        let bindingsComplete = !e.cloudSubject.isEmpty && !e.cloudAuthority.isEmpty
            && !e.cloudIssuer.isEmpty && !e.workspaceId.isEmpty
            && !e.localOwnerId.isEmpty && !e.localSessionId.isEmpty
            && !e.clientKey.isEmpty
        guard !payload.storedGeneration.isEmpty,
              payload.envelope.version >= 1,
              bindingsComplete,
              !e.sealed.isEmpty else {
            return nil
        }
        return StoredProtectedEnrollmentRecord(envelope: e, storedGeneration: payload.storedGeneration)
    }

    private static func nowMilliseconds() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}
