// The Updates pill and the sheet it opens: who is doing what right now,
// at a glance — the stopped chat first, then what is mid-turn, then what
// finished while you were not looking.
//
// Adapted from the OpenMausBot companion's UpdatesPill / UpdatesSheet
// (https://github.com/milind-soni/OpenMausBot, Apache-2.0 — full license
// text and attribution in public/third-party-notices.txt, shipped with
// the app). Two deliberate differences: the faces are this app's flowers
// rather than the maus avatar, and a "needs you" row offers a *route* to
// the answer ("Open the chat to answer") rather than the card's options as
// inline pills — approvals are answered under an active view lease whose
// context must be the conversation itself, and answering from a sheet
// would answer outside the context the person is looking at.
import SwiftUI
import CompanionCore

/// One row of the pill and the sheet: a chat, which kind of update it is,
/// and the one line that says why.
struct UpdateItem: Identifiable, Hashable {
    let chat: Chat
    let kind: FleetUpdate.Kind
    /// One line under the name — the question, what it is doing, or what it said.
    let line: String

    var id: String { chat.threadId }
}

extension CompanionState {
    /// This state's updates, resolved to chats. Unresolvable threads (a
    /// deletion racing the fold) are dropped rather than shown nameless.
    func updateItems(resolve: (String) -> Chat?) -> [UpdateItem] {
        updates.compactMap { update in
            resolve(update.threadId).map { UpdateItem(chat: $0, kind: update.kind, line: update.line) }
        }
    }
}

/// The pill under the roster's header: faces, headline, subline.
struct UpdatesPill: View {
    let updates: [UpdateItem]
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if !updates.isEmpty {
                    UpdateStack(chats: Array(updates.prefix(3).map(\.chat)))
                }
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        if let first = updates.first {
                            switch first.kind {
                            case .needsYou:
                                Image(systemName: "hand.raised.fill")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(AgentPalette.color(first.chat.color))
                                Text("\(first.chat.name) needs you")
                            case .working:
                                Text("\(first.chat.name) is working")
                            case .toReview:
                                Text("\(first.chat.name) has an update")
                            }
                        } else {
                            Text("All quiet")
                        }
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(updates.isEmpty ? Color.secondary : Color.primary)
                    .lineLimit(1)

                    Text(subline)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Color.secondary)
            }
            .padding(.leading, updates.isEmpty ? 16 : 7)
            .padding(.trailing, 12)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .accessibilityLabel("Updates")
        .accessibilityHint("Opens the chats that are waiting, working, or finished")
        .accessibilityIdentifier("updates-button")
    }

    private var subline: String {
        guard let first = updates.first else { return "Nothing needs you" }
        let rest = updates.count - 1
        if rest == 0 { return first.line.isEmpty ? " " : first.line }
        return rest == 1 ? "1 more update" : "\(rest) more updates"
    }
}

/// Up to three flowers overlapping, the way a group of faces reads at a
/// glance.
struct UpdateStack: View {
    let chats: [Chat]

    var body: some View {
        HStack(spacing: -12) {
            ForEach(chats) { chat in
                FlowerAvatar(
                    color: chat.color,
                    size: 28,
                    state: chat.mascotState,
                    seed: chat.id
                )
                .padding(2)
                .background(Circle().fill(Color(uiColor: .systemBackground)))
            }
        }
    }
}

/// What the pill opens: the active chats, grouped by what they need.
///
/// Needs you first — the phone exists so that a stopped bot on the laptop
/// can be un-stopped from wherever you are. Then what is working, then
/// what finished while you were not looking. Every row opens its
/// conversation; the answer itself is taken there.
struct UpdatesSheet: View {
    let updates: [UpdateItem]
    let open: (Chat) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Updates")
                        .font(.system(size: 22, weight: .bold))
                    Spacer()
                    Text(updates.isEmpty ? "All quiet" : "\(updates.count) active")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                }
                .padding(.horizontal, 20)
                .padding(.top, 22)
                .padding(.bottom, 6)

                if updates.isEmpty {
                    ContentUnavailableView(
                        "Nothing needs you",
                        systemImage: "checkmark.circle",
                        description: Text("When a bot stops for an answer, is mid-task, or finishes something, it shows up here.")
                    )
                    .padding(.top, 24)
                } else {
                    section("Needs you", kind: .needsYou)
                    section("Working", kind: .working)
                    section("To review", kind: .toReview)
                }
            }
            .padding(.bottom, 24)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.thinMaterial)
        .presentationCornerRadius(28)
    }

    @ViewBuilder
    private func section(_ title: LocalizedStringKey, kind: FleetUpdate.Kind) -> some View {
        let items = updates.filter { $0.kind == kind }
        if !items.isEmpty {
            let color = kind == .needsYou ? AgentPalette.color(items[0].chat.color) : Color.secondary
            Text(title)
                .textCase(.uppercase)
                .font(.system(size: 12, weight: .bold))
                .tracking(0.5)
                .foregroundStyle(color)
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 2)

            ForEach(items) { update in
                UpdateRow(update: update) {
                    open(update.chat)
                }
            }
        }
    }
}

private struct UpdateRow: View {
    let update: UpdateItem
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: 12) {
                FlowerAvatar(
                    color: update.chat.color,
                    size: 40,
                    state: update.chat.mascotState,
                    seed: update.chat.id
                )

                VStack(alignment: .leading, spacing: 3) {
                    Text(update.chat.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.primary)
                    if !update.chat.subtitle.isEmpty {
                        Text(update.chat.subtitle)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                    }
                    Text(update.line.isEmpty ? " " : update.line)
                        .font(.system(size: 14))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(update.kind == .needsYou ? 3 : 1)
                        .multilineTextAlignment(.leading)

                    if update.kind == .needsYou {
                        // The route, not the answers: approvals are taken
                        // in the conversation, under its own view lease.
                        Label("Open the chat to answer", systemImage: "hand.raised.fill")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.secondary)
                            .padding(.top, 6)
                    }
                }

                Spacer(minLength: 0)

                switch update.kind {
                case .needsYou:
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.secondary.opacity(0.5))
                        .padding(.top, 12)
                case .working:
                    ProgressView().controlSize(.small).padding(.top, 10)
                case .toReview:
                    HStack(spacing: 6) {
                        Circle()
                            .fill(AgentPalette.color(update.chat.color))
                            .frame(width: 10, height: 10)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.secondary.opacity(0.5))
                    }
                    .padding(.top, 12)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("update-\(update.chat.threadId)")
    }
}
