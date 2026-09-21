import SwiftUI
import AMUXCore

// MARK: - AddMemberSheet

/// Thin wrapper around `MemberListView` that:
///   * hides anyone already in the session (humans + agents) plus the calling user
///   * filters the confirm callback to humans only (agents are added via
///     `AddAgentSheet`, which also configures workspace + agent type)
///
/// Presented from `SessionDetailView` when the user taps "Add member" in the
/// session member sheet. Agents picked here are intentionally dropped — there's
/// no UI to set their workspace/type from this entry point, and we don't want
/// the confusion of half-configured runtimes.
public struct AddMemberSheet: View {
    @Environment(\.dismiss) private var dismiss

    let excludedActorIDs: Set<String>
    let accessibleAgentIDs: Set<String>
    let currentActorID: String?
    /// Handed to the picker so it refreshes presence when it opens.
    let actorStore: ActorStore?
    let agentPresenceStore: AgentPresenceStore?
    let onConfirm: (_ humanActorIDs: [String]) -> Void

    public init(excludedActorIDs: Set<String>,
                accessibleAgentIDs: Set<String> = [],
                currentActorID: String? = nil,
                actorStore: ActorStore? = nil,
                agentPresenceStore: AgentPresenceStore? = nil,
                onConfirm: @escaping (_ humanActorIDs: [String]) -> Void) {
        self.excludedActorIDs = excludedActorIDs
        self.accessibleAgentIDs = accessibleAgentIDs
        self.currentActorID = currentActorID
        self.actorStore = actorStore
        self.agentPresenceStore = agentPresenceStore
        self.onConfirm = onConfirm
    }

    public var body: some View {
        MemberListView(
            selected: [],
            actorStore: actorStore,
            agentPresenceStore: agentPresenceStore,
            currentActorID: currentActorID,
            accessibleAgentIDs: accessibleAgentIDs,
            currentPrimaryAgentID: nil,
            excludeActorID: currentActorID,
            excludeActorIDs: excludedActorIDs
        ) { selected in
            // Drop agents — this entry point is humans-only. AddAgentSheet
            // owns the agent flow (workspace + type config + runtimeStart).
            let humanIDs = selected.filter { !$0.isAgent }.map(\.actorId)
            onConfirm(humanIDs)
            dismiss()
        }
    }
}
