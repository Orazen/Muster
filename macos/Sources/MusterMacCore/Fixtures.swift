// Fixture content for M0: the fleet, a conversation with a live approval
// card, the daily-plan proposal, and sample memories.
//
// The CompanionCore wire types have no public memberwise inits (the shared
// core is read-only for this slice), so fixtures are JSON constants decoded
// through JSONDecoder — which is the stronger test anyway: the exact shapes
// here must satisfy the real decoder, exactly like live `/api/bots` data.

import CompanionCore
import Foundation

/// One proposed time block in the daily plan. Draft until approved; the
/// prototype never touches a real calendar.
public struct PlanBlock: Equatable, Identifiable, Sendable {
    public let id: Int
    public let title: String
    public let detail: String
    public let minutes: Int
    /// "09:00"-style start, editable in the review sheet.
    public var start: String
    public var included: Bool

    public init(id: Int, title: String, detail: String, minutes: Int, start: String, included: Bool = true) {
        self.id = id
        self.title = title
        self.detail = detail
        self.minutes = minutes
        self.start = start
        self.included = included
    }
}

/// One line of the sample calendar shown in the Today context panel.
public struct CalendarEvent: Equatable, Identifiable, Sendable {
    public enum Kind: String, Sendable { case focus, meeting, breakTime, suggested }

    public let id: Int
    public let time: String
    public let title: String
    public let detail: String
    public let kind: Kind

    public init(id: Int, time: String, title: String, detail: String, kind: Kind) {
        self.id = id
        self.time = time
        self.title = title
        self.detail = detail
        self.kind = kind
    }
}

/// A sample memory the Memory view lists. "Sample" is part of the text the
/// view shows; nothing here reads or writes real preference stores.
public struct SampleMemory: Equatable, Identifiable, Sendable {
    public let id: Int
    public let text: String
    public let origin: String

    public init(id: Int, text: String, origin: String) {
        self.id = id
        self.text = text
        self.origin = origin
    }
}

public struct FixtureFleet {
    public let fleet: Fleet
    public let transcript: [Message]
    public let pendingCard: Message
    public let plan: [PlanBlock]
    public let calendar: [CalendarEvent]
    public let memories: [SampleMemory]
}

public extension FixtureFleet {
    /// The fleet as the live `/api/bots?messages=0` wire would carry it,
    /// decoded through CompanionCore's own parser.
    static let fleetJSON = """
    {
      "bots": [
        {"id":"bot-scout","threadId":"thread-scout","name":"Scout","title":"Scout",
         "description":"Research and drafting","notifications":true,"unread":false,
         "color":"blue","modelSelection":{"instanceId":"ghost","model":"sonnet"},
         "createdAt":1723000000000,"busy":true},
        {"id":"bot-quill","threadId":"thread-quill","name":"Quill","title":"Quill",
         "description":"Writing","notifications":true,"unread":true,
         "color":"purple","modelSelection":{"instanceId":"ghost","model":"sonnet"},
         "createdAt":1723000100000,"busy":false},
        {"id":"bot-ledger","threadId":"thread-ledger","name":"Ledger","title":"Ledger",
         "description":"Reports","notifications":true,"unread":false,
         "color":"green","modelSelection":{"instanceId":"ghost","model":"sonnet"},
         "createdAt":1723000200000,"busy":false}
      ],
      "groups": [
        {"id":"room-1","threadId":"thread-room","name":"Launch prep",
         "memberIds":["bot-scout","bot-quill"],
         "defaultResponder":{"kind":"bot","botId":"bot-scout"},
         "bulletin":"Weekly plan lives here.","unread":false,"createdAt":1723000300000}
      ]
    }
    """

