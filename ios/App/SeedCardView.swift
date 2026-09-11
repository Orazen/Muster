import SwiftUI
import UIKit
import CompanionCore

/// Welcome answers have a durable receipt and explicit startup recovery.
/// They never use the live provider approval endpoint or pending predicate.
struct SeedCardView: View {
    let chat: Chat
    let message: Message
    @EnvironmentObject private var session: Session

    var body: some View {
        SeedCardContent(chat: chat, message: message, sessionID: session.seedSessionId)
            .id(SeedViewIdentity(session: session.seedSessionId, chat: chat, message: message))
    }
}

private struct SeedViewIdentity: Hashable {
    let session: UUID
    let kind: Bool
    let chat: [UInt16]
    let thread: [UInt16]
    let card: [UInt16]
    let signature: [UInt16]
    init(session: UUID, chat: Chat, message: Message) {
        self.session = session
        if case .bot = chat { kind = true } else { kind = false }
        self.chat = Array(chat.id.utf16)
        thread = Array(chat.threadId.utf16)
        card = Array(message.id.utf16)
        signature = Array(SeedCardContract.signature(message).utf16)
    }
}

private struct SeedEditorOpening: Identifiable { let id: UUID }

private struct SeedCardContent: View {
    let chat: Chat
    let message: Message
    let sessionID: UUID
    @EnvironmentObject private var session: Session
    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = SeedAnswerDraft()

    private var reference: SeedReference? {
        guard session.seedSessionId == sessionID, let reference = session.seedReference(chat: chat, message: message),
              SeedCardContract.exactText(reference.signature, SeedCardContract.signature(message)) else { return nil }
        return reference
    }
    private var writeBlocker: String? {
        guard let reference else { return nil }
        return session.state.seedWriteBlocker(botId: reference.botId, threadId: reference.threadId, cardId: reference.cardId)
    }
    private var action: SeedActionState? {
        guard let reference, let state = session.seedActions[reference.key] else { return nil }
        return SeedCardContract.exactText(state.reference.signature, reference.signature) || state.phase == .pending || state.inFlight ? state : nil
    }
    private var receipt: SeedAnswerReceipt? { message.card?.seedAnswer }
    private var canAnswer: Bool { reference != nil && writeBlocker == nil && message.card?.answered == nil && receipt == nil }
    private var canStart: Bool { reference != nil && writeBlocker == nil && (receipt?.status == .recorded || receipt?.status == .notStarted) }
    private var busy: Bool { draft.pending != nil || action?.phase == .pending || action?.inFlight == true }
    private var failure: String? { action?.phase == .failed ? action?.message : nil }
    private var retryAnswer: String? { draft.lastAnswer ?? action?.lastAnswer }

    var body: some View {
        let opening = draft.opening
        Group {
            if let card = message.card {
                VStack(alignment: .leading, spacing: 12) {
                    Text(reference == nil ? "Saved question" : "Getting started question").font(.caption).foregroundStyle(.secondary)
                    Text(card.title).font(.headline).fixedSize(horizontal: false, vertical: true)
                    if !card.subtitle.isEmpty { Text(card.subtitle).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                    ForEach(Array(card.options.enumerated()), id: \.offset) { index, option in
                        if canAnswer {
                            actionButton(option, id: "seed-option-\(index)", action: .answer(option))
                        } else { Text(option).font(.subheadline).foregroundStyle(.secondary) }
                    }
                    if canAnswer {
                        Button {
                            guard canAnswer, !busy, scenePhase == .active else { return }
                            draft.openEditor()
                        } label: { Text("Write your own answer").frame(maxWidth: .infinity, minHeight: 44) }
                        .buttonStyle(.bordered).disabled(busy || scenePhase != .active)
                        .accessibilityIdentifier("seed-custom-answer")
                    }
                    if let answer = card.answered { Text("Saved answer: \(answer)").font(.subheadline).textSelection(.enabled) }
                    if reference != nil, let receipt {
                        Text(statusText(receipt.status)).font(.subheadline).accessibilityIdentifier("seed-answer-status")
                        if let error = receipt.error { Text(error).font(.footnote).foregroundStyle(.secondary) }
                    }
                    if reference == nil { Text("Continue on your computer to review this saved question. It cannot start a task here.").font(.footnote).foregroundStyle(.secondary) }
                    if let writeBlocker { Text(writeBlocker).font(.footnote).foregroundStyle(.secondary) }
                    if opening == nil { feedback(in: nil) }
                }
                .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.13), in: RoundedRectangle(cornerRadius: 22))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("seed-card-\(message.id)")
            }
        }
        .sheet(item: Binding(
            get: { draft.opening.map { SeedEditorOpening(id: $0) } },
            set: { value in if value == nil, let opening { draft.closeEditor(opening) } }
        )) { presented in
            editor(presented.id)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .onChange(of: canAnswer) { _, eligible in if !eligible { draft.invalidateEditor() } }
        .onDisappear { draft.invalidateEditor() }
    }

    private func statusText(_ status: SeedAnswerStatus) -> String {
        switch status {
        case .recorded: return "Answer recorded. The task has not started."
        case .starting: return "Answer recorded. Start requested; waiting for confirmation."
        case .started: return "Answer recorded. The task started; follow its progress in this conversation."
        case .notStarted: return "Answer recorded. The task did not start. Resolve the issue below, then start the saved task."
        case .uncertain: return "Answer recorded. The start result could not be confirmed. Check status and review this conversation before sending another task."
        }
    }

