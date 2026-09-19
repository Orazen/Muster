import Foundation

public struct ComposerDraft: Sendable {
    public var text = ""
    public var revision: UInt64 = 0
    public var inFlight = false
    public var message: String?
    public init() {}
}

public struct ComposerViewLease: Equatable, Sendable {
    public let id: UUID
    public let context: ComposerContext
}

/// Drafts belong to the paired session, not a mounted conversation view.
/// Physical requests outlive view leases and keep their slot until the
/// transport actually closes, even if cancellation is ignored.
@MainActor
public final class ComposerCoordinator {
    public static let recoveryMessage = "Couldn't confirm the send. Check the conversation before trying again. Your draft is still here."
    public static let capacityMessage = "There are too many saved drafts. Clear a draft in another conversation before writing here."
    private final class Request {
        let id = UUID()
        let context: ComposerContext
        let lease: ComposerViewLease
        let text: String
        let revision: UInt64
        let transport: any ComposerTransport
        var invalidated = false
        var task: Task<Void, Never>?
        var timer: Task<Void, Never>?
        init(context: ComposerContext, lease: ComposerViewLease, draft: ComposerDraft, transport: any ComposerTransport) {
            self.context = context; self.lease = lease; text = draft.text; revision = draft.revision; self.transport = transport
        }
    }

    public private(set) var drafts: [ComposerContext: ComposerDraft] = [:]
    private var requests: [ComposerContext: Request] = [:]
    private var sessionId: UUID?
    private var transport: (any ComposerTransport)?
    private var view: ComposerViewLease?
    private var foreground = false
    private let readState: () -> CompanionState
    private let changed: ([ComposerContext: ComposerDraft]) -> Void
    private let unauthorized: () -> Void
    private let maximumContexts: Int
    private let timeoutNanoseconds: UInt64

    public init(readState: @escaping () -> CompanionState,
                changed: @escaping ([ComposerContext: ComposerDraft]) -> Void,
                unauthorized: @escaping () -> Void = {}, maximumContexts: Int = 64,
                timeoutNanoseconds: UInt64 = 20_000_000_000) {
        self.readState = readState; self.changed = changed; self.unauthorized = unauthorized
        self.maximumContexts = max(1, maximumContexts); self.timeoutNanoseconds = timeoutNanoseconds
    }

    public func bind(sessionId: UUID, transport: (any ComposerTransport)?) {
        for request in Array(requests.values) { invalidate(request) }
        self.sessionId = sessionId; self.transport = transport; view = nil
        drafts = [:]; changed(drafts)
    }

    public func setForeground(_ active: Bool) {
        guard foreground != active else { return }
        foreground = active
        if !active { for request in Array(requests.values) { invalidate(request) } }
        changed(drafts)
    }

    public func enter(_ context: ComposerContext) -> ComposerViewLease {
        if let previous = view { leave(previous) }
        let lease = ComposerViewLease(id: UUID(), context: context)
        view = lease
        return lease
    }

    public func leave(_ lease: ComposerViewLease) {
        guard view == lease else { return }
        view = nil
        if let request = requests[lease.context] { invalidate(request) }
    }

    public func reconcile() {
        for request in Array(requests.values) where !owns(request.context) { invalidate(request) }
    }

    /// Retire sends when the connection stops being live without discarding
    /// this session's drafts or releasing a transport that is still closing.
    public func connectionChanged() {
        for request in Array(requests.values) { invalidate(request) }
    }

    public func draft(for context: ComposerContext) -> ComposerDraft {
        guard context.sessionId == sessionId else { return ComposerDraft() }
        var draft = drafts[context] ?? ComposerDraft()
        if drafts[context] == nil && !hasRoom { draft.message = Self.capacityMessage }
        else if requests.count >= maximumContexts && requests[context] == nil {
            draft.message = "Previous requests are still closing. Your draft is still here."
        }
        return draft
    }

    private var hasRoom: Bool {
        drafts.count < maximumContexts || drafts.contains { $0.value.text.isEmpty && requests[$0.key] == nil }
    }

