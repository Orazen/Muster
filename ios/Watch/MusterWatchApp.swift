// The watch app's entry point. One scene, one session object, and the
// lifecycle rule the phone follows too: hold the stream only while the app
// can use it. watchOS suspends the app moments after it leaves the screen
// and would kill the socket anyway — dropping it ourselves means the cursor
// stops at a known place, and waking reconnects with whatever gap remains.
import SwiftUI

@MainActor
enum MusterWatchAppComposition {
    static var isTestHost: Bool {
#if DEBUG
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            || ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("-XCTest") })
#else
        false
#endif
    }

    static var shouldAttachHandoffReceiver: Bool { !isTestHost }
    static var shouldBuildProductionScene: Bool { !isTestHost }

    static func makeSession() -> WatchSession {
#if DEBUG
        if isTestHost {
            guard let defaults = UserDefaults(suiteName: "com.muster.watch.testhost.\(UUID().uuidString)") else {
                preconditionFailure("Could not create isolated Watch XCTest defaults")
            }
            return WatchSession(
                credentialStore: InertWatchTestHostCredentialStore(),
                defaults: defaults,
                snapshotPublisher: { _ in }
            )
        }
#endif
        return WatchSession()
    }
}

#if DEBUG
private final class InertWatchTestHostCredentialStore: CredentialStore {
    private var values: [String: String] = [:]

    func save(_ token: String, for connectionId: String) throws {
        values[connectionId] = token
    }

    func token(for connectionId: String) throws -> String? {
        values[connectionId]
    }

    func remove(_ connectionId: String) -> Bool {
        values.removeValue(forKey: connectionId)
        return true
    }
}
#endif

@main
struct MusterWatchApp: App {
    @StateObject private var session = MusterWatchAppComposition.makeSession()

    var body: some Scene {
        WindowGroup {
            appSceneContent
        }
    }

    @ViewBuilder
    private var appSceneContent: some View {
#if DEBUG
        if MusterWatchAppComposition.shouldBuildProductionScene {
            productionRootView
        } else {
            Color.clear
        }
#else
        productionRootView
#endif
    }

    private var productionRootView: some View {
        ProductionWatchScene(session: session)
    }
}

/// Constructed only for a production scene. The Debug XCTest host takes the
/// inert branch above before creating either the pairing UI or view services.
private struct ProductionWatchScene: View {
    let session: WatchSession
    /// One synthesizer for the whole app. Two would fight over the single
    /// audio session watchOS gives an app, and the fleet header and the chat
    /// both need to reach it.
    @StateObject private var voice = WatchVoice()
    /// Phone-to-watch pairing handoff. Attached once after this production
    /// scene exists, so the receiver has the session to adopt into.
    @State private var handoffAttached = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        RootView()
            .environmentObject(session)
            .environmentObject(voice)
            .task {
                if !handoffAttached {
                    if MusterWatchAppComposition.shouldAttachHandoffReceiver {
                        WatchHandoffReceiver.shared.attach(to: session)
                    }
                    handoffAttached = true
                }
                session.setForeground(scenePhase == .active)
                if scenePhase == .active { session.connect() }
            }
            .onChange(of: scenePhase) { _, phase in
                session.setForeground(phase == .active)
                switch phase {
                case .active:
                    session.connect()
                case .background, .inactive:
                    session.disconnect()
                    // A wrist that leaves the screen mid-sentence should stop
                    // talking. The synthesizer would keep going into a suspended
                    // app's audio session otherwise.
                    voice.stop()
                @unknown default:
                    break
                }
            }
    }
}
