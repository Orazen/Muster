// The live app shell: sign-in gate, fleet sidebar, live conversation,
// approvals, composer — a real Mac client over the real wire contract.
//
// The M0 prototype surfaces (Today, Browser, Memory, demo banner) remain
// available through "Demo mode" so the fixture-driven states stay
// demonstrable; live mode is the default once a session exists.

import CompanionCore
import MusterMacCore
import SwiftUI

@main
struct MusterMacApp: App {
    @StateObject private var live: LiveSessionModel
    @StateObject private var signIn: NativeSignInCoordinator
    @StateObject private var demo: PrototypeModel
    @State private var sessionRestoreError: String?

    init() {
        let session = LiveSessionModel()
        // One coordinator for the whole app, shared by every window: it is the
        // only authority for which sign-in attempt may still be adopted.
        let coordinator = NativeSignInCoordinator(live: session)
        _live = StateObject(wrappedValue: session)
        _signIn = StateObject(wrappedValue: coordinator)
        _demo = StateObject(wrappedValue: PrototypeModel.fixture())
        // Startup restore, sign-out and any external account change invalidate
        // pending sign-in work before it can save or connect.
        session.onSessionWillChangeExternally = { [weak coordinator] in
            coordinator?.invalidateForExternalSessionChange()
        }
    }

    var body: some Scene {
        WindowGroup("Muster") {
            GateView()
                .environmentObject(live)
                .environmentObject(signIn)
                .environmentObject(demo)
                .frame(minWidth: 1040, minHeight: 640)
                .preferredColorScheme(live.appearance.colorScheme)
                .tint(MusterAppearance.accent)
                .background(MusterAppearance.canvas)
                .task {
                    guard live.state == .signedOut else { return }
                    do {
                        if let saved = try SessionKeychain.load() {
                            live.connect(account: saved)
                        }
                    } catch {
                        sessionRestoreError = error.localizedDescription
                    }
                }
                .alert("Could not restore sign-in", isPresented: Binding(
                    get: { sessionRestoreError != nil },
                    set: { if !$0 { sessionRestoreError = nil } }
                )) {
                    Button("OK", role: .cancel) { sessionRestoreError = nil }
                } message: {
                    Text(sessionRestoreError ?? "")
                }
        }
        .windowToolbarStyle(.unified)
    }
}

/// Signs out when signed-in mode is asked to forget; routes by state.
struct GateView: View {
    @EnvironmentObject private var live: LiveSessionModel

    var body: some View {
        switch live.state {
        case .signedOut:
            SignInView()
        case .connecting:
            ConnectingView()
        case .live, .degraded:
            LiveShellView()
        case let .failed(message):
            SignInView(initialError: message)
        }
    }
}

// MARK: - Sign in

struct SignInView: View {
    @EnvironmentObject private var signIn: NativeSignInCoordinator
    var initialError: String? = nil
    /// Identity of this window, so the app-scoped coordinator can tell a newer
    /// attempt from an older one and refuse duplicate submits from this window.
    ///
    /// This MUST be `@State`, not a plain stored property with a `UUID()`
    /// default: a struct default is re-evaluated on every initialisation, and
    /// `GateView` rebuilds `SignInView()` whenever `live` publishes. That would
    /// hand this window a new identity mid-sign-in, which silently disables the
    /// input lock and lets a duplicate submit start a second request. `@State`
    /// keeps one identity for as long as this view stays on screen.
    @State private var windowID = UUID()
    @State private var origin = "http://127.0.0.1:8799"
    @State private var email = ""
    @State private var password = ""
    @State private var createAccount = false
    @FocusState private var focused: Field?

    enum Field { case origin, email, password }

