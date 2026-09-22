import AVFoundation
import Foundation
import Observation
import Speech

/// Cross-platform speech-to-text recorder used by both iOS (record → review
/// bubble → Edit/Send) and macOS (live transcript into the reply field).
///
/// Two overlapping APIs cover the two UX patterns:
///
/// - `toggle()` / `cancel()` — macOS style. Stopping returns to `.idle` and
///   leaves the transcript in `transcript` so the caller can keep using it.
///
/// - `startRecording()` / `stopRecording()` / `reset()` — iOS style. Stopping
///   transitions to `.done` once recognition finalizes (or after a 500 ms
///   fallback) so the UI can render a review bubble gated on `state == .done`.
///
/// Both APIs share the same capture pipeline and observable state, so there is
/// only ever one recorder running per instance.
@Observable @MainActor
public final class VoiceRecorder {
    public enum State: Equatable {
        case idle
        case recording
        /// Set after `stopRecording()` finishes recognition. Only reached via
        /// the iOS-style API; `toggle()`/`cancel()` always return to `.idle`.
        case done
        case denied
        case error(String)
    }

    public private(set) var state: State = .idle
    /// Live transcript while recording, retained after stop until cleared by
    /// `cancel()` / `reset()` or the next `startRecording()`.
    public private(set) var transcript: String = ""
    /// Normalized 0...1 audio level sampled from the input buffer; useful for
    /// waveform visualizations. Resets to 0 on cancel/reset.
    public private(set) var audioLevel: Float = 0

    /// Nil-when-empty alias the iOS UI uses to gate its review bubble without
    /// having to check both `state` and `transcript.isEmpty`.
    public var transcribedText: String? {
        transcript.isEmpty ? nil : transcript
    }

    private let recognizer = SFSpeechRecognizer(locale: Locale.current)
    private let contextualStrings: [String]
    private var audioEngine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    public init(contextualStrings: [String] = []) {
        self.contextualStrings = contextualStrings
    }

    // MARK: - macOS-style API

    public func toggle() {
        switch state {
        case .recording:
            tearDown(targetState: .idle, clearTranscript: false)
        case .idle, .done, .denied, .error:
            requestAndStart()
        }
    }

    public func cancel() {
        tearDown(targetState: .idle, clearTranscript: true)
    }

    // MARK: - iOS-style API

    public func startRecording() { requestAndStart() }

    /// Ends audio capture; state reaches `.done` when recognition finalizes.
    /// A 500 ms fallback forces the transition if the recognizer stalls.
    public func stopRecording() {
        guard state == .recording else { return }
        request?.endAudio()
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            if self?.state == .recording { self?.state = .done }
        }
    }

    public func reset() { cancel() }

    // MARK: - Private

    private func requestAndStart() {
        let finishAuthorization: @Sendable (SFSpeechRecognizerAuthorizationStatus) -> Void = { [weak self] status in
            // TCC invokes this completion on a worker queue. The callback is
            // deliberately `@Sendable` and registered from a nonisolated
            // helper, so it cannot inherit this class's MainActor isolation.
            // Hop back only after TCC has called it.
            Task.detached { @MainActor [weak self] in
                guard let self else { return }
                guard status == .authorized else { self.state = .denied; return }
                self.beginCapture()
            }
        }
        Self.requestSpeechAuthorization(finishAuthorization)
    }

    nonisolated private static func requestSpeechAuthorization(
        _ completion: @escaping @Sendable (SFSpeechRecognizerAuthorizationStatus) -> Void
    ) {
        SFSpeechRecognizer.requestAuthorization(completion)
    }

    private func beginCapture() {
        guard let recognizer, recognizer.isAvailable else {
            state = .error("Speech recognizer unavailable")
            return
        }

        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if !contextualStrings.isEmpty {
            request.contextualStrings = contextualStrings
        }

        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try? session.setActive(true, options: .notifyOthersOnDeactivation)
        #endif

        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        // The input-node tap runs on Core Audio's realtime worker. Keep the
        // callback fully nonisolated; even a weak capture of this MainActor
        // recorder makes Swift 6 assert before its body can schedule a Task.
        let publishAudioLevel: @Sendable (Float) -> Void = { [weak self] level in
            Task.detached { @MainActor [weak self] in
                self?.audioLevel = level
            }
        }
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
            guard let channelData = buffer.floatChannelData?[0] else { return }
            let frameLength = Int(buffer.frameLength)
            var sum: Float = 0
            for i in 0..<frameLength { sum += abs(channelData[i]) }
            let avg = sum / Float(max(frameLength, 1))
            let level = min(max(avg * 5, 0), 1)
            publishAudioLevel(level)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            state = .error(error.localizedDescription)
            return
        }

        self.audioEngine = engine
        self.request = request
        self.transcript = ""
        self.audioLevel = 0
        self.state = .recording

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            Task { @MainActor in
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                }
                if error != nil || result?.isFinal == true {
                    self.finalizeRecognition()
                }
            }
        }
    }

    /// Recognition callback path — audio has ended, transition to `.done`
    /// (iOS review-bubble flow) without clearing the transcript.
    private func finalizeRecognition() {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        task?.cancel()
        audioEngine = nil
        task = nil
        request = nil
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
        audioLevel = 0
        if state == .recording { state = .done }
    }

    /// Explicit teardown — used by toggle/cancel/reset. Targets either
    /// `.idle` or another state, and optionally clears the transcript.
    private func tearDown(targetState: State, clearTranscript: Bool) {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.finish()
        audioEngine = nil
        request = nil
        task = nil
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
        if clearTranscript { transcript = "" }
        audioLevel = 0
        state = targetState
    }
}
