import Foundation

public struct ApprovalViewLease: Equatable, Sendable {
    public let id: UUID
    public let context: ComposerContext
}

public enum ApprovalActionPhase: String, Sendable { case pending, failed, settled }

public struct ApprovalActionState: Sendable {
    public let reference: ApprovalReference
    public var phase: ApprovalActionPhase
    public var inFlight: Bool
    public var grantSaved: Bool
    public var outcome: ApprovalOutcome?
    public var message: String?
}

/// Owns live request operations independently of recycled card views. Grant
/// saving and answering are separate receipts within one captured operation.
@MainActor
public final class ApprovalActionCoordinator {
    private final class Request {
        enum Stage { case preparing, grant, response }
        let id = UUID()
        let reference: ApprovalReference
        let action: ApprovalAction
        let lease: ApprovalViewLease
        let transport: any ApprovalTransport
        var stage = Stage.preparing
        var grantSaved = false
        var invalidated = false
        var confirmationEmitted = false
        var task: Task<Void, Never>?
        var timer: Task<Void, Never>?
        init(reference: ApprovalReference, action: ApprovalAction, lease: ApprovalViewLease, transport: any ApprovalTransport) {
            self.reference = reference; self.action = action; self.lease = lease; self.transport = transport
        }
    }

    public private(set) var actions: [ApprovalActionKey: ApprovalActionState] = [:]
    private var requests: [ApprovalActionKey: Request] = [:]
    private var sessionId: UUID?
    private var transport: (any ApprovalTransport)?
    private var view: ApprovalViewLease?
    private var foreground = false
    private let readState: () -> CompanionState
    private let changed: ([ApprovalActionKey: ApprovalActionState]) -> Void
    private let unauthorized: () -> Void
    private let confirmed: (ApprovalReference, ApprovalOutcome) -> Void
    private let timeoutNanoseconds: UInt64
    private let maximumContexts: Int

    public init(readState: @escaping () -> CompanionState,
                changed: @escaping ([ApprovalActionKey: ApprovalActionState]) -> Void,
                unauthorized: @escaping () -> Void = {},
                confirmed: @escaping (ApprovalReference, ApprovalOutcome) -> Void = { _, _ in },
                timeoutNanoseconds: UInt64 = 20_000_000_000,
                maximumContexts: Int = 64) {
        self.readState = readState; self.changed = changed; self.unauthorized = unauthorized
        self.confirmed = confirmed
        self.timeoutNanoseconds = timeoutNanoseconds; self.maximumContexts = max(1, maximumContexts)
    }

    public func bind(sessionId: UUID, transport: (any ApprovalTransport)?) {
        invalidateAll(); self.sessionId = sessionId; self.transport = transport; view = nil
        actions = [:]; changed(actions)
    }
    public func setForeground(_ active: Bool) {
        guard foreground != active else { return }
        foreground = active
        if !active { invalidateAll() }
        changed(actions)
    }
    public func connectionChanged() { invalidateAll() }
    public func enter(_ context: ComposerContext) -> ApprovalViewLease {
        if let previous = view { leave(previous) }
        let lease = ApprovalViewLease(id: UUID(), context: context); view = lease; changed(actions); return lease
    }
    public func leave(_ lease: ApprovalViewLease) {
        guard view == lease else { return }
        view = nil; invalidateAll(); changed(actions)
    }
    public func reconcile() {
        for request in Array(requests.values) where !current(request, pending: request.stage != .response) { invalidate(request) }
    }

    public func reference(for context: ComposerContext, message: Message) -> ApprovalReference? {
        guard context.sessionId == sessionId, transport != nil else { return nil }
        return ApprovalContract.reference(for: context, message: message, in: readState())
    }
    public func actionState(for reference: ApprovalReference) -> ApprovalActionState? {
        guard let state = actionState(for: reference.context, cardId: reference.cardId, requestId: reference.requestId),
              ApprovalContract.exact(state.reference.signature, reference.signature) else { return nil }
        return state
    }
    public func actionState(for context: ComposerContext, cardId: String, requestId: String) -> ApprovalActionState? {
        guard context.sessionId == sessionId,
              let state = actions[ApprovalActionKey(sessionId: context.sessionId, threadId: context.target.threadId, requestId: requestId)],
              state.reference.context == context, state.reference.cardId == cardId,
              ApprovalContract.matches(state.reference, in: readState(), pending: false) else { return nil }
        return state
    }
    public func canAlwaysAllow(_ reference: ApprovalReference) -> Bool { ApprovalContract.canAlwaysAllow(reference) }

    public func canSubmit(_ reference: ApprovalReference, lease: ApprovalViewLease?) -> Bool {
        guard foreground, let lease, view == lease, lease.context == reference.context,
              reference.context.sessionId == sessionId, transport != nil,
              requests[reference.key] == nil, requests.count < maximumContexts,
              ApprovalContract.matches(reference, in: readState(), pending: true) else { return false }
        if let state = actionState(for: reference), state.phase == .settled || state.outcome == .unavailable { return false }
        return actions[reference.key] != nil || actions.count < maximumContexts || actions.keys.contains { requests[$0] == nil }
    }

