import SwiftUI
import CompanionCore

/// Approval, preparation, and sending remain separate user actions.
struct WatchCallCalendarView: View {
    @EnvironmentObject private var session: WatchSession
    let context: WatchCallContext
    @Binding var draft: String
    @Binding var draftRevision: Int
    let prepared: () -> Void
    @State private var visible = false
    @State private var date = {
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }()
    @State private var timeZone = TimeZone.current.identifier
    @State private var workStart = "09:00"
    @State private var workEnd = "17:00"
    @State private var titles = [""]
    @State private var minutes = ["30"]
    @State private var notice: String?
    private var usable: Bool { session.calendarIssued?.isUsable == true }
    private var canPrepare: Bool {
        usable && !session.calendarBusy && session.callPhase == .connected && session.callPendingRequestId == nil &&
        titles.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf16.count <= 300 } &&
        minutes.allSatisfy { Int($0).map { (5...240).contains($0) } ?? false }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Calendar planning").font(.headline)
            if let issued = session.calendarIssued {
                Text("Calendar: \(issued.grant.calendarId)").font(.footnote).accessibilityIdentifier("watch-calendar-selected")
                Text("Expires \(Date(timeIntervalSince1970: issued.grant.expiresAt / 1000).formatted(date: .abbreviated, time: .shortened))").font(.footnote)
                if !usable { Text("Calendar access expired. Connect again.").font(.footnote) }
            }
            Button(usable ? "Reconnect Calendar" : "Connect Calendar") {
                Task { await session.beginCalendarEnrollment(context) }
            }.disabled(session.calendarBusy).accessibilityIdentifier("watch-calendar-connect")
            if let code = session.calendarCode {
                Text(code).font(.headline.monospaced()).accessibilityIdentifier("watch-calendar-code")
                Text("On this computer, open Muster Calendar settings while signed in. Enter this code and approve the selected calendar. Code expires in five minutes.").font(.footnote)
                Button("Check approval") { Task { await session.checkCalendarEnrollment(context) } }
                    .disabled(session.calendarBusy).accessibilityIdentifier("watch-calendar-check")
                Button("Cancel connection") { Task { await session.cancelCalendarEnrollment(context) } }
                    .accessibilityIdentifier("watch-calendar-cancel")
            }
            if let message = session.calendarNotice { Text(message).font(.footnote).accessibilityIdentifier("watch-calendar-notice") }
            if usable {
                Group {
                TextField("Date YYYY-MM-DD", text: $date).accessibilityIdentifier("watch-calendar-date")
                TextField("Time zone", text: $timeZone).accessibilityIdentifier("watch-calendar-time-zone")
                TextField("Work starts HH:mm", text: $workStart).accessibilityIdentifier("watch-calendar-work-start")
                TextField("Work ends HH:mm", text: $workEnd).accessibilityIdentifier("watch-calendar-work-end")
                ForEach(titles.indices, id: \.self) { index in
                    TextField("Priority \(index + 1)", text: $titles[index]).accessibilityIdentifier("watch-calendar-priority-\(index)")
                    TextField("Minutes (5–240)", text: $minutes[index]).accessibilityIdentifier("watch-calendar-minutes-\(index)")
                }
                if titles.count < 3 {
                    Button("Add priority") { titles.append(""); minutes.append("30") }.accessibilityIdentifier("watch-calendar-add-priority")
                }
                if titles.count > 1 {
                    Button("Remove last priority") { titles.removeLast(); minutes.removeLast() }
                }
                Button("Prepare draft") { prepare() }.disabled(!canPrepare).accessibilityIdentifier("watch-calendar-prepare")
                }.disabled(session.calendarBusy)
                Text("Reads the selected calendar to prepare an unsent proposal. Review the message, then tap Send separately. No events are changed.").font(.footnote)
            }
            if session.calendarBusy { ProgressView().accessibilityIdentifier("watch-calendar-progress") }
            if let notice { Text(notice).font(.footnote).accessibilityIdentifier("watch-calendar-draft-notice") }
        }
        .onAppear { visible = true; session.loadCalendar(context) }
        .onDisappear { visible = false }
    }
    private func prepare() {
        guard canPrepare else { return }
        let revision = draftRevision, previousDraft = draft, callId = session.callRecord?.id
        let input = CallCalendarPlanRequest(date: date, timeZone: timeZone, workStart: workStart, workEnd: workEnd,
            commitments: titles.indices.map { .init(title: titles[$0], minutes: Int(minutes[$0]) ?? 0) })
        notice = nil
        Task { @MainActor in
            guard let result = await session.prepareCalendar(input, context: context) else { return }
            guard visible, session.callMatches(context), session.callRecord?.id == callId,
                  session.callPhase == .connected, draftRevision == revision, draft == previousDraft else {
                if visible { notice = "Your draft or call changed. Prepare again to replace the current draft." }
                return
            }
            draft = result.draft
            prepared()
        }
    }
}
