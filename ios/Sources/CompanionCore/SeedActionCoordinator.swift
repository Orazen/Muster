import Foundation

/// A cold-stream snapshot may race an accepted welcome answer. Its revision
/// check and adoption run together on the main actor; stale reads must be
/// replaced before the caller may commit the hello cursor.
public enum SeedSnapshotRefresh {
    @MainActor public static func hydrate(
        read: () async throws -> Fleet,
        revision: () -> UInt64,
        current: () -> Bool,
        apply: (Fleet) -> Void,
        retryDelayNanoseconds: UInt64 = 250_000_000
    ) async throws {
        for attempt in 0..<3 {
            guard current(), !Task.isCancelled else { throw CancellationError() }
            let before = revision()
            let fleet = try await read()
            guard current(), !Task.isCancelled else { throw CancellationError() }
            if revision() == before { apply(fleet); return }
            if attempt < 2 { try await Task.sleep(nanoseconds: retryDelayNanoseconds * UInt64(attempt + 1)) }
        }
        throw APIError.transport("The conversation changed while refreshing. Reconnect to confirm its latest state.")
    }
}

public protocol SeedCardTransport: Sendable {
    func answerSeedCard(botId: String, cardId: String, threadId: String, answer: String) async throws -> SeedCardResult
    func seedCardStatus(botId: String, cardId: String, threadId: String) async throws -> SeedCardResult
    func startSeedCard(botId: String, cardId: String, threadId: String, expectedAttempt: Int) async throws -> SeedCardResult
}

public struct SeedActionKey: Hashable, Sendable {
    public let sessionId: UUID
    public let botId: String
    public let threadId: String
    public let cardId: String
}

public struct SeedReference: Hashable, Sendable {
    public let sessionId: UUID
    public let botId: String
    public let threadId: String
    public let cardId: String
    public let signature: String
    public var key: SeedActionKey { SeedActionKey(sessionId: sessionId, botId: botId, threadId: threadId, cardId: cardId) }
}

public enum SeedAction: Sendable {
    case answer(String), check, start
    public var operation: SeedOperation { switch self { case .answer: return .answer; case .check: return .check; case .start: return .start } }
}
public enum SeedOperation: String, Sendable { case answer, check, start }
public enum SeedActionPhase: String, Sendable { case pending, failed, settled }
public struct SeedActionState: Sendable {
    public let reference: SeedReference
    public var operation: SeedOperation
    public var phase: SeedActionPhase
    public var inFlight: Bool
    public var message: String?
    public var lastAnswer: String?
}

/// Only durable welcome answers use this ledger. Live engine requests keep
/// their separate request-ID contract, including the Watch's pending list.
@MainActor
public final class SeedActionCoordinator {
    private struct ViewLease {
        let id: UUID
        let botId: String
        let threadId: String
    }
    @MainActor private final class Request {
        let reference: SeedReference
        let action: SeedAction
        let viewId: UUID
        let focus: UInt64
        let branchAnchor: String?
        var invalidated = false
        var timedOut = false
        var released = false
        var task: Task<Void, Never>?
        var timer: Task<Void, Never>?
        var waiter: CheckedContinuation<Void, Never>?
        init(reference: SeedReference, action: SeedAction, viewId: UUID, focus: UInt64, branchAnchor: String?) {
            self.reference = reference; self.action = action; self.viewId = viewId; self.focus = focus
            self.branchAnchor = branchAnchor
        }
    }

    private var sessionId: UUID?
    private var transport: (any SeedCardTransport)?
    private var foreground = false
    private var focus: UInt64 = 0
    private var view: ViewLease?
    private var requests: [SeedActionKey: Request] = [:]
    public private(set) var actions: [SeedActionKey: SeedActionState] = [:]
    private let readState: () -> CompanionState
    private let writeState: (CompanionState) -> Void
    private let changed: ([SeedActionKey: SeedActionState]) -> Void
    private let unauthorized: () -> Void
    private let timeoutNanoseconds: UInt64

    public init(
        readState: @escaping () -> CompanionState,
        writeState: @escaping (CompanionState) -> Void,
        changed: @escaping ([SeedActionKey: SeedActionState]) -> Void,
        unauthorized: @escaping () -> Void = {},
        timeoutNanoseconds: UInt64 = 10_000_000_000
    ) {
        self.readState = readState; self.writeState = writeState; self.changed = changed
        self.unauthorized = unauthorized; self.timeoutNanoseconds = timeoutNanoseconds
    }