    /// Call directly from the UI handler, before creating any Task.
    @discardableResult
    public func submit(_ reference: ApprovalReference, action: ApprovalAction, lease: ApprovalViewLease?) -> UUID? {
        guard canSubmit(reference, lease: lease), ApprovalContract.allows(action, reference: reference),
              let lease, let transport else { return nil }
        if actions[reference.key] == nil, actions.count >= maximumContexts,
           let old = actions.keys.first(where: { requests[$0] == nil }) { actions.removeValue(forKey: old) }
        let request = Request(reference: reference, action: action, lease: lease, transport: transport)
        request.grantSaved = actionState(for: reference)?.grantSaved == true
        requests[reference.key] = request
        publish(request, phase: .pending, message: request.grantSaved ? "The preference was saved. Confirming your answer…" : nil)
        request.task = Task { [weak self] in await self?.run(request) }
        return request.id
    }

    private func owns(_ request: Request) -> Bool {
        request.reference.context.sessionId == sessionId && transport != nil && requests[request.reference.key] === request
    }
    private func current(_ request: Request, pending: Bool) -> Bool {
        !request.invalidated && owns(request) && foreground && view == request.lease
            && ApprovalContract.matches(request.reference, in: readState(), pending: pending)
    }
    private func publish(_ request: Request, phase: ApprovalActionPhase, message: String?, outcome: ApprovalOutcome? = nil) {
        guard owns(request) else { return }
        actions[request.reference.key] = ApprovalActionState(reference: request.reference, phase: phase, inFlight: true,
            grantSaved: request.grantSaved, outcome: outcome, message: message)
        changed(actions)
    }
    private func recovery(_ request: Request) -> String {
        switch request.stage {
        case .preparing: return "This action stopped before sending. Check the conversation before choosing again."
        case .grant:
            return request.grantSaved
                ? "The preference was saved. No permission answer was sent. Check the conversation before choosing again."
                : "Couldn't confirm whether the preference was saved. No permission answer was sent. Check the conversation before choosing again."
        case .response:
            let prefix = request.grantSaved ? "The preference was saved. " : ""
            return prefix + "Couldn't confirm the answer. Check the conversation before choosing again."
        }
    }
    private func invalidateAll() { for request in Array(requests.values) { invalidate(request) } }
    private func invalidate(_ request: Request) {
        guard !request.invalidated else { return }
        request.invalidated = true; request.task?.cancel(); request.timer?.cancel()
        publish(request, phase: .failed, message: recovery(request) + " The previous request is still closing.")
    }

    private func run(_ request: Request) async {
        defer { finish(request) }
        guard !Task.isCancelled, current(request, pending: true) else { invalidate(request); return }
        request.timer = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: self?.timeoutNanoseconds ?? 0) } catch { return }
            guard let self, self.requests[request.reference.key] === request else { return }
            self.invalidate(request)
        }
        do {
            if case .alwaysAllow = request.action {
                request.stage = .grant
                let grant = try await request.transport.grantApproval(request.reference)
                guard grant.matches(request.reference) else { throw ApprovalError.invalidReceipt }
                // Even when the card settled during this await, retain the
                // verified partial result; never continue a retired operation.
                guard owns(request) else { return }
                request.grantSaved = true
                guard !Task.isCancelled, current(request, pending: true) else {
                    if request.invalidated { publish(request, phase: .failed, message: recovery(request)) }
                    else { invalidate(request) }
                    return
                }
                publish(request, phase: .pending, message: "The preference was saved. Confirming your answer…")
            }
            guard !Task.isCancelled, current(request, pending: true) else { invalidate(request); return }
            request.stage = .response
            let outcome = try await request.transport.respondToApproval(request.reference, action: request.action)
            guard !Task.isCancelled, current(request, pending: false) else { invalidate(request); return }
            if outcome == .unavailable {
                let prefix = request.grantSaved ? "The preference was saved. " : ""
                publish(request, phase: .failed, message: prefix + (ApprovalError.unavailable.errorDescription ?? ""), outcome: outcome)
            } else {
                let expected: ApprovalOutcome
                switch request.action { case .allow, .alwaysAllow: expected = .allowedOnce; case .deny: expected = .rejected; case .answer: expected = .answered }
                guard outcome == expected else { throw ApprovalError.invalidReceipt }
                let prefix = request.grantSaved ? "The preference was saved. " : ""
                let result = outcome == .allowedOnce ? "Allowed once." : outcome == .rejected ? "Denied." : "Answer delivered."
                publish(request, phase: .settled, message: prefix + result, outcome: outcome)
                // Publication can synchronously retire the session or view.
                // Feedback belongs only to this still-current checked receipt.
                guard !Task.isCancelled, current(request, pending: false), !request.confirmationEmitted else { return }
                request.confirmationEmitted = true
                confirmed(request.reference, outcome)
            }
        } catch {
            guard owns(request) else { return }
            var message = !request.invalidated && (error as? ApprovalError) == .upgradeRequired
                ? error.localizedDescription : recovery(request)
            if !request.invalidated, case let APIError.status(code, detail) = error,
               (400...499).contains(code), let detail, !detail.isEmpty { message += " " + detail }
            publish(request, phase: .failed, message: message)
            if !request.invalidated, !Task.isCancelled, (error as? APIError)?.isUnauthorized == true { unauthorized() }
        }
    }

    private func finish(_ request: Request) {
        request.timer?.cancel(); request.timer = nil; request.task = nil
        guard requests[request.reference.key] === request else { return }
        requests.removeValue(forKey: request.reference.key)
        guard request.reference.context.sessionId == sessionId,
              var state = actions[request.reference.key], state.reference.cardId == request.reference.cardId,
              ApprovalContract.exact(state.reference.signature, request.reference.signature) else { changed(actions); return }
        state.inFlight = false
        if request.invalidated { state.message = recovery(request); state.phase = .failed }
        actions[request.reference.key] = state; changed(actions)
    }
}
