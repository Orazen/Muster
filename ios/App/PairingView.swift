// Pairing: scan the computer's QR, confirm its identity, and connect.
//
// Two ways in, because discovery is allowed to fail. Bonjour finds the
// computer by name when the network cooperates; when it does not — a guest
// network with multicast off, a responder that could not take port 5353 —
// the address the desktop panel prints is typed instead. Neither path is a
// fallback bolted on: the desktop panel changes its own wording to match.
import SwiftUI
import CompanionCore
#if canImport(UIKit)
import UIKit
#endif

struct PairingView: View {
    private enum Field: Hashable { case address, code }
    private struct ScannerOpening: Identifiable { let id = UUID() }

    @EnvironmentObject private var session: Session
    @StateObject private var discovery = Discovery()

    @State private var manualAddress = ""
    @State private var code = ""
    @State private var scannedCredential: String?
    @State private var chosen: Connection?
    @State private var pairingOperation: UUID?
    @State private var failure: String?
    @State private var scannerOpening: ScannerOpening?
    @State private var selectionGeneration = UUID()
    @State private var resolving: UUID?
    @State private var ignoredInvitation = false
    @FocusState private var focusedField: Field?

    private var pairing: Bool { pairingOperation != nil }

    var body: some View {
        NavigationStack {
            Form {
                if ignoredInvitation {
                    Section {
                        Text("Another pairing link arrived during this connection attempt. It was not used. Open it again after this attempt finishes.")
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("pairing-invite-notice")
                    }
                }
                if let chosen {
                    codeSection(for: chosen)
                } else {
                    setupSection
                    manualSection
                    discoverySection
                }
            }
            .navigationTitle("Pair with a computer")
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focusedField = nil }
                        .accessibilityIdentifier("pairing-keyboard-done")
                }
            }
            .alert("Pairing problem", isPresented: Binding(
                get: { failure != nil },
                set: { if !$0 { failure = nil } }
            ), presenting: failure) { _ in
                Button("OK", role: .cancel) { failure = nil }
                    .accessibilityIdentifier("pairing-error-ok")
            } message: { message in
                Text(message).accessibilityIdentifier("pairing-error")
            }
            .onAppear {
                discovery.start()
                accept(session.pairingInvite)
            }
            .onDisappear { discovery.stop() }
            .onChange(of: session.pairingInvite) { _, invite in accept(invite) }
            .fullScreenCover(item: $scannerOpening) { opening in
                PairingScannerSheet { payload in
                    guard scannerOpening?.id == opening.id, !pairing else {
                        return "This scanner is no longer choosing a computer. Start scanning again after the current attempt."
                    }
                    guard let url = URL(string: payload), let invite = PairingInvite.parse(url) else {
                        return "That isn't a Muster pairing QR code."
                    }
                    accept(invite, fromSession: false)
                    return nil
                }
            }
        }
    }

    // MARK: - Choosing a computer

    private var setupSection: some View {
        Section("On your computer") {
            Label("Open Muster → Settings → Companion", systemImage: "1.circle.fill")
            Label("Choose Set up a phone", systemImage: "2.circle.fill")
            Button {
                guard !pairing, chosen == nil, scannerOpening == nil else { return }
                invalidateResolution()
                focusedField = nil
                failure = nil
                scannerOpening = ScannerOpening()
            } label: {
                Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(pairing)
            .accessibilityIdentifier("pairing-scan")

            Text("Scan the QR code, check the computer name, and confirm. The address and one-time credential are filled in for you.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var discoverySection: some View {
        Section("On this network") {
            if let problem = discovery.failure {
                Label(problem, systemImage: "wifi.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if discovery.found.isEmpty {
                HStack {
                    ProgressView()
                    Text("Looking…").foregroundStyle(.secondary)
                }
            }
            ForEach(discovery.found) { service in
                Button {
                    choose(service)
                } label: {
                    Label(service.name, systemImage: "desktopcomputer")
                }
                .disabled(pairing || resolving != nil)
            }
            if resolving != nil {
                ProgressView("Checking the selected computer…")
            }
            DisclosureGroup {
                Text("Check that this phone and your computer can reach each other. Guest Wi-Fi may block discovery or connections between devices.")
                    .font(.footnote)
                Text("You can enter the exact address from the Companion panel above, including a Tailscale name when shown. Discovery does not need to finish first.")
                    .font(.footnote)
            } label: {
                Text("Troubleshooting")
            }
            .accessibilityIdentifier("pairing-troubleshooting")
        }
    }

    private var manualSection: some View {
        Section {
            TextField("https://computer.example", text: Binding(
                get: { manualAddress },
                set: { value in
                    guard !pairing, chosen == nil, scannerOpening == nil else { return }
                    invalidateResolution()
                    manualAddress = value
                }
            ))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .focused($focusedField, equals: .address)
                .submitLabel(.continue)
                .onSubmit { chooseManualAddress() }
                .disabled(pairing)
                .accessibilityLabel("Computer address")
                .accessibilityIdentifier("pairing-address-input")
            Button("Continue") { chooseManualAddress() }
                .disabled(pairing || manualAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("pairing-continue")
        } header: {
            Text("Or enter the address")
        } footer: {
            Text("Enter the address from the Companion panel, including https:// when shown. A local address such as 192.168.1.42:8810 also works when reachable from this phone.")
        }
    }

    private func invalidateResolution() {
        selectionGeneration = UUID()
        resolving = nil
    }

    private func chooseManualAddress() {
        guard !pairing, chosen == nil, scannerOpening == nil else { return }
        invalidateResolution()
        focusedField = nil
        failure = nil
        guard let connection = Self.parse(manualAddress) else {
            showFailure("Enter an address such as https://computer.example or 192.168.1.42:8810.")
            return
        }
        scannedCredential = nil
        chosen = connection
        code = ""
        ignoredInvitation = false
    }

    private func choose(_ service: Discovery.Found) {
        guard !pairing, chosen == nil, scannerOpening == nil, resolving == nil else { return }
        let generation = UUID()
        selectionGeneration = generation
        resolving = generation
        focusedField = nil
        failure = nil
        Task {
            do {
                let connection = try await discovery.resolve(service)
                guard selectionGeneration == generation, !pairing else { return }
                resolving = nil
                chosen = connection
                scannedCredential = nil
                code = ""
                ignoredInvitation = false
            } catch {
                guard selectionGeneration == generation, !pairing else { return }
                resolving = nil
                showFailure(error.localizedDescription)
            }
        }
    }

    // MARK: - The code

    private func codeSection(for connection: Connection) -> some View {
        Section(scannedCredential == nil ? connection.name : "Confirm computer") {
            if scannedCredential != nil {
                Label(connection.name, systemImage: "desktopcomputer")
                    .font(.headline)
            }
            LabeledContent("Address") {
                Text(connection.displayAddress)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let credential = scannedCredential {
                Text("Only continue if this is the computer whose QR code you just scanned. This phone will be able to open chats, send work, and answer approvals on it.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                Button {
                    submit(connection, credential: credential)
                } label: {
                    if pairing {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Pair with this computer")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(pairing)
                .accessibilityIdentifier("pairing-confirm")
            } else {
                TextField("000000", text: Binding(
                    get: { code },
                    set: { value in
                        guard !pairing, chosen?.id == connection.id, scannedCredential == nil else { return }
                        code = String(value.filter { $0.isASCII && $0.isNumber }.prefix(6))
                    }
                ))
                    .keyboardType(.numberPad)
                    .focused($focusedField, equals: .code)
                    .submitLabel(.go)
                    .onSubmit { submit(connection, credential: code) }
                    .font(.system(.title, design: .monospaced))
                    .multilineTextAlignment(.center)
                    .disabled(pairing)
                    .accessibilityLabel("Pairing code")
                    .accessibilityIdentifier("pairing-code-input")

                Button {
                    submit(connection, credential: code)
                } label: {
                    if pairing {
                        ProgressView()
                    } else {
                        Text("Connect")
                    }
                }
                .disabled(code.count != 6 || pairing)
                .accessibilityIdentifier("pairing-connect")
            }

            Button("Choose a different computer", role: .cancel) {
                guard !pairing, chosen?.id == connection.id else { return }
                invalidateResolution()
                focusedField = nil
                chosen = nil
                code = ""
                scannedCredential = nil
                failure = nil
                ignoredInvitation = false
            }
            .disabled(pairing)
            .accessibilityIdentifier("pairing-change-computer")
        }
    }

    private func submit(_ connection: Connection, credential: String) {
        guard !pairing, chosen?.id == connection.id else { return }
        let cameFromScanner = scannedCredential != nil
        if cameFromScanner {
            guard scannedCredential == credential else { return }
        } else {
            guard code == credential, credential.count == 6,
                  credential.allSatisfy({ $0.isASCII && $0.isNumber }) else { return }
        }
        // Lock synchronously before creating the Task: a second queued tap
        // cannot start another credential redemption before SwiftUI redraws.
        let operation = UUID()
        pairingOperation = operation
        invalidateResolution()
        focusedField = nil
        failure = nil
        ignoredInvitation = false
        Task {
            do {
                try await session.pair(
                    with: connection,
                    credential: credential,
                    deviceName: Self.deviceName()
                )
                guard pairingOperation == operation else { return }
                // Session transitions to the roster asynchronously. Keep the
                // completed operation latched until this view is removed so
                // a queued tap cannot redeem the successful credential again.
                scannedCredential = nil
                code = ""
            } catch {
                guard pairingOperation == operation else { return }
                if cameFromScanner {
                    // The credential may have been accepted despite a lost
                    // response. Clear it; only a fresh invitation can retry.
                    chosen = nil
                    scannedCredential = nil
                    showFailure("\(error.localizedDescription) Start pairing again on your computer and open or scan the new invitation.")
                } else {
                    code = ""
                    showFailure(error.localizedDescription)
                }
                pairingOperation = nil
            }
        }
    }

    private func showFailure(_ message: String) {
        focusedField = nil
        failure = message
    }

    private func accept(_ invite: PairingInvite?, fromSession: Bool = true) {
        guard let invite else { return }
        if fromSession { session.consumePairingInvite() }
        guard !pairing else {
            // Do not queue a short-lived credential behind another attempt.
            // Keep this notice separate from that attempt's eventual error.
            ignoredInvitation = true
            return
        }
        invalidateResolution()
        focusedField = nil
        scannerOpening = nil
        chosen = invite.connection
        scannedCredential = invite.credential
        code = ""
        failure = nil
        ignoredInvitation = false
    }

    // MARK: - Helpers

    static func deviceName() -> String {
        #if canImport(UIKit)
        return UIDevice.current.name
        #else
        return "Companion"
        #endif
    }

    /// An explicit HTTP/HTTPS address, or a bare host on companion port 8810.
    static func parse(_ text: String) -> Connection? {
        // The shared parser preserves explicit schemes and their default
        // ports; an address without a scheme keeps companion port 8810.
        Connection.parse(text)
    }
}
