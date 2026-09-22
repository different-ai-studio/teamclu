import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Offered after a voice take when there is no usable default agent — no
/// personal one, no team one, or one pointing at an agent the viewer can't
/// reach any more. The choice is remembered as the viewer's personal default,
/// so this asks once rather than on every take.
struct VoiceAgentPicker: View {
    let agents: [ConnectedAgent]
    let agentPresenceStore: AgentPresenceStore?
    let onPick: (ConnectedAgent) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                Color.amux.mist.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        HaiSectionLabel(String(localized: "Agents"))
                        HaiPaperCard {
                            ForEach(Array(agents.enumerated()), id: \.element.id) { index, agent in
                                Button { onPick(agent) } label: { row(agent) }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("voice.agentChoice.\(agent.id)")
                                if index < agents.count - 1 {
                                    Color.amux.hairline
                                        .frame(height: 0.5)
                                        .padding(.leading, 14)
                                }
                            }
                        }
                        Text("Voice chats go here from now on. Change it any time on the agent's page.")
                            .font(.caption2)
                            .foregroundStyle(Color.amux.slate)
                            .padding(.horizontal, 24)
                    }
                    .padding(.vertical, 14)
                }
            }
            .navigationTitle("Choose an agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.title3)
                            .foregroundStyle(Color.amux.basalt)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancel")
                    .accessibilityIdentifier("voice.agentChoice.cancel")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ agent: ConnectedAgent) -> some View {
        let online = agent.isOnline(
            devicePresence: agentPresenceStore?.presence(forAgent: agent.id) ?? .unknown
        )
        return HStack(spacing: 10) {
            Circle()
                .fill(online ? Color.amux.sage : Color.amux.slate)
                .frame(width: 8, height: 8)
            Text(agent.displayName)
                .font(.system(size: 14.5))
                .foregroundStyle(Color.amux.onyx)
                .lineLimit(1)
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.amux.slate)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .contentShape(Rectangle())
    }
}

#Preview {
    VoiceAgentPicker(
        agents: [
            ConnectedAgent(id: "a1", displayName: "oect-matt", permissionLevel: "full",
                           lastActiveAt: Date()),
            ConnectedAgent(id: "a2", displayName: "build-box", permissionLevel: "ask",
                           lastActiveAt: Date().addingTimeInterval(-7200)),
        ],
        agentPresenceStore: nil,
        onPick: { _ in }
    )
}
