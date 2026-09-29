// The live session model: one account against one identified origin.
//
// Connection is a state machine, not a hope:
//   signedOut → connecting → live → signedOut (with the reason)
// and a degraded live state when the stream is down but the roster API
// still answers. The fleet model folds the same Frame enum the phone
// folds, so a desktop transcript behaves like every other client's.
//
// Sends are optimistic with a durable receipt: the draft leaves the box
// immediately (pending row), and the 202 intent receipt is authoritative.
// A reconnect replays from the last cursor; `resumed == false` re-hydrates
// the roster rather than trusting a partial replay.

import CompanionCore
import Foundation

public enum ConnectionState: Equatable, Sendable {
    case signedOut
    case connecting
    case live
    /// Stream down; roster API still answering.
    case degraded(String)
    case failed(String)
}

public struct PendingSend: Identifiable, Equatable, Sendable {
    public let id: String        // clientIntentId
    public let threadId: String
    public let text: String
    public var state: String     // pending | accepted | unknown
    /// The authoritative id from the 202 receipt; the matching transcript
    /// row (via SSE or roster) retires this row.
    public var messageId: String?
}

// Internal seam for deterministic delayed-response tests. Production always
// creates MusterTransport; callbacks remain bound to one connection lifetime.
protocol NativeSessionTransport: Sendable {
    func roster(messages: Int) async throws -> Fleet
    func memory(botId: String) async throws -> String
    func send(text: String, to botId: String, clientIntentId: String) async throws -> SendReceipt
    func respond(botId: String, requestId: String, behavior: String, message: String?) async throws -> ApprovalOutcome
    func events(lastEventId: String?, onEvent: @escaping @Sendable (StreamFrame) -> Void,
                onHello: @escaping @Sendable (String, Bool) -> Void) async throws
}

extension MusterTransport: NativeSessionTransport {}

@MainActor
public final class LiveSessionModel: ObservableObject {
    // Connection
    @Published public private(set) var state: ConnectionState = .signedOut
    @Published public private(set) var account: HarnessAccount?
    @Published public private(set) var lastCursor: String?
    // Data
    @Published public private(set) var fleet = Fleet(bots: [], groups: [])
    @Published public private(set) var transcripts: [String: [Message]] = [:]
    @Published public private(set) var pendingSends: [PendingSend] = []
    @Published public private(set) var memoryText: [String: String] = [:]
    // Selection
    @Published public var selectedThreadId: String?
    @Published public var draft = ""
    // Appearance
    @Published public var appearance: Appearance = .system

    private var transport: (any NativeSessionTransport)?
    private let makeTransport: @Sendable (HarnessAccount) throws -> any NativeSessionTransport
    private var connectionID = UUID()
    private var bootstrapTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var streamTask: Task<Void, Never>?
    private var reconnectAttempt = 0
    private var lastStreamId: String?
    private var lastSeq: Int?
    private let transcriptPage = 50

    public init() {
        makeTransport = { try MusterTransport(account: $0) }
    }

    init(transportFactory: @escaping @Sendable (HarnessAccount) throws -> any NativeSessionTransport) {
        makeTransport = transportFactory
    }

    private func isCurrent(_ id: UUID) -> Bool {
        connectionID == id && account != nil && transport != nil
    }

    // MARK: - Connection lifecycle

    public func connect(account: HarnessAccount) {
        disconnect()
        self.account = account
        state = .connecting
        guard let transport = try? makeTransport(account) else {
            state = .failed("That address doesn't look right.")
            return
        }
        self.transport = transport
        let id = connectionID
        bootstrapTask = Task { [weak self] in
            await self?.bootstrap(transport: transport, connectionID: id)
        }
    }

    public func disconnect() {
        // Invalidate first: a cancelled operation may already have queued its
        // completion, or an injected transport may ignore cancellation.
        connectionID = UUID()
        bootstrapTask?.cancel()
        bootstrapTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        streamTask?.cancel()
        streamTask = nil
        transport = nil
        account = nil
        lastStreamId = nil
        lastSeq = nil
        lastCursor = nil
        reconnectAttempt = 0
        selectedThreadId = nil
        draft = ""
        fleet = Fleet(bots: [], groups: [])
        transcripts = [:]
        pendingSends = []
        memoryText = [:]
        state = .signedOut
    }

