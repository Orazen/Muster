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
//
// Replies go through the composer-lease system, not a raw send: the draft is
// owned by the conversation's ComposerContext, survives scene switches and
// reconnects, and the explicit Send requires a live connection — the same
// rules the chat composer follows.
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

    @State private var composerLease: ComposerViewLease?
    @State private var visible = false

    private var usesTitleInNavigationBar: Bool {
        ReaderText.isLongForm(message.body)
    }

    private var composerContext: ComposerContext {
        session.composerContext(for: chat)
    }

    var body: some View {
        let context = composerContext
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
                readerComposer(context: context)
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle(navigationTitle)
        .accessibilityIdentifier("watch-message-reader")
        .onAppear {
            visible = true
            if composerLease == nil { composerLease = session.viewComposer(context) }
        }
        .onChange(of: context) { _, next in
            if let composerLease { session.leaveComposer(composerLease) }
            composerLease = visible ? session.viewComposer(next) : nil
        }
        .onDisappear {
            visible = false
            if let composerLease { session.leaveComposer(composerLease) }
            composerLease = nil
        }
    }

    /// The reader's reply row: same draft, same lease rules, same honest
    /// disabled states as the chat composer — a reply typed here is the same
    /// message a reply typed there would be.
    @ViewBuilder
    private func readerComposer(context: ComposerContext) -> some View {
        let draft = session.composerDraft(context)
        let canEdit = session.canEditComposer(context, lease: composerLease)
        let canSend = session.canSendComposer(context, lease: composerLease)
        VStack(alignment: .leading, spacing: 8) {
            if let blockingMessage = draft.message {
                Text(blockingMessage).font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if !canEdit {
                Text("Reopen this conversation to write in its current task.")
                    .font(.caption2).foregroundStyle(.secondary)
            } else if session.status != .live {
                Text("Reconnect to send. Your draft stays here.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if draft.inFlight {
                ProgressView(draft.message == nil ? "Sending…" : "Waiting for the request to close…")
                    .font(.caption2)
            }
            TextField("Reply", text: Binding(
                get: { session.composerDraft(context).text },
                set: { session.editComposer($0, context: context, lease: composerLease) }
            ))
                .submitLabel(.done)
                .disabled(!canEdit)
                .accessibilityLabel("Message draft")
                .accessibilityIdentifier("watch-reader-reply")
            Button("Send") {
                WKInterfaceDevice.current().play(.click)
                session.submitComposer(context, lease: composerLease)
            }
                .disabled(!canSend)
                .accessibilityIdentifier("watch-reader-send")
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
