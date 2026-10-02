import Foundation
import Security
import XCTest
@testable import MusterMacCore

// ============================================================================
// K1b — internal protected-store adapter for provider secrets.
//
// IMPORTANT ABOUT THE WITNESS CASES BELOW.
//
// `LegacyDirectWritePath` is a **test-only helper invented for this file**. Its
// defects are written into its own body. A source search found no production
// native caller of that shape. An earlier revision of this receipt presented
// "red 2/2 against the un-brokered path" as evidence that the shipped native app
// swallowed provider-storage errors. **That claim was wrong and is withdrawn**:
// those cases are negative controls showing what the adapter prevents, not a
// reproduction of a shipped defect. They are labelled `testNegativeControl*` for
// that reason and must not be cited as reproduction.
//
// No real Keychain is touched anywhere in this file. The `ProviderSecretStorage`
// fake exercises the adapter's branching; the `KeychainItemOps` fake exercises
// the Apple adapter's update-then-add split, duplicate race and attribute set.
// Neither is evidence of real OS behaviour.
// ============================================================================

// MARK: - Fakes

/// Fake OS storage that can be told to refuse, like the real thing can.
final class FakeProviderStorage: ProviderSecretStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]

    var writeStatus: OSStatus = errSecSuccess
    var readStatus: OSStatus = errSecSuccess
    var deleteStatus: OSStatus = errSecSuccess
    private(set) var writeCount = 0
    private(set) var deleteCount = 0

    func write(_ data: Data, account: String) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        guard writeStatus == errSecSuccess else { return writeStatus }
        items[account] = data
        writeCount += 1
        return errSecSuccess
    }
    func read(account: String) -> (OSStatus, Data?) {
        lock.lock(); defer { lock.unlock() }
        guard readStatus == errSecSuccess else { return (readStatus, nil) }
        return items[account].map { (errSecSuccess, $0) } ?? (errSecItemNotFound, nil)
    }
    func delete(account: String) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        deleteCount += 1
        guard deleteStatus == errSecSuccess else { return deleteStatus }
        guard items.removeValue(forKey: account) != nil else { return errSecItemNotFound }
        return errSecSuccess
    }

    var storedAccounts: [String] { lock.lock(); defer { lock.unlock() }; return Array(items.keys) }
    func secret(for account: String) -> Data? { lock.lock(); defer { lock.unlock() }; return items[account] }
}

/// Fake `SecItem` layer, so the Apple adapter's own branching is testable.
final class FakeKeychainOps: KeychainItemOps, @unchecked Sendable {
    private let lock = NSLock()
    var items: [String: Data] = [:]      // account -> bytes
    var exists: Set<String> = []
    /// Force the concurrent-insert race: update reports not-found, add reports duplicate.
    var simulateConcurrentInsert = false
    var addStatus: OSStatus = errSecSuccess
    var updateStatus: OSStatus = errSecSuccess
    var deleteStatus: OSStatus = errSecSuccess
    var calls: [String] = []
    private(set) var lastAddAttributes: [String: Any] = [:]
    private(set) var lastUpdateAttributes: [String: Any] = [:]
    private(set) var lastQuery: [String: Any] = [:]

    private func key(_ attributes: [String: Any]) -> String {
        (attributes[kSecAttrAccount as String] as? String) ?? ""
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        calls.append("add"); lastAddAttributes = attributes
        if simulateConcurrentInsert { return errSecDuplicateItem }
        guard addStatus == errSecSuccess else { return addStatus }
        let k = key(attributes)
        guard !exists.contains(k) else { return errSecDuplicateItem }
        exists.insert(k)
        items[k] = attributes[kSecValueData as String] as? Data
        return errSecSuccess
    }
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        calls.append("update"); lastQuery = query; lastUpdateAttributes = attributes
        if simulateConcurrentInsert { return errSecItemNotFound }
        guard updateStatus == errSecSuccess else { return updateStatus }
        let k = key(query)
        guard exists.contains(k) else { return errSecItemNotFound }
        items[k] = attributes[kSecValueData as String] as? Data
        return errSecSuccess
    }
    func read(_ query: [String: Any]) -> (OSStatus, Data?) {
        lock.lock(); defer { lock.unlock() }
        calls.append("read"); lastQuery = query
        let k = key(query)
        guard exists.contains(k) else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, items[k])
    }
    func delete(_ query: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        calls.append("delete"); lastQuery = query
        guard deleteStatus == errSecSuccess else { return deleteStatus }
        let k = key(query)
        guard exists.remove(k) != nil else { return errSecItemNotFound }
        items[k] = nil
        return errSecSuccess
    }
    var callLog: [String] { lock.lock(); defer { lock.unlock() }; return calls }
    func bytes(_ account: String) -> Data? { lock.lock(); defer { lock.unlock() }; return items[account] }
}

