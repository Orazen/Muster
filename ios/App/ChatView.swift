// One conversation: the transcript, the approval cards, and the composer.
//
// The transcript is whatever the harness folded — settled text, tool chips,
// option cards, screenshots. This renders those and nothing else; it does
// not re-derive anything from provider events, because the server already
// did that and having two folds is how two clients start disagreeing.
import SwiftUI
import CompanionCore
// Unconditional, because the uses below are: `Color(uiColor:)` and
// `UIImage(data:)` are reached on every path through this file. A
// `canImport` guard around the import alone does not make the file portable
// — it only moves the failure from "no such module" to "no such type", and
// hides that this view is iOS-only behind something that looks like it
// isn't. The App target is iOS; CompanionCore is where the portable half
// lives.
import UIKit

struct ChatView: View {
    let chat: Chat
    @EnvironmentObject private var session: Session
    @EnvironmentObject private var announcer: Announcer
    @Environment(\.dismiss) private var dismiss
    @State private var composerLease: ComposerViewLease?
    @State private var approvalLease: ApprovalViewLease?
    @State private var showingTasks = false
    @State private var shareFile: ShareFile?
    @State private var seedLease: UUID?
    @State private var seedVisible = false
    @FocusState private var composerFocused: Bool
    /// The composer's dictation. A `@StateObject` on purpose: a capture
    /// must survive body re-evaluation, and every partial result is one.
    @StateObject private var dictation = DictationController()

    /// The live bubble's scroll target. A constant because there is at most
    /// one per chat and it has no message id to borrow.
    static let liveBubbleId = "companion.live"

    private var messages: [Message] {
        session.state.visibleTranscript(forThread: chat.threadId)
    }

    /// The live chat record, so busy/unread stay current as frames land.
    private var current: Chat {
        switch chat {
        case let .bot(bot): return session.state.bot(bot.id).map(Chat.bot) ?? chat
        case let .room(room):
            return session.state.rooms.first { $0.id == room.id }.map(Chat.room) ?? chat
        }
    }

    private var isBotChat: Bool {
        if case .bot = current { return true }
        return false
    }

    /// True while the recogniser owns the tail of the draft.
    private var dictating: Bool { dictation.isListening }

    /// The header reads as one element to VoiceOver: who this is, and the
    /// task it is on — the identity the truncated label visually hides.
    private var accessibilitySummary: String {
        if let task = current.taskTitle {
            return "\(current.name), current task: \(task)"
        }
        return current.name
    }

