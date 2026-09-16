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
                        Text(chosen.displayAddress)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
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
                        .accessibilityIdentifier("watch-pairing-code")
                    Button("Pair") { pair() }
                        .accessibilityIdentifier("watch-pairing-submit")
                        .disabled(pairing || chosen == nil || code.count < 6)
                }

                Section("Or enter an address") {
                    TextField("Computer address", text: $manualAddress)
                        .accessibilityIdentifier("pairing-address-input")
                    Text("For example, https://computer.example or 192.168.1.42:8810. Use the address from the Companion panel.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Button("Use address") {
                        if let parsed = Connection.parse(manualAddress) {
                            chosen = parsed
                            error = nil
                        } else {
                            error = "Enter an HTTPS address or a host and port from the Companion panel."
                        }
                    }
                    .accessibilityIdentifier("watch-use-address")
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
                // The mascot first, the way the watch reads: one face that
                // answers "does anything need me?" before any row is
                // scrolled. Tapping it reads the state aloud.
                Section {
                    FleetHeader()
                        .listRowInsets(EdgeInsets(top: 10, leading: 0, bottom: 6, trailing: 0))
                        .listRowBackground(Color.clear)
                }

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
                            .accessibilityIdentifier("watch-approval-row-\(approval.message.id)")
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

/// The mascot, plus the one line of text that says the same thing in words.
/// Both are always present: the face is never the only carrier of meaning.
private struct FleetHeader: View {
    @EnvironmentObject private var session: WatchSession
    @EnvironmentObject private var voice: WatchVoice

    var body: some View {
        let mood = session.fleetMood
        VStack(spacing: 4) {
            Button {
                voice.toggle(mood.spoken, scope: .fleet)
            } label: {
                WatchFlower(
                    color: "orange",
                    state: mood.state,
                    size: 80,
                    // The pulse rides the fleet utterance specifically: a
                    // reply being read aloud in a chat must not move the
                    // status face, and vice versa.
                    speaking: voice.isSpeakingFleet
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Muster status")
            .accessibilityValue(mood.label)
            .accessibilityHint(voice.speaking ? "Stops reading the status" : "Reads the status aloud")
            .accessibilityIdentifier("watch-fleet-mascot")

            Text(mood.label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct BotRow: View {
    let bot: Bot
    @EnvironmentObject private var voice: WatchVoice

    var body: some View {
        HStack {
            // The bot's own face, at roster size. An 8-point colour dot was
            // the one place the watch refused to show the flower.
            //
            // It pulses while this bot's reply is the one being read, so the
            // roster shows whose voice is in the room.
            WatchFlower(
                color: bot.color,
                state: flowerState(for: bot),
                size: 28,
                speaking: voice.isSpeaking(threadId: bot.threadId)
            )
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

    @Environment(\.scenePhase) private var scenePhase
    @State private var lease: ApprovalViewLease?
    @State private var visible = false
    @State private var showingPreviousRun = false

    /// Resolved live from state, not held by value: the answer arrives as a
    /// stream patch, and the screen should reflect the harness's record of
    /// it the moment that lands.
    private var message: Message? {
        session.state.transcript(forThread: threadId).first { $0.id == messageId }
    }

    private var reference: ApprovalReference? {
        guard let message else { return nil }
        return session.approvalReference(threadId: threadId, message: message)
    }
    private var actionState: ApprovalActionState? {
        guard let message else { return nil }
        return session.approvalState(threadId: threadId, message: message)
    }
    private var canSubmit: Bool {
        guard scenePhase == .active, let reference else { return false }
        return session.canSubmitApproval(reference, lease: lease)
    }
    private var permissionOptions: [(index: Int, label: String, action: ApprovalAction?)] {
        guard let reference else { return [] }
        return reference.options.enumerated().map {
            (index: $0.offset, label: $0.element, action: ApprovalContract.action(for: $0.element, reference: reference))
        }.sorted { lhs, rhs in
            if (lhs.action == .deny) != (rhs.action == .deny) { return lhs.action == .deny }
            return lhs.index < rhs.index
        }
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

                    if let why = card.why, why.source == "previous-run", why.threadId == threadId {
                        Button {
                            showingPreviousRun.toggle()
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Previous run").font(.caption)
                                    Text("\(why.date.formatted(date: .abbreviated, time: .shortened)) · \(why.outcomeLabel)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: showingPreviousRun ? "chevron.up" : "chevron.down")
                                    .font(.caption2)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityValue(showingPreviousRun ? "Expanded" : "Collapsed")

                        if showingPreviousRun {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(why.intent)
                                if let hypothesis = why.hypothesis {
                                    Text("Assumed: \(hypothesis)")
                                }
                                if let findings = why.findings {
                                    Text("Learned: \(findings)")
                                }
                                ForEach(Array(why.decisions.enumerated()), id: \.offset) { _, decision in
                                    Text("• \(decision)")
                                }
                            }
                            .font(.caption2)
                        }
                    }

                    if card.isPending {
                        if let reference {
                            if card.isPermission {
                                ForEach(permissionOptions, id: \.index) { option in
                                    Button(option.label) {
                                        if let action = option.action { submit(action) }
                                    }
                                    .tint(option.action == .deny ? .red : .accentColor)
                                    .disabled(!canSubmit || option.action == nil)
                                    .accessibilityIdentifier("watch-approval-option-\(option.index)")
                                }
                                if ApprovalContract.canAlwaysAllow(reference),
                                   !card.options.contains(where: ApprovalContract.isAlwaysAllowOption) {
                                    Button("Always allow") { submit(.alwaysAllow) }
                                        .disabled(!canSubmit)
                                        .accessibilityIdentifier("watch-approval-always")
                                }
                            } else {
                                ForEach(Array(card.options.enumerated()), id: \.offset) { index, option in
                                    Button(option) { submit(.answer(option)) }
                                        .disabled(!canSubmit)
                                        .accessibilityIdentifier("watch-approval-option-\(index)")
                                }
                            }
                        }
                        if reference == nil || permissionOptions.contains(where: { $0.action == nil }) {
                            Text("Review this request on your computer. This watch cannot confirm these choices.")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    } else if actionState?.message == nil {
                        Text("This request is no longer pending.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if actionState?.inFlight == true {
                        ProgressView("Confirming your choice…")
                            .font(.caption2)
                            .accessibilityIdentifier("watch-approval-progress")
                    }
                    if let feedback = actionState?.message {
                        Text(feedback).font(.caption2)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("watch-approval-recovery")
                    }
                } else {
                    Text("That approval is no longer here.")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal)
        }
        .navigationTitle("Approve")
        .onAppear { visible = true; enter() }
        .onChange(of: session.approvalSessionId) { _, _ in if visible { enter() } }
        .onChange(of: threadId) { _, _ in if visible { enter() } }
        .onChange(of: messageId) { _, _ in if visible { enter() } }
        .onDisappear {
            visible = false
            if let lease { session.leaveApproval(lease) }
            lease = nil
        }
    }

    private func enter() {
        if let lease { session.leaveApproval(lease) }
        lease = session.approvalContext(threadId: threadId).map { session.viewApproval($0) }
    }

    private func submit(_ action: ApprovalAction) {
        guard canSubmit, let reference else { return }
        session.submitApproval(reference, action: action, lease: lease)
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
    @EnvironmentObject private var voice: WatchVoice
    let chat: WatchChat

    @State private var draft = ""

    private var tail: [Message] {
        Array(session.state.visibleTranscript(forThread: chat.threadId).suffix(20))
    }

    private var streaming: String? {
        session.state.streaming[chat.threadId]
    }

    /// The most recent bot message that says something, ready to be read
    /// aloud. `SpeechText` drops code fences and bounds the length, so a
    /// button that appears here always has something worth hearing.
    private var latestBotSpeech: VoiceActivity? {
        let text = session.state.visibleTranscript(forThread: chat.threadId)
            .last { $0.role == .bot && !($0.text ?? "").isEmpty }?
            .text
        guard let text else { return nil }
        // Scoped to the thread, not the fleet: the roster row for this bot is
        // what should pulse while its answer is read.
        return VoiceActivity(scope: .thread(chat.threadId), source: text)
    }

    /// True while this conversation's own reply is the utterance in flight.
    private var isReadingThisChat: Bool {
        voice.isSpeaking(threadId: chat.threadId)
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

                // Never automatic, always cancellable: the same control
                // starts and stops the reading, so a reply is never spoken
                // at someone who did not ask for it.
                if let speech = latestBotSpeech {
                    Button {
                        voice.toggle(speech)
                    } label: {
                        Label(
                            isReadingThisChat ? "Stop" : "Read aloud",
                            systemImage: isReadingThisChat ? "stop.fill" : "speaker.wave.2.fill"
                        )
                    }
                    .tint(isReadingThisChat ? .red : .accentColor)
                    .accessibilityIdentifier("watch-speak")
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
                    Text(connection.displayAddress)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
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