    public func canEdit(_ context: ComposerContext, lease: ComposerViewLease?) -> Bool {
        // System text editors may make the scene inactive while returning a
        // local draft. Sending still requires foreground below.
        view == lease && lease?.context == context && owns(context) && (drafts[context] != nil || hasRoom)
    }

    public func canSend(_ context: ComposerContext, lease: ComposerViewLease?) -> Bool {
        foreground && canEdit(context, lease: lease) && requests[context] == nil && requests.count < maximumContexts
            && !ComposerText.normalized(draft(for: context).text).isEmpty
    }

    public func edit(_ text: String, context: ComposerContext, lease: ComposerViewLease?) {
        guard canEdit(context, lease: lease) else { return }
        if drafts[context] == nil, drafts.count >= maximumContexts,
           let empty = drafts.first(where: { $0.value.text.isEmpty && requests[$0.key] == nil })?.key {
            drafts.removeValue(forKey: empty)
        }
        var draft = drafts[context] ?? ComposerDraft()
        draft.text = text
        // Swift's canonical String equality must never erase an edit event,
        // including editing away and back to identical UTF-16 text.
        draft.revision &+= 1
        drafts[context] = draft; changed(drafts)
    }

    /// Called directly by the button/Return handler: acquire the lock before
    /// creating a Task, capturing both the original target and its client.
    @discardableResult
    public func submit(_ context: ComposerContext, lease: ComposerViewLease?) -> UUID? {
        guard canSend(context, lease: lease), let lease, let transport, var draft = drafts[context] else { return nil }
        let request = Request(context: context, lease: lease, draft: draft, transport: transport)
        requests[context] = request
        draft.inFlight = true; draft.message = nil
        drafts[context] = draft; changed(drafts)
        request.task = Task { [weak self] in await self?.run(request) }
        return request.id
    }

    private func owns(_ context: ComposerContext) -> Bool {
        context.sessionId == sessionId && transport != nil && context.target.isValid && context.target.isCurrent(in: readState())
    }

    private func invalidate(_ request: Request) {
        guard !request.invalidated else { return }
        request.invalidated = true; request.task?.cancel(); request.timer?.cancel()
        if request.context.sessionId == sessionId, var draft = drafts[request.context] {
            draft.message = Self.recoveryMessage + " The previous request is still closing."
            drafts[request.context] = draft; changed(drafts)
        }
    }

    private func run(_ request: Request) async {
        defer { finish(request) }
        guard !Task.isCancelled, !request.invalidated, foreground, view == request.lease, owns(request.context) else {
            invalidate(request); return
        }
        request.timer = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: self?.timeoutNanoseconds ?? 0) } catch { return }
            guard let self, self.requests[request.context] === request else { return }
            self.invalidate(request)
        }
        do {
            let acknowledgment = try await request.transport.sendOrdinary(text: request.text, to: request.context.target)
            guard !request.invalidated, !Task.isCancelled, owns(request.context) else { invalidate(request); return }
            guard acknowledgment.threadId == request.context.target.threadId else {
                throw APIError.transport("The send acknowledgment named another conversation.")
            }
            guard var draft = drafts[request.context] else { return }
            if draft.revision == request.revision { draft.text = ""; draft.revision &+= 1 }
            draft.message = nil
            drafts[request.context] = draft; changed(drafts)
        } catch {
            guard request.context.sessionId == sessionId, var draft = drafts[request.context] else { return }
            draft.message = error is ComposerSendError ? error.localizedDescription : Self.recoveryMessage
            drafts[request.context] = draft; changed(drafts)
            if !request.invalidated, !Task.isCancelled, (error as? APIError)?.isUnauthorized == true { unauthorized() }
        }
    }

    private func finish(_ request: Request) {
        request.timer?.cancel(); request.timer = nil; request.task = nil
        guard requests[request.context] === request else { return }
        requests.removeValue(forKey: request.context)
        guard request.context.sessionId == sessionId, var draft = drafts[request.context] else { changed(drafts); return }
        draft.inFlight = false
        if request.invalidated { draft.message = Self.recoveryMessage }
        drafts[request.context] = draft; changed(drafts)
    }
}
