// Today: the daily-planning workspace from the design concept — greeting,
// three proposed priorities, the sample calendar in the context panel, and
// the review sheet that edits draft blocks locally.

import MusterMacCore
import SwiftUI

struct TodayView: View {
    @EnvironmentObject private var model: PrototypeModel
    @State private var showReview = false
    @State private var approved = false

    var body: some View {
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if !model.device.macAwake {
                        Label("Your sample Mac is asleep. Larger tasks will wait; nothing is sent to the cloud.", systemImage: "moon.zzz.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                            .accessibilityIdentifier("waiting-banner")
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("TUESDAY, 29 SEPTEMBER")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        (Text("Good morning, Tharun.\n").foregroundColor(.primary) + Text("Let's make room.").foregroundColor(.secondary))
                            .font(.system(size: 28, weight: .medium))
                            .kerning(-1)
                    }
                    .accessibilityElement(children: .combine)

                    HStack(spacing: 6) {
                        chip("calendar", "2 sample meetings")
                        chip("clock", "3 suggested priorities")
                        chip("laptopcomputer", "Your personal assistant")
                    }

                    planCard

                    HStack(alignment: .top, spacing: 10) {
                        FlowerView(colorName: nil, busy: false)
                            .frame(width: 24, height: 24)
                            .rotationEffect(.degrees(-5))
                        Text("I've left a little space between things.\nA good day doesn't have to be a full one.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    HStack(spacing: 6) {
                        suggestion("Make today a little lighter")
                        suggestion("Help me prepare for my next meeting")
                    }
                }
                .padding(24)
            }
            if model.contextPanelVisible {
                Divider()
                TodayContextPanel()
                    .frame(width: 284)
            }
        }
        .sheet(isPresented: $showReview) {
            ReviewSheet(approved: $approved)
        }
    }

    private func chip(_ icon: String, _ label: String) -> some View {
        Label(label, systemImage: icon)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(.quinary, in: RoundedRectangle(cornerRadius: 5))
    }

    private func suggestion(_ text: String) -> some View {
        Button {
            model.draft = text
        } label: {
            Text(text)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(.quinary, in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }

    private var planCard: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Three things worth your time")
                    .font(.subheadline.weight(.medium))
                Spacer()
                Text(approved ? "Preview approved" : "Draft plan")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.green)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
            }
            .padding(16)
            ForEach(model.plan) { block in
                Divider()
                HStack(alignment: .top, spacing: 12) {
                    Text("\(block.id + 1)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 22, height: 22)
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(block.title).font(.callout.weight(.medium))
                        Text(block.detail).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text("\(block.minutes) min")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .opacity(block.included ? 1 : 0.45)
            }
            Divider()
            HStack {
                Text("Nothing added to your calendar.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    showReview = true
                } label: {
                    Label(approved ? "Review again" : "Review time blocks", systemImage: "arrow.right")
                        .font(.caption.weight(.medium))
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("review-blocks")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }
}

struct TodayContextPanel: View {
    @EnvironmentObject private var model: PrototypeModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Your day").font(.subheadline.weight(.semibold))
                    Spacer()
                    Text("Sample calendar").font(.caption2).foregroundStyle(.tertiary)
                }
                HStack {
                    Text("September").font(.title3.weight(.medium))
                    Spacer()
                    Text("2026").font(.caption).foregroundStyle(.secondary)
                }
                WeekStrip()
                Text("TUESDAY, 29 SEPTEMBER")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(fixtureCalendar) { event in
                        CalendarRow(event: event)
                    }
                }
                Divider()
                Label {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Room to breathe").font(.caption.weight(.medium))
                        Text("Suggested blocks stay as drafts until you review them.").font(.caption2).foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "calendar")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .padding(20)
        }
        .background(.quinary.opacity(0.4))
    }

    // The concept's sample agenda; fixture data by definition.
    private var fixtureCalendar: [CalendarEvent] {
        [
            CalendarEvent(id: 0, time: "09:00", title: "Make something great", detail: "Focus time · 60 min", kind: .focus),
            CalendarEvent(id: 1, time: "10:30", title: "Product catch-up", detail: "30 min · Calendar", kind: .meeting),
            CalendarEvent(id: 2, time: "11:30", title: "A few thoughtful replies", detail: "Suggested · 30 min", kind: .suggested),
            CalendarEvent(id: 3, time: "12:00", title: "Space for lunch. And a walk.", detail: "", kind: .breakTime),
            CalendarEvent(id: 4, time: "14:00", title: "Design review", detail: "30 min · Calendar", kind: .meeting),
            CalendarEvent(id: 5, time: "14:30", title: "Bring the launch together", detail: "Suggested · 45 min", kind: .suggested),
        ]
    }
}

