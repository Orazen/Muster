// Every view the watch shows. Deliberately fewer than the phone's: the
// wrist is for glancing and settling — what needs you, what just happened,
// and a short reply — not for browsing transcripts, managing tasks or
// watching a desktop. Those stay on the phone and the computer, and the
// watch says so with what it leaves out.
import SwiftUI
import CompanionCore
import WatchKit

// MARK: - Palette

/// src/lib/mascot.ts — AGENT_COLORS, the same map AgentPalette carries on
/// the phone. A bot you know by its colour should be that colour here too.
enum WatchPalette {
    private static let hex: [String: String] = [
        "green": "#009957",
        "blue": "#377FE6",
        "red": "#D94B52",
        "orange": "#E78531",
        "purple": "#8057C8",
        "cyan": "#0EA5C6",
        "pink": "#D84F8B",
        "yellow": "#D8A729",
        "teal": "#01A492",
        "coral": "#E5634E",
    ]

    static func color(_ name: String) -> Color {
        Color(hex: hex[name] ?? "#8E8E93")
    }
}

extension Color {
    init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&value)
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1
        )
    }
}

// MARK: - Routes

/// Key paths cannot address tuple members, and `pendingApprovals` hands back
/// tuples — so the roster maps them into this on the way to the screen.
struct PendingApproval: Identifiable {
    let threadId: String
    let message: Message

    var id: String { message.id }
}

enum WatchRoute: Hashable {
    case approval(threadId: String, messageId: String)
    case bot(id: String)
    case room(id: String)
}

// MARK: - Root

/// Status routing. `.unpaired` pairs; `.unauthorized` explains and unpairs;
/// everything else is the fleet, with whatever went wrong as a banner.
struct RootView: View {
    @EnvironmentObject private var session: WatchSession

    var body: some View {
        switch session.status {
        case .unpaired:
            PairingView()
        case .unauthorized:
            UnauthorizedView()
        case .connecting, .live, .offline:
            FleetView()
        }
    }
}

private struct UnauthorizedView: View {
    @EnvironmentObject private var session: WatchSession

    var body: some View {
        VStack(spacing: 8) {
            Text("This watch is no longer paired with your computer.")
            Button("Unpair") { session.signOut() }
                .foregroundStyle(.red)
        }
        .padding(.horizontal)
    }
}

// MARK: - Pairing

/// Find the computer over Bonjour — or type its address, for the tailnet
/// case Bonjour cannot see — then redeem the six-digit code shown under
/// Companion on the desktop. The QR path the phone uses needs a camera; the
/// manual code is the flow that fits a wrist, and the sidecar keeps
/// accepting it for exactly this reason.
struct PairingView: View {
    @EnvironmentObject private var session: WatchSession
    @StateObject private var discovery = Discovery()

    @State private var chosen: Connection?
    @State private var code = ""
    @State private var manualAddress = ""
    @State private var resolving = false
    @State private var pairing = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section("Your computer") {
                    if let chosen {
                        Label(chosen.name, systemImage: "laptopcomputer")
                    } else if discovery.found.isEmpty {
                        Text(discovery.failure ?? "Looking for computers on this network…")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(discovery.found) { found in
                            Button {
                                choose(found)
                            } label: {
                                HStack {
                                    Text(found.name)
                                    Spacer()
                                    if resolving { ProgressView() }
                                }
                            }
                        }
                    }
                }

                Section("Pairing code") {
                    TextField("6-digit code", text: $code)
                    Button("Pair") { pair() }
                        .disabled(pairing || chosen == nil || code.count < 6)
                }

                Section("Or enter an address") {
                    TextField("host:port", text: $manualAddress)
                    Button("Use address") {
                        if let parsed = Connection.parse(manualAddress) {
                            chosen = parsed
                            error = nil
                        } else {
                            error = "That address doesn't look right."
                        }
                    }
                    .disabled(manualAddress.isEmpty)
                }

                if let error {
                    Text(error).foregroundStyle(.red)
                }
            }
            .navigationTitle("Pair")
            .onAppear { discovery.start() }
            .onDisappear { discovery.stop() }
        }
    }

    /// Bonjour hands back a service, not an address; resolving is a real
    /// network round-trip that can fail. It happens on selection, so the
    /// failure is about the computer they tapped — before any code is typed.
    private func choose(_ found: Discovery.Found) {
        guard !resolving else { return }
        resolving = true
        error = nil
        Task {
            do {
                chosen = try await discovery.resolve(found)
            } catch {
                self.error = error.localizedDescription
            }
            resolving = false
        }
    }

    private func pair() {
        guard let chosen, !pairing else { return }
        pairing = true
        error = nil
        Task {
            do {
                try await session.pair(with: chosen, credential: code.trimmingCharacters(in: .whitespaces))
            } catch {
                self.error = error.localizedDescription
            }
            pairing = false
        }
    }
}

// MARK: - Fleet

/// Approvals first — the screen the companion exists for — then the fleet.
struct FleetView: View {
    @EnvironmentObject private var session: WatchSession
    @State private var buzzedForCount = 0