    var body: some View {
        // Read the transcript once for this render. Pagination changes the
        // array as a unit; repeatedly reaching through ObservableObject for
        // every row only recomputes the same value.
        let transcript = messages
        let composerContext = session.composerContext(for: chat)
        // A VStack with the composer as a sibling, rather than a scroll view
        // with `.safeAreaInset`. The inset version sized itself to its
        // content, so a short transcript left the composer floating in the
        // middle of the screen with black beneath it. Here the scroll area is
        // explicitly told to take everything the composer does not.
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    // VStack, not LazyVStack. A lazy stack does not know how
                    // tall it is until its rows have been built, so
                    // `.defaultScrollAnchor(.bottom)` anchors against an
                    // estimate and the chat opens somewhere in the middle of
                    // the conversation. Building all of it up front makes the
                    // height exact and the anchor land on the newest message.
                    // A thread holds 50 messages until you ask for more, so
                    // there is nothing here worth being lazy about.
                    VStack(alignment: .leading, spacing: 12) {
                        if session.state.hasMore[chat.threadId] == true {
                            Button("Load earlier messages") {
                                // keep the reader where they were: after older
                                // messages are prepended, sit back on the one
                                // that used to be at the top
                                let anchor = transcript.first?.id
                                Task {
                                    await session.loadOlder(threadId: chat.threadId)
                                    if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                                }
                            }
                            .font(.footnote)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                        }

                        ForEach(Array(transcript.enumerated()), id: \.element.id) { index, message in
                            VStack(alignment: .leading, spacing: 12) {
                                // a gap in time is worth marking; a timestamp
                                // on every message is just noise
                                if startsANewStretch(at: index, in: transcript) {
                                    Text(RelativeStamp.separator(message.date))
                                        .font(.system(size: 13))
                                        .foregroundStyle(Color.secondary)
                                        .frame(maxWidth: .infinity)
                                        .padding(.top, 6)
                                }
                                MessageRow(chat: current, message: message)
                            }
                            .id(message.id)
                        }

                        // The reply as it is typed. It sits after the last
                        // settled message and disappears the moment the real
                        // one arrives — the store clears it on the same frame
                        // that appends the message, so there is never a beat
                        // where both are on screen.
                        if let live = session.state.streaming[chat.threadId], !live.isEmpty {
                            StreamingBubble(text: live, reasoning: nil)
                                .id(Self.liveBubbleId)
                        } else if let thinking = session.state.reasoning[chat.threadId], !thinking.isEmpty {
                            // Only while there is no answer yet. Once tokens
                            // of the reply exist, the reasoning is behind us
                            // and showing both is just noise.
                            StreamingBubble(text: nil, reasoning: thinking)
                                .id(Self.liveBubbleId)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                // A conversation grows from the bottom: a transcript shorter
                // than the screen rests at the bottom, and opening a chat
                // starts on the newest message rather than the oldest.
                .defaultScrollAnchor(.bottom)
                .onChange(of: transcript.last?.id) { _, _ in
                    guard let last = transcript.last else { return }
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
                // Follow the text as it arrives. Keyed on length rather than
                // the string so this fires once per delta batch, and without
                // animation — animating every token turns a smooth stream
                // into a stutter, because each scroll interrupts the last.
                .onChange(of: session.state.streaming[chat.threadId]?.count ?? 0) { _, length in
                    guard length > 0 else { return }
                    proxy.scrollTo(Self.liveBubbleId, anchor: .bottom)
                }
                .onChange(of: session.focusedMessageId) { _, messageId in
                    guard let messageId,
                          messages.contains(where: { $0.id == messageId })
                    else { return }
                    withAnimation { proxy.scrollTo(messageId, anchor: .center) }
                    session.consumeFocus(messageId)
                }
                .task {
                    guard let messageId = session.focusedMessageId,
                          messages.contains(where: { $0.id == messageId })
                    else { return }
                    proxy.scrollTo(messageId, anchor: .center)
                    session.consumeFocus(messageId)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            composer(context: composerContext, lease: composerLease)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.primary)
                        .frame(width: 32, height: 32)
                }
                .glassSurface(in: Circle())
                .accessibilityIdentifier("chat-back")
            }
            .bareToolbarBackground()
            ToolbarItem(placement: .principal) {
                // Identity + task label: the bot's flower and name, and under
                // them the open task's title — the thing a transcript is
                // *about*, which the old header dropped entirely. The label
                // truncates (a toolbar is narrow) but is never the only copy:
                // tapping the capsule opens the task list, where every title
                // renders in full. Bots only; rooms have no tasks.
                Button {
                    if case .bot = current { showingTasks = true }
                } label: {
                    VStack(spacing: 1) {
                        HStack(spacing: 8) {
                            FlowerAvatar(
                                color: current.color,
                                size: 24,
                                state: current.mascotState,
                                seed: current.id,
                                // The header face moves while this thread's
                                // reply is being read aloud in Walkie.
                                speaking: announcer.isSpeaking(threadId: current.threadId)
                            )
                            Text(current.name)
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(Color.primary)
                                .lineLimit(1)
                        }
                        if let task = current.taskTitle {
                            Text(task)
                                .font(.system(size: 11))
                                .foregroundStyle(Color.secondary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }
                    .padding(.leading, 10)
                    .padding(.trailing, 14)
                    .padding(.vertical, 4)
                    .glassCapsule()
                }
                .buttonStyle(.plain)
                .disabled(!isBotChat)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(accessibilitySummary)
                .accessibilityHint(isBotChat ? "Opens the task list" : "")
                // Stable UI-test hook for the capsule (VoiceOver text is
                // contextual, so tests match this instead of the label).
                .accessibilityIdentifier("chat-header-capsule")
            }
            .bareToolbarBackground()
            if case let .bot(bot) = current {
                // Rooms have no computer of their own — whichever member is
                // speaking owns one, and picking for the reader would be a
                // guess. Bots only.
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        ComputerView(bot: bot)
                    } label: {
                        Image(systemName: "display")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Color.primary)
                    }
                    .accessibilityLabel("Watch \(bot.name)'s computer")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if case let .bot(bot) = current {
                        Button("Tasks", systemImage: "square.stack") { showingTasks = true }
                            .disabled(bot.busy == true)
                    }
                    Button("Share as Markdown", systemImage: "doc.plaintext") {
                        Task {
                            if let url = await session.export(threadId: current.threadId, format: "markdown") {
                                shareFile = ShareFile(url: url)
                            }
                        }
                    }
                    Button("Share as JSON", systemImage: "curlybraces") {
                        Task {
                            if let url = await session.export(threadId: current.threadId, format: "json") {
                                shareFile = ShareFile(url: url)
                            }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Conversation actions")
            }
            if current.busy, case let .bot(bot) = current {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Stop") { Task { await session.interrupt(bot: bot) } }
                }
            }
            // Reading continues after Walkie closes, so the stop control has
            // to exist where the reader actually is.
            if announcer.isSpeaking(threadId: current.threadId) {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        announcer.stop()
                    } label: {
                        Image(systemName: "speaker.slash.fill")
                            .foregroundStyle(Color.primary)
                    }
                    .accessibilityLabel("Stop reading aloud")
                    .accessibilityIdentifier("chat-stop-speaking")
                }
            }
        }
        .task {
            // opening a chat is what marks it read, exactly as on the desktop
            if current.unread { await session.markRead(current) }
        }
        .onChange(of: current.unread) { _, unread in
            // A message can arrive while this chat is already on screen. The
            // initial task above will not run again, so clear that new unread
            // bit here rather than leaving a badge on an open conversation.
            if unread { Task { await session.markRead(current) } }
        }
        .sheet(isPresented: $showingTasks) {
            if case let .bot(bot) = current { TaskManagerView(bot: bot) }
        }
        .sheet(item: $shareFile) { file in
            ActivityShareSheet(items: [file.url])
        }
        .onAppear {
            seedVisible = true
            if seedLease == nil { seedLease = session.viewSeedConversation(chat) }
            if composerLease == nil { composerLease = session.viewComposer(composerContext) }
            if approvalLease == nil { approvalLease = session.viewApprovalConversation(chat) }
        }
        .onChange(of: session.seedSessionId) { _, _ in
            if let seedLease { session.leaveSeedConversation(seedLease) }
            seedLease = seedVisible ? session.viewSeedConversation(chat) : nil
            if let composerLease { session.leaveComposer(composerLease) }
            composerLease = seedVisible ? session.viewComposer(session.composerContext(for: chat)) : nil
            if let approvalLease { session.leaveApprovalConversation(approvalLease) }
            approvalLease = seedVisible ? session.viewApprovalConversation(chat) : nil
        }
        .onChange(of: chat.threadId) { _, _ in
            if let composerLease { session.leaveComposer(composerLease) }
            composerLease = seedVisible ? session.viewComposer(session.composerContext(for: chat)) : nil
            if let approvalLease { session.leaveApprovalConversation(approvalLease) }
            approvalLease = seedVisible ? session.viewApprovalConversation(chat) : nil
        }
        .onDisappear {
            seedVisible = false
            if let seedLease { session.leaveSeedConversation(seedLease) }
            seedLease = nil
            if let composerLease { session.leaveComposer(composerLease) }
            composerLease = nil
            if let approvalLease { session.leaveApprovalConversation(approvalLease) }
            approvalLease = nil
        }
    }

    /// True when this message opens a fresh stretch of conversation — the
    /// first one, or one that follows a gap of half an hour or more.
    private func startsANewStretch(at index: Int, in messages: [Message]) -> Bool {
        guard index > 0 else { return true }
        return messages[index].at - messages[index - 1].at > 30 * 60 * 1000
    }

    private func composer(context: ComposerContext, lease: ComposerViewLease?) -> some View {
        let draft = session.composerDraft(context)
        let canSend = session.canSendComposer(context, lease: lease)
        let canEdit = session.canEditComposer(context, lease: lease)
        let submit = { session.submitComposer(context, lease: lease) }
        return VStack(alignment: .leading, spacing: 8) {
            // Dictation's own states first: they are transient and loud,
            // and a refusal must be read before anything quieter shares
            // the row with it.
            if dictating {
                Label("Listening — speak your message", systemImage: "waveform")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("composer-dictation-status")
            } else if let refusal = dictation.flow.refusal {
                Text(refusal)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("composer-dictation-error")
            } else if let message = draft.message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("composer-recovery")
            } else if draft.inFlight {
                Text("Sending…").font(.footnote).foregroundStyle(.secondary)
            } else if !canEdit {
                Text("Reopen this conversation to write in its current task.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                TextField("Ask \(chat.name)", text: Binding(
                    get: { session.composerDraft(context).text },
                        set: { session.editComposer($0, context: context, lease: lease) }
                ), axis: .vertical)
                    .lineLimit(1...5)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .glassCapsule()
                    .focused($composerFocused)
                    // While the recogniser owns the tail of the draft,
                    // typing into it would be overwritten by the next
                    // result — the words arrive from the microphone or
                    // they do not move.
                    .disabled(!canEdit || dictating)
                    .accessibilityLabel("Message draft")
                    .accessibilityIdentifier("composer-field")
                    .submitLabel(.send)
                    // Return sends, Shift+Return breaks the line — the shape
                    // every chat app has. `.ignored` hands the keypress back to
                    // the text field, which is what inserts the newline; there is
                    // no way to type one otherwise once Return is claimed.
                    .onKeyPress(.return, phases: .down) { press in
                        guard !press.modifiers.contains(.shift) else { return .ignored }
                        submit()
                        return .handled
                    }
                    // software keyboards have no Shift+Return, so their Return
                    // key is a send — which is what `.submitLabel(.send)` promises
                    .onSubmit(submit)

                // The mic between the words and the send button: dictation
                // fills the draft, sending stays a separate, deliberate
                // act — the same split typing already has.
                Button {
                    let base = session.composerDraft(context).text
                    Task {
                        // A stop returns the committed draft; starts and
                        // refusals return nothing (partials write back
                        // through onChange while the capture runs).
                        if let text = await dictation.toggle(base: base) {
                            session.editComposer(text, context: context, lease: lease)
                        }
                    }
                } label: {
                    Image(systemName: dictating ? "stop.fill" : "mic")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(dictating ? Color.white : Color.primary)
                        .frame(width: 44, height: 44)
                        .background(
                            Circle().fill(dictating ? Color.red : Color.secondary.opacity(0.35))
                        )
                }
                // Stopping must work even if the contract closed mid-capture.
                .disabled(!canEdit && !dictating)
                .accessibilityLabel(dictating ? "Stop dictating" : "Dictate a message")
                .accessibilityIdentifier("composer-dictate")

                Button {
                    submit()
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Color(uiColor: .systemBackground))
                        .frame(width: 44, height: 44)
                        .background(
                            Circle().fill(canSend ? Color.primary : Color.secondary.opacity(0.35))
                        )
                }
                // A send racing the next partial would write the old draft
                // back over the new words; dictation stops first, then the
                // person sends.
                .disabled(!canSend || dictating)
                .accessibilityLabel("Send")
                .accessibilityIdentifier("composer-send")
                .animation(.easeOut(duration: 0.15), value: canSend)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.bar)
        // Dictation writes through the session as the words arrive — the
        // draft has one owner, and it is not this view. Guarded to a live
        // capture so a refused or finished flow can never push its stale
        // text over something the user typed afterwards.
        .onChange(of: dictation.flow.draft) { _, text in
            guard dictating else { return }
            session.editComposer(text, context: context, lease: lease)
        }
        .onDisappear {
            // Leaving the chat mid-capture: detach() commits before it
            // silences the recogniser, so no spoken word is dropped on the
            // way out.
            guard dictating else { return }
            session.editComposer(dictation.detach(), context: context, lease: lease)
        }
    }
}

