// What is being read aloud, and whose face moves while it happens.
//
// Both surfaces speak — the watch through `WatchVoice`, the phone through
// Walkie's `Announcer` — and both draw the same flower. Without one shared
// answer to "who is talking", the two screens animate different faces for the
// same utterance, which is the kind of drift the pose table was centralised to
// prevent. So the scope lives here, as a value, and each speaker publishes one.
//
// The text is prepared by the caller's own stripper, deliberately. The watch
// uses `SpeechText`; the phone uses `Walkie.spokenText`, which also drops
// tables and block markers. Swapping either would change what a voice reads
// aloud, which is a behaviour change and not a refactor.
import Foundation

/// Which face a spoken utterance belongs to. A fleet-level line — the watch's
/// aggregate status — belongs to no bot in particular.
public enum VoiceScope: Equatable, Sendable, Hashable {
    case fleet
    case thread(String)
}

public struct VoiceActivity: Equatable, Sendable {
    public let scope: VoiceScope
    public let text: String

    public init(scope: VoiceScope, text: String) {
        self.scope = scope
        self.text = text
    }

    /// From raw markdown, prepared by `SpeechText`. Nil when there is nothing
    /// worth hearing — a reply that is only a code block, say — so a caller
    /// never starts a silent utterance.
    public init?(scope: VoiceScope, source: String) {
        guard let spoken = SpeechText.spoken(source) else { return nil }
        self.init(scope: scope, text: spoken)
    }

    /// From text a platform-specific preparer already stripped. Nil for empty
    /// for the same reason as above.
    public static func prepared(scope: VoiceScope, text: String) -> VoiceActivity? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return VoiceActivity(scope: scope, text: trimmed)
    }

    /// True for the aggregate status line, which the fleet header shows.
    public var isFleetSpeech: Bool { scope == .fleet }

    /// True when this utterance belongs to the thread in question. A
    /// fleet-level utterance answers false for every thread: it is about the
    /// fleet, and pulsing an arbitrary bot's face for it would be a lie.
    public func isSpeaking(threadId: String) -> Bool {
        if case let .thread(id) = scope { return id == threadId }
        return false
    }
}