    @ViewBuilder private func feedback(in opening: UUID?) -> some View {
        if busy {
            Text(action?.phase == .failed && action?.inFlight == true ? "Waiting for the previous request to close…"
                 : action?.operation == .check ? "Checking saved status…"
                 : action?.operation == .start ? "Requesting task start…" : "Recording your answer…")
                .font(.footnote).foregroundStyle(.secondary)
        }
        if reference != nil, let failure {
            Text(failure).font(.subheadline).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("seed-answer-error")
        }
        if reference != nil, receipt != nil || failure != nil || writeBlocker != nil {
            actionButton("Check status", id: "seed-check-status", action: .check, opening: opening)
            if canStart { actionButton("Start saved task", id: "seed-start-task", action: .start) }
            if canAnswer, failure != nil, let retryAnswer {
                actionButton("Retry same answer", id: "seed-retry-answer", action: .answer(retryAnswer), opening: opening)
            }
        }
    }

    private func actionButton(_ label: String, id: String, action: SeedAction, opening: UUID? = nil, disabled: Bool = false) -> some View {
        Button { perform(action, opening: opening) } label: { Text(label).frame(maxWidth: .infinity, minHeight: 44) }
            .buttonStyle(.borderedProminent).disabled(disabled || busy || scenePhase != .active)
            .accessibilityIdentifier(id)
    }

    private func perform(_ action: SeedAction, opening: UUID?) {
        guard scenePhase == .active, !busy, let reference else { return }
        let token: UUID?
        switch action {
        case let .answer(text):
            guard canAnswer else { return }
            token = draft.beginAnswer(text, from: opening)
        case .start:
            guard canStart else { return }
            token = draft.beginAction(from: opening)
        case .check: token = draft.beginAction(from: opening)
        }
        guard let token else { return }
        Task {
            await session.actOnSeed(reference, action: action)
            draft.finishAction(token)
        }
    }

    private func editor(_ opening: UUID) -> some View {
        SeedEditorFocusScope(canFocus: { canFocusEditor(opening) }) { editorFocus in
            NavigationStack {
                VStack(spacing: 0) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            TextEditor(text: Binding(get: { draft.text }, set: { value in
                                guard canAnswer, scenePhase == .active else { return }
                                draft.edit(value, in: opening)
                            }))
                            .frame(height: 140).padding(8)
                            .scrollContentBackground(.hidden)
                            .background(Color.secondary.opacity(0.13), in: RoundedRectangle(cornerRadius: 12))
                            .focused(editorFocus)
                            .accessibilityLabel("Your own answer").accessibilityIdentifier("seed-answer-input")
                            Text("\(draft.text.utf16.count) / 4000").font(.caption).foregroundStyle(draft.text.utf16.count > 4000 ? .red : .secondary)
                            feedback(in: opening)
                        }.padding(16)
                    }
                    actionButton("Send answer", id: "seed-send-answer", action: .answer(draft.text), opening: opening,
                                 disabled: !SeedCardContract.isValidAnswer(draft.text))
                        .padding(12).background(.bar)
                }
                .navigationTitle("Your own answer").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { draft.closeEditor(opening) }.frame(minWidth: 44, minHeight: 44)
                            .accessibilityLabel("Close answer editor").accessibilityIdentifier("seed-close-editor")
                    }
                }
            }
        }
        .id(opening)
    }

    private func canFocusEditor(_ opening: UUID) -> Bool {
        guard draft.opening == opening, canAnswer, scenePhase == .active, let reference,
              let current = session.state.seedCard(botId: reference.botId, threadId: reference.threadId, cardId: reference.cardId) else { return false }
        return current.card?.answered == nil && current.card?.seedAnswer == nil
    }
}

/// Focus belongs to one presentation; the exact draft remains in the card.
private struct SeedEditorFocusScope<Content: View>: View {
    let canFocus: () -> Bool
    let content: (FocusState<Bool>.Binding) -> Content
    @FocusState private var focused: Bool

    init(canFocus: @escaping () -> Bool, @ViewBuilder content: @escaping (FocusState<Bool>.Binding) -> Content) {
        self.canFocus = canFocus
        self.content = content
    }

    var body: some View {
        content($focused)
            .background(SeedEditorPresentationObserver {
                guard canFocus() else { return }
                focused = true
            }.allowsHitTesting(false).accessibilityHidden(true))
            .onDisappear { focused = false }
    }
}

/// SwiftUI onAppear runs before rendering. UIKit's viewDidAppear waits until
/// the sheet transition finishes, so request focus once at that boundary.
private struct SeedEditorPresentationObserver: UIViewControllerRepresentable {
    var onPresented: () -> Void

    func makeUIViewController(context: Context) -> Controller {
        let controller = Controller()
        controller.onPresented = onPresented
        return controller
    }

    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.onPresented = onPresented
    }

    static func dismantleUIViewController(_ controller: Controller, coordinator: ()) {
        controller.onPresented = nil
    }

    final class Controller: UIViewController {
        var onPresented: (() -> Void)?
        private var didPresent = false

        override func loadView() {
            let view = UIView()
            view.backgroundColor = .clear
            view.isUserInteractionEnabled = false
            view.accessibilityElementsHidden = true
            self.view = view
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard !didPresent, view.window != nil else { return }
            didPresent = true
            onPresented?()
        }
    }
}
