import SwiftUI
import AMUXSharedUI

/// Full-bleed capture surface behind the tab bar's mic control.
///
/// Selecting that tab starts the recorder immediately, so this is never a
/// landing page — it *is* the take: a live level meter, the partial transcript
/// as it lands, and one verb. Done hands the transcript to
/// `VoiceSessionStarter`, which creates the session and navigates into it.
struct VoiceCaptureView: View {
    enum Phase: Equatable {
        /// Between the tap and the first audio buffer — TCC prompt on a first
        /// run, then engine start.
        case preparing
        case recording
        /// The take is in, but there is no default agent to send it to — the
        /// picker is up over this screen.
        case awaitingAgent
        /// The take is in; the session is being created.
        case startingSession
    }

    let phase: Phase
    /// 0...1 normalized input level, driving the meter's swing.
    let level: Float
    let transcript: String
    /// When the current take started, for the elapsed readout. Nil until
    /// capture is actually running.
    let startedAt: Date?
    let onDone: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            elapsed
            meter
            caption
            Spacer(minLength: 24)
            actions
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.amux.mist)
    }

    @ViewBuilder
    private var elapsed: some View {
        if phase == .recording, let startedAt {
            TimelineView(.periodic(from: startedAt, by: 1)) { context in
                Text(Self.clock(context.date.timeIntervalSince(startedAt)))
                    .font(.system(.footnote, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(Color.amux.slate)
                    .monospacedDigit()
            }
            .padding(.bottom, 32)
        }
    }

    @ViewBuilder
    private var meter: some View {
        switch phase {
        case .preparing:
            // Same footprint as the live meter so the transition into
            // `.recording` doesn't shift the layout under the user.
            VoiceLevelMeter(level: 0, animating: false)
                .padding(.horizontal, 32)
        case .recording:
            VoiceLevelMeter(level: level, animating: true)
                .padding(.horizontal, 32)
        case .awaitingAgent:
            VoiceLevelMeter(level: 0, animating: false)
                .padding(.horizontal, 32)
        case .startingSession:
            ProgressView()
                .controlSize(.large)
                .frame(height: VoiceLevelMeter.height)
        }
    }

    @ViewBuilder
    private var caption: some View {
        VStack(spacing: 12) {
            if let hint {
                Text(hint)
                    .font(.amuxSerif(19))
                    .foregroundStyle(Color.amux.slate)
                    .multilineTextAlignment(.center)
            }
            if !transcript.isEmpty {
                ScrollView {
                    Text(transcript)
                        .font(.amuxSerif(21))
                        .foregroundStyle(Color.amux.onyx)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
                .defaultScrollAnchor(.bottom)
                .scrollIndicators(.hidden)
                .frame(maxHeight: 180)
            }
        }
        .padding(.horizontal, 32)
        .padding(.top, 32)
    }

    /// The one line of prose above the transcript. Nil once words are landing
    /// — the transcript says "we are listening" better than a label does.
    private var hint: String? {
        switch phase {
        case .preparing:
            String(localized: "Getting the microphone ready\u{2026}")
        case .recording:
            transcript.isEmpty ? String(localized: "Listening\u{2026}") : nil
        case .awaitingAgent:
            String(localized: "Choose an agent for this chat.")
        case .startingSession:
            String(localized: "Starting your agent\u{2026}")
        }
    }

    @ViewBuilder
    private var actions: some View {
        if phase == .preparing || phase == .recording {
            VStack(spacing: 14) {
                Button(action: onDone) {
                    Image(systemName: "checkmark")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Color.amux.mist)
                        .frame(width: 72, height: 72)
                        .background(Color.amux.cinnabar, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(phase != .recording)
                .opacity(phase == .recording ? 1 : 0.35)
                .accessibilityIdentifier("voice.stopRecordingButton")
                .accessibilityLabel("Done recording")

                Text("Done")
                    .font(.footnote)
                    .foregroundStyle(Color.amux.basalt)

                Button("Cancel", action: onCancel)
                    .font(.subheadline)
                    .foregroundStyle(Color.amux.slate)
                    .buttonStyle(.plain)
                    .padding(.top, 10)
                    .accessibilityIdentifier("voice.cancelRecordingButton")
            }
            .padding(.bottom, 44)
        }
    }

    private static func clock(_ seconds: TimeInterval) -> String {
        let total = Int(max(0, seconds))
        return String(format: "%02d:%02d", total / 60, total % 60)
    }
}

/// Column of capsules whose heights ride a travelling wave scaled by the live
/// input level: a gentle pulse in silence so the screen reads as listening, a
/// wide swing when someone is actually talking.
private struct VoiceLevelMeter: View {
    static let height: CGFloat = 132

    let level: Float
    let animating: Bool
    var barCount: Int = 21

    var body: some View {
        Group {
            if animating {
                TimelineView(.animation) { context in
                    bars(time: context.date.timeIntervalSinceReferenceDate)
                }
            } else {
                bars(time: 0)
            }
        }
        .frame(height: Self.height)
    }

    private func bars(time: TimeInterval) -> some View {
        HStack(alignment: .center, spacing: 5) {
            ForEach(0..<barCount, id: \.self) { index in
                Capsule()
                    .fill(Color.amux.cinnabar.opacity(0.3 + 0.55 * bell(index)))
                    .frame(width: 4, height: barHeight(index, time: time))
            }
        }
        .frame(height: Self.height, alignment: .center)
    }

    /// 0 at the edges, 1 in the middle — gives the column a spindle silhouette
    /// instead of a flat block.
    private func bell(_ index: Int) -> Double {
        sin(Double(index) / Double(max(barCount - 1, 1)) * .pi)
    }

    private func barHeight(_ index: Int, time: TimeInterval) -> CGFloat {
        let l = Double(max(0, min(1, level)))
        let wave = (sin(time * 5 + Double(index) * 0.55) + 1) / 2   // 0...1
        let swing = bell(index) * (0.35 + 0.65 * wave) * (0.2 + 0.8 * l)
        let normalized = min(1, 0.06 + swing)
        return max(4, normalized * Self.height)
    }
}

#Preview("Recording") {
    VoiceCaptureView(
        phase: .recording,
        level: 0.55,
        transcript: "帮我看一下昨天那个部署为什么失败了",
        startedAt: Date().addingTimeInterval(-7),
        onDone: {},
        onCancel: {}
    )
}

#Preview("Preparing") {
    VoiceCaptureView(phase: .preparing, level: 0, transcript: "",
                     startedAt: nil, onDone: {}, onCancel: {})
}

#Preview("Starting session") {
    VoiceCaptureView(phase: .startingSession, level: 0,
                     transcript: "帮我看一下昨天那个部署为什么失败了",
                     startedAt: nil, onDone: {}, onCancel: {})
}
