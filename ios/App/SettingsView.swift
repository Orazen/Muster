// Settings stays status-first: who this phone is paired with, what it is
// allowed to do, and the few controls worth having on a phone. Almost
// nothing here is editable on purpose: API keys, pairing and the Local VM
// live on the computer, because losing the phone must not mean losing the
// ability to lock it out. Network details live one level deeper so the
// everyday screen stays calm.
//
// The row and tile shape — the colored SettingsIcon tiles, the computer
// row with its status dot, the Connection details page with its
// troubleshooting block — is adapted from the OpenMausBot companion's
// SettingsView (https://github.com/milind-soni/OpenMausBot, Apache-2.0 —
// full license text and attribution in public/third-party-notices.txt,
// shipped with the app). Deliberately not ported here: multi-computer
// switching and address editing (this client pairs with one computer and
// cannot edit a saved address), and the workspace screens (they need
// server routes this client does not have). See
// docs/plans/openmaus-ios-parity.md.
import SwiftUI
import CompanionCore
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var session: Session
    @State private var confirmingSignOut = false
    @State private var enablingNotifications = false

    var body: some View {
        Form {
            Section("Computer") {
                if let connection = session.connection {
                    NavigationLink {
                        ConnectionDetailsView()
                    } label: {
                        ComputerSettingsRow(
                            name: Text(verbatim: connection.name),
                            status: Text(statusText),
                            connected: session.status == .live
                        )
                    }
                    .accessibilityIdentifier("settings-connection")
                } else {
                    LabeledContent("Connection", value: statusText)
                }
            }

            Section {
                if notificationsAreEnabled {
                    notificationRow
                        .accessibilityHint(notificationAccessibilityHint)
                } else {
                    Button {
                        enablingNotifications = true
                        Task {
                            await session.enableNotifications()
                            enablingNotifications = false
                        }
                    } label: {
                        notificationRow
                    }
                    .disabled(enablingNotifications)
                    .accessibilityHint(notificationAccessibilityHint)
                }
            } header: {
                Text("Notifications")
            } footer: {
                Text("Approvals and finished work appear while MusterMobile is connected, including frames replayed after a short background pause. Closed-app push needs the separate APNs relay release.")
            }

            Section {
                NavigationLink {
                    QuickRepliesEditor()
                } label: {
                    Label {
                        Text("Quick Replies")
                    } icon: {
                        SettingsIcon(symbol: "bolt.fill", color: .yellow)
                    }
                }
                .accessibilityIdentifier("settings-quick-replies")
            } header: {
                Text("Chat")
            } footer: {
                Text("The chips above the composer: rename them, reorder them, add the prompt you type every day.")
            }

            Section {
                Button("Unpair this phone", role: .destructive) { confirmingSignOut = true }
            } footer: {
                Text("Removes the pairing from this phone only. To stop it reaching the computer at all, remove the device in Muster → Settings → Companion.")
            }

            Section("Not here") {
                Text("API keys, pairing and the Local VM are managed on the computer. This phone is deliberately not allowed to change them.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .task { await session.refreshNotificationAuthorization() }
        .confirmationDialog(
            "Unpair this phone?",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Unpair", role: .destructive) { session.signOut() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You'll need a new pairing code to connect again.")
        }
    }

    private var notificationsAreEnabled: Bool {
        switch session.notificationAuthorization {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    private var notificationAccessibilityHint: LocalizedStringKey {
        if notificationsAreEnabled { return "Notifications are enabled" }
        if session.notificationAuthorization == .denied { return "Opens device Settings" }
        return "Asks for permission to send notifications"
    }

    private var notificationRow: some View {
        HStack(spacing: 12) {
            SettingsIcon(symbol: "bell.fill", color: .red)
            Text("Notifications")
                .foregroundStyle(.primary)
            Spacer()
            if enablingNotifications {
                ProgressView()
                    .controlSize(.small)
            } else {
                Text(LocalizedStringKey(session.notificationStatusText))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var statusText: String {
        switch session.status {
        case .live: return "Connected"
        case .connecting: return "Connecting…"
        case .unpaired: return "Not paired"
        case .unauthorized: return "Unpaired on the computer"
        case let .offline(reason): return reason
        }
    }
}

/// The computer row: who, and whether the line to them is up.
struct ComputerSettingsRow: View {
    let name: Text
    let status: Text
    let connected: Bool

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(AgentPalette.color("blue").opacity(0.14))
                    .frame(width: 38, height: 38)
                Image(systemName: "laptopcomputer")
                    .foregroundStyle(AgentPalette.color("blue"))
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                name
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Circle()
                        .fill(connected ? Color.green : Color.secondary)
                        .frame(width: 7, height: 7)
                    status
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// The colored tile every settings row wears, so the list reads as choices
/// rather than as more status.
struct SettingsIcon: View {
    let symbol: String
    let color: Color

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(color, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// One level deeper: the full address, what to check when the line is
/// down, and a reconnect that does not make the person restart anything.
///
/// Removing the pairing is deliberately *not* here — it stays on the main
/// Settings screen, where this app has always kept it.
struct ConnectionDetailsView: View {
    @EnvironmentObject private var session: Session
    @State private var showingFullAddress = false
    @State private var copiedAddress = false
    @State private var refreshing = false

    var body: some View {
        Form {
            if let connection = session.connection {
                Section {
                    HStack(spacing: 14) {
                        ProfileAvatar(name: connection.name, size: 46)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(connection.name)
                                .font(.headline)
                            Label {
                                session.status.settingsText
                            } icon: {
                                Image(systemName: session.status == .live ? "checkmark.circle.fill" : "circle.dotted")
                            }
                                .font(.subheadline)
                                .foregroundStyle(session.status == .live ? Color.green : Color.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }

                Section {
                    DisclosureGroup("Connection details") {
                        VStack(alignment: .leading, spacing: 12) {
                            Group {
                                if showingFullAddress {
                                    Text(connection.displayAddress)
                                        .textSelection(.enabled)
                                } else {
                                    Text(shortened(connection.displayAddress))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                            }
                            .font(.footnote.monospaced())
                            .foregroundStyle(.secondary)

                            HStack(spacing: 16) {
                                Button(showingFullAddress ? "Hide full address" : "Show full address") {
                                    showingFullAddress.toggle()
                                }
                                Button(copiedAddress ? "Copied" : "Copy") {
                                    UIPasteboard.general.string = connection.displayAddress
                                    copiedAddress = true
                                    Task {
                                        try? await Task.sleep(for: .seconds(2))
                                        copiedAddress = false
                                    }
                                }
                            }
                            .font(.subheadline.weight(.medium))
                        }
                        .padding(.top, 10)
                    }
                } footer: {
                    Text("The address this phone dials, exactly as it was paired.")
                }

                Section("Troubleshooting") {
                    troubleshootingText
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    Button {
                        refreshing = true
                        Task {
                            await session.refresh()
                            refreshing = false
                        }
                    } label: {
                        HStack {
                            Text("Try reconnecting")
                            if refreshing {
                                Spacer()
                                ProgressView().controlSize(.small)
                            }
                        }
                    }
                    .disabled(refreshing)
                    .accessibilityIdentifier("connection-retry")
                }
            } else {
                ContentUnavailableView("No computer connected", systemImage: "laptopcomputer.slash")
            }
        }
        .navigationTitle("Connection")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Our copy, except for `.offline`, whose text the computer itself sent
    /// and which is shown exactly as it arrived.
    private var troubleshootingText: Text {
        switch session.status {
        case .live:
            return Text("This computer is connected and responding normally.")
        case .connecting:
            return Text("Muster is trying the saved connection automatically.")
        case let .offline(reason):
            return Text(verbatim: reason)
        case .unauthorized:
            return Text("This device was removed from the computer. Pair it again to reconnect.")
        case .unpaired:
            return Text("This device is not paired with a computer.")
        }
    }

    private func shortened(_ address: String) -> String {
        guard address.count > 14 else { return address }
        let leadingCount = min(20, max(8, address.count - 8))
        return "\(address.prefix(leadingCount))…\(address.suffix(6))"
    }
}

private extension Session.Status {
    var settingsText: Text {
        switch self {
        case .live: return Text("Connected")
        case .connecting: return Text("Connecting…")
        case .unpaired: return Text("Not paired")
        case .unauthorized: return Text("Needs pairing")
        case .offline: return Text("Offline")
        }
    }
}