    private var approvals: [PendingApproval] {
        session.state.pendingApprovals.map {
            PendingApproval(threadId: $0.threadId, message: $0.message)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if case let .offline(reason) = session.status {
                    Section { Text(reason).foregroundStyle(.secondary) }
                }

                if !approvals.isEmpty {
                    Section("Needs you") {
                        ForEach(approvals) { approval in
                            NavigationLink(value: WatchRoute.approval(
                                threadId: approval.threadId,
                                messageId: approval.message.id
                            )) {
                                ApprovalRow(approval: approval)
                            }
                        }
                    }
                }

                Section("Bots") {
                    ForEach(session.state.bots.filter { $0.hidden != true }) { bot in
                        NavigationLink(value: WatchRoute.bot(id: bot.id)) {
                            BotRow(bot: bot)
                        }
                    }
                }

                if !session.state.rooms.isEmpty {
                    Section("Rooms") {
                        ForEach(session.state.rooms) { room in
                            NavigationLink(value: WatchRoute.room(id: room.id)) {
                                RoomRow(room: room)
                            }
                        }
                    }
                }

                Section {
                    NavigationLink {
                        WatchSettingsView()
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                }
            }
            .navigationTitle("Muster")
            .navigationDestination(for: WatchRoute.self) { route in
                switch route {
                case let .approval(threadId, messageId):
                    ApprovalView(threadId: threadId, messageId: messageId)
                case let .bot(id):
                    BotChatView(botId: id)
                case let .room(id):
                    RoomChatView(roomId: id)
                }
            }
            .onChange(of: approvals.count) { _, count in
                // One buzz when work arrives that only the wrist can settle.
                // Counting rather than comparing contents: approvals resolve
                // by dropping below the previous count, and a second request
                // arriving while one is open deserves its own tap.
                guard session.status == .live, count > buzzedForCount else { return }
                WKInterfaceDevice.current().play(.notification)
                buzzedForCount = count
            }
        }
    }
}

private struct BotRow: View {
    let bot: Bot

    var body: some View {
        HStack {
            Circle()
                .fill(WatchPalette.color(bot.color))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading) {
                Text(bot.name).lineLimit(1)
                if bot.busy == true {
                    Text("working…").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if bot.unread {
                Circle().fill(.blue).frame(width: 7, height: 7)
            }
        }
    }
}

private struct RoomRow: View {
    let room: Room