struct MessageRow: View {
    let chat: Chat
    let message: Message
    @EnvironmentObject private var session: Session
    @State private var editingText = ""
    @State private var showingEdit = false

    private static let reactionChoices = ["👍", "❤️", "😂", "🎉", "👀"]

    private var versions: [Message] {
        session.state.versions(of: message, inThread: chat.threadId)
    }

    var body: some View {
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 6) {
            content

            if let comm = message.comm {
                Label("Messaged \(comm.withName)", systemImage: "arrow.up.right.bubble")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary)
            }

            if let reactions = message.reactions, !reactions.isEmpty {
                HStack(spacing: 6) {
                    ForEach(reactionGroups(reactions), id: \.emoji) { group in
                        Button("\(group.emoji) \(group.count)") {
                            Task { await session.react(to: message, in: chat.threadId, emoji: group.emoji) }
                        }
                        .font(.system(size: 13))
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .tint(group.mine ? Color.accentColor : Color.secondary)
                    }
                }
            }

            if versions.count > 1, let index = versions.firstIndex(where: { $0.id == message.id }),
               case let .bot(bot) = chat {
                HStack(spacing: 8) {
                    Button {
                        Task { await session.switchVersion(to: versions[index - 1], for: bot) }
                    } label: { Image(systemName: "chevron.left") }
                    .disabled(index == 0 || bot.busy == true)
                    Text("\(index + 1) of \(versions.count)")
                    Button {
                        Task { await session.switchVersion(to: versions[index + 1], for: bot) }
                    } label: { Image(systemName: "chevron.right") }
                    .disabled(index + 1 >= versions.count || bot.busy == true)
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.secondary)
            }
        }
        .contextMenu {
            ForEach(Self.reactionChoices, id: \.self) { emoji in
                Button(emoji) { Task { await session.react(to: message, in: chat.threadId, emoji: emoji) } }
            }
            if message.role == .user, message.kind == .text, case let .bot(bot) = chat,
               !session.state.unresolvedSeedAnswerUser(threadId: chat.threadId, messageId: message.id) {
                Divider()
                Button("Edit and retry", systemImage: "pencil") {
                    guard !session.state.unresolvedSeedAnswerUser(threadId: chat.threadId, messageId: message.id) else { return }
                    editingText = message.text ?? ""
                    showingEdit = true
                }
                .disabled(bot.busy == true)
            }
        }
        .alert("Edit and retry", isPresented: $showingEdit) {
            TextField("Message", text: $editingText)
            Button("Cancel", role: .cancel) {}
            if case let .bot(bot) = chat {
                Button("Send") {
                    guard !session.state.unresolvedSeedAnswerUser(threadId: chat.threadId, messageId: message.id) else { return }
                    let text = editingText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    Task { await session.edit(message, for: bot, text: text) }
                }
            }
        } message: {
            Text("This creates a new version and continues from there.")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch message.kind {
        case .text:
            TextBubble(message: message)
        case .options:
            if message.card?.requestId == nil { SeedCardView(chat: chat, message: message) }
            else { CardView(chat: chat, message: message) }
        case .activity:
            ActivityChip(tool: message.tool)
        case .screen:
            ScreenShot(threadId: chat.threadId, message: message)
        case .unknown:
            // A message kind from a newer computer. Almost everything the
            // harness sends carries `text`, so showing it is usually the
            // whole message and always better than a gap in the transcript.
            // When there is nothing to show, show nothing — a placeholder
            // saying "unsupported" is a worse gap than the gap.
            if let text = message.text, !text.isEmpty {
                TextBubble(message: message)
            }
        }
    }

    private func reactionGroups(_ reactions: [Reaction]) -> [(emoji: String, count: Int, mine: Bool)] {
        Dictionary(grouping: reactions, by: \.emoji)
            .map { (emoji: $0.key, count: $0.value.count, mine: $0.value.contains { $0.by == "user" }) }
            .sorted { $0.emoji < $1.emoji }
    }
}