    /// Busy only while *this* window owns the pending attempt, so a stale
    /// response cannot spin a window that has already moved on.
    private var busy: Bool { signIn.isPending(window: windowID) }
    private var error: String? { signIn.errorMessage }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 10) {
                    FlowerView(colorName: nil, busy: busy)
                        .frame(width: 44, height: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Muster for Mac").font(.system(size: 22, weight: .semibold))
                        Text("Your fleet, on your desktop.").foregroundStyle(.secondary)
                    }
                }
                Form {
                    // Inputs are locked while this window's attempt is in
                    // flight: the coordinator snapshotted them at submit, so
                    // editing them mid-flight could only desynchronise the UI
                    // from the request that is actually running.
                    TextField("Server", text: $origin)
                        .textFieldStyle(.roundedBorder)
                        .focused($focused, equals: .origin)
                        .disabled(busy)
                    TextField("Email", text: $email)
                        .textFieldStyle(.roundedBorder)
                        .textContentType(.emailAddress)
                        .focused($focused, equals: .email)
                        .disabled(busy)
                    SecureField("Password", text: $password)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(submitSignIn)
                        .focused($focused, equals: .password)
                        .disabled(busy)
                    Toggle("Create a new account", isOn: $createAccount)
                        .disabled(busy)
                    if let error {
                        Text(error).font(.callout).foregroundStyle(.red)
                    }
                    Button(busy ? "Connecting…" : (createAccount ? "Create & connect" : "Connect")) {
                        submitSignIn()
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || email.isEmpty || password.isEmpty || origin.isEmpty)
                }
                .formStyle(.grouped)
            }
            .frame(width: 420)
            Spacer()
        }
        .padding(28)
        .onAppear {
            signIn.presentInitialError(initialError)
            focused = email.isEmpty ? .email : .password
        }
        .onChange(of: origin) { _, _ in reportInputEdits() }
        .onChange(of: email) { _, _ in reportInputEdits() }
        .onChange(of: password) { _, _ in reportInputEdits() }
        .onChange(of: createAccount) { _, _ in reportInputEdits() }
        .onDisappear {
            // Closing the window that owns the attempt cancels it. Safe after a
            // successful sign-in: adoption consumes the attempt first, so the
            // navigation that replaces this view finds nothing to cancel and the
            // user stays signed in. Closing a stale window is likewise a no-op,
            // which is what keeps a newer window's attempt alive.
            signIn.cancelAttempt(window: windowID)
        }
    }

    /// Backstop for the locked-inputs policy. The fields above are disabled while
    /// this window owns an attempt, so this only fires if something changes them
    /// anyway — in which case this window's own pending attempt is cancelled
    /// rather than allowed to activate a superseded identity.
    private func reportInputEdits() {
        signIn.inputsEdited(in: windowID, to: currentInputs())
    }

    private func currentInputs() -> NativeSignInCoordinator.SignInInputs {
        NativeSignInCoordinator.SignInInputs(
            origin: origin,
            email: email,
            password: password,
            mode: createAccount ? .signUp : .signIn
        )
    }

    private func submitSignIn() {
        // The coordinator refuses a duplicate submit from this window and
        // supersedes any attempt from another window. Inputs are snapshotted
        // here and locked until the attempt settles, so a response can never
        // activate a superseded account, origin or mode.
        let inputs = currentInputs()
        signIn.beginAttempt(window: windowID, inputs: inputs)
    }
}