struct WeekStrip: View {
    private let days = [("M", "28"), ("T", "29"), ("W", "30"), ("T", "1"), ("F", "2"), ("S", "3"), ("S", "4")]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(days, id: \.1) { day, date in
                VStack(spacing: 6) {
                    Text(day).font(.caption2).foregroundStyle(.secondary)
                    Text(date).font(.caption.weight(.medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(date == "29" ? Color.primary.opacity(0.85) : .clear, in: RoundedRectangle(cornerRadius: 7))
                .foregroundStyle(date == "29" ? Color(nsColor: .controlBackgroundColor) : .primary)
            }
        }
    }
}

struct CalendarRow: View {
    let event: CalendarEvent

    private var accent: Color {
        switch event.kind {
        case .focus: return .green
        case .meeting: return .purple
        case .suggested: return .accentColor
        case .breakTime: return .secondary
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(event.time)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(width: 34, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title).font(.caption.weight(.medium))
                if !event.detail.isEmpty {
                    Text(event.detail).font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                event.kind == .breakTime ? Color.clear : Color(nsColor: .controlBackgroundColor),
                in: RoundedRectangle(cornerRadius: 6)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(event.kind == .breakTime ? Color.clear : Color(nsColor: .separatorColor))
            )
            .overlay(alignment: .leading) {
                if event.kind != .breakTime {
                    Rectangle().fill(accent).frame(width: 2)
                }
            }
        }
    }
}

struct ReviewSheet: View {
    @EnvironmentObject private var model: PrototypeModel
    @Environment(\.dismiss) private var dismiss
    @Binding var approved: Bool
    @State private var focusAfterClose = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("A plan, with your say.").font(.title3.weight(.medium))
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            Text("Review three suggested blocks for your sample calendar. Change a start time or leave a block out.")
                .font(.callout)
                .foregroundStyle(.secondary)
            ForEach(model.plan) { block in
                HStack(spacing: 10) {
                    Toggle("", isOn: Binding(
                        get: { model.plan.first(where: { $0.id == block.id })?.included ?? false },
                        set: { _ in model.toggleBlock(id: block.id) }
                    ))
                    .labelsHidden()
                    .accessibilityLabel("Include \(block.title)")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(block.title).font(.callout)
                        Text("\(block.minutes) minutes · Personal calendar · Sample")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    TextField("", text: Binding(
                        get: { model.plan.first(where: { $0.id == block.id })?.start ?? block.start },
                        set: { model.setBlockTime(id: block.id, start: $0) }
                    ))
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 78)
                    .accessibilityLabel("Start time for \(block.title)")
                }
                .padding(.vertical, 6)
            }
            Text("Prototype: approval changes this preview only. No real calendar is connected.")
                .font(.caption2)
                .foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Keep as draft") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Approve sample plan") {
                    approved = true
                    focusAfterClose = true
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(model.includedBlockCount == 0)
                .accessibilityIdentifier("approve-plan")
            }
        }
        .padding(22)
        .frame(width: 480)
        .onAppear { approved = false }
    }
}
