import Foundation
import Security
import XCTest
@testable import MusterMacCore

/// Models Keychain status results without calling any Security API.
private final class FakeSessionKeychainStorage: SessionKeychainStorage {
    var data: Data?
    var addStatus: OSStatus = errSecSuccess
    var updateStatus: OSStatus = errSecSuccess
    var deleteStatus: OSStatus = errSecSuccess
    var readStatus: OSStatus = errSecSuccess
    var readReturnsNoData = false
    var insertDuringAdd: Data?
    var operations: [String] = []
    var queries: [[String: Any]] = []
    var writes: [[String: Any]] = []

    func add(_ attributes: [String: Any]) -> OSStatus {
        operations.append("add")
        writes.append(attributes)
        guard addStatus == errSecSuccess else { return addStatus }
        if let insertDuringAdd { data = insertDuringAdd }
        guard data == nil else { return errSecDuplicateItem }
        data = attributes[kSecValueData as String] as? Data
        return errSecSuccess
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        operations.append("update")
        queries.append(query)
        writes.append(attributes)
        guard updateStatus == errSecSuccess else { return updateStatus }
        guard data != nil else { return errSecItemNotFound }
        data = attributes[kSecValueData as String] as? Data
        return errSecSuccess
    }

    func read(_ query: [String: Any]) -> (OSStatus, Data?) {
        operations.append("read")
        queries.append(query)
        guard readStatus == errSecSuccess else { return (readStatus, nil) }
        if readReturnsNoData { return (errSecSuccess, nil) }
        return data.map { (errSecSuccess, $0) } ?? (errSecItemNotFound, nil)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        operations.append("delete")
        queries.append(query)
        guard deleteStatus == errSecSuccess else { return deleteStatus }
        guard data != nil else { return errSecItemNotFound }
        data = nil
        return errSecSuccess
    }
}

final class SessionKeychainTests: XCTestCase {
    private func account(_ name: String) -> HarnessAccount {
        HarnessAccount(origin: "https://\(name).fixture.invalid", cookieName: "better-auth.session_token", cookieValue: "synthetic-\(name)")
    }

    func testFailedReplacementPreservesOriginalBytesAndReportsFailure() throws {
        let storage = FakeSessionKeychainStorage()
        let original = try JSONEncoder().encode(account("old"))
        storage.data = original
        storage.addStatus = errSecInteractionNotAllowed
        storage.updateStatus = errSecInteractionNotAllowed

        XCTAssertThrowsError(try SessionKeychain.save(account("new"), storage: storage)) {
            XCTAssertEqual($0 as? SessionKeychainError, .saveFailed(errSecInteractionNotAllowed))
        }
        XCTAssertEqual(storage.data, original)
        XCTAssertEqual(storage.operations, ["update"])
    }

    func testFailedFirstSaveReportsFailure() {
        let storage = FakeSessionKeychainStorage()
        storage.addStatus = errSecAuthFailed

        XCTAssertThrowsError(try SessionKeychain.save(account("new"), storage: storage)) {
            XCTAssertEqual($0 as? SessionKeychainError, .saveFailed(errSecAuthFailed))
        }
        XCTAssertNil(storage.data)
        XCTAssertEqual(storage.operations, ["update", "add"])
    }

    func testFailedClearReportsFailureAndKeepsSavedSession() throws {
        let storage = FakeSessionKeychainStorage()
        let original = try JSONEncoder().encode(account("old"))
        storage.data = original
        storage.deleteStatus = errSecInteractionNotAllowed

        XCTAssertThrowsError(try SessionKeychain.clear(storage: storage)) {
            XCTAssertEqual($0 as? SessionKeychainError, .clearFailed(errSecInteractionNotAllowed))
        }
        XCTAssertEqual(storage.data, original)
        XCTAssertEqual(storage.operations, ["delete"])
    }

