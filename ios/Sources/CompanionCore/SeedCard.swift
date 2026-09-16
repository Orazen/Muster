import Foundation

public enum SeedAnswerStatus: String, Codable, Hashable, Sendable {
    case recorded, starting, started, uncertain
    case notStarted = "not-started"
}

public struct SeedAnswerReceipt: Codable, Hashable, Sendable {
    public var messageId: String
    public var attempt: Int
    public var status: SeedAnswerStatus
    public var error: String?

    public init(messageId: String, attempt: Int, status: SeedAnswerStatus, error: String? = nil) {
        self.messageId = messageId; self.attempt = attempt; self.status = status; self.error = error
    }
    public var isValid: Bool {
        !messageId.isEmpty && (0...SeedCardContract.maximumAttempt).contains(attempt)
            && (status == .recorded ? attempt == 0 : attempt > 0)
    }
    private enum CodingKeys: String, CodingKey { case messageId, attempt, status, error }
    public init(from decoder: Decoder) throws {
        let raw = try decoder.container(keyedBy: SeedJSONKey.self)
        guard Set(raw.allKeys.map(\.stringValue)).isSubset(of: ["messageId", "attempt", "status", "error"]) else {
            throw SeedCardContract.invalid(decoder, "Unknown welcome receipt field")
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messageId = try c.decode(String.self, forKey: .messageId)
        attempt = try c.decode(Int.self, forKey: .attempt)
        status = try c.decode(SeedAnswerStatus.self, forKey: .status)
        error = c.contains(.error) ? try c.decode(String.self, forKey: .error) : nil
        guard isValid else { throw SeedCardContract.invalid(decoder, "Invalid welcome receipt") }
    }
}

private struct SeedJSONKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

public struct SeedCardResult: Decodable, Sendable {
    public var ok: Bool
    public var outcome: String?
    public var cardMessage: Message
    public var userMessage: Message?

    public init(ok: Bool = true, outcome: String? = nil, cardMessage: Message, userMessage: Message?) {
        self.ok = ok; self.outcome = outcome; self.cardMessage = cardMessage; self.userMessage = userMessage
    }
    private enum CodingKeys: String, CodingKey { case ok, outcome, cardMessage, userMessage }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decode(Bool.self, forKey: .ok)
        outcome = c.contains(.outcome) ? try c.decode(String.self, forKey: .outcome) : nil
        cardMessage = try c.decode(Message.self, forKey: .cardMessage)
        // Missing userMessage differs from an explicitly unanswered status.
        guard c.contains(.userMessage) else { throw SeedCardContract.invalid(decoder, "Missing welcome user message") }
        userMessage = try c.decodeIfPresent(Message.self, forKey: .userMessage)
        let rawMessage = try c.nestedContainer(keyedBy: SeedJSONKey.self, forKey: .cardMessage)
        let rawCard = try rawMessage.nestedContainer(keyedBy: SeedJSONKey.self, forKey: SeedJSONKey(stringValue: "card")!)
        let answered = SeedJSONKey(stringValue: "answered")!
        if rawCard.contains(answered) { _ = try rawCard.decode(String.self, forKey: answered) }
        guard isValid else { throw SeedCardContract.invalid(decoder, "Invalid welcome answer response") }
    }

    public var isValid: Bool {
        guard ok, outcome == nil || ["recorded", "already-recorded", "starting", "already-requested"].contains(outcome!),
              SeedCardContract.canonical(cardMessage), let card = cardMessage.card,
              card.purpose == nil || card.purpose == SeedCardContract.purpose, card.dismissed != true else { return false }
        guard let receipt = card.seedAnswer else { return outcome == nil && userMessage == nil && card.answered == nil }
        guard receipt.isValid, let echo = userMessage, !echo.seedContextInvalid, echo.role == .user,
              echo.kind == .text, echo.from == nil, echo.at.isFinite, !echo.id.isEmpty,
              echo.id != cardMessage.id, echo.id == receipt.messageId,
              let text = echo.text, SeedCardContract.isValidAnswer(text), let answer = card.answered,
              SeedCardContract.exactText(text, answer) else { return false }
        return true
    }
}

public enum SeedMergeOutcome: Equatable, Sendable { case accepted, rejected }