    public func bind(sessionId: UUID, transport: (any SeedCardTransport)?) {
        invalidateRequests()
        self.sessionId = sessionId; self.transport = transport; view = nil
        actions = [:]; changed(actions)
    }

    public func setForeground(_ value: Bool) {
        guard foreground != value else { return }
        foreground = value; focus &+= 1; invalidateRequests()
    }

    /// A reconnect invalidates old callbacks without changing draft identity.
    public func connectionChanged() { invalidateRequests() }

    public func viewConversation(botId: String, threadId: String) -> UUID {
        invalidateRequests()
        let lease = ViewLease(id: UUID(), botId: botId, threadId: threadId)
        view = lease
        return lease.id
    }

    public func leaveConversation(_ lease: UUID) {
        guard view?.id == lease else { return }
        invalidateRequests(); view = nil
    }

    public func reference(botId: String, threadId: String, cardId: String) -> SeedReference? {
        guard let sessionId, transport != nil,
              let card = readState().seedCard(botId: botId, threadId: threadId, cardId: cardId) else { return nil }
        return SeedReference(sessionId: sessionId, botId: botId, threadId: threadId, cardId: cardId, signature: SeedCardContract.signature(card))
    }

    public func reconcile() {
        for request in Array(requests.values) where !current(request) { invalidate(request) }
    }

    private func card(_ reference: SeedReference) -> Message? {
        guard reference.sessionId == sessionId, transport != nil,
              let card = readState().seedCard(botId: reference.botId, threadId: reference.threadId, cardId: reference.cardId),
              SeedCardContract.exactText(SeedCardContract.signature(card), reference.signature) else { return nil }
        return card
    }

    private func current(_ request: Request) -> Bool {
        let reference = request.reference
        return !request.invalidated && foreground && focus == request.focus
            && requests[reference.key] === request && view?.id == request.viewId
            && view?.botId == reference.botId && view?.threadId == reference.threadId && card(reference) != nil
            && (request.branchAnchor.map { anchor in readState().visibleTranscript(forThread: reference.threadId).contains { $0.id == anchor } } ?? true)
    }

    private func publish(_ request: Request, phase: SeedActionPhase, message: String?, inFlight: Bool) {
        guard current(request) else { return }
        let previous = actions[request.reference.key]
        let answer: String?
        if case let .answer(text) = request.action { answer = text }
        else if let previous, SeedCardContract.exactText(previous.reference.signature, request.reference.signature) { answer = previous.lastAnswer }
        else { answer = nil }
        actions[request.reference.key] = SeedActionState(reference: request.reference, operation: request.action.operation,
            phase: phase, inFlight: inFlight, message: message, lastAnswer: answer)
        changed(actions)
    }

    private func releaseWaiter(_ request: Request) {
        guard !request.released else { return }
        request.released = true; request.waiter?.resume(); request.waiter = nil
    }

    private func invalidateRequests() { for request in Array(requests.values) { invalidate(request) } }

    private func invalidate(_ request: Request) {
        request.invalidated = true; request.task?.cancel(); request.timer?.cancel()
        if let entry = actions[request.reference.key], entry.phase == .pending {
            var next = entry; next.phase = .failed; next.inFlight = true
            next.message = "The previous request is still closing. Check status after it finishes."
            actions[request.reference.key] = next; changed(actions)
        }
        releaseWaiter(request)
    }

    private func finish(_ request: Request) {
        request.timer?.cancel(); request.timer = nil; request.task = nil
        if requests[request.reference.key] === request { requests.removeValue(forKey: request.reference.key) }
        if var entry = actions[request.reference.key], SeedCardContract.exactText(entry.reference.signature, request.reference.signature) {
            entry.inFlight = false
            if request.invalidated && entry.phase == .pending { actions.removeValue(forKey: request.reference.key) }
            else { actions[request.reference.key] = entry }
            changed(actions)
        }
        releaseWaiter(request)
    }

