// Conversation: transcript, live approval card, and the composer.
//
// Loading (empty), streaming, approval-pending and waiting-for-device
// states are all exercised with fixture data — the states M0 must
// demonstrate. The streaming state is a local timer growing a bot reply;
// it proves the in-flight tail rendering without any network.

import CompanionCore
import MusterMacCore
import SwiftUI

struct ConversationView: View {
    @EnvironmentObject private var model: PrototypeModel

    var body: some View {
        VStack(spacing: 0) {
            transcript
            if model.pendingCardMessage != nil {
                ApprovalCardView()
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }
            ComposerView()
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if model.selectedMessages.isEmpty {
                        emptyState
                    }
                    ForEach(model.selectedMessages) { message in
                        MessageRow(message: message)
                            .id(message.id)
                    }
                    if model.streaming {
                        StreamingRow()
                            .id("streaming-tail")
                    }
                }
                .padding(16)
            }
            .onChange(of: model.selectedMessages.count) { _ in
                if let last = model.selectedMessages.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            FlowerView(colorName: nil, busy: false)
                .frame(width: 64, height: 64)
            Text("Nothing here yet")
                .font(.headline)
            Text("This fixture conversation is empty — select another bot or compose a local draft.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }
}

struct MessageRow: View {
    let message: Message

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if message.role == .user { Spacer(minLength: 48) }
            switch message.kind {
            case .activity:
                HStack(spacing: 5) {
                    Image(systemName: (message.tool?.ok ?? false) ? "checkmark.circle" : "gearshape")
                        .font(.caption2)
                    Text(message.tool?.name ?? message.text ?? "Activity")
                        .font(.caption)
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.quinary, in: Capsule())
            case .options:
                // Historical card rendered inline; the live one is pinned
                // above the composer by ConversationView.
                Label(message.text ?? "Approval card", systemImage: "seal")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            default:
                VStack(alignment: .leading, spacing: 2) {
                    Text(message.role == .user ? "You" : "Muster")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(message.text ?? "")
                        .font(.body)
                        .textSelection(.enabled)
                }
                .padding(10)
                .background(message.role == .user ? Color.accentColor.opacity(0.14) : Color(nsColor: .controlBackgroundColor),
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            if message.role == .bot { Spacer(minLength: 48) }
        }
    }
}

struct StreamingRow: View {
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(.secondary).frame(width: 6, height: 6)
                .opacity(pulse ? 0.3 : 1)
            Circle().fill(.secondary).frame(width: 6, height: 6)
                .opacity(pulse ? 1 : 0.3)
            Circle().fill(.secondary).frame(width: 6, height: 6)
                .opacity(pulse ? 0.3 : 1)
            Text("arriving…")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .onAppear {
            // Reduced motion: show a steady tail, never a pulsing one.
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }
}

struct ComposerView: View {
    @EnvironmentObject private var model: PrototypeModel
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 4) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Ask anything, or let's take the next step…", text: $model.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .padding(8)
                    .background(.quinary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .focused($composerFocused)
                    .onSubmit(send)
                    .accessibilityIdentifier("composer-field")
                Button {
                    send()
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.callout.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 26, height: 26)
                        .background(Color.primary, in: RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.plain)
                .disabled(ComposerText.normalized(model.draft).isEmpty)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel("Send draft locally")
                .accessibilityIdentifier("composer-send")
            }
            Text("You choose what Muster can access. Actions wait for your approval. Fixture prototype — no model request is sent.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .background(.bar)
        .onAppear { composerFocused = true }
    }

    private func send() {
        let text = ComposerText.normalized(model.draft)
        guard !text.isEmpty else { return }
        _ = model.sendDraft()
        model.beginStreamingDemo()
    }
}

struct ApprovalCardView: View {
    @EnvironmentObject private var model: PrototypeModel

    var body: some View {
        if let pending = model.pendingCardMessage, let card = pending.card {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "hand.raised.fill")
                        .foregroundStyle(.orange)
                    Text(card.title)
                        .font(.headline)
                    Spacer()
                    Text("Approval needed")
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.orange.opacity(0.15), in: Capsule())
                }
                Text(card.subtitle)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                if let held = card.held {
                    Text(held)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let why = card.why {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Why: \(why.intent)")
                            .font(.caption)
                        Text(why.decisions.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 8) {
                    ForEach(card.options, id: \.self) { option in
                        ApprovalOptionButton(option: option)
                    }
                    Spacer()
                    Button("Dismiss") {
                        model.answerPendingCard(option: nil)
                    }
                    .buttonStyle(.link)
                    .accessibilityIdentifier("approval-Dismiss")
                }
            }
            .padding(12)
            .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(.orange.opacity(0.5), lineWidth: 1)
            )
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Approval needed: \(card.title)")
        }
    }
}

/// One answer choice on the approval card. Deny reads as a quiet refusal;
/// every other choice is prominent. Two plain branches, because button
/// styles don't compose through a ternary.
struct ApprovalOptionButton: View {
    @EnvironmentObject private var model: PrototypeModel
    let option: String

    private var isDeny: Bool { option == "Deny" }

    var body: some View {
        if isDeny {
            button.buttonStyle(.bordered)
        } else {
            button.buttonStyle(.borderedProminent)
        }
    }

    private var button: some View {
        Button {
            model.answerPendingCard(option: option)
        } label: {
            Text(option).frame(minWidth: 64)
        }
        .accessibilityIdentifier("approval-\(option)")
    }
}
