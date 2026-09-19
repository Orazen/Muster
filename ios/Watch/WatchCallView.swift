import SwiftUI
import CompanionCore

/// Foreground, text-backed calls. Dictation belongs to the system keyboard;
/// speaking a finished answer always requires a separate tap.
struct WatchCallView: View {
    @EnvironmentObject private var session: WatchSession
    @EnvironmentObject private var voice: WatchVoice
    let bot: Bot

    @State private var draft = ""
    @State private var draftRevision = 0
    @State private var showCalendar = false
    @State private var calendarDraftReady = false
    @State private var actionPending = false
    @State private var visible = false
    @State private var context: WatchCallContext?

    private var matches: Bool { context.map { session.callMatches($0) } ?? false }
    private var currentThread: Bool {
        session.state.bots.contains { $0.id == bot.id && $0.threadId == bot.threadId }
    }
    private var hostAvailable: Bool { session.status == .live }
    private var botBusy: Bool { session.state.bots.first { $0.id == bot.id }?.busy == true }
    private var active: Bool { session.callPhase != .idle && session.callPhase != .ended }
    private var misplaced: Bool { !currentThread || (active && !matches) }
    private var record: ForegroundCallRecord? { matches ? session.callRecord : nil }
    private var canSend: Bool {
        guard visible, hostAvailable, !actionPending, matches, currentThread, session.callPhase == .connected,
              session.callPendingRequestId == nil else { return false }
        switch record?.turn?.state {
        case .starting, .working, .uncertain: return false
        default:
            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            return !text.isEmpty && text.utf16.count <= 8_000
        }
    }
    private var status: String {
        switch session.callPhase {
        case .idle: return "Ready to call"
        case .starting: return "Starting…"
        case .ringing: return "Ready to connect"
        case .connected: return "Connected"
        case .ending: return "Ending…"
        case .ended: return "Call ended"
        case .uncertain: return "Status unconfirmed"
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    WatchFlower(color: bot.color, size: 32, speaking: voice.isSpeaking(threadId: bot.threadId))
                    Text(bot.name).font(.headline)
                }
                if misplaced {
                    Text(currentThread ? "A call is open in another conversation. Return there to end it before starting here." : "This conversation has changed. Return to the bot to start a new call.")
                        .font(.footnote)
                    if active && matches { endButton }
                } else {
                    Text(status).font(.headline).accessibilityIdentifier("watch-call-status")
                    if !hostAvailable {
                        Text("Host unavailable. Reconnect to continue.").font(.footnote)
                            .accessibilityIdentifier("watch-call-unavailable")
                    } else if botBusy && !active {
                        Text("Wait for this bot to finish before starting a call.").font(.footnote)
                            .accessibilityIdentifier("watch-call-busy")
                    }
                    if let notice = session.callNotice {
                        Text(notice).font(.footnote).accessibilityIdentifier("watch-call-notice")
                    }
                    if active { endButton }
                    callControls
                    if let turn = record?.turn {
                        if turn.state == .starting || turn.state == .working {
                            Text("Working…").font(.footnote)
                        }
                        if let error = turn.error, !error.isEmpty {
                            Text(error).font(.footnote).accessibilityIdentifier("watch-call-error")
                        }
                        if turn.state == .completed, let reply = turn.reply, !reply.isEmpty {
                            Text(reply).font(.footnote).accessibilityIdentifier("watch-call-reply")
                            if let speech = VoiceActivity(scope: .thread(bot.threadId), source: reply) {
                                Button {
                                    voice.toggle(speech)
                                } label: {
                                    Label(voice.isSpeaking(threadId: bot.threadId) ? "Stop listening" : "Listen", systemImage: "speaker.wave.2.fill")
                                }
                                .accessibilityIdentifier("watch-call-listen")
                            }
                        }
                    }
                    if session.callCanDismissUnknown {
                        Text("The host no longer recognizes this call. Previous work may still be running.").font(.footnote)
                        Button("Forget call") {
                            if let context { session.dismissUnknownCall(context) }
                        }
                            .disabled(actionPending)
                            .accessibilityIdentifier("watch-call-forget")
                    }
                }
            }
            .padding(.horizontal)
        }
        .navigationTitle("Call")
        .onChange(of: draft) { _, _ in draftRevision += 1 }
        .onAppear {
            context = session.makeCallContext(botId: bot.id, threadId: bot.threadId)
            actionPending = false
            showCalendar = false
            visible = true
        }
        .task {
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 5_000_000_000) }
                catch { return }
                guard !Task.isCancelled else { return }
                if visible, let context, matches, active, session.callPhase != .ending, !session.callEndRequested, !actionPending {
                    await session.pollCall(context)
                }
            }
        }
        .onDisappear {
            visible = false
            if let context { session.endCallImmediately(context) }
            if voice.isSpeaking(threadId: bot.threadId) { voice.stop() }
        }
    }

    @ViewBuilder private var callControls: some View {
        switch session.callPhase {
        case .idle, .ended:
            Text("Keep this screen open during the call.").font(.footnote).foregroundStyle(.secondary)
            Button("Start call") { perform { await session.beginCall($0) } }
                .disabled(actionPending || !hostAvailable || botBusy)
                .accessibilityIdentifier("watch-call-start")
        case .ringing:
            Button("Connect") { perform { await session.acceptCall($0) } }
                .disabled(actionPending)
                .accessibilityIdentifier("watch-call-connect")
        case .connected:
            TextField("Say or type a message", text: $draft)
                .accessibilityIdentifier("watch-call-input")
            Button("Plan my day") {
                calendarDraftReady = false
                showCalendar = true
                if let context { session.loadCalendar(context) }
            }
            .disabled(actionPending || session.callPendingRequestId != nil)
            .accessibilityIdentifier("watch-call-plan-day")
            if showCalendar, let context {
                WatchCallCalendarView(context: context, draft: $draft, draftRevision: $draftRevision) {
                    showCalendar = false; calendarDraftReady = true
                }
            }
            if calendarDraftReady {
                Text("Draft ready. Review the message, then tap Send.").font(.footnote).accessibilityIdentifier("watch-calendar-draft-notice")
            }
            if draft.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count > 8_000 {
                Text("Shorten your message to 8,000 characters.").font(.footnote)
                    .accessibilityIdentifier("watch-call-length")
            }
            Button("Send") {
                let text = draft
                perform { await session.sendCall(text, context: $0) }
            }
            .disabled(!canSend)
            .accessibilityIdentifier("watch-call-send")
            if record?.turn?.state == .failed || record?.turn?.state == .uncertain {
                checkButton
            }
        case .uncertain:
            if session.callEndRequested {
                Text("The host may still be working. Retry End to confirm.").font(.footnote)
            } else {
                Text("Your request may have reached the host. Check before sending again.").font(.footnote)
                checkButton
            }
        case .starting, .ending:
            ProgressView().accessibilityIdentifier("watch-call-progress")
        }
    }

    private var checkButton: some View {
        Button("Check status") { perform { await session.pollCall($0) } }
            .disabled(actionPending)
            .accessibilityIdentifier("watch-call-check")
    }
    private var endButton: some View {
        Button(session.callPhase == .uncertain ? "Retry End" : "End call", role: .destructive) {
            if let context { session.endCallImmediately(context) }
            if voice.isSpeaking(threadId: bot.threadId) { voice.stop() }
        }
        .disabled(session.callPhase == .ending)
        .accessibilityIdentifier("watch-call-end")
    }
    private func perform(_ action: @escaping @MainActor (WatchCallContext) async -> Void) {
        guard visible, let capturedContext = context, !actionPending else { return }
        actionPending = true
        Task { @MainActor in
            guard visible, context == capturedContext else {
                if context == capturedContext { actionPending = false }
                return
            }
            await action(capturedContext)
            if context == capturedContext { actionPending = false }
        }
    }
}
