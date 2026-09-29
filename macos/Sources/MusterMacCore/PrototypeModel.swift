// The prototype's app model. This is an owned fixture flow — nothing here
// touches the network. Send/approval/memory actions are local so the native
// interface is testable end to end while every mutation stays in this
// process, per the M0 boundary. Appearance follows the design concept:
// light, dark, or system.

import CompanionCore
import Foundation
import SwiftUI

/// What one "send" produced locally. The prototype never claims a server
/// acknowledgement.
public struct LocalSend: Equatable, Sendable {
    public let messageId: String
    public let text: String
    public let sessionSendCount: Int
}

/// Which entry the sidebar selection points at.
public enum ConversationSelection: Hashable, Sendable {
    case bot(String)
    case room(String)
}

/// The concept's four primary destinations.
public enum ViewDestination: String, CaseIterable, Sendable {
    case today, conversations, browser, memory, settings
}

/// Browser control state, mirroring the concept's takeover model. In M0 this
/// drives a locally drawn sample page only — no WKWebView, no network.
public enum BrowserControl: Equatable, Sendable {
    case agent
    case humanTakeover
}

/// Sample device power state for the "waiting" affordance. Fixture only.
public struct DeviceFixture: Equatable, Sendable {
    public var macAwake: Bool
    public init(macAwake: Bool) { self.macAwake = macAwake }
}

/// Appearance choice persisted by the app (not by the design artifact).
public enum Appearance: String, CaseIterable, Sendable {
    case system, light, dark

    /// The window's preferred color scheme; nil follows the system.
    public var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

@MainActor
public final class PrototypeModel: ObservableObject {
    // Navigation
    @Published public var destination: ViewDestination = .today
    @Published public var selection: ConversationSelection
    // Data
    @Published public private(set) var fleet: Fleet
    @Published public private(set) var transcripts: [String: [Message]]
    @Published public private(set) var memories: [SampleMemory]
    @Published public private(set) var plan: [PlanBlock]
    // Composer
    @Published public var draft: String
    @Published public private(set) var sends: [LocalSend]
    // Surfaces
    @Published public var browserControl: BrowserControl = .agent
    @Published public var device: DeviceFixture
    @Published public var appearance: Appearance = .system
    @Published public var contextPanelVisible = true
    /// Streaming demonstration state (local timer, no network).
    @Published public private(set) var streaming = false

    private let fixture: FixtureFleet

    public init(fleet: Fleet, transcripts: [String: [Message]], fixture: FixtureFleet) {
        self.fleet = fleet
        self.transcripts = transcripts
        self.fixture = fixture
        self.selection = fleet.bots.first.map { .bot($0.id) } ?? .room(fleet.groups.first?.id ?? "")
        self.draft = ""
        self.sends = []
        self.memories = fixture.memories
        self.plan = fixture.plan
        self.device = DeviceFixture(macAwake: true)
    }

    public static func fixture() -> PrototypeModel {
        let standard = FixtureFleet.standard()
        var transcripts: [String: [Message]] = [:]
        for bot in standard.fleet.bots {
            transcripts[bot.threadId] = bot.id == "bot-scout" ? standard.transcript : []
        }
        for room in standard.fleet.groups {
            transcripts[room.threadId] = [
                WireMessageFactory.user(id: "r-1", text: "Weekly plan draft is attached to the room bulletin.", at: 1_724_000_300_000),
                WireMessageFactory.bot(id: "r-2", text: "I will pick this up after the changelog is committed.", at: 1_724_000_305_000),
            ].compactMap(\.self)
        }
        return PrototypeModel(fleet: standard.fleet, transcripts: transcripts, fixture: standard)
    }

    // MARK: - Derived

    public var selectedThreadId: String? {
        switch selection {
        case let .bot(id): return fleet.bots.first(where: { $0.id == id })?.threadId
        case let .room(id): return fleet.groups.first(where: { $0.id == id })?.threadId
        }
    }

    public var selectedMessages: [Message] {
        guard let threadId = selectedThreadId else { return [] }
        return transcripts[threadId] ?? []
    }

    public var pendingCardMessage: Message? {
        selectedMessages.last { $0.card?.isPending == true }
    }

    public var hostLabel: String {
        device.macAwake ? "On this Mac" : "Waiting for your Mac"
    }

    public var hostDetail: String {
        device.macAwake
            ? "Mac · iPhone · Watch"
            : "Mac asleep · tasks will wait"
    }

    // MARK: - Composer (local only)

    @discardableResult
    public func sendDraft() -> LocalSend? {
        let text = ComposerText.normalized(draft)
        guard !text.isEmpty else { return nil }
        let messageId = "local-\(sends.count + 1)"
        guard let threadId = selectedThreadId,
              let message = WireMessageFactory.user(id: messageId, text: text, at: Date().timeIntervalSince1970 * 1000) else { return nil }
        transcripts[threadId, default: []].append(message)
        let send = LocalSend(messageId: messageId, text: text, sessionSendCount: sends.count + 1)
        sends.append(send)
        draft = ""
        return send
    }

    // MARK: - Approval (local only)

    public func answerPendingCard(option: String?) {
        guard let pending = pendingCardMessage, var card = pending.card else { return }
        if let option { card.answered = option } else { card.dismissed = true }
        var answered = pending
        answered.card = card
        if let threadId = selectedThreadId,
           let index = transcripts[threadId]?.firstIndex(where: { $0.id == pending.id }) {
            transcripts[threadId]?[index] = answered
        }
    }

    // MARK: - Plan review (local only)

    public func setBlockTime(id: Int, start: String) {
        if let index = plan.firstIndex(where: { $0.id == id }) { plan[index].start = start }
    }

    public func toggleBlock(id: Int) {
        if let index = plan.firstIndex(where: { $0.id == id }) { plan[index].included.toggle() }
    }

    public var includedBlockCount: Int { plan.filter(\.included).count }

    // MARK: - Memory (local only)

    public func forgetMemory(id: Int) {
        memories.removeAll { $0.id == id }
    }

    public func resetMemories() {
        memories = fixture.memories
    }

    // MARK: - Streaming demonstration (local timer content, no network)

    public func beginStreamingDemo() {
        guard !streaming, let threadId = selectedThreadId else { return }
        streaming = true
        let words = ["Fixture", "stream:", "the", "native", "transcript", "keeps", "its", "tail", "visible", "while", "a", "reply", "arrives."]
        var index = 0
        var text = ""
        Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            Task { @MainActor in
                guard index < words.count else {
                    timer.invalidate()
                    self.streaming = false
                    return
                }
                text += (index == 0 ? "" : " ") + words[index]
                index += 1
                var transcript = self.transcripts[threadId] ?? []
                let messageId = "fixture-stream"
                if let existing = transcript.firstIndex(where: { $0.id == messageId }) {
                    transcript[existing].text = text
                } else if let message = WireMessageFactory.bot(id: messageId, text: text, at: Date().timeIntervalSince1970 * 1000) {
                    transcript.append(message)
                }
                self.transcripts[threadId] = transcript
            }
        }
    }
}
