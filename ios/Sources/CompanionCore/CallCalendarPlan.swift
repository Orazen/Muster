import Foundation

/// Inputs for an explicit, read-only preparation. The calendar is selected by
/// its capability on the computer, never by a caller-supplied calendar ID.
public struct CallCalendarPlanRequest: Codable, Equatable, Sendable {
    public struct Commitment: Codable, Equatable, Sendable {
        public let title: String
        public let minutes: Int
        public init(title: String, minutes: Int) { self.title = title; self.minutes = minutes }
    }
    public let date: String
    public let timeZone: String
    public let workStart: String
    public let workEnd: String
    public let commitments: [Commitment]

    public init(date: String, timeZone: String, workStart: String, workEnd: String, commitments: [Commitment]) {
        self.date = date; self.timeZone = timeZone; self.workStart = workStart
        self.workEnd = workEnd; self.commitments = commitments
    }
}

/// Unsent text only. Receiving this response does not send a call message or
/// authorize a calendar mutation. A UI must leave sending as a separate action.
public struct CallCalendarPlanDraft: Codable, Equatable, Sendable {
    public let draft: String
    public let date: String
    public let timeZone: String
    public let calendarId: String
}
