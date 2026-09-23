// A message, plain, with the system's own selection on it.
//
// The bubble itself cannot offer drag-to-select: long-press there already
// opens the reactions menu, and SwiftUI gives that gesture to whichever of
// the two asks last. So selecting part of a reply happens here instead —
// the same move Telegram and WhatsApp make, and for the same reason.
//
// Ported near-verbatim from the OpenMausBot companion's
// SelectableTextSheet (https://github.com/milind-soni/OpenMausBot,
// Apache-2.0 — full license text and attribution in
// public/third-party-notices.txt, shipped with the app).
import SwiftUI
import UIKit

struct SelectableTextSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView {
                // The raw text, not the rendered markdown: what gets copied
                // should be what the bot actually wrote, backticks and all.
                Text(text)
                    .textSelection(.enabled)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .accessibilityHint("Touch and hold to select part of this message")
            }
            .navigationTitle("Select Text")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        UIPasteboard.general.string = text
                        Haptics.selection()
                        withAnimation(.snappy) { copied = true }
                    } label: {
                        Label(copied ? "Copied" : "Copy All",
                              systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Text("Touch and hold the text to select part of it.")
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(.bar)
            }
        }
    }
}

/// A message's text on its way to the selection sheet.
struct SelectableText: Identifiable {
    let id = UUID()
    let text: String
}
