// What the Updates pill shows: only the chats doing something.
//
// Three kinds, in the order a person cares about them — a chat that has
// stopped and needs an answer, a chat mid-turn, and a chat that finished
// with something you have not read. A chat that is idle and read is not an
// update and never appears here; that is what the roster below is for.
//
// Adapted from the OpenMausBot companion's Updates.swift
// (https://github.com/milind-soni/OpenMausBot, Apache-2.0 — full license
// text and attribution in public/third-party-notices.txt, shipped with
// the app). The classification is re-derived against this client's own
// state: Muster bots carry `busy`/`unread` rather than ordered task
// activities, there is no send queue to headline, and this file keys every
// entry by `threadId` — the one key bots, rooms, approvals and streams
// share — so the App layer can resolve a name without the core knowing
// what a view is.
import Foundation

public struct FleetUpdate: Hashable, Identifiable, Sendable {
    public enum Kind: Int, Comparable, Sendable {
        case needsYou = 0, working, toReview

        public static func < (left: Kind, right: Kind) -> Bool { left.rawValue < right.rawValue }
    }

    /// The thread this is about — a bot's or a room's.
    public var threadId: String
    public var kind: Kind
    /// One line under the name — the question, what it is doing, or what it said.
    public var line: String
    /// The card to answer, when `kind == .needsYou`.
    public var card: OptionCard?

    public var id: String { threadId }

    public init(threadId: String, kind: Kind, line: String, card: OptionCard? = nil) {
        self.threadId = threadId
        self.kind = kind
        self.line = line
        self.card = card
    }
}

extension CompanionState {
    /// Every chat worth a headline, ordered by kind. One entry per thread:
    /// the pill headlines the most recent thing that stopped, and the sheet
    /// lists the rest — a second entry for the same conversation would read
    /// as two bots where there is one.
    public var updates: [FleetUpdate] {
        var out: [FleetUpdate] = []
        var seen = Set<String>()

        // Newest approval first: an unanswered card outranks everything a
        // chat is doing, because only a person can un-stop it.
        for pending in pendingApprovals {
            guard seen.insert(pending.threadId).inserted else { continue }
            let card = pending.message.card
            var line = card?.subtitle ?? ""
            if line.isEmpty { line = card?.title ?? "" }
            out.append(FleetUpdate(threadId: pending.threadId, kind: .needsYou, line: line, card: card))
        }

        for bot in bots where bot.hidden != true {
            guard seen.insert(bot.threadId).inserted else { continue }
            if bot.busy == true {
                out.append(FleetUpdate(threadId: bot.threadId, kind: .working, line: workingLine(bot.threadId)))
            } else if bot.unread {
                out.append(FleetUpdate(threadId: bot.threadId, kind: .toReview, line: lastLine(bot.threadId)))
            }
        }

        for room in rooms {
            guard seen.insert(room.threadId).inserted else { continue }
            if room.busyBotId != nil {
                out.append(FleetUpdate(threadId: room.threadId, kind: .working, line: workingLine(room.threadId)))
            } else if room.unread {
                out.append(FleetUpdate(threadId: room.threadId, kind: .toReview, line: lastLine(room.threadId)))
            }
        }

        // Stable within a kind: the sort must not reorder the newest-first
        // approvals that `pendingApprovals` already hands over.
        return out.enumerated().sorted { left, right in
            left.element.kind == right.element.kind
                ? left.offset < right.offset
                : left.element.kind < right.element.kind
        }.map(\.element)
    }

    /// What a busy thread reads as: the tail of its reply if one is being
    /// typed, the tool it last touched, otherwise the honest "Working…".
    private func workingLine(_ threadId: String) -> String {
        if let live = streaming[threadId], !live.isEmpty {
            return String(live.suffix(120)).replacingOccurrences(of: "\n", with: " ")
        }
        if let last = visibleTranscript(forThread: threadId).last, last.kind == .activity, let tool = last.tool {
            return tool.name
        }
        return "Working…"
    }

    /// What an unread thread reads as: its last message, whatever kind it
    /// was. A pending card never lands here — it became `needsYou` above
    /// and the `seen` set kept this entry out.
    private func lastLine(_ threadId: String) -> String {
        guard let last = visibleTranscript(forThread: threadId).last else { return "" }
        switch last.kind {
        case .text, .unknown: return last.text ?? ""
        case .options: return last.card?.title ?? ""
        case .activity: return last.tool?.name ?? ""
        case .screen: return "Screenshot"
        }
    }
}
