// Composer dictation: the microphone side of `DictationFlow`.
//
// Speech and AVFoundation live here for the same boundary reason Walkie's
// do — hardware has no unit test. Every decision about *words* belongs to
// CompanionCore's `DictationFlow` (tested); this class asks iOS for the
// two permissions, drives `TalkSession`'s capture engine — proven by Walkie
// and deliberately not duplicated — and feeds each result into the flow.
//
// It never sends. Results are written back through the session as they
// arrive and a person presses Send, exactly like typing: the same rule the
// whole companion is built on.
import AVFoundation
import Combine
import CompanionCore
import Foundation
import Speech

@MainActor
final class DictationController: ObservableObject {
    /// The whole state the composer renders: phase, live draft, refusal.
    @Published private(set) var flow = DictationFlow()

    /// Walkie's capture engine, owned per-controller so a dictation in one
    /// chat is never Walkie's business. Fresh recogniser session per
    /// capture (TalkSession's own rule): a dropped recogniser cannot leak
    /// words into the next attempt.
    private let talk = TalkSession()
    /// Recognition results → the flow's replace rule. TalkSession publishes
    /// on the main actor; so does this sink.
    private var pump: AnyCancellable?

    init() {
        pump = talk.$partial
            .sink { [weak self] text in self?.flow.hear(text) }
    }

    var isListening: Bool { flow.phase == .listening }

    /// The mic was tapped. Starting requests both permissions in the order
    /// iOS presents them (each refusal gets its own honest message), then
    /// opens the capture against the draft as it stands. Stopping settles
    /// the recogniser and commits. Returns the text to write into the
    /// composer on a stop, or nil — starts and refusals write themselves
    /// through the partial pump (or not at all).
    func toggle(base: String) async -> String? {
        if isListening {
            _ = await talk.end()
            return flow.finish()
        }
        guard await authorized() else { return nil }
        // The flow listens *before* the microphone opens: TalkSession's
        // first partial can land as soon as the engine runs, and a result
        // arriving while the flow is idle is ignored by design (that rule
        // is what makes late callbacks safe). If the engine then fails to
        // open, the listening state it opened is finished — there are no
        // words yet, so commit changes nothing — and the refusal becomes
        // the phase the composer renders.
        flow.begin(base: base)
        guard await talk.begin() else {
            flow.finish()
            flow.refuse(talkFailure)
            return nil
        }
        return nil
    }

    /// The chat is going away mid-capture. Commit first, silence second:
    /// `cancel()` publishes an empty partial, and only a finished flow
    /// ignores it — the other order wipes exactly the words being saved.
    /// Returns the text the composer should keep.
    func detach() -> String {
        let text = flow.finish()
        talk.cancel()
        return text
    }

    /// Both permissions, in the order iOS asks for them. Distinct refusals,
    /// distinct messages: "speech is off" and "the microphone is off" are
    /// different Settings panes, and telling someone the wrong one wastes
    /// their time.
    private func authorized() async -> Bool {
        let speech: Bool = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
        guard speech else {
            flow.refuse("Speech recognition is off — allow it in Settings to dictate.")
            return false
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            flow.refuse("The microphone is off — allow it in Settings to dictate.")
            return false
        }
        return true
    }

    /// TalkSession's own refusal, if the engine would not open. Its three
    /// failure paths each set this freshly, so nothing stale can leak in.
    private var talkFailure: String {
        if case let .denied(why) = talk.phase { return why }
        return "Dictation could not start."
    }
}
