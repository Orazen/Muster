// The message reader's title decisions, without a view.
//
// The watch has one layout problem the phone does not: a 45mm screen has no
// room for a navigation title *and* a heading that say the same thing. Codex
// Watch solves it by promoting the title into the navigation bar once the
// body is long enough to need the space, and showing it inline when the body
// is short enough that a bare "Message" would be the only thing on screen.
//
// That decision is a pure function of the text, so it lives here rather than
// in the view: both clients must agree, and a rule about word counts is the
// kind of thing that is wrong in a way you only notice on a wrist.
import Foundation

public enum ReaderText {
    /// Above this many words the body is long enough to scroll, so the title
    /// earns the navigation bar. At or below it the whole message fits, and a
    /// nav title would cost a line of body for no gain.
    public static let longFormWordThreshold = 20

    /// What to put in the navigation bar. The caller's name for the thread is
    /// the fallback: a message with no heading is still a message from
    /// *someone*, and "Message" wastes the one label there is room for.
    public static func title(for body: String, fallback: String) -> String {
        if let heading = firstHeading(in: body) { return heading }
        return fallback
    }

    /// True when the title belongs in the navigation bar rather than inline
    /// above the body.
    public static func isLongForm(_ body: String) -> Bool {
        wordCount(body) > longFormWordThreshold
    }

    /// The first heading's text, or nil. The body's own title, when it has
    /// one — a reply that opens "# Result" is telling you what it is.
    public static func firstHeading(in body: String) -> String? {
        for block in Markdown.blocks(body) {
            if case let .heading(_, text) = block {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return nil
    }

    /// Whitespace-delimited words. The same count the reader uses, so the
    /// threshold means one thing everywhere.
    public static func wordCount(_ text: String) -> Int {
        text.split { $0.isWhitespace || $0.isNewline }.count
    }

    /// A one-paragraph taste of a long body, for the bubble that links to the
    /// reader. Cut on a word where one is near the limit, so the preview does
    /// not end mid-word.
    public static func preview(_ body: String, limit: Int = 140) -> String {
        let flat = plainText(body)
        guard flat.count > limit else { return flat }
        let cut = flat.index(flat.startIndex, offsetBy: limit)
        let head = String(flat[..<cut])
        guard let boundary = head.lastIndex(of: " ") else { return head + "…" }
        return String(head[..<boundary]).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// The body as one run of prose: block markers dropped, blocks joined
    /// with a space. For the preview, and deliberately lossy — the reader
    /// renders the real structure.
    public static func plainText(_ body: String) -> String {
        Markdown.blocks(body)
            .map { block in
                switch block {
                case let .paragraph(text): return text
                case let .heading(_, text): return text
                case let .bullet(_, text): return text
                case let .ordered(_, _, text): return text
                case let .quote(text): return text
                case let .code(_, text): return text
                case .rule: return ""
                }
            }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}