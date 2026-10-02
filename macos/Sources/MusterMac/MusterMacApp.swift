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
    @StateObject private var demo: PrototypeModel

    init() {
        _live = StateObject(wrappedValue: LiveSessionModel())
        _demo = StateObject(wrappedValue: PrototypeModel.fixture())
    }

    var body: some Scene {
        WindowGroup("Muster") {
            GateView()
                .environmentObject(live)
                .environmentObject(demo)
                .frame(minWidth: 1040, minHeight: 640)
                .preferredColorScheme(live.appearance.colorScheme)
                .tint(MusterAppearance.accent)
                .background(MusterAppearance.canvas)
                .task {
                    guard live.state == .signedOut else { return }
                    if let saved = SessionKeychain.load() {
                        live.connect(account: saved)
                    }
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
    @EnvironmentObject private var live: LiveSessionModel
    var initialError: String? = nil
    @State private var origin = "http://127.0.0.1:8799"
    @State private var email = ""
    @State private var password = ""
    @State private var createAccount = false
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Field?

    enum Field { case origin, email, password }

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
                    TextField("Server", text: $origin)
                        .textFieldStyle(.roundedBorder)
                        .focused($focused, equals: .origin)
                    TextField("Email", text: $email)
                        .textFieldStyle(.roundedBorder)
                        .textContentType(.emailAddress)
                        .focused($focused, equals: .email)
                    SecureField("Password", text: $password)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(signIn)
                        .focused($focused, equals: .password)
                    Toggle("Create a new account", isOn: $createAccount)
                    if let error {
                        Text(error).font(.callout).foregroundStyle(.red)
                    }
                    Button(busy ? "Connecting…" : (createAccount ? "Create & connect" : "Connect")) {
                        signIn()
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
            error = initialError
            focused = email.isEmpty ? .email : .password
        }
    }

    private func signIn() {
        guard !busy else { return }
        busy = true
        error = nil
        let originText = origin.trimmingCharacters(in: .whitespaces)
        let mode: MusterTransport.SignInMode = createAccount ? .signUp : .signIn
        Task {
            do {
                let account = try await MusterTransport.signIn(originText: originText, email: email, password: password, mode: mode)
                SessionKeychain.save(account)
                live.connect(account: account)
            } catch let transportError as MusterTransportError {
                error = describe(transportError)
            } catch {
                self.error = "Could not reach the server."
            }
            busy = false
        }
    }

    private func describe(_ transportError: MusterTransportError) -> String {
        switch transportError {
        case .badOrigin: return "That server address doesn't look right."
        case .noSession: return "Sign-in returned no session — check the password and try again."
        case .signInFailed: return "Sign-in failed."
        case .server(401, _): return "Email or password is incorrect."
        case let .server(code, message): return message ?? "The server answered with an error (\(code))."
        case .redirectRefused: return "The server redirected sign-in — refusing for safety."
        case .unreadable: return "The server sent something this app couldn't read."
        }
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
    @State private var query = ""

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
                        SessionKeychain.clear()
                        live.disconnect()
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
