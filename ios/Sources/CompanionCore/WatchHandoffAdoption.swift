import Foundation

/// The credential boundary used by WatchSession. A failed candidate save must
/// leave the old stream, connection, defaults and credential untouched. These
/// synchronous closures cannot interleave with another main-actor handoff.
public enum WatchHandoffAdoption {
    @MainActor
    public static func perform(
        _ handoff: CompanionHandoff,
        replacing previous: Connection?,
        saveCredential: (_ token: String, _ connectionID: String) throws -> Void,
        activate: (_ connectionData: Data) -> Void,
        removeCredential: (_ connectionID: String) -> Void
    ) throws {
        // Prepare fallible data before touching the credential store.
        let encoded = try JSONEncoder().encode(handoff.connection)
        try saveCredential(handoff.token, handoff.connection.id)
        activate(encoded)
        if let previous, previous.id != handoff.connection.id {
            removeCredential(previous.id)
        }
    }
}