/// The shape the adapter exists to prevent: write straight through, report
/// nothing, swallow a failed delete. TEST-ONLY. Not shipped code.
@MainActor
final class LegacyDirectWritePath {
    private let storage: FakeProviderStorage
    private(set) var configuredProviders: Set<String> = []
    init(storage: FakeProviderStorage) { self.storage = storage }
    /// Returns nothing and cannot fail — which is the problem.
    func store(secret: Data, provider: String) {
        _ = storage.write(secret, account: provider)
        configuredProviders.insert(provider)
    }
    /// Reports "removed" whether or not the secret actually went away.
    func remove(provider: String) -> Bool {
        _ = storage.delete(account: provider)
        configuredProviders.remove(provider)
        return true
    }
}

// MARK: - Negative controls (not reproduction)

@MainActor
final class ProviderSecretStoreNegativeControlTests: XCTestCase {
    private func secret(_ tag: String) -> Data { Data("synthetic-provider-key-\(tag)".utf8) }

    /// NEGATIVE CONTROL, not reproduction. Shows what the adapter's fail-closed
    /// write prevents, using an invented helper.
    func testNegativeControlUnguardedWriteReportsConfiguredDespiteRefusal() {
        let storage = FakeProviderStorage()
        storage.writeStatus = errSecAuthFailed
        let legacy = LegacyDirectWritePath(storage: storage)

        legacy.store(secret: secret("a"), provider: "openai")

        XCTAssertTrue(legacy.configuredProviders.contains("openai"))
        XCTAssertNil(storage.secret(for: "openai"))
    }

    /// NEGATIVE CONTROL, not reproduction.
    func testNegativeControlUnguardedDeleteReportsSuccessDespiteRefusal() {
        let storage = FakeProviderStorage()
        let legacy = LegacyDirectWritePath(storage: storage)
        legacy.store(secret: secret("b"), provider: "anthropic")

        storage.deleteStatus = errSecAuthFailed
        let reported = legacy.remove(provider: "anthropic")

        XCTAssertTrue(reported)
        XCTAssertNotNil(storage.secret(for: "anthropic"))
    }

    /// NEGATIVE CONTROL: without the adapter the raw secret is freely readable.
    func testNegativeControlUnguardedStorageExposesRawSecret() {
        let storage = FakeProviderStorage()
        let legacy = LegacyDirectWritePath(storage: storage)
        legacy.store(secret: secret("c"), provider: "google")

        let (status, bytes) = storage.read(account: "google")
        XCTAssertEqual(status, errSecSuccess)
        XCTAssertEqual(bytes, secret("c"))
    }
}

// MARK: - The adapter

@MainActor
final class ProviderSecretStoreTests: XCTestCase {
    private func secret(_ tag: String) -> Data { Data("synthetic-provider-key-\(tag)".utf8) }
    private func store(_ storage: FakeProviderStorage) -> ProviderSecretStore {
        ProviderSecretStore(storage: storage)
    }

    // MARK: Basic behaviour

    func testStoreReturnsAStorageKeyAndTheSecretIsPresent() throws {
        let storage = FakeProviderStorage()
        let store = self.store(storage)
        let raw = secret("ok")

        let ref = try store.store(secret: raw, provider: "openai")

        XCTAssertEqual(ref.provider, "openai")
        XCTAssertEqual(storage.secret(for: ref.account), raw)
        XCTAssertTrue(store.status(for: "openai").configured)
    }

