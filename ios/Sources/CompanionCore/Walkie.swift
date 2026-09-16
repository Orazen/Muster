// The pure half of the Walkie panel — the walkie-talkie surface.
//
// Everything here is a decision about what the panel shows and what the
// phone should say out loud, made from the same folded state the roster
// already reads. The hardware — microphone, recogniser, synthesiser — lives
// in the App target, because Speech and AVFoundation do not exist here;
// this file is what those parts consult, and it is the part that can be
// tested without a mouth.
import Foundation

public enum Walkie {
    /// What the bot is doing, as far as the panel is concerned. Derived from
    /// the same fields the roster row shows, so the two can never disagree.
    public enum Status: Equatable, Sendable {
        case working
        case waitingOnYou
        case ready
    }

    /// The line the status card quotes under the headline.
    public struct Quote: Equatable, Sendable {
        public let text: String
        /// True while the words are still arriving — your own live
        /// transcript, or a reply mid-stream. False for settled text.
        public let live: Bool

        public init(text: String, live: Bool) {
            self.text = text
            self.live = live
        }
    }

    private static func words(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else { return nil }
        return trimmed
    }

    public static func status(bot: Bot, state: CompanionState) -> Status {
        if bot.busy == true { return .working }
        if state.pendingApprovals.contains(where: { $0.threadId == bot.threadId }) { return .waitingOnYou }
        return .ready
    }

    /// The roster row's second line.
    public static func statusLine(_ status: Status) -> String {
        switch status {
        case .working: return "Working…"
        case .waitingOnYou: return "Waiting on you"
        case .ready: return "Ready"
        }
    }

    /// The status card's quote. Priority is the radio, not the archive: what
    /// you are saying right now beats a reply still streaming in, which beats
    /// the settled transcript. While the bot works, the settled line is your
    /// last words to it — the echo of the transmission, the way a real
    /// walkie leaves the last message up while the other end thinks.
    /// Otherwise it is its last answer to you.
    public static func quote(bot: Bot, state: CompanionState, partial: String? = nil) -> Quote? {
        if let partial, let text = words(partial) { return Quote(text: text, live: true) }
        if let streaming = words(state.streaming[bot.threadId]) { return Quote(text: streaming, live: true) }

        let transcript = state.visibleTranscript(forThread: bot.threadId)
        switch status(bot: bot, state: state) {
        case .working:
            if let said = transcript.last(where: { $0.role == .user && $0.kind == .text }),
               let text = words(said.text) {
                return Quote(text: text, live: false)
            }
        case .waitingOnYou:
            if let card = transcript.last(where: { $0.card?.isPending == true })?.card {
                return Quote(text: card.title, live: false)
            }
        case .ready:
            if let answer = transcript.last(where: { $0.role == .bot && $0.kind == .text }),
               let text = words(answer.text) {
                return Quote(text: text, live: false)
            }
        }
        return nil
    }

    /// The reply the phone should speak next: the newest settled bot text
    /// message, unless that is the one already spoken. `lastSpokenId` is
    /// seeded to the transcript's end when a bot is selected, so opening the
    /// panel never reads history aloud. Walking backwards stops at the seed
    /// rather than skipping past it: anything older was there before you
    /// started listening, and re-speaking it is a bug, not a courtesy.
    public static func nextSpeakable(in transcript: [Message], after lastSpokenId: String?) -> Message? {
        for message in transcript.reversed() {
            guard message.id != lastSpokenId else { return nil }
            if message.role == .bot, message.kind == .text, words(message.text) != nil {
                return message
            }
        }
        return nil
    }

    /// Markdown to words a voice can read.
    ///
    /// The synthesiser reads characters, not structure, so structure has to
    /// come out first: fenced code is dropped whole (reading JSON aloud is
    /// noise, not content), table rows are dropped (pipes and alignment
    /// dashes are meaningless spoken), block markers — headings, quotes,
    /// list bullets — are stripped from line starts, and inline markup is
    /// resolved by Foundation's own parser so `[text](url)` says "text" and
    /// not the URL. A line of nothing but rules is dropped too.
    public static func spokenText(_ source: String) -> String {
        var kept: [String] = []
        var inFence = false
        for raw in source.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                inFence.toggle()
                continue
            }
            if inFence { continue }
            if line.isEmpty { continue }
            if line.hasPrefix("|") { continue }
            if line.allSatisfy({ $0 == "-" || $0 == "_" || $0 == "*" || $0 == " " } ), line.contains("-") || line.contains("_") { continue }
            kept.append(stripBlockMarkers(line))
        }
        let joined = kept.joined(separator: " ")
        let inline = (try? AttributedString(
            markdown: joined,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )).map { String($0.characters) } ?? joined
        return inline
            .split(whereSeparator: { $0.isWhitespace || $0.isNewline })
            .joined(separator: " ")
    }

    /// Drops the block-level prefix of one line: `# ` headings at any depth,
    /// `> ` quotes, `-`/`*`/`+` bullets, and `1. ` ordinals. Deliberately
    /// character-wise rather than regex: these are the only shapes markdown
    /// puts at a line start, and a pattern library is not worth importing
    /// for four prefixes.
    private static func stripBlockMarkers(_ line: String) -> String {
        var s = Substring(line)
        if s.allSatisfy({ $0 == "#" }), !s.isEmpty { return "" }
        while s.first == "#" { s = s.dropFirst() }
        if s.first == ">" { s = s.dropFirst() }
        if let first = s.first, first == "-" || first == "*" || first == "+" {
            s = s.dropFirst()
        } else if let dot = s.firstIndex(of: "."),
                  s[s.startIndex..<dot].allSatisfy({ $0.isNumber }),
                  s[s.startIndex..<dot].count > 0 {
            s = s[s.index(after: dot)...]
        }
        return String(s).trimmingCharacters(in: .whitespaces)
    }
}
