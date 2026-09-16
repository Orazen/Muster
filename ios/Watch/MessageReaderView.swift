// A reply, full screen, at reading size.
//
// The chat list shows the tail of a conversation in bubbles, which is right
// for "what did it just say" and wrong for an answer with a list and a
// snippet in it: at bubble width a structured reply is a column of wrapped
// fragments. Codex Watch's reader screen is the fix, and this is the same
// shape — the full message, rendered markdown, with Reply one tap away.
//
// The title rule is `ReaderText`'s, in the core, so both this and any future
// reader agree on when the heading moves into the navigation bar.
import SwiftUI
import WatchKit
import CompanionCore

/// One message, ready to read. A value rather than a `Message` so the view
/// has no opinion about the wire shape, and so the preview has something to
/// build.
struct ReadableMessage: Identifiable {
    let id: String
    let title: String
    let body: String
    let from: Sender?
}

struct MessageReaderView: View {
    @EnvironmentObject private var session: WatchSession
    @EnvironmentObject private var voice: WatchVoice
    @Environment(\.dismiss) private var dismiss

    let message: ReadableMessage
    /// The thread this message belongs to, so the reader can reply into it
    /// and pulse the right flower while it reads.
    let chat: WatchChat

    @State private var draft = ""

    private var usesTitleInNavigationBar: Bool {
        ReaderText.isLongForm(message.body)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let from = message.from {
                    Text(from.name)
                        .font(.caption2)
                        .foregroundStyle(WatchPalette.color(from.color))
                }

                if !usesTitleInNavigationBar, !message.title.isEmpty {
                    Text(message.title)
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("watch-reader-title")
                }

                WatchMarkdown(source: message.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("watch-reader-body")

                if let activity = speechActivity {
                    Button {
                        voice.toggle(activity)
                    } label: {
                        Label(
                            isReadingThisMessage ? "Stop" : "Read aloud",
                            systemImage: isReadingThisMessage ? "stop.fill" : "speaker.wave.2.fill"
                        )
                    }
                    .tint(isReadingThisMessage ? .red : .accentColor)
                    .accessibilityIdentifier("watch-reader-speak")
                }

                // Replying from here, rather than sending the reader back to
                // the chat, is the whole point of opening a long answer: you
                // have just read it, and the answer is usually one line.
                TextField("Reply", text: $draft)
                    .onSubmit { send() }
                    .accessibilityIdentifier("watch-reader-reply")
                Button("Send") { send() }
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("watch-reader-send")
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle(navigationTitle)
        .accessibilityIdentifier("watch-message-reader")
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        draft = ""
        WKInterfaceDevice.current().play(.click)
        Task {
            switch chat {
            case let .bot(bot): await session.send(text, to: bot)
            case let .room(room): await session.send(text, to: room)
            }
        }
    }

    private var navigationTitle: String {
        usesTitleInNavigationBar ? message.title : chat.name
    }

    /// The reader's own utterance, scoped to the thread so the roster row for
    /// this bot is what moves — not the fleet face.
    private var speechActivity: VoiceActivity? {
        VoiceActivity(scope: .thread(chat.threadId), source: message.body)
    }

    private var isReadingThisMessage: Bool {
        voice.isSpeaking(threadId: chat.threadId)
    }
}