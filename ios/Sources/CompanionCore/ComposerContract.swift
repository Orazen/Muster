import Foundation

public struct ComposerTarget: Hashable, Sendable {
    public enum Kind: String, Sendable { case bot, room }
    public let kind: Kind
    public let ownerId: String
    public let threadId: String

    public init(kind: Kind, ownerId: String, threadId: String) {
        self.kind = kind; self.ownerId = ownerId; self.threadId = threadId
    }

    public var isValid: Bool {
        Self.validId(ownerId) && Self.validId(threadId)
    }

    public static func validId(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }

    public func isCurrent(in state: CompanionState) -> Bool {
        switch kind {
        case .bot:
            return state.bot(ownerId).map { $0.hidden != true && $0.threadId == threadId } ?? false
        case .room:
            return state.rooms.contains { $0.id == ownerId && $0.threadId == threadId }
        }
    }
}

public struct ComposerContext: Hashable, Sendable {
    public let sessionId: UUID
    public let target: ComposerTarget
    public init(sessionId: UUID, target: ComposerTarget) { self.sessionId = sessionId; self.target = target }
}

public enum ComposerText {
    /// Match the server's ECMAScript String.trim(), not Foundation's broader
    /// whitespace set. The raw draft is never replaced by this wire value.
    public static func normalized(_ text: String) -> String {
        func whitespace(_ scalar: Unicode.Scalar) -> Bool {
            switch scalar.value {
            case 0x0009...0x000D, 0x0020, 0x00A0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
            default: return false
            }
        }
        let scalars = text.unicodeScalars
        let start = scalars.firstIndex { !whitespace($0) } ?? scalars.endIndex
        guard start != scalars.endIndex else { return "" }
        let end = scalars.index(after: scalars.lastIndex { !whitespace($0) }!)
        return String(scalars[start..<end])
    }
}

/// A checked HTTP acknowledgment only. This does not establish durable
/// SQLite persistence, eventual execution, or delivery after a lost response.
public struct ComposerAcknowledgment: Sendable {
    public let threadId: String
    public let messageId: String?
    public let queued: Bool
    public init(threadId: String, messageId: String? = nil, queued: Bool = false) {
        self.threadId = threadId; self.messageId = messageId; self.queued = queued
    }

    static func decode(_ data: Data, expectedThreadId: String, rawText: String) throws -> Self {
        struct Echo: Decodable { let id: String; let role: String; let kind: String; let text: String }
        struct Body: Decodable {
            let ok: Bool
            let threadId: String
            let message: Echo?
            let queued: Bool?
            let messageId: String?
            enum CodingKeys: String, CodingKey { case ok, threadId, message, queued, messageId }
            init(from decoder: Decoder) throws {
                let values = try decoder.container(keyedBy: CodingKeys.self)
                ok = try values.decode(Bool.self, forKey: .ok)
                threadId = try values.decode(String.self, forKey: .threadId)
                message = try values.contains(.message) ? values.decode(Echo.self, forKey: .message) : nil
                queued = try values.contains(.queued) ? values.decode(Bool.self, forKey: .queued) : nil
                messageId = try values.contains(.messageId) ? values.decode(String.self, forKey: .messageId) : nil
            }
        }
        let body = try JSONDecoder().decode(Body.self, from: data)
        guard body.ok, body.threadId == expectedThreadId,
              body.messageId.map(ComposerTarget.validId) ?? true,
              body.queued != true || body.messageId != nil else {
            throw APIError.transport("The send acknowledgment could not be verified.")
        }
        if let echo = body.message {
            guard ComposerTarget.validId(echo.id), echo.role == "user", echo.kind == "text",
                  echo.text.utf16.elementsEqual(ComposerText.normalized(rawText).utf16),
                  body.messageId.map({ $0 == echo.id }) ?? true else {
                throw APIError.transport("The send acknowledgment did not match this message.")
            }
        }
        return Self(threadId: body.threadId, messageId: body.message?.id ?? body.messageId, queued: body.queued ?? false)
    }
}

public protocol ComposerTransport: Sendable {
    func sendOrdinary(text: String, to target: ComposerTarget) async throws -> ComposerAcknowledgment
}

public enum ComposerSendError: Error, LocalizedError, Sendable {
    case upgradeRequired
    case tooLarge
    public var errorDescription: String? {
        switch self {
        case .upgradeRequired: return "Update Muster on your computer before sending from this composer. Your draft is still here."
        case .tooLarge: return "This message is too large to send. Shorten it and try again. Your draft is still here."
        }
    }
}
