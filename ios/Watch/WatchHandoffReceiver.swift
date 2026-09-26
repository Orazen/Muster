// WatchHandoffReceiver — the watch side of phone-to-watch pairing.
//
// The phone's WatchHandoffBridge pushes {connection, token, generation} over
// WatchConnectivity after the phone pairs; this receiver adopts it with the
// watch's own normal pairing path (token to keychain, connection to
// defaults, client built, stream connected) — the wrist never types a
// six-digit code again. A tombstone value unpairs the watch when the phone
// unpairs.
//
// The radio delivers on its own schedule (watch app not running, wrist
// asleep), on two channels, so the SAME payload can arrive twice and an OLDER
// payload can arrive after a newer one. Every entry point therefore funnels
// into `adoptIfNewer`, which asks `WatchHandoffOrdering` what to do and then
// only carries the decision out. The ordering itself — higher generation wins,
// equal is a no-op, lower is dropped — lives in CompanionCore where it is
// tested; see that file for why a queued delivery used to be able to restore
// revoked trust.
import Foundation
import WatchConnectivity
import WatchKit
import CompanionCore

@MainActor
final class WatchHandoffReceiver: NSObject, WCSessionDelegate {
    static let shared = WatchHandoffReceiver()

    private weak var session: WatchSession?
    /// Ordering lives in CompanionCore so it is testable; this is only a handle
    /// on it. Nil until `attach(to:)`, so a delegate callback that beats
    /// activation does nothing rather than deciding without persistence.
    private var ordering: WatchHandoffOrdering?

    private override init() {
        super.init()
    }

    /// Wire up once, from the app's composition root, after WatchSession
    /// exists. Activation is what surfaces anything already waiting in the
    /// application context (a handoff sent while the watch app was closed).
    func attach(to session: WatchSession) {
        self.session = session
        ordering = WatchHandoffOrdering(store: UserDefaultsHandoffTrustStore())
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

    /// The single decision every delivery path funnels into.
    ///
    /// The ORDERING is not decided here — it is decided by
    /// `WatchHandoffOrdering` in CompanionCore, where it can be tested without
    /// a radio. This shell only carries out the decision: adopt, unpair,
    /// ignore. Before that existed, any delivery that was not byte-identical to
    /// the current one was adopted, so a queued older pairing could put a
    /// revoked computer's token back into the keychain, and a queued older
    /// unpair could sign out a pairing created after it.
    private func adoptIfNewer(dictionary: [String: Any]) {
        guard let session, let ordering else { return }
        guard let data = dictionary[CompanionHandoffCodec.key] as? Data else { return }

        // Tombstone: the phone unpaired, so does the watch — unless a newer
        // pairing has already superseded it.
        if CompanionHandoffCodec.isUnpair(data) {
            let tombstone = CompanionHandoffCodec.decodeTombstone(from: dictionary)
            switch ordering.decideUnpair(generation: tombstone?.generation) {
            case .unpair:
                if session.connection != nil { session.signOut() }
            case .stale, .duplicate:
                break
            case .adopt:
                break
            }
            return
        }

        guard let handoff = CompanionHandoffCodec.decode(from: data) else { return }
        switch ordering.decidePairing(handoff) {
        case .adopt:
            session.adoptHandoff(handoff)
            // Only now that the pairing is actually in place: the generation
            // floor must not advance ahead of the work it is meant to describe.
            ordering.commitAdoption(handoff)
            WKInterfaceDevice.current().play(.notification)
        case .duplicate, .stale:
            break
        case .unpair:
            break
        }
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
