// The watch app's entry point. One scene, one session object, and the
// lifecycle rule the phone follows too: hold the stream only while the app
// can use it. watchOS suspends the app moments after it leaves the screen
// and would kill the socket anyway — dropping it ourselves means the cursor
// stops at a known place, and waking reconnects with whatever gap remains.
import SwiftUI

@main
struct MusterWatchApp: App {
    @StateObject private var session = WatchSession()
    /// One synthesizer for the whole app. Two would fight over the single
    /// audio session watchOS gives an app, and the fleet header and the chat
    /// both need to reach it.
    @StateObject private var voice = WatchVoice()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(voice)
                .task {
                    session.setForeground(scenePhase == .active)
                    if scenePhase == .active { session.connect() }
                }
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