    private func bootstrap(transport: any NativeSessionTransport, connectionID id: UUID) async {
        guard isCurrent(id), !Task.isCancelled else { return }
        do {
            let roster = try await transport.roster(messages: transcriptPage)
            guard isCurrent(id), !Task.isCancelled else { return }
            applyRoster(roster)
            state = .live
            openStream(connectionID: id)
        } catch let error as MusterTransportError {
            guard isCurrent(id), !Task.isCancelled else { return }
            state = .failed(Self.describe(error))
        } catch {
            guard isCurrent(id), !Task.isCancelled else { return }
            state = .failed("Could not reach the server.")
        }
    }

    private static func describe(_ error: MusterTransportError) -> String {
        switch error {
        case .badOrigin: return "That address doesn't look right."
        case .noSession: return "Sign-in returned no session. Nothing was saved."
        case .signInFailed: return "Sign-in failed."
        case .server(401, _): return "Session expired — sign in again."
        case let .server(code, message): return message ?? "The server answered with an error (\(code))."
        case .redirectRefused: return "The server redirected sign-in — refusing."
        case .unreadable: return "The server sent something this app couldn't read."
        }
    }
    // MARK: - Stream

    private func openStream(connectionID id: UUID) {
        guard isCurrent(id), let transport else { return }
        streamTask?.cancel()
        let lastEventId: String?
        if let streamId = lastStreamId, let seq = lastSeq { lastEventId = "\(streamId):\(seq)" } else { lastEventId = nil }
        let onEvent: @Sendable (StreamFrame) -> Void = { [weak self] streamFrame in
            guard let model = self else { return }
            Task { @MainActor in
                guard model.isCurrent(id) else { return }
                model.apply(streamFrame.frame)
            }
        }
        let onHello: @Sendable (String, Bool) -> Void = { [weak self] cursor, resumed in
            guard let model = self else { return }
            Task { @MainActor in
                guard model.isCurrent(id) else { return }
                model.streamOpened(cursor: cursor, resumed: resumed, connectionID: id)
            }
        }
        streamTask = Task { [weak self] in
            do {
                try await transport.events(lastEventId: lastEventId, onEvent: onEvent, onHello: onHello)
                if !Task.isCancelled { self?.streamDropped(connectionID: id) }
            } catch {
                if !Task.isCancelled { self?.streamDropped(connectionID: id) }
            }
        }
    }

    private func streamOpened(cursor: String, resumed: Bool, connectionID id: UUID) {
        guard isCurrent(id) else { return }
        let parts = cursor.split(separator: ":", maxSplits: 1).map(String.init)
        if parts.count == 2 {
            lastStreamId = parts[0]
            lastSeq = Int(parts[1])
        }
        reconnectAttempt = 0
        if state != .live { state = .live }
        if !resumed { Task { await self.rehydrate(connectionID: id) } }
    }