private struct ShareFile: Identifiable {
    let url: URL
    var id: String { url.path }
}

private struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct TextBubble: View {
    let message: Message

    var body: some View {
        let mine = message.role == .user
        HStack {
            if mine { Spacer(minLength: 44) }
            VStack(alignment: .leading, spacing: 4) {
                // rooms attribute each line to the member who said it
                if let from = message.from {
                    Text(from.name)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(AgentPalette.color(from.color))
                }
                // Bots get markdown, you do not — the same split the desktop
                // makes. Markdown you did not intend is worse than markdown
                // you did: a message about `**` should show the asterisks.
                if mine {
                    Text(message.text ?? "")
                        .font(.system(size: 17))
                        .foregroundStyle(Color.primary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    MarkdownText(source: message.text ?? "")
                        .foregroundStyle(Color.primary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Color.secondary.opacity(mine ? 0.24 : 0.13))
            )
            if !mine { Spacer(minLength: 44) }
        }
    }
}

/// A tool the bot ran. Deliberately quiet — these are the bulk of a busy
/// transcript and they are context, not content.
struct ActivityChip: View {
    let tool: ToolActivity?

    var body: some View {
        if let tool {
            Label {
                Text(tool.name).lineLimit(1)
            } icon: {
                Image(systemName: tool.ok == false ? "exclamationmark.triangle" : "wrench.and.screwdriver")
            }
            .font(.system(size: 13))
            .foregroundStyle(tool.ok == false ? Color.red : Color.secondary)
            .padding(.leading, 4)
        }
    }
}

/// An option card. When it still has a request behind it, this is the
/// screen the companion exists for — a bot stopped, and only a person can
/// let it continue.
struct CardView: View {
    let chat: Chat
    let message: Message
    @EnvironmentObject private var session: Session
    @Environment(\.scenePhase) private var scenePhase

    private var reference: ApprovalReference? { session.approvalReference(chat: chat, message: message) }
    private var actionState: ApprovalActionState? { session.approvalState(chat: chat, message: message) }

    private func action(for option: String) -> ApprovalAction? {
        guard let reference else { return nil }
        return ApprovalContract.action(for: option, reference: reference)
    }

    private func submit(_ action: ApprovalAction) {
        guard scenePhase == .active, let reference, session.canSubmitApproval(reference) else { return }
        session.submitApproval(reference, action: action)
    }

    private var canSubmit: Bool {
        guard scenePhase == .active, let reference else { return false }
        return session.canSubmitApproval(reference)
    }

    var body: some View {
        if let card = message.card {
            VStack(alignment: .leading, spacing: 12) {
                Text(card.title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.primary)
                Text(card.subtitle)
                    .font(.system(size: 15))
                    .foregroundStyle(Color.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)

                if let held = card.held {
                    Label(held, systemImage: "exclamationmark.shield")
                        .font(.system(size: 13))
                        .foregroundStyle(.orange)
                }

                if let why = card.why, why.source == "previous-run", why.threadId == chat.threadId {
                    DisclosureGroup {
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
                        .font(.system(size: 13))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Previous run").font(.system(size: 14, weight: .medium))
                            Text("\(why.date.formatted(date: .abbreviated, time: .shortened)) · \(why.outcomeLabel)")
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if card.isPending {
                    // Vertical options retain complete labels and a 44-point
                    // touch target on narrow screens and with larger text.
                    VStack(spacing: 10) {
                        ForEach(Array(card.options.enumerated()), id: \.offset) { index, option in
                            let choice = action(for: option)
                            Button { if let choice { submit(choice) } } label: {
                                Text(option).multilineTextAlignment(.center)
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(choice == .deny ? Color.secondary : Color.accentColor)
                            .disabled(!canSubmit || choice == nil)
                            .accessibilityIdentifier("approval-option-\(index)")
                        }
                    }

                    if let reference, ApprovalContract.canAlwaysAllow(reference),
                       !card.options.contains(where: ApprovalContract.isAlwaysAllowOption) {
                        Button { submit(.alwaysAllow) } label: {
                            Text("Always allow this tool")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .font(.system(size: 14))
                        .buttonStyle(.bordered)
                        .disabled(!canSubmit)
                        .accessibilityIdentifier("approval-always-allow")
                    }
                    if reference == nil || card.options.contains(where: { action(for: $0) == nil }) {
                        Text("Review this request on your computer. This app cannot confirm these choices.")
                            .font(.footnote).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else if let answered = card.answered {
                    Label(answered, systemImage: "checkmark.circle")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.secondary)
                }
                if let actionState {
                    if actionState.inFlight {
                        ProgressView("Confirming your choice…").font(.footnote)
                    }
                    if let feedback = actionState.message {
                        Text(feedback).font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("approval-recovery")
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("approval-card-\(message.id)")
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Color.secondary.opacity(0.13))
            )
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(card.isPending ? Color.accentColor : .clear, lineWidth: 1.5)
            }
        }
    }
}

/// A frame of the bot's computer. In the paged shape the pixels are not in
/// the transcript — they are fetched here, once, when the row appears.
struct ScreenShot: View {
    let threadId: String
    let message: Message
    @EnvironmentObject private var session: Session
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.secondary.opacity(0.13))
                    .frame(height: 160)
                    .overlay { ProgressView() }
            }
        }
        .task {
            guard image == nil else { return }
            let data: Data?
            if let inline = message.png, let decoded = Data(base64Encoded: inline) {
                data = decoded
            } else if message.hasImage == true {
                data = await session.image(threadId: threadId, messageId: message.id)
            } else {
                data = nil
            }
            image = data.flatMap(UIImage.init(data:))
        }
    }
}

/// The reply as it is being typed, styled to match the settled bubble it is
/// about to become — the handover should be invisible, and any difference in
/// padding or corner radius reads as the message jumping on arrival.
///
/// A caret rather than a spinner: a spinner says "something is happening
/// somewhere", which the reader already knows. A caret at the end of real
/// text says how far along it is.
///
/// The caret does not blink, deliberately. The obvious way to blink it —
/// `withAnimation(.repeatForever) { flag.toggle() }` in `onAppear` — animates
/// the change once and then sits still, and a caret that blinks twice and
/// stops looks more broken than one that never blinks. A correct version
/// animates opacity on a separate view, which needs a device to get right;
/// static is honest until then.
struct StreamingBubble: View {
    let text: String?
    let reasoning: String?

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                if let reasoning, !reasoning.isEmpty, text?.isEmpty != false {
                    // Quieter and smaller than an answer, because it is not
                    // one. Tail-limited: reasoning runs to thousands of words
                    // and the part worth seeing is always the end.
                    //
                    // Plain text, unlike the answer: the tail cut lands
                    // wherever it lands, and rendering markdown that starts
                    // mid-syntax invents structure the model did not write.
                    Text(String(reasoning.suffix(400)))
                        .font(.system(size: 14))
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let text, !text.isEmpty {
                    // Same renderer as the settled bubble, for the same
                    // reason as the padding: a live reply showing `**bold**`
                    // that snaps to bold on arrival is the message jumping,
                    // just in a different dimension. The parser tolerates the
                    // half-finished markdown this is always holding — an
                    // unclosed fence renders as code, an unclosed link as the
                    // characters typed so far.
                    MarkdownText(source: text, caret: true)
                        .foregroundStyle(Color.primary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Color.secondary.opacity(0.13))
            )
            Spacer(minLength: 44)
        }
        // No `.textSelection` on purpose: selecting text that is still growing
        // fights the reader, and the settled bubble a frame later is
        // selectable anyway.
    }
}
