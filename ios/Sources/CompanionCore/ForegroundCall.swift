import Foundation

public struct ForegroundCallTurn: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case starting, working, completed, failed, uncertain, cancelled }
    public let requestId: String
    public let state: State
    public let messageId: String?
    public let reply: String?
    public let error: String?
}

public struct ForegroundCallRecord: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case ringing, connected, ended }
    public let id: String
    public let botId: String
    public let threadId: String
    public let state: State
    public let revision: Int
    public let expiresAt: Double
    public let endReason: String?
    public let turn: ForegroundCallTurn?
}

public protocol ForegroundCallTransport: Sendable {
    func beginCall(botId: String, threadId: String, requestId: String, capability: String) async throws -> ForegroundCallRecord
    func readCall(botId: String, callId: String, capability: String) async throws -> ForegroundCallRecord
    func acceptCall(botId: String, callId: String, capability: String) async throws -> ForegroundCallRecord
    func sendCallMessage(botId: String, callId: String, requestId: String, text: String, capability: String) async throws -> ForegroundCallRecord
    func endCall(botId: String, callId: String, capability: String) async throws -> ForegroundCallRecord
}

/// Foreground-only state. The capability never enters a model, preference or
/// keychain. Failed writes are reconciled by explicit reads, never replayed.
@MainActor
public final class ForegroundCallCoordinator {
    public enum Phase: Equatable, Sendable { case idle, starting, ringing, connected, ending, ended, uncertain }
    public private(set) var phase: Phase = .idle
    public private(set) var call: ForegroundCallRecord?
    public private(set) var notice: String?
    public private(set) var pendingRequestId: String?
    private var sessionId: UUID?
    private var transport: (any ForegroundCallTransport)?
    private var foreground = true
    private var generation = 0
    private var operation = 0
    private var busy = false
    private var endingRequested = false
    public var hasRequestedEnd: Bool { endingRequested }
    private var endTask: Task<Void, Never>?
    public private(set) var canDismissUnknown = false
    private var identity: (bot: String, thread: String, id: String, capability: String)?
    private let changed: @MainActor () -> Void

    /// Ephemeral authorization for explicit calendar actions in this connected call.
    public var calendarScope: CallCalendarScope? {
        guard foreground, phase == .connected, !endingRequested, let identity else { return nil }
        return CallCalendarScope(botId: identity.bot, threadId: identity.thread, callId: identity.id, capability: identity.capability)
    }

    public init(changed: @escaping @MainActor () -> Void = {}) { self.changed = changed }

    public func bind(sessionId: UUID, transport: (any ForegroundCallTransport)?) {
        // Best-effort cleanup uses the OLD transport and capability only.
        if !(endingRequested && busy), let old = identity, let previous = self.transport {
            Task { _ = try? await previous.endCall(botId: old.bot, callId: old.id, capability: old.capability) }
        }
        generation += 1; operation += 1; busy = false
        self.sessionId = sessionId; self.transport = transport
        identity = nil; call = nil; pendingRequestId = nil; notice = nil; endingRequested = false; endTask = nil; canDismissUnknown = false; phase = .idle
        changed()
    }

    /// Synchronous lifecycle fence for scene callbacks; a queued background
    /// task must never end a replacement call after foregrounding or rebinding.
    public func setForegroundImmediately(_ active: Bool) {
        foreground = active
        if !active { _ = startEnding() }
    }

    public func setForeground(_ active: Bool) async {
        setForegroundImmediately(active)
        if !active { await endTask?.value }
    }

    /// A host 404 cannot prove prior work stopped. Explicit local dismissal
    /// releases the lost capability without recreating or replaying anything.
    public func dismissUnknownCall() {
        guard canDismissUnknown, !busy, phase == .uncertain else { return }
        generation += 1; operation += 1
        identity = nil; call = nil; pendingRequestId = nil; endTask = nil
        endingRequested = false; canDismissUnknown = false; phase = .ended
        notice = "Disconnected locally. Previous work may still be running."
        changed()
    }

