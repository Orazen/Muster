// Session persistence with the same discipline as the CLI's 0600 config:
// the cookie is stored only through this helper, only in the login
// keychain, only readable by this device after first unlock — never in
// UserDefaults, never in a file the transport writes.

import Foundation
import Security

// Per-call injection keeps failure tests away from the user's Keychain.
protocol SessionKeychainStorage {
    func add(_ attributes: [String: Any]) -> OSStatus
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
    func read(_ query: [String: Any]) -> (OSStatus, Data?)
    func delete(_ query: [String: Any]) -> OSStatus
}

private struct SystemSessionKeychainStorage: SessionKeychainStorage {
    func add(_ attributes: [String: Any]) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func read(_ query: [String: Any]) -> (OSStatus, Data?) {
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result as? Data)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

public enum SessionKeychainError: Error, Equatable, LocalizedError, Sendable {
    case saveFailed(OSStatus)
    case loadFailed(OSStatus)
    case clearFailed(OSStatus)
    case invalidSavedSession
    case encodingFailed

    public var errorDescription: String? {
        switch self {
        case let .saveFailed(status):
            return "Could not save this session in Keychain (status \(status)). Check Keychain access and try again."
        case let .loadFailed(status):
            return "Could not read the saved session from Keychain (status \(status)). Check Keychain access and try again."
        case let .clearFailed(status):
            return "Could not remove the saved session from Keychain (status \(status))."
        case .invalidSavedSession:
            return "The saved session could not be read. Sign in again to replace it."
        case .encodingFailed:
            return "Could not prepare this session for Keychain. Sign in again."
        }
    }
}

public enum SessionKeychain {
    private static let service = "com.muster.MusterMac"

    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "session",
        ]
    }

    public static func save(_ account: HarnessAccount) throws {
        try save(account, storage: SystemSessionKeychainStorage())
    }

    static func save(_ account: HarnessAccount, storage: any SessionKeychainStorage) throws {
        let data: Data
        do {
            data = try JSONEncoder().encode(account)
        } catch {
            throw SessionKeychainError.encodingFailed
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        // Never delete a working session to replace it: a rejected update
        // leaves that item intact. Only a confirmed absence permits an add.
        let updateStatus = storage.update(query, attributes: attributes)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw SessionKeychainError.saveFailed(updateStatus)
        }
        let addStatus = storage.add(query.merging(attributes) { _, new in new })
        guard addStatus == errSecSuccess else {
            // A concurrent insert is a failure too; do not overwrite it.
            throw SessionKeychainError.saveFailed(addStatus)
        }
    }

    public static func load() throws -> HarnessAccount? {
        try load(storage: SystemSessionKeychainStorage())
    }

    static func load(storage: any SessionKeychainStorage) throws -> HarnessAccount? {
        var readQuery = query
        readQuery[kSecReturnData as String] = true
        readQuery[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, data) = storage.read(readQuery)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw SessionKeychainError.loadFailed(status)
        }
        guard let data,
              let account = try? JSONDecoder().decode(HarnessAccount.self, from: data) else {
            throw SessionKeychainError.invalidSavedSession
        }
        return account
    }

    public static func clear() throws {
        try clear(storage: SystemSessionKeychainStorage())
    }

    static func clear(storage: any SessionKeychainStorage) throws {
        let status = storage.delete(query)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SessionKeychainError.clearFailed(status)
        }
    }
}
