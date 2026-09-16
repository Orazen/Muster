// The microphone and the voice.
//
// Everything that touches hardware lives here, on the iOS side of the
// boundary: Speech and AVFoundation do not exist in CompanionCore, and the
// phone's two radios — one for talking, one for listening — are the only
// parts of Walkie that cannot be tested from a Mac. Every *decision* about
// what to capture and what to say comes from CompanionCore's Walkie; these
// two classes only move electrons.
import AVFoundation
import CompanionCore
import Foundation
import Speech

/// One push-to-talk capture: hold, speak, release.
///
/// A fresh recogniser session per hold, deliberately. Walkie turns are short
/// commands, not dictation marathons; restarting is cheap, and it means a
/// dropped or errored session can never leak words into the next press.
@MainActor
final class TalkSession: NSObject, ObservableObject {
    enum Phase: Equatable {
        case idle
        case listening
        case denied(String)
    }

    @Published private(set) var phase: Phase = .idle
    /// The words as they arrive, for the live quote on the status card.
    @Published private(set) var partial = ""

    private var engine: AVAudioEngine?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var best = ""
    private var finish: CheckedContinuation<String, Never>?

    /// Both permissions the microphone path needs, in the order iOS asks
    /// for them. A false answer means the phone said no — the panel says so
    /// plainly and stays a working status board.
    static func requestPermissions() async -> Bool {
        let speech: Bool = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
        guard speech else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }

    /// Start a capture. Returns false when the recogniser or the microphone
    /// could not be opened — the panel shows why and the button resets.
    @discardableResult
    func begin() async -> Bool {
        guard phase != .listening else { return true }
        cancel()

        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            phase = .denied("Speech recognition is not available right now.")
            return false
        }
        self.recognizer = recognizer

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            phase = .denied("The microphone could not be opened.")
            return false
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request
        best = ""
        partial = ""

        let newEngine = AVAudioEngine()
        let input = newEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        newEngine.prepare()
        do { try newEngine.start() } catch {
            input.removeTap(onBus: 0)
            phase = .denied("The microphone could not be started.")
            return false
        }
        self.engine = newEngine

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal == true || error != nil
            Task { @MainActor in
                guard let self else { return }
                if let text {
                    self.best = text
                    self.partial = text
                }
                if final { self.resolve() }
            }
        }
        phase = .listening
        return true
    }

    /// End the capture and hand back the final words. Waits briefly for the
    /// recogniser to settle — a release that lands a token before the final
    /// result should not lose that token — then takes whatever it has.
    func end() async -> String {
        guard phase == .listening else { cancel(); return "" }
        request?.endAudio()
        let text = await withCheckedContinuation { continuation in
            finish = continuation
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                guard let self, self.finish != nil else { return }
                self.finish = nil
                continuation.resume(returning: self.best)
            }
        }
        teardown()
        phase = .idle
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Abandon the capture. The words go nowhere — but a continuation left
    /// unresolved would crash the app on deinit, so an `end()` already
    /// waiting is handed what it has rather than dropped.
    func cancel() {
        if let finish {
            self.finish = nil
            finish.resume(returning: best)
        }
        teardown()
        partial = ""
        if case .listening = phase { phase = .idle }
    }

    func clearError() {
        if case .denied = phase { phase = .idle }
    }

    // MARK: - Internals

    private func teardown() {
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        self.engine = nil
        // Hand the microphone back; the announcer's playback category takes
        // over when a reply is spoken, and nothing else in the app uses
        // audio, so an inactive session is the honest resting state.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func resolve() {
        partial = best
        guard let finish else { return }
        self.finish = nil
        finish.resume(returning: best)
    }
}

/// The speaker end of the radio: reads replies aloud, one at a time, newest
/// wins. Replay re-says the last thing it was given.
@MainActor
final class Announcer: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published private(set) var speaking = false
    @Published private(set) var canReplay = false

    /// Which face the utterance in flight belongs to, so the roster can pulse
    /// the bot whose answer is being read rather than every face at once.
    /// The watch publishes the same value through `WatchVoice`.
    @Published private(set) var activity: VoiceActivity?

    private let synth = AVSpeechSynthesizer()
    private var last: String?
    /// The scope travels with the replayable text, because Replay re-says the
    /// same words and should move the same face.
    private var lastScope: VoiceScope = .fleet

    override init() {
        super.init()
        synth.delegate = self
    }

    /// True while the utterance in flight is this thread's.
    func isSpeaking(threadId: String) -> Bool {
        speaking && (activity?.isSpeaking(threadId: threadId) ?? false)
    }

    func speak(_ text: String, scope: VoiceScope) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        last = trimmed
        lastScope = scope
        canReplay = true
        synth.stopSpeaking(at: .immediate)
        activity = VoiceActivity(scope: scope, text: trimmed)
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.rate = 0.5
        synth.speak(utterance)
    }

    func replay() {
        guard let last else { return }
        synth.stopSpeaking(at: .immediate)
        activity = VoiceActivity(scope: lastScope, text: last)
        let utterance = AVSpeechUtterance(string: last)
        utterance.rate = 0.5
        synth.speak(utterance)
    }

    func stop() {
        synth.stopSpeaking(at: .immediate)
        speaking = false
        activity = nil
    }

    // MARK: - Delegate

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in self.speaking = true }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.speaking = false
            self.activity = nil
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.speaking = false
            self.activity = nil
        }
    }
}