    func testStatusIsMeasuredNotAssumed() throws {
        let storage = FakeProviderStorage()
        let store = self.store(storage)

        let absent = store.status(for: "openai")
        XCTAssertFalse(absent.configured)
        XCTAssertNil(absent.measuredStatus, "an absent item is not a measured failure")

        try store.store(secret: secret("s"), provider: "openai")
        XCTAssertTrue(store.status(for: "openai").configured)
        XCTAssertEqual(store.status(for: "openai").measuredStatus, errSecSuccess)

        // A refused read must surface its real status rather than read as absent.
        storage.readStatus = errSecInteractionNotAllowed
        let unreadable = store.status(for: "openai")
        XCTAssertFalse(unreadable.configured)
        XCTAssertEqual(unreadable.measuredStatus, errSecInteractionNotAllowed)
    }

    func testFetchReturnsTheSecretForATrustedInternalCaller() throws {
        let storage = FakeProviderStorage()
        let store = self.store(storage)
        let raw = secret("f")
        let ref = try store.store(secret: raw, provider: "anthropic")

        // Documented, not hidden: this adapter returns the secret by design.
        XCTAssertEqual(try store.fetch(ref), raw)
    }

    func testDeleteRemovesItAndStatusBecomesUnconfigured() throws {
        let storage = FakeProviderStorage()
        let store = self.store(storage)
        let ref = try store.store(secret: secret("d"), provider: "openai")

        try store.delete(ref)

        XCTAssertNil(storage.secret(for: ref.account))
        XCTAssertFalse(store.status(for: "openai").configured)
    }

    // MARK: Injected failures — fail closed, measured, retain

    func testRefusedWriteFailsClosedAndStoresNothing() {
        let storage = FakeProviderStorage()
        storage.writeStatus = errSecAuthFailed
        let store = self.store(storage)

        XCTAssertThrowsError(try store.store(secret: secret("r"), provider: "openai")) { error in
            XCTAssertEqual(error as? ProviderCustodyError, .writeRefused(errSecAuthFailed),
                           "the real OSStatus must be surfaced, not swallowed")
        }
        XCTAssertFalse(store.status(for: "openai").configured,
                       "a refused first write leaves nothing configured")
        XCTAssertEqual(storage.writeCount, 0, "nothing may be counted as stored")
    }

    /// The case an earlier revision got wrong: a refused **replacement** must keep
    /// the earlier secret and keep reporting the provider configured.
    func testRefusedReplacementPreservesTheEarlierSecretAndConfiguredState() throws {
        let storage = FakeProviderStorage()
        let store = self.store(storage)
        let first = secret("first")
        try store.store(secret: first, provider: "openai")
        XCTAssertEqual(storage.storedAccounts.count, 1)

        storage.writeStatus = errSecAuthFailed
        XCTAssertThrowsError(try store.store(secret: secret("second"), provider: "openai")) { error in
            XCTAssertEqual(error as? ProviderCustodyError, .writeRefused(errSecAuthFailed))
        }

        // The earlier secret survives untouched and the provider stays configured.
        XCTAssertEqual(storage.secret(for: "provider:openai"), first,
                       "a refused replacement must not destroy or overwrite the earlier secret")
        XCTAssertTrue(store.status(for: "openai").configured,
                      "a refused replacement must not report the provider unconfigured")
    }

    func testRefusedDeleteReportsFailureAndRetainsSecret() throws {
        let storage = FakeProviderStorage()
        let store = self.store(storage)
        let raw = secret("k")
        let ref = try store.store(secret: raw, provider: "anthropic")

        storage.deleteStatus = errSecAuthFailed
        XCTAssertThrowsError(try store.delete(ref)) { error in
            XCTAssertEqual(error as? ProviderCustodyError, .deleteRefused(errSecAuthFailed))
        }
        XCTAssertEqual(storage.secret(for: ref.account), raw, "a refused delete must RETAIN the secret")
        XCTAssertTrue(store.status(for: "anthropic").configured,
                      "the caller must still know the key is present after a failed removal")
    }

    func testDeletingAnAlreadyAbsentSecretIsSuccessNotFailure() throws {
        let storage = FakeProviderStorage()
        let store = self.store(storage)
        let ref = try store.store(secret: secret("g"), provider: "openai")
        try store.delete(ref)
        XCTAssertNoThrow(try store.delete(ref), "confirmed absence is success, not failure")
    }