struct ConnectingView: View {
    var body: some View {
        VStack(spacing: 12) {
            FlowerView(colorName: nil, busy: true)
                .frame(width: 56, height: 56)
            Text("Connecting…").font(.headline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Live shell

struct LiveShellView: View {
    @EnvironmentObject private var live: LiveSessionModel

    var body: some View {
        NavigationSplitView {
            FleetSidebar()
                .navigationSplitViewColumnWidth(min: 220, ideal: 250, max: 320)
        } detail: {
            LiveConversationView()
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if case let .degraded(detail) = live.state {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reconnecting — \(detail)").font(.caption)
                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 5)
                .background(.yellow.opacity(0.16))
            }
        }
    }
}

// MARK: - Sidebar

struct FleetSidebar: View {
    @EnvironmentObject private var live: LiveSessionModel
    @EnvironmentObject private var signIn: NativeSignInCoordinator
    @State private var query = ""
    @State private var signOutError: String?

    private var bots: [Bot] {
        let filtered = query.isEmpty ? live.fleet.bots : live.fleet.bots.filter {
            $0.name.localizedCaseInsensitiveContains(query) || $0.title.localizedCaseInsensitiveContains(query)
        }
        return filtered.sorted { lhs, rhs in
            let lh = live.pendingCards.contains { $0.bot.id == lhs.id }
            let rh = live.pendingCards.contains { $0.bot.id == rhs.id }
            if lh != rh { return lh }
            return lhs.name < rhs.name
        }
    }

    var body: some View {
        List(selection: Binding(
            get: { live.selectedThreadId },
            set: { live.selectedThreadId = $0 })) {
            Section("Fleet") {
                ForEach(bots) { bot in
                    let pending = live.pendingCards.contains { $0.bot.id == bot.id }
                    HStack(spacing: 9) {
                        FlowerView(colorName: bot.color, busy: bot.busy ?? false)
                            .frame(width: 26, height: 26)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(bot.name).font(.system(size: 13, weight: pending ? .semibold : .regular)).lineLimit(1)
                            Text(bot.busy == true ? "Working…" : (bot.title.isEmpty ? bot.modelSelection.model : bot.title))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        if pending {
                            Image(systemName: "checkmark.seal.fill")
                                .foregroundStyle(.orange)
                                .help("Waiting for your approval")
                        }
                        if bot.unread {
                            Circle().fill(Color.accentColor).frame(width: 8, height: 8)
                        }
                    }
                    .tag(bot.threadId)
                }
            }
            if !live.fleet.groups.isEmpty {
                Section("Rooms") {
                    ForEach(live.fleet.groups) { room in
                        HStack(spacing: 9) {
                            Image(systemName: "person.3")
                                .foregroundStyle(.secondary)
                            Text(room.name).font(.system(size: 13)).lineLimit(1)
                        }
                        .tag(room.threadId)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(MusterAppearance.sidebar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(connectionColor).frame(width: 7, height: 7)
                Text(connectionLabel).font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Menu {
                    Button("Sign out") {
                        signOut()
                    }
                } label: {
                    Image(systemName: "person.crop.circle")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(MusterAppearance.sidebar)
        }
        .searchable(text: $query, placement: .sidebar, prompt: "Search fleet")
        .alert("Could not sign out", isPresented: Binding(
            get: { signOutError != nil },
            set: { if !$0 { signOutError = nil } }
        )) {
            Button("OK", role: .cancel) { signOutError = nil }
        } message: {
            Text("\(signOutError ?? "") You are still signed in, and this Mac can reconnect when you reopen Muster. Check Keychain access, then choose Sign out again from the account menu.")
        }
    }

    private func signOut() {
        // Fence any sign-in still in flight FIRST, unconditionally.
        //
        // `live.disconnect()` below also fences it, via
        // `onSessionWillChangeExternally` — but only on the success path. If the
        // Keychain clear is rejected we deliberately stay connected and report
        // the failure, so the hook never fires and a pending attempt would
        // survive to re-save and re-connect moments after the user asked to sign
        // out. Invalidate before touching storage so both paths are covered.
        signIn.invalidateForSignOut()
        do {
            try SessionKeychain.clear()
            signOutError = nil
            live.disconnect()
        } catch {
            signOutError = error.localizedDescription
        }
    }

    private var connectionColor: Color {
        if case .degraded = live.state { return .orange }
        return .green
    }

    private var connectionLabel: String {
        if case let .degraded(detail) = live.state { return "Degraded — \(detail)" }
        return "Live — \(live.fleet.bots.count) teammates"
    }
}

// MARK: - Conversation

struct LiveConversationView: View {
    @EnvironmentObject private var live: LiveSessionModel

    private var selectedBot: Bot? {
        live.fleet.bots.first { $0.threadId == live.selectedThreadId }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let bot = selectedBot {
                LiveTranscriptView(threadId: bot.threadId)
                ForEach(live.pendingSends.filter { $0.threadId == bot.threadId }) { pending in
                    PendingSendRow(pending: pending)
                }
                if let card = live.pendingCards.first(where: { $0.bot.id == bot.id }) {
                    LiveApprovalCard(bot: card.bot, message: card.message)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }
                LiveComposer(bot: bot)
            } else {
                ContentUnavailableView("No conversation selected", systemImage: "bubble.left.and.text.bubble.right")
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            if let bot = selectedBot {
                FlowerView(colorName: bot.color, busy: bot.busy ?? false)
                    .frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text(bot.name).font(.headline)
                    Text(bot.busy == true ? "Working…" : bot.title.isEmpty ? bot.modelSelection.model : bot.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text("Muster")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 56)
        .background(MusterAppearance.canvas)
    }
}

struct LiveTranscriptView: View {
    @EnvironmentObject private var live: LiveSessionModel
    let threadId: String

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    let messages = live.transcripts[threadId] ?? []
                    if messages.isEmpty {
                        VStack(spacing: 8) {
                            FlowerView(colorName: nil, busy: false)
                                .frame(width: 56, height: 56)
                            Text("Say hello").font(.headline)
                            Text("This teammate has no conversation yet.").foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 60)
                    }
                    ForEach(messages) { message in
                        MessageRow(message: message)
                            .id(message.id)
                    }
                }
                .padding(16)
            }
            .onChange(of: live.transcripts[threadId]?.count) { _, _ in
                if let last = live.transcripts[threadId]?.last {
                    withAnimation(.snappy) { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
        .textSelection(.enabled)
    }
}

struct PendingSendRow: View {
    let pending: PendingSend

    var body: some View {
        HStack(spacing: 6) {
            switch pending.state {
            case "pending":
                ProgressView().controlSize(.mini)
                Text("Sending…").font(.caption).foregroundStyle(.secondary)
            case "accepted":
                Image(systemName: "checkmark.circle").font(.caption).foregroundStyle(.green)
                Text("Accepted").font(.caption).foregroundStyle(.secondary)
            default:
                Image(systemName: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                Text(pending.state).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }
}

struct LiveApprovalCard: View {
    @EnvironmentObject private var live: LiveSessionModel
    let bot: Bot
    let message: Message

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "hand.raised.fill")
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 1) {
                    Text(message.card?.title ?? "Approval needed").font(.headline)
                    if let subtitle = message.card?.subtitle, !subtitle.isEmpty {
                        Text(subtitle).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if let tool = message.card?.tool {
                Text(tool)
                    .font(.system(.caption, design: .monospaced))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.quinary, in: RoundedRectangle(cornerRadius: 4))
            }
            HStack(spacing: 8) {
                ForEach(message.card?.options ?? [], id: \.self) { option in
                    Button(option) {
                        Task { await live.respond(botId: bot.id, card: message, option: option) }
                    }
                    .buttonStyle(.borderedProminent)
                }
                Spacer()
            }
        }
        .padding(16)
        .background(MusterAppearance.panel, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(MusterAppearance.accent.opacity(0.65)))
    }
}

struct LiveComposer: View {
    @EnvironmentObject private var live: LiveSessionModel
    let bot: Bot
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Message \(bot.name)…", text: $live.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .focused($focused)
                .onSubmit { Task { await live.sendDraft() } }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            Button {
                Task { await live.sendDraft() }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(MusterAppearance.accent, in: RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Send message")
            .disabled(live.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(6)
        .background(MusterAppearance.panel, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(MusterAppearance.border))
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(MusterAppearance.canvas)
        .onAppear { focused = true }
    }
}
