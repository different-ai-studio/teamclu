import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

/// The actor list, pushed onto the root session stack from the top-right
/// menu. Rows push `"actor:<id>"` onto the shared path; `SessionsHome`
/// resolves it to `ActorDetailView`.
struct MembersScreen: View {
    let pairing: PairingManager
    let mqtt: MQTTService
    let sessionViewModel: SessionListViewModel
    let teamcluService: TeamcluService?
    let activeTeam: TeamSummary?
    let currentActorID: String?
    let store: ActorStore
    let connectedAgentsStore: ConnectedAgentsStore?
    let agentPresenceStore: AgentPresenceStore?
    /// One-shot trigger from the parent (the zero-agent reminder) to open the
    /// invite sheet without a toolbar tap. Toggled back to false after firing
    /// so subsequent triggers re-fire cleanly.
    @Binding var externalInviteTrigger: Bool

    @State private var showInvite     = false
    @State private var showTeamStats  = false

    @Query(sort: \CachedActor.displayName) private var actors: [CachedActor]

    var body: some View {
        MemberListContent(
            store: store,
            pairing: pairing,
            mqtt: mqtt,
            sessionViewModel: sessionViewModel,
            teamcluService: teamcluService,
            currentActorID: currentActorID,
            connectedAgentsStore: connectedAgentsStore,
            agentPresenceStore: agentPresenceStore,
            onAddYourAgent: { showInvite = true }
        )
            .navigationTitle("Actors")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showTeamStats = true } label: {
                        Image(systemName: "chart.bar.xaxis")
                            .font(.title3)
                            .foregroundStyle(Color.amux.onyx)
                            .accessibilityHidden(true)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Team Statistics")
                    .accessibilityIdentifier("members.teamStatsButton")
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showInvite = true } label: {
                        Image(systemName: "person.badge.plus")
                            .font(.title3)
                            .foregroundStyle(activeTeam == nil ? Color.amux.slate.opacity(0.5) : Color.amux.onyx)
                            .accessibilityHidden(true)
                    }
                    .buttonStyle(.plain)
                    .disabled(activeTeam == nil)
                    .accessibilityLabel("Invite Member")
                    .accessibilityIdentifier("members.inviteButton")
                }
            }
            .sheet(isPresented: $showInvite) {
                MemberInviteSheet(store: store, canManage: canManageTeam)
            }
            .sheet(isPresented: $showTeamStats) {
                TeamStatsSheet(actors: actors, teamID: activeTeam?.id)
            }
            .onChange(of: externalInviteTrigger, initial: true) { _, newValue in
                guard newValue else { return }
                showInvite = true
                externalInviteTrigger = false
            }
    }

    private var canManageTeam: Bool {
        guard let id = currentActorID else { return false }
        if let actor = store.actors.first(where: { $0.id == id }) {
            return actor.isOwner || actor.isAdmin
        }
        if let cached = actors.first(where: { $0.actorId == id }) {
            return cached.isOwner || cached.isAdmin
        }
        return false
    }
}
