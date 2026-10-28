import AMUXCore

enum ComposerRightButton: Equatable {
    case stopRecording // voice recording in progress — finish recording
    case send          // idle, text or attachments to send
    case mic           // idle, nothing to send — start recording
}

enum ComposerInputMode: Equatable {
    case textField
    case waveform
}

enum ComposerState {
    /// Right-side button next to the text input. Multi-agent sessions
    /// removed the in-input stop button — interrupts now live on each
    /// agent's chip card above the composer (so you can stop one
    /// runtime without affecting the others).
    /// Attachments alone count as something to send: with an image in the
    /// tray and an empty field the button used to stay a mic, so a picture
    /// could not go out without typing something first.
    static func rightButton(
        hasText: Bool,
        hasAttachments: Bool = false,
        voiceState: VoiceRecorder.State
    ) -> ComposerRightButton {
        if voiceState == .recording { return .stopRecording }
        return hasText || hasAttachments ? .send : .mic
    }

    static func inputMode(voiceState: VoiceRecorder.State) -> ComposerInputMode {
        voiceState == .recording ? .waveform : .textField
    }
}
