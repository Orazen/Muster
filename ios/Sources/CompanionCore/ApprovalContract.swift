import Foundation

public struct ApprovalActionKey: Hashable, Sendable {
    public let sessionId: UUID
    public let threadId: String
    public let requestId: String
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.sessionId == rhs.sessionId && lhs.threadId == rhs.threadId && ApprovalContract.exact(lhs.requestId, rhs.requestId)
    }
    public func hash(into hasher: inout Hasher) {
        hasher.combine(sessionId); hasher.combine(threadId)
        hasher.combine(requestId.utf16.count)
        for unit in requestId.utf16 { hasher.combine(unit) }
    }
}

public struct ApprovalReference: Sendable {
    public let context: ComposerContext
    public let cardId: String
    public let requestId: String
    public let signature: String
    public let options: [String]
    public let tool: String?
    public let allowKey: String?
    public let speakerId: String?
    public var key: ApprovalActionKey {
        ApprovalActionKey(sessionId: context.sessionId, threadId: context.target.threadId, requestId: requestId)
    }
    public var isPermission: Bool { tool != nil }
}

public enum ApprovalAction: Equatable, Sendable {
    case allow, deny, answer(String), alwaysAllow
    public var behavior: String {
        switch self { case .allow, .alwaysAllow: return "allow"; case .deny: return "deny"; case .answer: return "answer" }
    }
    public var answer: String? { if case let .answer(text) = self { return text }; return nil }
    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.allow, .allow), (.deny, .deny), (.alwaysAllow, .alwaysAllow): return true
        case let (.answer(a), .answer(b)): return ApprovalContract.exact(a, b)
        default: return false
        }
    }
}

public enum ApprovalOutcome: String, Decodable, Sendable {
    case allowedOnce = "allowed-once", rejected, answered, unavailable
}

public enum ApprovalError: Error, LocalizedError, Equatable, Sendable {
    case upgradeRequired, invalidReference, invalidReceipt, unavailable
    public var errorDescription: String? {
        switch self {
        case .upgradeRequired: return "Update Muster on the computer before using Always allow. No permission answer was sent."
        case .invalidReference: return "This request changed. Check the conversation before choosing again."
        case .invalidReceipt: return "The computer did not confirm this action. Check the conversation before choosing again."
        case .unavailable: return "The request is no longer available. This answer was not delivered."
        }
    }
}

/// A checked grant receipt, separate from permission delivery. No state is
/// changed optimistically; the normal stream remains the transcript authority.
public struct ApprovalGrantReceipt: Sendable {
    public let botId: String
    public let threadId: String
    public let requestId: String
    public let cardId: String
    public let allowKey: String

    public init(botId: String, threadId: String, requestId: String, cardId: String, allowKey: String) {
        self.botId = botId; self.threadId = threadId; self.requestId = requestId; self.cardId = cardId; self.allowKey = allowKey
    }

    public func matches(_ reference: ApprovalReference) -> Bool {
        botId == reference.context.target.ownerId && threadId == reference.context.target.threadId
            && ApprovalContract.exact(requestId, reference.requestId) && cardId == reference.cardId
            && reference.allowKey.map { ApprovalContract.exact($0, allowKey) } == true
    }

    static func decode(_ data: Data, reference: ApprovalReference) throws -> Self {
        struct Grant: Decodable { let threadId: String; let requestId: String; let cardId: String; let allowKey: String }
        struct Owner: Decodable { let id: String; let threadId: String; let alwaysAllow: [String] }
        struct Body: Decodable { let bot: Owner; let grant: Grant }
        guard let body = try? JSONDecoder().decode(Body.self, from: data),
              body.bot.threadId == reference.context.target.threadId,
              body.bot.alwaysAllow.contains(where: { ApprovalContract.exact($0, body.grant.allowKey) }) else {
            throw ApprovalError.invalidReceipt
        }
        let result = Self(botId: body.bot.id, threadId: body.grant.threadId, requestId: body.grant.requestId,
            cardId: body.grant.cardId, allowKey: body.grant.allowKey)
        guard result.matches(reference) else { throw ApprovalError.invalidReceipt }
        return result
    }
}

public protocol ApprovalTransport: Sendable {
    func grantApproval(_ reference: ApprovalReference) async throws -> ApprovalGrantReceipt
    func respondToApproval(_ reference: ApprovalReference, action: ApprovalAction) async throws -> ApprovalOutcome
}

public enum ApprovalContract {
    public static func exact(_ lhs: String, _ rhs: String) -> Bool { lhs.utf16.elementsEqual(rhs.utf16) }
    public static func validRequestId(_ value: String) -> Bool {
        value.utf16.count <= 4096 && !ComposerText.normalized(value).isEmpty
    }
    private static func nonblank(_ value: String) -> Bool { !ComposerText.normalized(value).isEmpty }