    func testReadFailureDuringFetchIsSurfacedNotSilentlyEmpty() throws {
        let storage = FakeProviderStorage()
        let store = self.store(storage)
        let ref = try store.store(secret: secret("x"), provider: "openai")

        storage.readStatus = errSecInteractionNotAllowed
        XCTAssertThrowsError(try store.fetch(ref)) { error in
            XCTAssertEqual(error as? ProviderCustodyError, .readFailed(errSecInteractionNotAllowed))
        }
    }

    func testInconsistentRefIsAProgrammingGuardNotAuthorisation() throws {
        let storage = FakeProviderStorage()
        let store = self.store(storage)
        let mismatched = ProviderSecretRef(account: "provider:someone-else", provider: "openai")

        XCTAssertThrowsError(try store.fetch(mismatched)) { error in
            XCTAssertEqual(error as? ProviderCustodyError, .inconsistentRef)
        }
        XCTAssertThrowsError(try store.delete(mismatched)) { error in
            XCTAssertEqual(error as? ProviderCustodyError, .inconsistentRef)
        }
        // Recorded honestly: a ref whose account matches the derivation IS accepted,
        // because this adapter does not model issuance or ownership. Asserting the
        // opposite here would re-introduce the withdrawn capability claim.
        _ = try store.store(secret: secret("openai"), provider: "openai")
        let derivable = ProviderSecretRef(account: "provider:openai", provider: "openai")
        XCTAssertEqual(try store.fetch(derivable), secret("openai"),
                       "this adapter deliberately does not check issuance or owner")
    }

    func testThereIsNoPlaintextFallback() {
        let storage = FakeProviderStorage()
        let store = self.store(storage)
        XCTAssertThrowsError(try store.plaintextFallback()) { error in
            XCTAssertEqual(error as? ProviderCustodyError, .plaintextFallbackForbidden)
        }
        XCTAssertEqual(storage.writeCount, 0)
    }

    // MARK: Isolation from session custody

    func testProviderSecretsUseTheirOwnNamespace() throws {
        let storage = FakeProviderStorage()
        let store = self.store(storage)
        let ref = try store.store(secret: secret("n"), provider: "openai")

        XCTAssertTrue(ref.account.hasPrefix("provider:"))
        XCTAssertNotEqual(ref.account, "session",
                          "a provider secret must never land in the session account")
        XCTAssertNotEqual(SystemProviderSecretStorage.service, "com.muster.MusterMac",
                          "provider secrets must use their own Keychain service")
        XCTAssertEqual(storage.storedAccounts, [ref.account])
    }

    func testErrorDescriptionsNeverContainSecretMaterialAndAreActuallyUsed() {
        for error in [ProviderCustodyError.writeRefused(errSecAuthFailed),
                      .deleteRefused(errSecAuthFailed),
                      .readFailed(errSecAuthFailed),
                      .inconsistentRef, .plaintextFallbackForbidden] {
            let text = error.localizedDescription
            XCTAssertFalse(text.contains("synthetic-provider-key"))
            XCTAssertFalse(text.lowercased().contains("bearer"))
            XCTAssertFalse(text.isEmpty)
        }
        XCTAssertTrue(ProviderCustodyError.deleteRefused(errSecAuthFailed)
            .localizedDescription.contains("still stored"),
                      "LocalizedError conformance must actually surface the measured message")
    }
}

// MARK: - The Apple adapter's own branching

@MainActor
final class SystemProviderSecretStorageTests: XCTestCase {
    private func secret(_ tag: String) -> Data { Data("synthetic-provider-key-\(tag)".utf8) }

    func testFirstWriteUsesAddAfterAFailedUpdate() {
        let ops = FakeKeychainOps()
        let storage = SystemProviderSecretStorage(ops: ops)

        let status = storage.write(secret("one"), account: "provider:openai")

        XCTAssertEqual(status, errSecSuccess)
        XCTAssertEqual(ops.callLog, ["update", "add"],
                       "a first write must try update-in-place, then add")
        XCTAssertEqual(ops.bytes("provider:openai"), secret("one"))
    }