    var body: some View {
        HStack {
            Image(systemName: "bubble.left.and.bubble.right")
                .foregroundStyle(.blue)
            Text(room.name).lineLimit(1)
            Spacer()
            if room.unread {
                Circle().fill(.blue).frame(width: 7, height: 7)
            }
        }
    }
}

/// One line under the thread name: what the card asks, and who asked.
private struct ApprovalRow: View {
    let approval: PendingApproval

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(approval.message.card?.title ?? "Waiting on you")
                .font(.headline)
                .lineLimit(2)
            if let tool = approval.message.card?.tool {
                Text(tool).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Approval

/// The decision screen. Buttons in deny-first order — the accidental tap on
/// a wrist should cost the bot a retry, not run a command.
struct ApprovalView: View {
    @EnvironmentObject private var session: WatchSession
    let threadId: String
    let messageId: String

    @State private var busy = false

    /// Resolved live from state, not held by value: the answer arrives as a
    /// stream patch, and the screen should reflect the harness's record of
    /// it the moment that lands.
    private var message: Message? {
        session.state.transcript(forThread: threadId).first { $0.id == messageId }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let message, let card = message.card {
                    if let from = message.from {
                        Text(from.name)
                            .font(.caption2)
                            .foregroundStyle(WatchPalette.color(from.color))
                    }
                    Text(card.title).font(.headline)
                    if !card.subtitle.isEmpty {
                        Text(card.subtitle).font(.caption).foregroundStyle(.secondary)
                    }

                    if busy {
                        ProgressView()
                    } else if card.answered != nil || card.dismissed == true {
                        Text("Answered — the bot carries on.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if card.isPermission {
                        Button {
                            decide(choice: "deny")
                        } label: {
                            Label("Deny", systemImage: "xmark")
                        }
                        .tint(.red)
                        Button {
                            decide(choice: "allow")
                        } label: {
                            Label("Allow", systemImage: "checkmark")
                        }
                        .tint(.green)
                        if let bot = session.state.bot(forThread: threadId), card.allowKey != nil {
                            Button {
                                decideAlways(bot: bot, card: card)
                            } label: {
                                Label("Always allow", systemImage: "checkmark.seal")
                            }
                        }
                    } else {
                        ForEach(card.options, id: \.self) { option in
                            Button(option) { decide(choice: option) }
                        }
                    }
                } else {
                    Text("That approval is no longer here.")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal)
        }
        .navigationTitle("Approve")
    }

    /// Settle the card with an allow/deny or a chosen option. Always-allow
    /// goes through `decideAlways` because the harness expects two calls:
    /// the answer settles this card, the grant key stops the next one.
    private func decide(choice: String) {
        guard let card = message?.card, !busy else { return }
        busy = true
        Task {
            await session.answer(threadId: threadId, card: card, choice: choice)
            WKInterfaceDevice.current().play(.success)
            busy = false
        }
    }

    private func decideAlways(bot: Bot, card: OptionCard) {
        guard !busy else { return }
        busy = true
        Task {
            await session.answer(threadId: threadId, card: card, choice: "allow")
            await session.alwaysAllow(bot: bot, card: card)
            WKInterfaceDevice.current().play(.success)
            busy = false
        }
    }
}

// MARK: - Chat

/// A bot or a room. They share a thread, which is what every message and
/// approval is keyed by — the views below differ only in how they send.
enum WatchChat: Identifiable, Hashable {
    case bot(Bot)
    case room(Room)

    var id: String {
        switch self {
        case let .bot(bot): return bot.id
        case let .room(room): return room.id
        }
    }

    var threadId: String {
        switch self {
        case let .bot(bot): return bot.threadId
        case let .room(room): return room.threadId
        }
    }

    var name: String {
        switch self {
        case let .bot(bot): return bot.name
        case let .room(room): return room.name
        }
    }

    var busy: Bool {
        switch self {
        case let .bot(bot): return bot.busy ?? false
        case let .room(room): return room.busyBotId != nil
        }
    }
}

/// The tail of a conversation, the reply being typed, and a way to answer.
/// Scrollback and search stay on the phone on purpose: this is "what did it
/// just say", not "what did it say in March".
struct ChatView: View {
    @EnvironmentObject private var session: WatchSession
    let chat: WatchChat

    @State private var draft = ""

    private var tail: [Message] {
        Array(session.state.visibleTranscript(forThread: chat.threadId).suffix(20))
    }

    private var streaming: String? {
        session.state.streaming[chat.threadId]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if chat.busy {
                    if case let .bot(bot) = chat {
                        Button {
                            Task { await session.interrupt(bot: bot) }
                        } label: {
                            Label("Stop", systemImage: "stop.fill")
                        }
                        .tint(.red)
                    }
                }

                if let streaming, !streaming.isEmpty {
                    Text(streaming)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .italic()
                }

                ForEach(tail) { message in
                    Bubble(message: message)
                }

                if tail.isEmpty, streaming == nil {
                    Text("No messages yet.")
                        .foregroundStyle(.secondary)
                }

                // The watch keyboard's first-class affordance is dictation;
                // typing is the fallback, and both arrive here as text.
                TextField("Reply", text: $draft)
                    .onSubmit { send() }
                Button("Send") { send() }
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.horizontal)
        }
        .navigationTitle(chat.name)
        .onAppear {
            Task {
                switch chat {
                case let .bot(bot): await session.markRead(bot)
                case let .room(room): await session.markRead(room)
                }
            }
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        draft = ""
        Task {
            switch chat {
            case let .bot(bot): await session.send(text, to: bot)
            case let .room(room): await session.send(text, to: room)
            }
        }
    }
}

private struct Bubble: View {
    let message: Message

    var body: some View {
        switch message.kind {
        case .options:
            if let card = message.card {
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.title).font(.caption).bold()
                    if card.isPending {
                        Text("Waiting on you").font(.caption2).foregroundStyle(.orange)
                    } else if let answered = card.answered {
                        Text("Answered: \(answered)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .padding(6)
                .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
            }
        case .activity:
            if let tool = message.tool {
                Text(tool.spoken ?? tool.name)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        case .screen:
            Text("Screenshot — see your phone or computer")
                .font(.caption2)
                .foregroundStyle(.secondary)
        case .text, .unknown:
            if let text = message.text, !text.isEmpty {
                Text(text)
                    .font(.footnote)
                    .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
                    .padding(8)
                    .background(
                        message.role == .user ? Color.accentColor.opacity(0.35) : Color.gray.opacity(0.2),
                        in: RoundedRectangle(cornerRadius: 10)
                    )
            }
        }
    }
}

struct BotChatView: View {
    @EnvironmentObject private var session: WatchSession
    let botId: String

    var body: some View {
        if let bot = session.state.bot(botId) {
            ChatView(chat: .bot(bot))
        } else {
            Text("This bot is gone.").foregroundStyle(.secondary)
        }
    }
}

struct RoomChatView: View {
    @EnvironmentObject private var session: WatchSession
    let roomId: String

    var body: some View {
        if let room = session.state.rooms.first(where: { $0.id == roomId }) {
            ChatView(chat: .room(room))
        } else {
            Text("This room is gone.").foregroundStyle(.secondary)
        }
    }
}

// MARK: - Settings

struct WatchSettingsView: View {
    @EnvironmentObject private var session: WatchSession

    var body: some View {
        List {
            if let connection = session.connection {
                Section("Connected to") {
                    Text(connection.name)
                    Text("\(connection.host):\(connection.port)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            if let error = session.actionError {
                Section { Text(error).foregroundStyle(.red) }
            }
            Section {
                Button("Unpair this watch", role: .destructive) { session.signOut() }
            }
        }
        .navigationTitle("Settings")
    }
}
