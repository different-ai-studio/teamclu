import Testing
import AMUXCore
@testable import AMUXUI

@Suite("ComposerState decision helpers")
struct ComposerStateTests {

    // MARK: rightButton
    //
    // `rightButton` used to take `isAgentActive` and return a `.stop` case that
    // overrode everything else. Both are gone — stopping a busy agent moved to
    // the chip bar, which knows *which* agent to stop, something a single
    // composer button could not express once sessions could hold several. The
    // test covering it went stale unnoticed because this target does not
    // compile in CI (no iOS job) and cannot compile under `swift test` (AMUXUI
    // is UIKit-only). Run it with:
    //
    //     xcodebuild test -scheme AMUXUI \
    //       -destination 'platform=iOS Simulator,name=iPhone 17 Pro'

    @Test("recording shows stopRecording")
    func recordingShowsStopRecording() {
        #expect(ComposerState.rightButton(hasText: false, voiceState: .recording) == .stopRecording)
        // Recording wins over having text: the mic is mid-capture, and sending
        // now would drop whatever has not been transcribed yet.
        #expect(ComposerState.rightButton(hasText: true, voiceState: .recording) == .stopRecording)
    }

    @Test("attachments without text show send")
    func attachmentsOnlyShowsSend() {
        #expect(ComposerState.rightButton(hasText: false, hasAttachments: true, voiceState: .idle) == .send)
        #expect(ComposerState.rightButton(hasText: false, hasAttachments: true, voiceState: .recording) == .stopRecording)
    }

    @Test("non-empty text shows send")
    func withTextShowsSend() {
        #expect(ComposerState.rightButton(hasText: true, voiceState: .idle) == .send)
        #expect(ComposerState.rightButton(hasText: true, voiceState: .done) == .send)
        #expect(ComposerState.rightButton(hasText: true, voiceState: .denied) == .send)
    }

    @Test("empty text shows mic")
    func emptyShowsMic() {
        #expect(ComposerState.rightButton(hasText: false, voiceState: .idle) == .mic)
        #expect(ComposerState.rightButton(hasText: false, voiceState: .done) == .mic)
        #expect(ComposerState.rightButton(hasText: false, voiceState: .denied) == .mic)
        // A failed recording still leaves an empty field, so the affordance is
        // "try again", not "send nothing".
        #expect(ComposerState.rightButton(hasText: false, voiceState: .error("oops")) == .mic)
    }

    // MARK: inputMode

    @Test("input shows waveform only while recording")
    func waveformOnlyWhileRecording() {
        #expect(ComposerState.inputMode(voiceState: .recording) == .waveform)
        #expect(ComposerState.inputMode(voiceState: .idle) == .textField)
        #expect(ComposerState.inputMode(voiceState: .done) == .textField)
        #expect(ComposerState.inputMode(voiceState: .denied) == .textField)
        #expect(ComposerState.inputMode(voiceState: .error("x")) == .textField)
    }
}
