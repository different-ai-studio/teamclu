import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Pinned under the session list: the way into a new session.
///
/// The field is a stand-in, not a text field — tapping it opens
/// `NewSessionSheet` with the keyboard already up, which is where the agent,
/// workspace, idea and app are chosen. The mic beside it skips all of that and
/// hands a spoken take straight to the default agent.
struct HomeComposerBar: View {
    /// The default agent's name for the placeholder, nil when there is none
    /// yet (no agents, or a default that is no longer reachable).
    let agentName: String?
    let transitionNamespace: Namespace.ID
    let onCompose: () -> Void
    let onVoice: () -> Void

    var body: some View {
        LiquidGlassContainer(spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Button(action: onCompose) {
                    HStack {
                        Text(placeholder)
                            .font(.body)
                            .foregroundStyle(Color.amux.slate)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 16)
                    .frame(height: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .liquidGlass(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .matchedTransitionSource(id: "newSession", in: transitionNamespace)
                .accessibilityLabel("New Session")
                .accessibilityIdentifier("sessions.composerField")

                Button {
                    Haptics.tap()
                    onVoice()
                } label: {
                    Image(systemName: "mic")
                        .font(.title3)
                        .foregroundStyle(Color.amux.onyx)
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .liquidGlass(in: Circle())
                .accessibilityLabel("Voice")
                .accessibilityIdentifier("sessions.voiceButton")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        // Into the home-indicator reserve, to the same 22pt off the screen
        // edge that SessionDetailView's resting composer sits at — so the bar
        // doesn't jump when a session pushes in over it.
        .padding(.bottom, -12)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sessions.composerBar")
    }

    private var placeholder: String {
        guard let agentName, !agentName.isEmpty else { return String(localized: "Message") }
        return String(localized: "Message \(agentName)…")
    }
}