    public func begin(botId: String, threadId: String) async {
        guard foreground, sessionId != nil, let transport, identity == nil, !busy else { return }
        generation += 1
        let id = UUID().uuidString.lowercased()
        let capability = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max)) }.joined()
        identity = (botId, threadId, id, capability)
        call = nil; endingRequested = false; pendingRequestId = nil
        await perform { try await transport.beginCall(botId: botId, threadId: threadId, requestId: id, capability: capability) }
    }

    public func accept() async {
        guard foreground, phase == .ringing, !endingRequested, let current = identity, let transport else { return }
        await perform { try await transport.acceptCall(botId: current.bot, callId: current.id, capability: current.capability) }
    }

    public func send(_ text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard foreground, phase == .connected, !endingRequested, !busy, pendingRequestId == nil,
              !text.isEmpty, text.utf16.count <= 8000, let current = identity, let transport else { return }
        if let state = call?.turn?.state, [.starting, .working, .uncertain].contains(state) { return }
        let request = UUID().uuidString.lowercased()
        pendingRequestId = request
        await perform { try await transport.sendCallMessage(botId: current.bot, callId: current.id, requestId: request, text: text, capability: current.capability) }
    }

    /// Caller schedules explicit reads only while foreground; no hidden timer
    /// keeps a call alive after suspension or replays an uncertain message.
    public func poll() async {
        guard foreground, !endingRequested, let current = identity, let transport else { return }
        await perform { try await transport.readCall(botId: current.bot, callId: current.id, capability: current.capability) }
    }

    public func endImmediately() { _ = startEnding() }

    public func end() async { await startEnding()?.value }

    private func startEnding() -> Task<Void, Never>? {
        if let endTask { return endTask }
        guard let current = identity, let transport else { return nil }
        // Invalidate a pending begin/accept/send/read before scheduling work.
        generation += 1; operation += 1; busy = false; endingRequested = true
        let version = generation
        phase = .ending; notice = nil; changed()
        let task = Task { @MainActor in
            guard self.generation == version else { return }
            await self.perform(ending: true) {
                try await transport.endCall(botId: current.bot, callId: current.id, capability: current.capability)
            }
            if self.generation == version { self.endTask = nil }
        }
        endTask = task
        return task
    }

    private func perform(ending: Bool = false, _ request: () async throws -> ForegroundCallRecord) async {
        guard !busy, let expected = identity else { return }
        busy = true; operation += 1
        let version = generation; let op = operation
        if call == nil && !ending { phase = .starting }
        notice = nil; changed()
        defer { if generation == version && operation == op { busy = false; changed() } }
        do {
            try Task.checkCancellation()
            let result = try await request()
            try Task.checkCancellation()
            guard generation == version, operation == op else { return }
            guard result.id == expected.id, result.botId == expected.bot, result.threadId == expected.thread,
                  result.revision >= 0, result.expiresAt.isFinite, result.expiresAt > 0,
                  (result.turn?.reply?.utf16.count ?? 0) <= 16000,
                  call?.state != .ended || result.state == .ended,
                  !ending || result.state == .ended else {
                phase = .uncertain; notice = "The call status could not be confirmed. Check again or end the call."; return
            }
            if let previous = call, result.revision < previous.revision { return }
            if call?.state == .connected && result.state == .ringing {
                phase = .uncertain; notice = "The call status changed unexpectedly. Check again or end the call."; return
            }
            if let previous = call, previous.revision == result.revision, previous != result {
                phase = .uncertain; notice = "The call status changed unexpectedly. Check again or end the call."; return
            }
            canDismissUnknown = false
            call = result
            switch result.state {
            case .ringing: phase = .ringing
            case .connected: phase = .connected
            case .ended: phase = .ended; identity = nil; pendingRequestId = nil
            }
            if let pending = pendingRequestId, result.turn?.requestId == pending { pendingRequestId = nil }
        } catch {
            guard generation == version, operation == op else { return }
            phase = .uncertain
            if case APIError.status(code: 404, message: _) = error { canDismissUnknown = true }
            notice = ending ? "Couldn't confirm the call ended. The host may still be working. Try End again."
                : "Couldn't confirm the call status. Check again before sending more work."
        }
    }
}