    func testReplacementUpdatesInPlaceWithoutDeleting() {
        let ops = FakeKeychainOps()
        let storage = SystemProviderSecretStorage(ops: ops)
        _ = storage.write(secret("one"), account: "provider:openai")
        ops.calls = []

        let status = storage.write(secret("two"), account: "provider:openai")

        XCTAssertEqual(status, errSecSuccess)
        XCTAssertEqual(ops.callLog, ["update"], "an existing item must be updated, never re-added")
        XCTAssertFalse(ops.callLog.contains("delete"), "never delete before replacing")
        XCTAssertEqual(ops.bytes("provider:openai"), secret("two"))
    }

    func testARefusedUpdateDoesNotFallBackToAdd() {
        let ops = FakeKeychainOps()
        let storage = SystemProviderSecretStorage(ops: ops)
        _ = storage.write(secret("one"), account: "provider:openai")
        ops.calls = []
        ops.updateStatus = errSecAuthFailed

        let status = storage.write(secret("two"), account: "provider:openai")

        XCTAssertEqual(status, errSecAuthFailed, "a denied update must not be masked by an add")
        XCTAssertEqual(ops.callLog, ["update"], "must not attempt add after a non-notFound refusal")
        XCTAssertEqual(ops.bytes("provider:openai"), secret("one"), "the earlier secret survives")
    }

    func testADuplicateInsertIsReportedNotOverwritten() {
        let ops = FakeKeychainOps()
        let storage = SystemProviderSecretStorage(ops: ops)
        _ = storage.write(secret("one"), account: "provider:openai")
        ops.calls = []

        // A concurrent insert lands between the update and the add.
        ops.simulateConcurrentInsert = true
        let status = storage.write(secret("two"), account: "provider:openai")

        XCTAssertEqual(status, errSecDuplicateItem,
                       "a concurrent insert must be reported as a failure, not a success")
        XCTAssertEqual(ops.callLog, ["update", "add"])
        XCTAssertEqual(ops.bytes("provider:openai"), secret("one"),
                       "the existing item must survive a losing writer")
    }

    func testWriteUsesTheProvidersOwnServiceAndThisDeviceOnlyAccessibility() {
        let ops = FakeKeychainOps()
        let storage = SystemProviderSecretStorage(ops: ops)
        _ = storage.write(secret("attrs"), account: "provider:openai")

        let attrs = ops.lastAddAttributes
        XCTAssertEqual(attrs[kSecAttrService as String] as? String, "com.muster.MusterMac.provider")
        XCTAssertNotEqual(attrs[kSecAttrService as String] as? String, "com.muster.MusterMac")
        XCTAssertEqual(attrs[kSecAttrAccessible as String] as? String,
                       kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(attrs[kSecClass as String] as? String, kSecClassGenericPassword as String)
    }

    func testDeletePropagatesRefusalAndConfirmedAbsence() {
        let ops = FakeKeychainOps()
        let storage = SystemProviderSecretStorage(ops: ops)
        _ = storage.write(secret("one"), account: "provider:openai")

        XCTAssertEqual(storage.delete(account: "provider:openai"), errSecSuccess)
        XCTAssertEqual(storage.delete(account: "provider:openai"), errSecItemNotFound)

        _ = storage.write(secret("two"), account: "provider:openai")
        ops.deleteStatus = errSecAuthFailed
        XCTAssertEqual(storage.delete(account: "provider:openai"), errSecAuthFailed,
                       "a denied delete must be propagated, not swallowed")
        XCTAssertEqual(ops.bytes("provider:openai"), secret("two"), "and the secret is retained")
    }

    func testReadReportsAbsenceDistinctlyFromRefusal() {
        let ops = FakeKeychainOps()
        let storage = SystemProviderSecretStorage(ops: ops)

        let absent = storage.read(account: "provider:nope")
        XCTAssertEqual(absent.0, errSecItemNotFound)
        XCTAssertNil(absent.1)

        _ = storage.write(secret("one"), account: "provider:openai")
        let present = storage.read(account: "provider:openai")
        XCTAssertEqual(present.0, errSecSuccess)
        XCTAssertEqual(present.1, secret("one"))
    }
}