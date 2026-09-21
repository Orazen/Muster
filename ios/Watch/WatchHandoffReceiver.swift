// WatchHandoffReceiver — the watch side of phone-to-watch pairing.
//
// The phone's WatchHandoffBridge pushes {connection, token} over
// WatchConnectivity after the phone pairs; this receiver adopts it with the
// watch's own normal pairing path (token to keychain, connection to
// defaults, client built, stream connected) — the wrist never types a
// six-digit code again. A tombstone value unpairs the watch when the phone
// unpairs.
//
// The radio delivers on its own schedule (watch app not running, wrist
// asleep); every entry point funnels into one idempotent adopt that checks
// the incoming token against what is already stored, so a redelivered
// context is a no-op, not a re-pair.
import Foundation
import WatchConnectivity
import WatchKit
import CompanionCore

@MainActor
final class WatchHandoffReceiver: NSObject, WCSessionDelegate {
    static let shared = WatchHandoffReceiver()

    private weak var session: WatchSession?

    private override init() {
        super.init()
    }

    /// Wire up once, from the app's composition root, after WatchSession
    /// exists. Activation is what surfaces anything already waiting in the
    /// application context (a handoff sent while the watch app was closed).
    func attach(to session: WatchSession) {
        self.session = session
#if DEBUG
        // Owned acceptance: the rig delivers the handoff as a launch
        // argument (JSON, identical to what the radio would carry). The
        // receiver path below is the same adoptIfNewer the delegates use.
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "-watch-handoff-payload"),
           index + 1 < arguments.count,
           let data = arguments[index + 1].data(using: .utf8) {
            session.consumeTestingHandoff(data: data)
        }
#endif
        guard WCSession.isSupported() else { return }
        let wc = WCSession.default
        wc.delegate = self
        if wc.activationState != .activated {
            wc.activate()
        } else {
            adoptPendingContext()
        }
    }

    private func adoptPendingContext() {
        let context = WCSession.default.receivedApplicationContext
        guard !context.isEmpty else { return }
        adoptIfNewer(dictionary: context)
    }

    /// The single decision every delivery path funnels into. Idempotent: if
    /// the token on the wire is the one already in the keychain, nothing
    /// happens — that is what makes redelivery harmless. A fresh token
    /// (re-paired phone, new computer) goes through the watch's normal pair
    /// path.
    private func adoptIfNewer(dictionary: [String: Any]) {
        guard let session else { return }
        // Tombstone: the phone unpaired, so does the watch.
        if let data = dictionary[CompanionHandoffCodec.key] as? Data,
           String(data: data, encoding: .utf8) == CompanionHandoffCodec.unpairMarker {
            if session.connection != nil {
                session.signOut()
            }
            return
        }
        guard let handoff = CompanionHandoffCodec.decode(from: dictionary) else { return }
        // Already on this exact pairing? Nothing to do — this is what makes
        // redelivery harmless.
        if session.connection?.id == handoff.connection.id,
           (try? Keychain.token(for: handoff.connection.id)) == handoff.token {
            return
        }
        session.adoptHandoff(handoff)
        WKInterfaceDevice.current().play(.notification)
    }

    // MARK: - WCSessionDelegate

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard activationState == .activated else { return }
        Task { @MainActor in
            self.adoptPendingContext()
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in
            self.adoptIfNewer(dictionary: applicationContext)
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        Task { @MainActor in
            self.adoptIfNewer(dictionary: userInfo)
        }
    }

    /// Live handoff while both sides are talking.
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor in
            self.adoptIfNewer(dictionary: message)
        }
    }

    // MARK: - Owned acceptance hook

    /// Feed the receiver exactly what WCSession would deliver. The real
    /// radio needs a physically paired iPhone+Watch simulator duo, which no
    /// CI or rig in this repo can create; the owned watch UI test drives
    /// this DEBUG-only hook instead and asserts the identical downstream
    /// behavior — adoption without the pairing UI. The delegate methods
    /// above call adoptIfNewer with the same dictionaries, so the hook and
    /// the radio share one code path.
#if DEBUG
    func ingestTestingHandoff(dictionary: [String: Any]) {
        adoptIfNewer(dictionary: dictionary)
    }
#endif
}

#if DEBUG
extension WatchSession {
    /// DEBUG-only: adopt a handoff payload exactly as the receiver would —
    /// same decode, same idempotence, same pair path — without a radio.
    func consumeTestingHandoff(data: Data) {
        guard let handoff = try? JSONDecoder().decode(CompanionHandoff.self, from: data) else { return }
        adoptHandoff(handoff)
    }
}
#endif