    private func streamDropped(connectionID id: UUID) {
        guard isCurrent(id) else { return }
        switch state {
        case .live, .degraded: break
        default: return
        }
        reconnectAttempt += 1
        let delay = min(pow(2.0, Double(reconnectAttempt)), 30.0)
        state = .degraded("reconnecting in \(Int(delay))s")
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            catch { return }
            guard let self, self.isCurrent(id), !Task.isCancelled else { return }
            self.openStream(connectionID: id)
        }
    }

    private func rehydrate(connectionID id: UUID) async {
        guard isCurrent(id), let transport else { return }
        if let roster = try? await transport.roster(messages: transcriptPage), isCurrent(id), !Task.isCancelled {
            applyRoster(roster)
        }
    }

    // MARK: - Frame folding (same semantics as the web client)

    private func applyRoster(_ roster: Fleet) {
        var next = transcripts
        for bot in roster.bots {
            if let messages = bot.messages { next[bot.threadId] = messages }
        }
        for room in roster.groups {
            if let messages = room.messages { next[room.threadId] = messages }
        }
        fleet = Fleet(bots: roster.bots, groups: roster.groups)
        transcripts = next
        if selectedThreadId == nil {
            selectedThreadId = roster.bots.first?.threadId ?? roster.groups.first?.threadId
        }
        // A roster page carrying a receipt's message retires that pending row.
        let delivered = Set(next.values.flatMap { $0.map(\.id) })
        pendingSends.removeAll { row in
            if let messageId = row.messageId, delivered.contains(messageId) { return true }
            return row.state != "pending" && row.messageId == nil
        }
    }

    private func apply(_ frame: Frame) {
        switch frame {
        case let .message(threadId, message):
            var thread = transcripts[threadId] ?? []
            if !thread.contains(where: { $0.id == message.id }) { thread.append(message) }
            transcripts[threadId] = thread
            // The transcript row carrying a receipt's messageId retires its
            // pending row — the send is now visibly in the conversation.
            if message.role == .user, let pending = pendingSends.first(where: { $0.messageId == message.id }) {
                pendingSends.removeAll { $0.id == pending.id }
            }
        case let .messagePatch(threadId, message):
            var thread = transcripts[threadId] ?? []
            if let index = thread.firstIndex(where: { $0.id == message.id }) {
                thread[index] = message
            } else {
                thread.append(message)
            }
            transcripts[threadId] = thread
        case let .thread(threadId, _):
            // A branch switch: the roster re-page is the honest source for
            // the now-visible branch.
            _ = threadId
            let id = connectionID
            Task { await self.rehydrate(connectionID: id) }
        case let .bot(bot):
            if let index = fleet.bots.firstIndex(where: { $0.id == bot.id }) {
                var updated = fleet.bots
                var merged = bot
                merged.messages = updated[index].messages
                updated[index] = merged
                fleet = Fleet(bots: updated, groups: fleet.groups)
            } else {
                var updated = fleet.bots
                updated.append(bot)
                fleet = Fleet(bots: updated, groups: fleet.groups)
            }
        case let .botDeleted(botId):
            fleet = Fleet(bots: fleet.bots.filter { $0.id != botId }, groups: fleet.groups)
        case let .room(room):
            if let index = fleet.groups.firstIndex(where: { $0.id == room.id }) {
                var updated = fleet.groups
                var merged = room
                merged.messages = updated[index].messages
                updated[index] = merged
                fleet = Fleet(bots: fleet.bots, groups: updated)
            } else {
                var updated = fleet.groups
                updated.append(room)
                fleet = Fleet(bots: fleet.bots, groups: updated)
            }
        case let .roomDeleted(groupId):
            fleet = Fleet(bots: fleet.bots, groups: fleet.groups.filter { $0.id != groupId })
        case .config:
            let id = connectionID
            Task { await self.rehydrate(connectionID: id) }
        default:
            break // screens/runtime/notify handled by later slices
        }
    }

    // MARK: - Sends

    public func sendDraft() async {
        let text = ComposerText.normalized(draft)
        guard !text.isEmpty, let threadId = selectedThreadId,
              let bot = fleet.bots.first(where: { $0.threadId == threadId }) else { return }
        let intentId = UUID().uuidString.lowercased()
        var pending = PendingSend(id: intentId, threadId: threadId, text: text, state: "pending", messageId: nil)
        pendingSends.append(pending)
        draft = ""
        guard let transport else { return }
        let id = connectionID
        do {
            let receipt = try await transport.send(text: text, to: bot.id, clientIntentId: intentId)
            guard isCurrent(id), !Task.isCancelled else { return }
            pending.state = receipt.state
            pending.messageId = receipt.messageId
            replacePending(pending)
            // The message row may have already streamed in while the receipt
            // was in flight; retire immediately if so.
            if (transcripts[threadId] ?? []).contains(where: { $0.id == receipt.messageId }) {
                pendingSends.removeAll { $0.id == pending.id }
            }
        } catch let error as MusterTransportError {
            guard isCurrent(id), !Task.isCancelled else { return }
            pending.state = Self.describe(error)
            replacePending(pending)
        } catch {
            guard isCurrent(id), !Task.isCancelled else { return }
            pending.state = "unknown"
            replacePending(pending)
        }
    }

    private func replacePending(_ pending: PendingSend) {
        if let index = pendingSends.firstIndex(where: { $0.id == pending.id }) {
            pendingSends[index] = pending
        }
    }

    // MARK: - Approvals

    public func respond(botId: String, card: Message, option: String?) async {
        guard let requestId = card.card?.requestId, let option else { return }
        let behavior: String
        let answerText: String?
        switch option.lowercased() {
        case "allow": behavior = "allow"; answerText = nil
        case "deny": behavior = "deny"; answerText = nil
        default: behavior = "answer"; answerText = option
        }
        _ = try? await transport?.respond(botId: botId, requestId: requestId, behavior: behavior, message: answerText)
    }

    // MARK: - Memory

    public func loadMemory(botId: String) async {
        guard let transport else { return }
        let id = connectionID
        if let text = try? await transport.memory(botId: botId), isCurrent(id), !Task.isCancelled {
            memoryText[botId] = text
        }
    }

    // MARK: - Derived

    public var pendingCards: [(bot: Bot, message: Message)] {
        fleet.bots.compactMap { bot in
            guard let message = (transcripts[bot.threadId] ?? []).last(where: { $0.card?.isPending == true && $0.card?.requestId != nil }) else { return nil }
            return (bot, message)
        }
    }
}