public enum SeedCardContract {
    public static let purpose = "onboarding-v1"
    public static let title = "What do you mostly want help with?"
    public static let subtitle = "Pick whatever's closest; we can always expand from there."
    public static let options = ["Work & projects", "Writing & research", "Life admin", "A bit of everything"]
    // The server's attempt counter is a JS number, so the valid domain ends
    // at 2^53−1. The watchOS simulator is arm64_32, where Int.max is smaller
    // than that — and smaller than any attempt count that can ever exist —
    // so the clamp is semantically identical: "no real attempt reaches this".
    public static let maximumAttempt: Int = Int(min(Double(Int.max), 9_007_199_254_740_991))

    public static func exactText(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf16.elementsEqual(rhs.utf16)
    }
    public static func isValidAnswer(_ text: String) -> Bool {
        // ECMAScript trim's WhiteSpace + LineTerminator set, including BOM.
        text.utf16.count <= 4000 && text.unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x0009...0x000D, 0x0020, 0x00A0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return false
            default: return true
            }
        }
    }
    static func invalid(_ decoder: Decoder, _ description: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: description))
    }
    static func canonical(_ message: Message) -> Bool {
        guard !message.seedContextInvalid, !message.id.isEmpty, message.at.isFinite,
              message.role == .bot, message.kind == .options, message.from == nil,
              let card = message.card, !card.seedInvalid, card.requestId == nil, card.tool == nil,
              card.held == nil, card.allowKey == nil,
              exactText(card.title, title), exactText(card.subtitle, subtitle), card.options.count == options.count else { return false }
        return zip(card.options, options).allSatisfy { exactText($0, $1) }
    }
    public static func isRecognized(_ message: Message, in messages: [Message]) -> Bool {
        guard canonical(message), let card = message.card, card.dismissed != true,
              card.answered == nil || card.seedAnswer != nil else { return false }
        if let receipt = card.seedAnswer {
            guard receipt.isValid, let answer = card.answered, isValidAnswer(answer) else { return false }
        }
        if card.purpose == purpose { return true }
        guard card.purpose == nil, messages.count > 1, messages[1].id == message.id else { return false }
        let greeting = messages[0]
        guard !greeting.seedContextInvalid, greeting.role == .bot, greeting.kind == .text,
              greeting.from == nil, greeting.parentId == nil, message.parentId == greeting.id,
              let text = greeting.text else { return false }
        let prefix = "Hey — I'm ", suffix = ". Nice to meet you."
        guard text.hasPrefix(prefix), text.hasSuffix(suffix) else { return false }
        let name = text.dropFirst(prefix.count).dropLast(suffix.count)
        return !name.isEmpty && !name.unicodeScalars.contains { [10, 13, 0x2028, 0x2029].contains(Int($0.value)) }
    }
    public static func signature(_ message: Message) -> String {
        // JSON bytes encode canonically distinct Unicode without Swift's String equality collapsing it.
        let fields: [String?] = [message.id, message.parentId, message.card?.title, message.card?.subtitle]
            + (message.card?.options.map(Optional.some) ?? [])
        return ((try? JSONEncoder().encode(fields)) ?? Data()).base64EncodedString()
    }
    public static func matches(_ current: Message, _ result: SeedCardResult) -> Bool {
        result.isValid && current.id == result.cardMessage.id && signature(current) == signature(result.cardMessage)
    }
    private static func progress(_ receipt: SeedAnswerReceipt) -> Int {
        receipt.status == .recorded ? 0 : receipt.status == .starting ? 1 : 2
    }
    static func preserveReceipt(_ current: Message, _ incoming: Message) -> Message {
        guard canonical(current), let before = current.card?.seedAnswer, before.isValid else { return incoming }
        guard canonical(incoming), signature(current) == signature(incoming), let after = incoming.card?.seedAnswer,
              after.isValid, after.messageId == before.messageId,
              let oldAnswer = current.card?.answered, let newAnswer = incoming.card?.answered, exactText(oldAnswer, newAnswer),
              after.attempt >= before.attempt else { return current }
        if after.attempt == before.attempt && (progress(after) < progress(before)
            || progress(before) == 2 && after.status != before.status) { return current }
        return incoming
    }
}

