// Bot replies on a 45mm screen, rendered.
//
// The watch was drawing `**bold**` and `- bullet` as literal characters in
// its bubbles — the exact defect the phone's `MarkdownText` was written to
// fix, left unfixed on the smaller screen where raw markup costs the most
// room. `Markdown.blocks` already does the splitting in the core; this draws
// each block at watch sizes and hands the inline run to Foundation.
//
// Deliberately smaller than the phone's: 15pt body rather than 17, and a
// tighter block spacing, because the same reply has to fit a screen a third
// the width. The structure is identical, so a reply wraps the same way on
// both — only the type scale differs.
import SwiftUI
import CompanionCore

struct WatchMarkdown: View {
    let source: String
    var size: CGFloat = 15
    /// Drawn after the last block. The streaming bubble sets this so the live
    /// reply and the settled one share a layout.
    var caret: Bool = false

    var body: some View {
        let blocks = Markdown.blocks(source)
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { item in
                view(for: item.element, tail: caret && item.offset == blocks.count - 1)
            }
        }
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock, tail: Bool) -> some View {
        switch block {
        case let .paragraph(text):
            inline(text, tail: tail)
                .font(.system(size: size))
                .fixedSize(horizontal: false, vertical: true)

        case let .heading(level, text):
            // Two sizes, not six. There is no room on a wrist for a six-step
            // hierarchy, and an h3 that looks like body text is a heading
            // that failed.
            inline(text, tail: tail)
                .font(.system(size: level <= 2 ? size + 2 : size, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)

        case let .bullet(indent, text):
            marker("•", indent: indent, text: text, tail: tail)

        case let .ordered(indent, number, text):
            marker("\(number).", indent: indent, text: text, tail: tail)

        case let .quote(text):
            HStack(alignment: .top, spacing: 6) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.secondary.opacity(0.4))
                    .frame(width: 2)
                inline(text, tail: tail)
                    .font(.system(size: size))
                    .foregroundStyle(Color.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)

        case let .code(language, text):
            VStack(alignment: .leading, spacing: 3) {
                if let language, !language.isEmpty {
                    Text(language)
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundStyle(Color.secondary)
                }
                // Wrapping rather than side-scrolling: a watch has no room to
                // push text sideways, and a snippet the reader cannot see the
                // end of is worse than one that wraps.
                (Text(text) + caretText(tail))
                    .font(.system(size: 12, design: .monospaced))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.secondary.opacity(0.16))
            )

        case .rule:
            Divider()
        }
    }

    private func marker(_ symbol: String, indent: Int, text: String, tail: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(symbol)
                .font(.system(size: size))
                .foregroundStyle(Color.secondary)
                .frame(minWidth: 12, alignment: .trailing)
            inline(text, tail: tail).font(.system(size: size))
        }
        .padding(.leading, CGFloat(indent) * 10)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Inline markdown via Foundation. `.inlineOnlyPreservingWhitespace`
    /// because the blocks are already split — `.full` would re-interpret the
    /// markers this has consumed.
    ///
    /// Falling back to the raw string is the point: a half-typed link
    /// mid-stream shows as the characters sent so far rather than vanishing.
    private func inline(_ text: String, tail: Bool = false) -> Text {
        let rendered: Text
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            rendered = Text(attributed)
        } else {
            rendered = Text(text)
        }
        return rendered + caretText(tail)
    }

    private func caretText(_ tail: Bool) -> Text {
        tail ? Text("\u{2007}▍").foregroundStyle(Color.secondary) : Text("")
    }
}