// Composer dictation, as the part that decides anything.
//
// The microphone itself is iOS-side (Speech/AVFoundation do not exist in
// this package, and must not — hardware has no honest unit test). What is
// testable is the part that has been getting dictation wrong since the
// first implementation anywhere: ownership of the words. A draft already
// holds what the user typed; a recogniser rewrites its whole transcript on
// every result; audio dies mid-sentence; callbacks arrive after the
// recogniser was told to stop. Each of those is a way to lose or duplicate
// someone's sentences, and none of them involve a microphone.
//
// So: `DictationFlow` snapshots the draft when the mic opens, treats every
// recognition result as a *replacement* of the capture's own tail, commits
// on every ending (stop, failure, abandonment), and ignores anything
// arriving while it is not listening. It has no send — a dictated message
// goes nowhere until a person sends it, which is the same rule the composer
// itself follows.

/// The composer's dictation session: whose words are these, and what
/// happens to them when the capture ends.
public struct DictationFlow: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case idle
        case listening
        /// Microphone or speech access refused, or the recogniser could not
        /// start. Carries the reason shown next to the field.
        case refused(String)
    }

    public private(set) var phase: Phase = .idle

    /// What the draft held before this capture. Typed words are the user's;
    /// they are never touched, only carried.
    private var base = ""
    /// This capture's transcript as the recogniser last stated it. Owned
    /// entirely by the flow — replaced, never accumulated.
    private var segment = ""

    public init() {}

    /// The draft as it should read right now: the user's text plus the
    /// words heard since the mic opened.
    public var draft: String { Self.join(base, segment) }

    /// The refusal to show by the field, if the last attempt ended in one.
    public var refusal: String? {
        if case let .refused(reason) = phase { return reason }
        return nil
    }

    /// The mic was tapped. Snapshots the draft as it stands — everything
    /// typed before speaking belongs to the user and is carried, not
    /// rewritten — and starts listening. A capture already in flight is
    /// left alone: re-snapshotting mid-sentence would fold dictated words
    /// into the base and then re-append them.
    public mutating func begin(base draft: String) {
        guard phase != .listening else { return }
        base = draft
        segment = ""
        phase = .listening
    }

    /// A recognition result arrived. It *replaces* the segment: a
    /// `bestTranscription` is the whole capture so far, so appending it
    /// would duplicate every word on every result. Ignored while not
    /// listening — a late callback from a recogniser already stopped must
    /// not rewrite a draft it no longer owns.
    public mutating func hear(_ transcript: String) {
        guard phase == .listening else { return }
        segment = transcript
    }

    /// The capture ended — the stop control, a dead microphone, or the
    /// screen going away. What was heard is what the person said, so it is
    /// committed into the base rather than dropped with the audio. Returns
    /// the text the composer should hold. Ending a capture that is not
    /// running returns the draft unchanged, so a double-tap cannot append
    /// the same words twice.
    @discardableResult
    public mutating func finish() -> String {
        guard phase == .listening else { return draft }
        base = draft
        segment = ""
        phase = .idle
        return base
    }

    /// Permission refused or the recogniser would not start. Nothing was
    /// heard, so the draft is exactly what it was; the reason is what the
    /// field shows. (Committing here would be wrong for the same reason
    /// dropping on finish would be: neither side may guess.)
    public mutating func refuse(_ reason: String) {
        guard phase != .listening else { return }
        segment = ""
        phase = .refused(reason)
    }

    /// Whitespace-only is no text at all: a segment the recogniser emitted
    /// as blank must not become a dangling space in the draft.
    private static func join(_ base: String, _ segment: String) -> String {
        let tail = segment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tail.isEmpty else { return base }
        guard !base.isEmpty else { return tail }
        // The draft's own edge decides the separator. A trailing space or
        // newline (pasted text, an unfinished line) already separates —
        // adding another would show up as a double space the user has to
        // hunt down before sending.
        if base.last?.isWhitespace == true { return base + tail }
        return base + " " + tail
    }
}
