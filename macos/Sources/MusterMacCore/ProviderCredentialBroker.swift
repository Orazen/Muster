// Internal protected-store adapter for provider API secrets.
//
// SCOPE — read this before assuming more than it does.
//
// This is a **protected storage adapter**, deliberately NOT a capability or
// authority design. An earlier revision of this file was named a "broker" and
// advertised an opaque-handle boundary with no credential read-back. That claim
// was not implemented and has been withdrawn:
//
//   * a public generic `use(handle) { … }` handed raw secret `Data` to an
//     unrestricted caller closure, so `try use(h) { $0 }` was a read-back;
//   * handles were validated by string consistency against a derivable account
//     name, not by issuance or ownership, so a fabricated one passed.
//
// Rather than invent an identity scheme before the W1b authority contract is
// accepted — it is unaccepted and default-off — this is narrowed to what it
// genuinely does: put, fetch and delete provider secrets in OS protected storage
// with **fail-closed, measured** failure handling. Owner binding, device binding
// and capability issuance are explicitly a **future caller responsibility**, to be
// implemented against the accepted authority contract, not here.
//
// What this type does guarantee, and what its tests demonstrate:
//   * a refused write throws and stores nothing — there is no partial state;
//   * a refused *replacement* leaves the previous secret intact;
//   * the real `OSStatus` is surfaced, never collapsed to a boolean;
//   * a refused delete retains the secret and reports failure;
//   * confirmed absence counts as a successful delete;
//   * there is no plaintext fallback, only an explicit refusal.
// It does NOT guarantee secrecy from other code in the same process — this is an
// internal adapter, and `fetch` returns the secret by design.
//
// Distinct from `SessionKeychain`, which stores exactly one session cookie under
// a fixed service/account. That file is deliberately untouched; this reuses its
// *disciplines*, not its code path, and provider secrets live under their own
// Keychain service so the two can never collide.

import Foundation
import Security

// MARK: - Low-level Keychain seam

/// The four `SecItem` calls this adapter makes, behind a seam so the
/// update-then-add split, the duplicate-item race, and the attribute set can be
/// exercised without touching the user's real Keychain.
internal protocol KeychainItemOps: Sendable {
    func add(_ attributes: [String: Any]) -> OSStatus
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
    func read(_ query: [String: Any]) -> (OSStatus, Data?)
    func delete(_ query: [String: Any]) -> OSStatus
}

internal struct SystemKeychainItemOps: KeychainItemOps {
    func add(_ attributes: [String: Any]) -> OSStatus { SecItemAdd(attributes as CFDictionary, nil) }
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }
    func read(_ query: [String: Any]) -> (OSStatus, Data?) {
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result as? Data)
    }
    func delete(_ query: [String: Any]) -> OSStatus { SecItemDelete(query as CFDictionary) }
}

// MARK: - Storage

internal protocol ProviderSecretStorage: Sendable {
    /// Returns the real `OSStatus`. Never falls back, never swallows.
    func write(_ data: Data, account: String) -> OSStatus
    func read(account: String) -> (OSStatus, Data?)
    func delete(account: String) -> OSStatus
}

/// The Apple implementation. Provider secrets get their own service, and are
/// `ThisDeviceOnly` so they do not travel in the Keychain's own backup path.
internal struct SystemProviderSecretStorage: ProviderSecretStorage {
    /// Deliberately different from `SessionKeychain`'s service.
    static let service = "com.muster.MusterMac.provider"

    private let ops: any KeychainItemOps
    init(ops: any KeychainItemOps = SystemKeychainItemOps()) { self.ops = ops }

    private func query(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
        ]
    }

    func write(_ data: Data, account: String) -> OSStatus {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        // Update in place, never delete-then-add: a refused update must leave the
        // working secret intact rather than destroying it in between.
        let status = ops.update(query(account: account), attributes: attributes)
        if status == errSecSuccess { return status }
        guard status == errSecItemNotFound else { return status }
        return ops.add(query(account: account).merging(attributes) { _, new in new })
    }

    func read(account: String) -> (OSStatus, Data?) {
        var q = query(account: account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        return ops.read(q)
    }

    func delete(account: String) -> OSStatus { ops.delete(query(account: account)) }
}

// MARK: - Vocabulary

/// A storage key for one provider secret. **Not** a capability: it carries no
/// proof of issuance and no owner. See the scope note at the top of this file.
internal struct ProviderSecretRef: Hashable, Sendable {
    let account: String
    let provider: String
}