    public func act(_ reference: SeedReference, action: SeedAction) async {
        guard !Task.isCancelled, foreground, let transport, let view, view.botId == reference.botId, view.threadId == reference.threadId,
              requests[reference.key] == nil, let initial = card(reference), let initialCard = initial.card else { return }
        let request = Request(reference: reference, action: action, viewId: view.id, focus: focus,
            branchAnchor: readState().visibleTranscript(forThread: reference.threadId).last?.id)
        requests[reference.key] = request
        let receipt = initialCard.seedAnswer
        let failure: String?
        switch action {
        case let .answer(text):
            if !SeedCardContract.isValidAnswer(text) { failure = "Enter a nonblank answer of up to 4,000 characters." }
            else if let saved = initialCard.answered, !SeedCardContract.exactText(saved, text) {
                failure = "This question already has a saved answer. Check its status before continuing."
            } else { failure = readState().seedWriteBlocker(botId: reference.botId, threadId: reference.threadId, cardId: reference.cardId) }
        case .start:
            if receipt?.status != .recorded && receipt?.status != .notStarted {
                failure = "This saved task cannot be started again. Check status and review the conversation."
            } else { failure = readState().seedWriteBlocker(botId: reference.botId, threadId: reference.threadId, cardId: reference.cardId) }
        case .check: failure = nil
        }
        if let failure { publish(request, phase: .failed, message: failure, inFlight: false); finish(request); return }
        publish(request, phase: .pending, message: nil, inFlight: true)
        guard current(request) else { finish(request); return }
        if action.operation != .check {
            if let blocked = readState().seedWriteBlocker(botId: reference.botId, threadId: reference.threadId, cardId: reference.cardId) {
                publish(request, phase: .failed, message: blocked, inFlight: false); finish(request); return
            }
            if action.operation == .start, card(reference)?.card?.seedAnswer != receipt {
                publish(request, phase: .failed, message: "The saved task changed. Check its status before starting it.", inFlight: false)
                finish(request); return
            }
        }
        await withCheckedContinuation { waiter in
            request.waiter = waiter
            request.timer = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: self?.timeoutNanoseconds ?? 10_000_000_000) }
                catch { return }
                guard let self, self.current(request) else { return }
                request.timedOut = true; request.task?.cancel()
                self.publish(request, phase: .failed, message: "The request timed out. Check the saved status after the previous request closes.", inFlight: true)
                self.releaseWaiter(request)
            }
            request.task = Task { [weak self] in
                guard let self else { return }
                defer { self.finish(request) }
                do {
                    guard self.current(request), !request.timedOut, !Task.isCancelled else { return }
                    let result: SeedCardResult
                    switch action {
                    case let .answer(text): result = try await transport.answerSeedCard(botId: reference.botId, cardId: reference.cardId, threadId: reference.threadId, answer: text)
                    case .check: result = try await transport.seedCardStatus(botId: reference.botId, cardId: reference.cardId, threadId: reference.threadId)
                    case .start: result = try await transport.startSeedCard(botId: reference.botId, cardId: reference.cardId, threadId: reference.threadId, expectedAttempt: receipt!.attempt)
                    }
                    guard self.current(request), !request.timedOut, let latest = self.card(reference), SeedCardContract.matches(latest, result) else {
                        if self.current(request), !request.timedOut { self.publish(request, phase: .failed, message: "The saved answer could not be matched to this conversation. Check its status.", inFlight: false) }
                        return
                    }
                    guard action.operation == .check || (result.outcome != nil && result.cardMessage.card?.seedAnswer != nil && result.userMessage != nil) else {
                        throw APIError.transport("The computer returned an unrecognized saved-answer receipt.")
                    }
                    if case let .answer(text) = action, !SeedCardContract.exactText(result.userMessage?.text ?? "", text) {
                        throw APIError.transport("The computer returned a different saved answer.")
                    }
                    if case .start = action, result.userMessage?.id != receipt?.messageId {
                        throw APIError.transport("The saved task receipt changed.")
                    }
                    var state = self.readState()
                    guard state.mergeSeedAnswer(botId: reference.botId, threadId: reference.threadId, cardId: reference.cardId, result: result) == .accepted else {
                        throw APIError.transport("The saved answer could not be matched to this conversation.")
                    }
                    self.writeState(state)
                    self.publish(request, phase: .settled, message: nil, inFlight: false)
                } catch {
                    guard self.current(request), !request.timedOut else { return }
                    if let api = error as? APIError, api.isUnauthorized {
                        self.publish(request, phase: .failed, message: api.localizedDescription, inFlight: false)
                        self.unauthorized(); return
                    }
                    let definite: Bool
                    if case let APIError.status(code, _) = error { definite = (400..<500).contains(code) && code != 408 }
                    else { definite = false }
                    let message = action.operation == .check
                        ? "Could not check the saved status. \(error.localizedDescription) Try checking again."
                        : definite ? "The request was not accepted. \(error.localizedDescription)"
                            : "Could not confirm the request response. Check the saved status before trying again."
                    self.publish(request, phase: .failed, message: message, inFlight: false)
                }
            }
        }
    }
}