    private static func literal(_ value: String, _ expected: String) -> Bool {
        // Only ASCII case changes are permitted, not whitespace, synonyms,
        // localization guesses, or Unicode compatibility normalization.
        value.utf8.map { (65...90).contains($0) ? $0 + 32 : $0 }.elementsEqual(expected.utf8)
    }
    public static func isAlwaysAllowOption(_ option: String) -> Bool { literal(option, "always allow") }

    public static func canAlwaysAllow(_ reference: ApprovalReference) -> Bool {
        reference.context.target.kind == .bot && reference.tool.map(nonblank) == true
            && reference.allowKey.map(nonblank) == true
            && reference.options.contains { literal($0, "allow") }
    }

    public static func action(for option: String, reference: ApprovalReference) -> ApprovalAction? {
        guard reference.options.contains(where: { exact($0, option) }) else { return nil }
        if !reference.isPermission { return .answer(option) }
        if literal(option, "allow") { return .allow }
        if literal(option, "deny") { return .deny }
        if isAlwaysAllowOption(option), canAlwaysAllow(reference) { return .alwaysAllow }
        return nil
    }

    public static func allows(_ action: ApprovalAction, reference: ApprovalReference) -> Bool {
        switch action {
        case .alwaysAllow: return canAlwaysAllow(reference)
        case .allow: return reference.isPermission && reference.options.contains { literal($0, "allow") }
        case .deny: return reference.isPermission && reference.options.contains { literal($0, "deny") }
        case let .answer(text): return !reference.isPermission && reference.options.contains { exact($0, text) }
        }
    }

    public static func response(_ data: Data, action: ApprovalAction) throws -> ApprovalOutcome {
        struct Body: Decodable { let ok: Bool; let outcome: ApprovalOutcome }
        guard let body = try? JSONDecoder().decode(Body.self, from: data), body.ok else { throw ApprovalError.invalidReceipt }
        let expected: ApprovalOutcome
        switch action { case .allow, .alwaysAllow: expected = .allowedOnce; case .deny: expected = .rejected; case .answer: expected = .answered }
        guard body.outcome == expected || body.outcome == .unavailable else { throw ApprovalError.invalidReceipt }
        return body.outcome
    }

    private static func signature(_ message: Message) -> String {
        guard let card = message.card else { return "" }
        // Settlement may arrive by SSE before its HTTP receipt. Keep that
        // receipt verifiable without treating the settled card as actionable.
        let fields = [message.id, message.parentId, message.from?.botId, card.requestId, card.tool, card.allowKey,
                      card.title, card.subtitle, card.held, card.purpose] + card.options.map(Optional.some)
        return (try? JSONEncoder().encode(fields).base64EncodedString()) ?? ""
    }

    static func message(for context: ComposerContext, cardId: String, in state: CompanionState, pending: Bool) -> Message? {
        let target = context.target
        guard target.isValid, target.isCurrent(in: state), ComposerTarget.validId(cardId) else { return nil }
        let messages = state.transcript(forThread: target.threadId)
        let candidates = messages.filter { $0.id == cardId }
        guard candidates.count == 1, let message = candidates.first,
              !message.seedContextInvalid, message.role == .bot, message.kind == .options, message.at.isFinite,
              let card = message.card, !card.seedInvalid, card.purpose == nil, card.seedAnswer == nil,
              let requestId = card.requestId, validRequestId(requestId),
              !pending || card.isPending, card.tool.map(nonblank) ?? true else { return nil }
        switch target.kind {
        case .bot:
            guard message.from == nil || message.from?.botId == target.ownerId else { return nil }
            if let leaf = state.bot(target.ownerId)?.activeLeafId {
                let byId = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
                var next: String? = leaf; var visited = Set<String>(); var found = false
                while let id = next {
                    guard visited.insert(id).inserted else { return nil }
                    guard let current = byId[id] else { break }
                    if id == cardId { found = true }
                    next = current.parentId
                }
                guard found else { return nil }
            }
        case .room:
            guard let room = state.rooms.first(where: { $0.id == target.ownerId }),
                  let speaker = message.from?.botId, room.memberIds.contains(speaker), state.bot(speaker) != nil,
                  room.busyBotId == speaker || (!pending && !card.isPending && room.busyBotId == nil) else { return nil }
        }
        return message
    }

    public static func reference(for context: ComposerContext, message supplied: Message, in state: CompanionState) -> ApprovalReference? {
        guard let current = message(for: context, cardId: supplied.id, in: state, pending: true),
              supplied.card?.isPending == true, !supplied.seedContextInvalid, supplied.card?.seedInvalid != true,
              supplied.role == .bot, supplied.kind == .options,
              exact(signature(current), signature(supplied)), let card = current.card, let requestId = card.requestId else { return nil }
        return ApprovalReference(context: context, cardId: current.id, requestId: requestId, signature: signature(current),
            options: card.options, tool: card.tool, allowKey: card.allowKey, speakerId: current.from?.botId)
    }

    static func matches(_ reference: ApprovalReference, in state: CompanionState, pending: Bool) -> Bool {
        guard let current = message(for: reference.context, cardId: reference.cardId, in: state, pending: pending) else { return false }
        return exact(signature(current), reference.signature)
    }
}
