import Foundation

/// View-local draft lifetime. A request result never clears text or invents
/// a saved receipt; only the server-backed card controls that presentation.
public struct SeedAnswerDraft: Sendable {
    public private(set) var text = ""
    public private(set) var lastAnswer: String?
    public private(set) var opening: UUID?
    public private(set) var pending: UUID?
    public private(set) var revision: UInt64 = 0

    public init() {}

    @discardableResult
    public mutating func openEditor() -> UUID? {
        guard opening == nil, pending == nil else { return nil }
        let token = UUID()
        opening = token
        return token
    }

    public mutating func closeEditor(_ token: UUID) {
        guard opening == token else { return }
        opening = nil
    }

    public mutating func invalidateEditor() { opening = nil }

    public mutating func edit(_ value: String, in token: UUID) {
        guard opening == token else { return }
        // Do not skip canonically equivalent Swift strings: their UTF-16
        // payloads can differ and the saved-answer API compares exact units.
        text = value
        revision &+= 1
    }

    public mutating func beginAction(from token: UUID? = nil) -> UUID? {
        guard pending == nil, opening == token else { return nil }
        let action = UUID()
        pending = action
        return action
    }

    public mutating func beginAnswer(_ answer: String, from token: UUID? = nil) -> UUID? {
        guard SeedCardContract.isValidAnswer(answer), let action = beginAction(from: token) else { return nil }
        lastAnswer = answer
        return action
    }

    public mutating func finishAction(_ token: UUID) {
        guard pending == token else { return }
        pending = nil
    }
}