    func testSuccessfulReplacementUpdatesWithoutDeletingAndRestoresNewSession() throws {
        let storage = FakeSessionKeychainStorage()
        storage.data = try JSONEncoder().encode(account("old"))

        try SessionKeychain.save(account("new"), storage: storage)

        XCTAssertEqual(storage.operations, ["update"])
        XCTAssertEqual(try SessionKeychain.load(storage: storage), account("new"))
        XCTAssertEqual(storage.writes.first?[kSecAttrAccessible as String] as? String,
                       kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    func testFirstSaveUsesExistingServiceAccountAndDeviceOnlyAccessibility() throws {
        let storage = FakeSessionKeychainStorage()

        try SessionKeychain.save(account("new"), storage: storage)

        XCTAssertEqual(storage.operations, ["update", "add"])
        let attributes = try XCTUnwrap(storage.writes.last)
        XCTAssertEqual(attributes[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(attributes[kSecAttrService as String] as? String, "com.muster.MusterMac")
        XCTAssertEqual(attributes[kSecAttrAccount as String] as? String, "session")
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String,
                       kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(try SessionKeychain.load(storage: storage), account("new"))
    }

    func testUnavailableOrDeniedUpdateNeverFallsBackToAddOrDelete() throws {
        for status in [errSecAuthFailed, errSecNotAvailable, errSecParam] {
            let storage = FakeSessionKeychainStorage()
            let original = try JSONEncoder().encode(account("old"))
            storage.data = original
            storage.updateStatus = status

            XCTAssertThrowsError(try SessionKeychain.save(account("new"), storage: storage)) {
                XCTAssertEqual($0 as? SessionKeychainError, .saveFailed(status))
            }
            XCTAssertEqual(storage.operations, ["update"])
            XCTAssertEqual(storage.data, original)
        }
    }

    func testConcurrentInsertIsPreservedAndReportedInsteadOfOverwritten() throws {
        let storage = FakeSessionKeychainStorage()
        let concurrent = try JSONEncoder().encode(account("other"))
        storage.insertDuringAdd = concurrent

        XCTAssertThrowsError(try SessionKeychain.save(account("new"), storage: storage)) {
            XCTAssertEqual($0 as? SessionKeychainError, .saveFailed(errSecDuplicateItem))
        }
        XCTAssertEqual(storage.operations, ["update", "add"])
        XCTAssertEqual(storage.data, concurrent)
    }

    func testClearRemovesSessionAndAlreadyMissingIsSuccessful() throws {
        let storage = FakeSessionKeychainStorage()
        storage.data = try JSONEncoder().encode(account("old"))

        try SessionKeychain.clear(storage: storage)
        XCTAssertNil(storage.data)
        try SessionKeychain.clear(storage: storage)
        XCTAssertEqual(storage.operations, ["delete", "delete"])
    }

    func testFailedClearCanRetryWithoutLosingTheOriginalItemEarly() throws {
        let storage = FakeSessionKeychainStorage()
        let original = try JSONEncoder().encode(account("old"))
        storage.data = original
        storage.deleteStatus = errSecAuthFailed
        XCTAssertThrowsError(try SessionKeychain.clear(storage: storage))
        XCTAssertEqual(storage.data, original)

        storage.deleteStatus = errSecSuccess
        try SessionKeychain.clear(storage: storage)
        XCTAssertNil(storage.data)
    }

    func testOnlyMissingItemLoadsAsNoSavedSession() throws {
        let storage = FakeSessionKeychainStorage()

        XCTAssertNil(try SessionKeychain.load(storage: storage))
        XCTAssertEqual(storage.operations, ["read"])
        let query = try XCTUnwrap(storage.queries.first)
        XCTAssertEqual(query[kSecAttrService as String] as? String, "com.muster.MusterMac")
        XCTAssertEqual(query[kSecAttrAccount as String] as? String, "session")
        XCTAssertEqual(query[kSecReturnData as String] as? Bool, true)
        XCTAssertEqual(query[kSecMatchLimit as String] as? String, kSecMatchLimitOne as String)
    }

    func testFailedLoadReportsStatusAndPreservesItemWithoutAnyWrite() throws {
        for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecNotAvailable] {
            let storage = FakeSessionKeychainStorage()
            let original = try JSONEncoder().encode(account("old"))
            storage.data = original
            storage.readStatus = status

            XCTAssertThrowsError(try SessionKeychain.load(storage: storage)) {
                XCTAssertEqual($0 as? SessionKeychainError, .loadFailed(status))
            }
            XCTAssertEqual(storage.operations, ["read"])
            XCTAssertEqual(storage.data, original)
        }
    }

    func testMalformedSavedSessionIsReportedAndLeftUntouched() {
        let storage = FakeSessionKeychainStorage()
        let original = Data("not a saved account".utf8)
        storage.data = original

        XCTAssertThrowsError(try SessionKeychain.load(storage: storage)) {
            XCTAssertEqual($0 as? SessionKeychainError, .invalidSavedSession)
        }
        XCTAssertEqual(storage.data, original)
        XCTAssertEqual(storage.operations, ["read"])
    }

    func testSuccessfulReadWithoutDataIsReportedAsUnreadable() {
        let storage = FakeSessionKeychainStorage()
        storage.readReturnsNoData = true

        XCTAssertThrowsError(try SessionKeychain.load(storage: storage)) {
            XCTAssertEqual($0 as? SessionKeychainError, .invalidSavedSession)
        }
        XCTAssertEqual(storage.operations, ["read"])
    }

    func testStorageFailureDescriptionsContainNoAccountData() throws {
        let storage = FakeSessionKeychainStorage()
        storage.data = try JSONEncoder().encode(account("private"))
        storage.updateStatus = errSecAuthFailed
        storage.readStatus = errSecAuthFailed
        storage.deleteStatus = errSecAuthFailed
        let actions: [() throws -> Void] = [
            { try SessionKeychain.save(self.account("private"), storage: storage) },
            { _ = try SessionKeychain.load(storage: storage) },
            { try SessionKeychain.clear(storage: storage) },
        ]
        for action in actions {
            XCTAssertThrowsError(try action()) { error in
                XCTAssertFalse(error.localizedDescription.contains("private"))
                XCTAssertFalse(error.localizedDescription.contains("synthetic"))
                XCTAssertFalse(error.localizedDescription.contains("fixture.invalid"))
            }
        }
    }
}