extension CompanionState {
    /// Unlike display fallbacks, an unknown leaf or cycle never authorizes an action.
    func seedActivePath(_ threadId: String) -> [Message] {
        let all = transcript(forThread: threadId)
        guard let leaf = bot(forThread: threadId)?.activeLeafId ?? all.last?.id else { return [] }
        let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        guard var current = byId[leaf] else { return [] }
        var path: [Message] = [], seen = Set<String>()
        while true {
            guard seen.insert(current.id).inserted else { return [] }
            path.append(current)
            guard let parentId = current.parentId, let parent = byId[parentId] else { break }
            current = parent
        }
        return path.reversed()
    }
    public func seedCard(botId: String, threadId: String, cardId: String) -> Message? {
        guard let bot = bot(botId), bot.hidden != true, bot.threadId == threadId,
              room(forThread: threadId) == nil,
              let card = seedActivePath(threadId).first(where: { $0.id == cardId }),
              SeedCardContract.isRecognized(card, in: transcript(forThread: threadId)) else { return nil }
        return card
    }
    public func seedWriteBlocker(botId: String, threadId: String, cardId: String) -> String? {
        guard let message = seedCard(botId: botId, threadId: threadId, cardId: cardId), let card = message.card else {
            return "Open the current bot conversation to answer this question."
        }
        if bot(botId)?.busy == true { return "This bot is working. Wait for it to finish before starting this saved task." }
        let path = seedActivePath(threadId)
        guard let anchor = path.firstIndex(where: { $0.id == (card.seedAnswer?.messageId ?? cardId) }) else {
            return "The saved answer is not on this branch. Check status to confirm its record."
        }
        if card.seedAnswer != nil {
            let echo = path[anchor]
            guard echo.role == .user, echo.kind == .text, let text = echo.text, let answer = card.answered,
                  SeedCardContract.exactText(text, answer) else { return "The saved answer could not be confirmed. Check status before starting it." }
        }
        if path.dropFirst(anchor + 1).contains(where: { $0.role == .user }) {
            return "This conversation contains newer work. This earlier question can no longer start a task."
        }
        return nil
    }
    public func unresolvedSeedAnswerUser(threadId: String, messageId: String) -> Bool {
        transcript(forThread: threadId).contains { message in
            guard SeedCardContract.isRecognized(message, in: transcript(forThread: threadId)),
                  let receipt = message.card?.seedAnswer else { return false }
            return receipt.messageId == messageId && receipt.status != .started
        }
    }
    public mutating func mergeSeedAnswer(botId: String, threadId: String, cardId: String, result: SeedCardResult) -> SeedMergeOutcome {
        guard let current = seedCard(botId: botId, threadId: threadId, cardId: cardId),
              SeedCardContract.matches(current, result) else { return .rejected }
        var all = transcript(forThread: threadId)
        let path = seedActivePath(threadId)
        guard let cardIndex = path.firstIndex(where: { $0.id == cardId }) else { return .rejected }
        let echo = result.userMessage
        let existing = echo.flatMap { incoming in all.first { $0.id == incoming.id } }
        if let echo {
            guard let parent = echo.parentId, let parentIndex = path.firstIndex(where: { $0.id == parent }), parentIndex >= cardIndex else { return .rejected }
            if existing == nil && echo.parentId != path.last?.id { return .rejected }
            if let existing {
                guard !existing.seedContextInvalid, existing.role == .user, existing.kind == .text, existing.from == nil,
                      let text = existing.text, let incomingText = echo.text, SeedCardContract.exactText(text, incomingText),
                      existing.parentId == echo.parentId, let index = path.firstIndex(where: { $0.id == echo.id }), index > cardIndex else { return .rejected }
            }
        }
        let selected = SeedCardContract.preserveReceipt(current, result.cardMessage)
        // A newer local receipt may win, but only for the same exact saved answer and echo.
        if let before = current.card?.seedAnswer {
            guard let after = result.cardMessage.card?.seedAnswer, before.messageId == after.messageId,
                  let text = current.card?.answered, let incomingText = result.cardMessage.card?.answered,
                  SeedCardContract.exactText(text, incomingText) else { return .rejected }
            let beforeTerminal = before.status != .recorded && before.status != .starting
            let afterTerminal = after.status != .recorded && after.status != .starting
            if before.attempt == after.attempt && beforeTerminal && afterTerminal && before.status != after.status { return .rejected }
        }
        guard let index = all.firstIndex(where: { $0.id == cardId }), let card = selected.card else { return .rejected }
        all[index].card?.purpose = card.purpose ?? current.card?.purpose
        all[index].card?.answered = card.answered
        all[index].card?.seedAnswer = card.seedAnswer
        if let echo, existing == nil {
            all.append(echo)
            if echo.parentId == path.last?.id, let botIndex = bots.firstIndex(where: { $0.id == botId }) {
                bots[botIndex].activeLeafId = echo.id
            }
        }
        messages[threadId] = all
        return .accepted
    }
}
