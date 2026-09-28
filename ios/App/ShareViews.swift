// The two views inbound share intake needs on the roster.
//
// A share arrives as text and nothing else: no conversation, no thread, no
// intent about who should receive it. The sending app knew nothing about
// Muster, so choosing the destination is the owner's job — which is why this
// is a chooser rather than "put it in the first chat".
//
// Nothing here sends. Both views hand a choice back to ChatListView, which
// records it and navigates; the draft is written by ChatView once that
// conversation holds a composer lease.
import SwiftUI
import CompanionCore

/// One waiting share, in the roster's own row language: the words, and the
/// fact that they have not been sent.
struct SharedTextRow: View {
    let shared: SharedText

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "square.and.arrow.down")
                .foregroundStyle(Color.accentColor)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(shared.text)
                    .font(.system(size: 15))
                    .foregroundStyle(Color.primary)
                    .lineLimit(3)
                Text("Waiting to send")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// Which conversation should these words go to?
struct ShareTargetSheet: View {
    let shared: SharedText
    let chats: [ChatSummary]
    let onPick: (Chat) -> Void
    let onDiscard: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(shared.text)
                        .font(.system(size: 15))
                        .foregroundStyle(Color.secondary)
                        .textSelection(.enabled)
                } header: {
                    Text("Shared text")
                } footer: {
                    // The whole point of the picker: this has not been sent,
                    // and it will not be until the owner presses Send in the
                    // conversation they pick.
                    Text("Nothing has been sent. Pick a conversation, then press Send there.")
                }

                Section("Send to") {
                    ForEach(chats) { summary in
                        Button {
                            onPick(summary.chat)
                        } label: {
                            HStack(spacing: 12) {
                                FlowerAvatar(color: summary.chat.color, size: 34, state: "idle", seed: summary.chat.id)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(summary.chat.name)
                                        .font(.system(size: 15, weight: .medium))
                                        .foregroundStyle(Color.primary)
                                    if !summary.chat.subtitle.isEmpty {
                                        Text(summary.chat.subtitle)
                                            .font(.system(size: 12))
                                            .foregroundStyle(Color.secondary)
                                            .lineLimit(1)
                                    }
                                }
                                Spacer()
                            }
                            .contentShape(Rectangle())
                        }
                    }
                    if chats.isEmpty {
                        Text("No conversations yet.")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.secondary)
                    }
                }
            }
            .navigationTitle("Share to Muster")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard", role: .destructive) { onDiscard() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }
}
