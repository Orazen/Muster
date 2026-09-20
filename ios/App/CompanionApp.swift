// App entry, and the one place that decides when the event stream lives.
//
// A phone is not a desktop: the stream is torn down the moment the app
// leaves the screen, because iOS is going to kill it anyway and doing it
// deliberately means the cursor is written down at a known point. Coming
// back asks the harness what was missed rather than asking for everything.
import SwiftUI

@main
struct CompanionApp: App {
    @StateObject private var session = Session()
    /// One speaker for the whole app, hoisted out of Walkie so the roster and
    /// the chat header can see whose reply is being read. The watch does the
    /// same with `WatchVoice`; two speakers would fight over the single audio
    /// session anyway.
    @StateObject private var announcer = Announcer()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(announcer)
                .onAppear {
                    // Categories must exist before a banner is delivered, or
                    // its action is a dead tap; the closure routes a tap to
                    // the conversation that produced the alert.
                    NotificationCoordinator.shared.registerCategories()
                    NotificationCoordinator.shared.onOpenThread = { threadId in
                        session.pendingOpenThreadId = threadId
                    }
                    session.setForeground(scenePhase == .active); session.connect()
                }
                .onOpenURL { url in
                    // Two flavors ride the `muster` scheme: pairing invites
                    // (muster://pair?…) and the cloud OAuth finish
                    // (muster://oauth/finish#code=…). Route by host.
                    if url.host?.lowercased() == "oauth" {
                        CloudAuth.shared.handleCallback(url)
                    } else {
                        session.receivePairingURL(url)
                    }
                }
                .onChange(of: scenePhase) { _, phase in
                    session.setForeground(phase == .active)
                    switch phase {
                    case .active:
                        session.connect()
                        Task { await session.refreshNotificationAuthorization() }
                    case .background: session.disconnect()
                    case .inactive: break
                    @unknown default: break
                    }
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        Group {
            switch session.status {
            case .unpaired:
                // A pending pairing invite always wins — deep links are
                // explicit intent and must never be intercepted by the
                // welcome (owned UI tests and real invites both ride this).
                if session.pairingInvite != nil || session.welcomeSeen {
                    PairingView()
                } else {
                    WelcomeView()
                }
            case .unauthorized:
                UnpairedView()
            default:
                ChatListView()
            }
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { session.actionError != nil },
                set: { if !$0 { session.actionError = nil } }
            ),
            presenting: session.actionError
        ) { _ in
            Button("OK", role: .cancel) { session.actionError = nil }
        } message: { message in
            Text(message)
        }
    }
}

/// The token stopped working. Almost always because someone revoked this
/// phone on the computer — which is exactly what that button is for, so the
/// honest thing is to say so and offer to pair again.
struct UnpairedView: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        ContentUnavailableView {
            Label("This phone was unpaired", systemImage: "lock.slash")
        } description: {
            Text("It was removed from the computer's companion settings, or the pairing was reset.")
        } actions: {
            Button("Pair again") { session.signOut() }
                .buttonStyle(.borderedProminent)
        }
    }
}
