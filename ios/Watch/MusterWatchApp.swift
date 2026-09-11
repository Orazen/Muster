// The watch app's entry point. One scene, one session object, and the
// lifecycle rule the phone follows too: hold the stream only while the app
// can use it. watchOS suspends the app moments after it leaves the screen
// and would kill the socket anyway — dropping it ourselves means the cursor
// stops at a known place, and waking reconnects with whatever gap remains.
import SwiftUI

@main
struct MusterWatchApp: App {
    @StateObject private var session = WatchSession()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
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
            @unknown default:
                break
            }
        }
    }
}
