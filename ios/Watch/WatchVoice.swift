// Reading a reply aloud.
//
// AVSpeechSynthesizer is local, needs no permission and no network, which is
// the whole reason it fits a wrist: the phone's Walkie does push-to-talk in
// the other direction, and this is the return path without a second socket.
//
// Deliberately narrow:
//   - Never automatic. A watch that starts talking because a bot replied is a
//     watch people take off. Every utterance begins with a tap.
//   - One utterance at a time, cancellable by the same control that started
//     it, with a visible STOP — the rule the reference voice apps state and
//     the one that keeps a wrist honest.
//   - Text is prepared by `SpeechText` in the core, so code blocks are never
//     read and a long reply is bounded before it reaches the speaker.
import AVFoundation
import Combine
import CompanionCore
import Foundation

/// Speaks one prepared string at a time.
@MainActor
final class WatchVoice: ObservableObject {
    /// True from the moment an utterance is queued until it finishes, is
    /// stopped, or fails. Drives the STOP control and the flower's pulse.
    @Published private(set) var speaking = false

    /// What is currently being read, and whose face it belongs to. Published
    /// so every flower on screen can decide for itself whether it is the one
    /// that should move — the fleet header pulses for the status line, a chat
    /// pulses only for its own thread.
    @Published private(set) var activity: VoiceActivity?

    /// True when the utterance in flight is this thread's.
    func isSpeaking(threadId: String) -> Bool {
        speaking && (activity?.isSpeaking(threadId: threadId) ?? false)
    }

    /// True when the utterance in flight is the fleet-level status.
    var isSpeakingFleet: Bool {
        speaking && (activity?.isFleetSpeech ?? false)
    }

    private let synthesizer = AVSpeechSynthesizer()
    /// AVSpeechSynthesizer holds its delegate weakly and calls it off the main
    /// actor, so the proxy is owned here and hops back.
    private let proxy = SpeechDelegateProxy()

    init() {
        proxy.onChange = { [weak self] active in
            Task { @MainActor in
                self?.speaking = active
                // The synthesizer can finish on its own; clearing the scope
                // here keeps a face from pulsing after the voice has stopped.
                if !active { self?.activity = nil }
            }
        }
        synthesizer.delegate = proxy
    }

    /// Read `source` aloud, or do nothing when there is nothing to say.
    ///
    /// Returns whether speech started, so a caller can tell "silent because
    /// this was all code" from "silent because it failed".
    @discardableResult
    func speak(_ source: String, scope: VoiceScope = .fleet) -> Bool {
        guard let activity = VoiceActivity(scope: scope, source: source) else { return false }
        return speak(activity)
    }

    /// Read a prepared activity aloud. The scope travels with the utterance so
    /// the face that pulses is the one the words are about.
    @discardableResult
    func speak(_ activity: VoiceActivity) -> Bool {
        stop()
        let utterance = AVSpeechUtterance(string: activity.text)
        utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        // A little under the default rate: a reply is usually the first time
        // the words have been heard, not a reread.
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
        self.activity = activity
        speaking = true
        synthesizer.speak(utterance)
        return true
    }

    func stop() {
        guard synthesizer.isSpeaking || speaking else { return }
        synthesizer.stopSpeaking(at: .immediate)
        speaking = false
        activity = nil
    }

    func toggle(_ activity: VoiceActivity) {
        if speaking { stop() } else { speak(activity) }
    }

    /// Toggle for a caller holding a finished sentence rather than markdown —
    /// the fleet status line, which is already words.
    func toggle(_ source: String, scope: VoiceScope) {
        guard let activity = VoiceActivity.prepared(scope: scope, text: source) else { return }
        toggle(activity)
    }
}

/// The synthesizer's delegate, off the main actor by necessity. It carries one
/// closure back and nothing else.
private final class SpeechDelegateProxy: NSObject, AVSpeechSynthesizerDelegate {
    var onChange: ((Bool) -> Void)?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        onChange?(true)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onChange?(false)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onChange?(false)
    }
}