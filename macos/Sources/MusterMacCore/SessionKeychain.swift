// Session persistence with the same discipline as the CLI's 0600 config:
// the cookie is stored only through this helper, only in the login
// keychain, only readable by this device after first unlock — never in
// UserDefaults, never in a file the transport writes.

import Foundation
import Security

public enum SessionKeychain {
    private static let service = "com.muster.MusterMac"

    public static func save(_ account: HarnessAccount) {
        guard let data = try? JSONEncoder().encode(account) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "session",
        ]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attributes as CFDictionary, nil)
    }

    public static func load() -> HarnessAccount? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "session",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let account = try? JSONDecoder().decode(HarnessAccount.self, from: data) else { return nil }
        return account
    }

    public static func clear() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "session",
        ] as CFDictionary)
    }
}