/// Fail-closed errors. Each means "the secret is not protected as asked", never
/// "carry on unprotected". Conforms to `LocalizedError` so `localizedDescription`
/// actually uses these measured messages.
internal enum ProviderCustodyError: Error, Equatable, LocalizedError, Sendable {
    case writeRefused(OSStatus)
    case deleteRefused(OSStatus)
    case readFailed(OSStatus)
    /// A ref that does not match the account derived for its provider. This is a
    /// programming-error guard, **not** an authorisation check.
    case inconsistentRef
    /// There is no plaintext fallback. Asking for one is a visible refusal.
    case plaintextFallbackForbidden

    var errorDescription: String? {
        switch self {
        case let .writeRefused(status):
            return "Could not protect this provider key (status \(status))."
        case let .deleteRefused(status):
            return "Could not remove this provider key (status \(status)). It is still stored on this Mac."
        case let .readFailed(status):
            return "Could not read this provider key (status \(status))."
        case .inconsistentRef:
            return "This provider key reference is not valid."
        case .plaintextFallbackForbidden:
            return "Muster does not store provider keys unprotected."
        }
    }
}

/// What a caller may know about a provider: whether a secret is present, plus the
/// real status that was measured. No secret, no readiness that was not verified.
internal struct ProviderCustodyStatus: Equatable, Sendable {
    let provider: String
    let configured: Bool
    let measuredStatus: OSStatus?

    init(provider: String, configured: Bool, measuredStatus: OSStatus?) {
        self.provider = provider
        self.configured = configured
        self.measuredStatus = measuredStatus
    }
}

// MARK: - The adapter

@MainActor
internal final class ProviderSecretStore {
    private let storage: any ProviderSecretStorage
    private let account: @Sendable (String) -> String

    init(storage: any ProviderSecretStorage = SystemProviderSecretStorage(),
         account: @escaping @Sendable (String) -> String = { "provider:\($0)" }) {
        self.storage = storage
        self.account = account
    }

    private func account(for provider: String) -> String { account(provider) }

    /// Programming-error guard only. It checks that a ref is internally
    /// consistent; it does **not** establish that the ref was ever issued, nor
    /// that the caller may use it. That is a future caller's job, against the
    /// accepted authority contract.
    private func checkConsistency(_ ref: ProviderSecretRef) throws {
        guard ref.account == account(for: ref.provider) else {
            throw ProviderCustodyError.inconsistentRef
        }
    }

    /// Stores `secret` and returns its storage key.
    ///
    /// Throws `.writeRefused` if storage refuses, and stores nothing in that
    /// case — there is no partial or pretend state. A refused *replacement* leaves
    /// any previously stored secret intact and still configured.
    @discardableResult
    func store(secret: Data, provider: String) throws -> ProviderSecretRef {
        let key = account(for: provider)
        let status = storage.write(secret, account: key)
        guard status == errSecSuccess else { throw ProviderCustodyError.writeRefused(status) }
        return ProviderSecretRef(account: key, provider: provider)
    }

    /// Configured state, measured rather than assumed.
    func status(for provider: String) -> ProviderCustodyStatus {
        let key = account(for: provider)
        let (status, data) = storage.read(account: key)
        if status == errSecSuccess, data != nil {
            return ProviderCustodyStatus(provider: provider, configured: true, measuredStatus: status)
        }
        return ProviderCustodyStatus(provider: provider, configured: false,
                                     measuredStatus: status == errSecItemNotFound ? nil : status)
    }

    /// Returns the stored secret.
    ///
    /// This adapter is internal and trusted, and returns the secret **by design**.
    /// It is not a read-back barrier; the barrier, if one is wanted, belongs in
    /// whatever calls this — not here, and not yet.
    func fetch(_ ref: ProviderSecretRef) throws -> Data {
        try checkConsistency(ref)
        let (status, data) = storage.read(account: ref.account)
        guard status == errSecSuccess, let data else {
            throw ProviderCustodyError.readFailed(status)
        }
        return data
    }

    /// Removes the secret. A refused deletion throws and the secret is
    /// **retained**; it is never reported as removed. Confirmed absence counts as
    /// success, because the secret is genuinely gone.
    func delete(_ ref: ProviderSecretRef) throws {
        try checkConsistency(ref)
        let status = storage.delete(account: ref.account)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ProviderCustodyError.deleteRefused(status)
        }
    }

    /// Always fails. Exists so a future caller reaching for a downgrade gets a
    /// named refusal instead of an unencrypted write.
    func plaintextFallback() throws -> Never {
        throw ProviderCustodyError.plaintextFallbackForbidden
    }
}