// Walkie — talk to your bots the way you would over a radio.
//
// Pick a bot, hold the button, say the thing, let go. The words go out as
// a message; the reply comes back out loud. The layout follows the
// OpenMausBot companion's Walkie sheet (Apache-2.0, attribution in the
// shipped notices): roster on top, one live status card, a row of
// radio-style controls, and one big push-to-talk capsule. What it shows is
// Muster's own folded state, decided in CompanionCore's Walkie so the
// choices are testable; this file draws them and wires the gestures.
import SwiftUI
import CompanionCore

struct WalkieView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss

    @StateObject private var talk = TalkSession()
    /// App-scoped, not owned here: the roster rows outside Walkie also pulse
    /// while a reply is read, so the speaker outlives this sheet.
    @EnvironmentObject private var announcer: Announcer

    @AppStorage("walkie.voiceOn") private var voiceOn = true
    @AppStorage("walkie.botId") private var selectedId = ""
    @State private var path = NavigationPath()
    /// The transcript's end when this bot was selected — replies after this
    /// point get spoken, everything older stays silent.
    @State private var lastSpokenId: String?
    @State private var holding = false
    @State private var micDenied = false

    private var bots: [Bot] { session.state.bots.filter { $0.hidden != true } }

    /// The remembered bot, or whoever is there if that one is gone. Never
    /// empty while a bot exists — the panel always has a transmission
    /// target, which is the whole point of a radio.
    private var selected: Bot? {
        if let bot = session.state.bot(selectedId) { return bot }
        return bots.first
    }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 14) {
                header
                roster
                statusCard
                controls
                Spacer(minLength: 0)
                holdButton
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationDestination(for: Chat.self) { ChatView(chat: $0) }
        }
        .onAppear { seedSpokenBoundary() }
        .onChange(of: selected?.id) { _, _ in
            seedSpokenBoundary()
            talk.cancel()
            announcer.stop()
            holding = false
            micDenied = false
        }
        .onChange(of: transcriptTail) { _, _ in speakNewReply() }
        .onChange(of: voiceOn) { _, on in if !on { announcer.stop() } }
        // Closing the sheet deliberately does NOT stop the reading: the
        // speaker is app-scoped now, so a reply can finish while the reader
        // moves through the roster, and the chat header offers the Stop.
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Walkie")
                    .font(.system(size: 34, weight: .bold))
                    .foregroundStyle(Color.primary)
                HStack(spacing: 6) {
                    Circle()
                        .fill(connectionDot)
                        .frame(width: 7, height: 7)
                    Text(session.connection?.name ?? "Your computer")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .frame(width: 40, height: 40)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .glassSurface(in: Circle())
            .accessibilityLabel("Close Walkie")
            .accessibilityIdentifier("walkie-close")
        }
        .padding(.top, 6)
    }

    private var connectionDot: Color {
        if case .live = session.status { return .green }
        if case .unauthorized = session.status { return .red }
        return .orange
    }

    // MARK: - Roster

    private var roster: some View {
        Group {
            if bots.isEmpty {
                Text("No bots yet. Make one on your computer and it will answer here.")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 34)
            } else {
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(bots) { bot in
                            row(bot)
                        }
                    }
                    .padding(.vertical, 8)
                }
                .frame(maxHeight: 300)
            }
        }
        .glassSheet(cornerRadius: 24)
    }

    private func row(_ bot: Bot) -> some View {
        let isSelected = bot.id == selected?.id
        let status = Walkie.status(bot: bot, state: session.state)
        return Button { select(bot) } label: {
            HStack(spacing: 12) {
                FlowerAvatar(
                    color: bot.color,
                    size: 40,
                    state: flowerState(for: bot),
                    seed: bot.id,
                    // Pulses while this bot's own reply is the one being
                    // read, so the roster shows whose voice is in the room.
                    speaking: announcer.isSpeaking(threadId: bot.threadId)
                )
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(bot.name)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                        if !bot.title.isEmpty {
                            Text(bot.title)
                                .font(.system(size: 12))
                                .foregroundStyle(Color.secondary)
                                .lineLimit(1)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(Color.secondary.opacity(0.15)))
                        }
                        Spacer(minLength: 4)
                    }
                    Text(Walkie.statusLine(status))
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }
                trailingMark(isSelected: isSelected, working: status == .working)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            isSelected ? Color.accentColor.opacity(0.10) : Color.clear,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .overlay {
            if isSelected {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.accentColor, lineWidth: 1.5)
                // The selected row's own ring, not the glass's — a radio
                // shows which channel it is on.
            }
        }
        .padding(.horizontal, 8)
        // Named, not id'd: the id is a random string that means nothing to
        // a test or a screen reader, and two bots sharing a name is not a
        // state the harness allows.
        .accessibilityIdentifier("walkie-row-\(bot.name)")
    }

    @ViewBuilder
    private func trailingMark(isSelected: Bool, working: Bool) -> some View {
        if isSelected && working {
            ProgressView().controlSize(.small)
        } else if isSelected {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 20))
                .foregroundStyle(Color.accentColor)
        } else {
            Image(systemName: "circle")
                .font(.system(size: 18))
                .foregroundStyle(Color.secondary.opacity(0.5))
        }
    }

    // MARK: - Status card

    private var headline: String {
        if micDenied { return "Microphone access is off — allow it in Settings." }
        if case .denied(let why) = talk.phase { return why }
        if talk.phase == .listening { return "Listening…" }
        guard let bot = selected else { return "No one to talk to yet" }
        if announcer.speaking { return "\(bot.name) is speaking" }
        switch Walkie.status(bot: bot, state: session.state) {
        case .working: return "\(bot.name) is working on it"
        case .waitingOnYou: return "\(bot.name) is waiting on you"
        case .ready: return "\(bot.name) is ready"
        }
    }

    private var headlineSpinner: Bool {
        guard !micDenied else { return false }
        if talk.phase == .listening { return true }
        if let bot = selected, !announcer.speaking {
            return Walkie.status(bot: bot, state: session.state) == .working
        }
        return false
    }

    private var statusCard: some View {
        let quote = selected.flatMap {
            Walkie.quote(
                bot: $0,
                state: session.state,
                partial: talk.phase == .listening ? talk.partial : nil
            )
        }
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if headlineSpinner { ProgressView().controlSize(.small) }
                Text(headline)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
                Spacer()
            }
            if let quote {
                Text("\u{201C}\(quote.text)\u{201D}")
                    .font(.system(size: 17, weight: quote.live ? .regular : .medium))
                    .foregroundStyle(Color.primary)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSheet()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("walkie-status")
    }

    // MARK: - Controls

    private var controls: some View {
        // Four glass controls in one row: they belong to a single cluster, so
        // their surfaces merge where they meet rather than stacking.
        GlassCluster(spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Spacer(minLength: 0)
                control(
                    image: "arrow.counterclockwise",
                    label: "Replay",
                    identifier: "walkie-replay",
                    enabled: announcer.canReplay
                ) { announcer.replay() }

                control(
                    image: "stop.fill",
                    label: "Stop",
                    identifier: "walkie-stop",
                    enabled: (selected?.busy == true) || talk.phase == .listening
                ) { stop() }

                control(
                    image: voiceOn ? "speaker.wave.2.fill" : "speaker.slash.fill",
                    label: voiceOn ? "Voice on" : "Voice off",
                    identifier: "walkie-voice"
                ) { voiceOn.toggle() }

                control(
                    image: "bubble.left.and.bubble.right.fill",
                    label: "Open chat",
                    identifier: "walkie-open-chat",
                    enabled: selected != nil
                ) {
                    if let bot = selected { path.append(Chat.bot(bot)) }
                }
                Spacer(minLength: 0)
            }
        }
    }

    private func control(
        image: String,
        label: String,
        identifier: String,
        enabled: Bool = true,
        _ action: @escaping () -> Void
    ) -> some View {
        VStack(spacing: 6) {
            Button(action: action) {
                Image(systemName: image)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(enabled ? Color.primary : Color.secondary.opacity(0.5))
                    .frame(width: 62, height: 46)
                    .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .glassSurface(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .disabled(!enabled)
            .accessibilityIdentifier(identifier)
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Color.secondary)
        }
    }

    // MARK: - Push to talk

    private var holdEnabled: Bool {
        selected != nil && session.status == .live
    }

    private var holdLabel: String {
        if talk.phase == .listening { return "Listening — release to send" }
        guard let bot = selected else { return "No bots yet" }
        guard holdEnabled else { return "Connect to your computer" }
        return "Hold to talk to \(bot.name)"
    }

    private var holdButton: some View {
        let listening = talk.phase == .listening
        return HStack(spacing: 10) {
            Image(systemName: listening ? "waveform" : "mic.fill")
                .font(.system(size: 18, weight: .semibold))
            Text(holdLabel)
                .font(.system(size: 18, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
        .background(
            Capsule().fill(
                listening ? Color.red
                    : holdEnabled ? Color.blue
                    : Color.secondary.opacity(0.4)
            )
        )
        .contentShape(Capsule())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in beginHold() }
                .onEnded { _ in endHold() }
        )
        .accessibilityLabel(holdLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("walkie-hold")
        // VoiceOver has no press-and-hold, so activation toggles: tap once
        // to talk, tap again to send.
        .accessibilityAction { holding ? endHold() : beginHold() }
    }

    private func beginHold() {
        guard !holding, holdEnabled else { return }
        holding = true
        Task { await startTransmission() }
    }

    private func startTransmission() async {
        announcer.stop()
        talk.clearError()
        micDenied = false
        if !(await TalkSession.requestPermissions()) {
            micDenied = true
            holding = false
            return
        }
        if !(await talk.begin()) { holding = false }
    }

    private func endHold() {
        guard holding else { return }
        holding = false
        Task { await finishTransmission() }
    }

    private func finishTransmission() async {
        guard let bot = selected else { return }
        let text = await talk.end()
        guard !text.isEmpty else { return }
        await session.send(text, to: .bot(bot))
    }

    /// Stop means stop: the transmission if there is one, the synthesiser if
    /// it is talking, and the bot itself if it is working.
    private func stop() {
        if talk.phase == .listening {
            talk.cancel()
            holding = false
        }
        announcer.stop()
        if let bot = selected, bot.busy == true {
            Task { await session.interrupt(bot: bot) }
        }
    }

    // MARK: - Speaking the replies

    private func select(_ bot: Bot) {
        guard bot.id != selected?.id else { return }
        selectedId = bot.id
    }

    /// A single string that changes whenever the selected thread gains a
    /// settled message — the value SwiftUI watches to decide whether a
    /// reply has landed.
    private var transcriptTail: String {
        guard let bot = selected else { return "" }
        return "\(bot.threadId)|\(session.state.visibleTranscript(forThread: bot.threadId).last?.id ?? "")"
    }

    private func seedSpokenBoundary() {
        guard let bot = selected else { lastSpokenId = nil; return }
        lastSpokenId = session.state.visibleTranscript(forThread: bot.threadId).last?.id
    }

    private func speakNewReply() {
        guard let bot = selected else { return }
        let transcript = session.state.visibleTranscript(forThread: bot.threadId)
        guard let message = Walkie.nextSpeakable(in: transcript, after: lastSpokenId) else { return }
        lastSpokenId = message.id
        // The boundary advances even muted — unmuting should not dump a
        // backlog; Replay is the way back to a missed reply.
        guard voiceOn, let text = message.text else { return }
        // Scoped to the thread: the bot whose answer is read is the bot whose
        // face pulses, and a fleet-level line never moves a roster row.
        announcer.speak(Walkie.spokenText(text), scope: .thread(bot.threadId))
    }
}
