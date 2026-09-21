// WatchHandoffBridge — the phone keeps the watch paired without re-pairing.
//
// One job, both directions:
//  - after the phone pairs (QR, code, or invite), push the {connection, token}
//    to the paired watch, which adopts it with no code entry at all;
//  - after the phone unpairs, push a tombstone so the watch unpairs too —
//    a watch that keeps a token for a computer the phone disowned would
//    be a stale trust root on a wrist.
//
// Everything here degrades silently when there is no paired watch: the
// simulator, a phone without the watch app, or a watch out of reach. The
// watch's own pairing flow stays fully functional for a watch that never
// received a handoff.
import Foundation
import WatchConnectivity
import CompanionCore

@MainActor
final class WatchHandoffBridge: NSObject, WCSessionDelegate {
    static let shared = WatchHandoffBridge()

    private override init() {
        super.init()
        activateIfNeeded()
    }

    /// Call once at app start so a handoff arriving while the phone was
    /// closed (application context) is picked up before the first render.
    func activateIfNeeded() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        guard session.activationState != .activated else { return }
        session.activate()
    }

    // MARK: - Phone -> watch

    /// After a successful pairing on the phone.
    func pushPairing(connection: Connection, token: String) {
        send(CompanionHandoff(connection: connection, token: token))
    }

    /// After an unpair on the phone.
    func pushUnpair() {
        guard let session = reachableSession() else { return }
        // The tombstone rides both channels: user-info survives even if the
        // watch is unreachable a moment later.
        try? session.updateApplicationContext([CompanionHandoffCodec.key: Data(CompanionHandoffCodec.unpairMarker.utf8)])
        session.transferUserInfo([CompanionHandoffCodec.key: Data(CompanionHandoffCodec.unpairMarker.utf8)])
    }

    private func send(_ handoff: CompanionHandoff) {
        guard let data = CompanionHandoffCodec.encode(handoff) else { return }
        // Application context: latest-wins, delivered even when the watch
        // app is not running — exactly the semantics a pairing wants.
        if let session = reachableSession() {
            try? session.updateApplicationContext([CompanionHandoffCodec.key: data])
        }
        // And a user-info transfer as belt-and-braces: it queues until the
        // watch is reachable, so a pairing done on the train still lands.
        if WCSession.isSupported() {
            WCSession.default.transferUserInfo([CompanionHandoffCodec.key: data])
        }
    }

    private func reachableSession() -> WCSession? {
        guard WCSession.isSupported() else { return nil }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return nil }
        return session
    }

    // MARK: - WCSessionDelegate

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        // Nothing to do on the phone side; the watch side adopts context.
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        // Required on the phone: re-activate so the next handoff works.
        session.activate()
    }
}