    /// The scout transcript, ending in a live approval card carrying the
    /// same OptionCard fields production sends (including the why-journal).
    static let transcriptJSON = """
    [
      {"id":"m-1","role":"user","kind":"text","at":1724000000000,
       "text":"Help me make a simpler weekly routine."},
      {"id":"m-2","role":"bot","kind":"text","at":1724000005000,
       "text":"Let's start with one small habit: a calm morning plan. I'll suggest your priorities, and you choose what goes into the calendar."},
      {"id":"m-3","role":"bot","kind":"activity","at":1724000008000,
       "tool":{"name":"Read your saved routine","ok":true}},
      {"id":"m-4","role":"user","kind":"text","at":1724000010000,
       "text":"Sounds right — go ahead."},
      {"id":"m-5","role":"bot","kind":"text","at":1724000060000,
       "text":"One step needs your approval before I can write anything."},
      {"id":"m-approve","role":"bot","kind":"options","at":1724000100000,
       "text":"I can commit this change to the repo. Allow?",
       "card":{"title":"Commit change",
               "subtitle":"git commit -m \\"Tidy the sidebar layout\\"",
               "options":["Allow once","Always allow","Deny"],
               "requestId":"req-commit-1","tool":"Bash",
               "held":"Auto mode stopped to ask before writing.",
               "allowKey":"Bash:git",
               "why":{"source":"previous-run","runId":"run-77",
                      "botId":"bot-scout","threadId":"thread-scout",
                      "at":1724000050000,
                      "intent":"Prepare the weekly changelog entry.",
                      "decisions":["Read 4 files","Wrote draft to scratch"],
                      "outcome":"partial",
                      "hypothesis":"The changelog needs last sprint's merged fixes.",
                      "findings":"Found 3 merged fixes and one reverted feature."}}}
    ]
    """

    static func standard() -> FixtureFleet {
        let decoder = JSONDecoder()
        do {
            let fleet = try decoder.decode(Fleet.self, from: Data(fleetJSON.utf8))
            let transcript = try decoder.decode([Message].self, from: Data(transcriptJSON.utf8))
            let pendingCard = transcript.last { $0.card?.isPending == true } ?? transcript[0]
            let plan = [
                PlanBlock(id: 0, title: "Move the Muster launch forward", detail: "A quiet hour before the day gets busy.", minutes: 60, start: "09:00"),
                PlanBlock(id: 1, title: "Reply to the people waiting on you", detail: "A few thoughtful drafts. You have the final say.", minutes: 30, start: "11:30"),
                PlanBlock(id: 2, title: "Bring your launch notes together", detail: "One place for the next small steps.", minutes: 45, start: "14:30"),
            ]
            let calendar = [
                CalendarEvent(id: 0, time: "09:00", title: "Make something great", detail: "Focus time · 60 min", kind: .focus),
                CalendarEvent(id: 1, time: "10:30", title: "Product catch-up", detail: "30 min · Calendar", kind: .meeting),
                CalendarEvent(id: 2, time: "11:30", title: "A few thoughtful replies", detail: "Suggested · 30 min", kind: .suggested),
                CalendarEvent(id: 3, time: "12:00", title: "Space for lunch. And a walk.", detail: "", kind: .breakTime),
                CalendarEvent(id: 4, time: "14:00", title: "Design review", detail: "30 min · Calendar", kind: .meeting),
                CalendarEvent(id: 5, time: "14:30", title: "Bring the launch together", detail: "Suggested · 45 min", kind: .suggested),
            ]
            let memories = [
                SampleMemory(id: 0, text: "Morning is my best focus time", origin: "Added from a conversation · Sample"),
                SampleMemory(id: 1, text: "Keep a little space between meetings", origin: "Your preference · Sample"),
                SampleMemory(id: 2, text: "Review messages before sending", origin: "Approval preference · Sample"),
            ]
            return FixtureFleet(fleet: fleet, transcript: transcript, pendingCard: pendingCard,
                                plan: plan, calendar: calendar, memories: memories)
        } catch {
            // Fixture JSON is a compiled-in constant: a decode failure is a
            // programmer error, not a runtime condition to handle.
            fatalError("M0 fixture JSON no longer matches CompanionCore's wire contract: \(error)")
        }
    }
}

/// Runtime message construction for the prototype's local send/stream
/// demonstration. CompanionCore exposes no public memberwise init, so these
/// build the wire JSON and decode it — the same path real data takes.
public enum WireMessageFactory {
    private static func decode(_ json: String) -> Message? {
        try? JSONDecoder().decode(Message.self, from: Data(json.utf8))
    }

    public static func user(id: String, text: String, at: Double) -> Message? {
        let escaped = text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        return decode("""
        {"id":"\(id)","role":"user","kind":"text","at":\(at),"text":"\(escaped)"}
        """)
    }

    public static func bot(id: String, text: String, at: Double) -> Message? {
        let escaped = text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        return decode("""
        {"id":"\(id)","role":"bot","kind":"text","at":\(at),"text":"\(escaped)"}
        """)
    }
}
