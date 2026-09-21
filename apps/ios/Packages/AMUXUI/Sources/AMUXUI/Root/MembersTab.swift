import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

enum MembersTabPresentation {
    /// Only actor ids reach this path. An actor's skills / MCP / env list is
    /// pushed by `ActorDetailView`'s own `navigationDestination(item:)`, so it
    /// never lands here — by then the actor detail already emptied the tab bar.
    static func isTabBarVisible(navigationPath: NavigationPath) -> Bool {
        navigationPath.isEmpty
    }
}

public struct MembersTab: View {
    let pairing: PairingManager
    let mqtt: MQTTService
    let sessionViewModel: SessionListViewModel
    let teamcluService: TeamcluService?
    let activeTeam: TeamSummary?
    let currentActorID: String?
    let store: ActorStore
    let connectedAgentsStore: ConnectedAgentsStore?
    let agentPresenceStore: AgentPresenceStore?
    let workspacesRepository: (any WorkspaceRepository)?
    let agentAccessRepository: (any AgentAccessRepository)?
    let teamResourceRepository: (any TeamResourceRepository)?
    /// One-shot trigger from the parent (e.g. the zero-agent reminder) to
    /// open the invite sheet without a toolbar tap. Toggled back to false
    /// after firing so subsequent triggers re-fire cleanly.
    @Binding var externalInviteTrigger: Bool

    @State private var showInvite     = false
    @State private var showTeamStats  = false
    @State private var navigationPath = NavigationPath()

    @Query(sort: \CachedActor.displayName) private var actors: [CachedActor]

    public init(pairing: PairingManager,
                mqtt: MQTTService,
                sessionViewModel: SessionListViewModel,
                teamcluService: TeamcluService?,
                activeTeam: TeamSummary?,
                currentActorID: String? = nil,
                store: ActorStore,
                connectedAgentsStore: ConnectedAgentsStore? = nil,
                agentPresenceStore: AgentPresenceStore? = nil,
                workspacesRepository: (any WorkspaceRepository)? = nil,
                agentAccessRepository: (any AgentAccessRepository)? = nil,
                teamResourceRepository: (any TeamResourceRepository)? = nil,
                showInvite: Binding<Bool> = .constant(false)) {
        self.pairing = pairing
        self.mqtt = mqtt
        self.sessionViewModel = sessionViewModel
        self.teamcluService = teamcluService
        self.activeTeam = activeTeam
        self.currentActorID = currentActorID
        self.store = store
        self.connectedAgentsStore = connectedAgentsStore
        self.agentPresenceStore = agentPresenceStore
        self.workspacesRepository = workspacesRepository
        self.agentAccessRepository = agentAccessRepository
        self.teamResourceRepository = teamResourceRepository
        self._externalInviteTrigger = showInvite
    }

    public var body: some View {
        NavigationStack(path: $navigationPath) {
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
                    ToolbarItem(placement: .navigationBarLeading) {
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
                    MemberInviteSheet(store: store)
                }
                .sheet(isPresented: $showTeamStats) {
                    TeamStatsSheet(actors: actors, teamID: activeTeam?.id)
                }
                .onChange(of: externalInviteTrigger) { _, newValue in
                    guard newValue else { return }
                    showInvite = true
                    externalInviteTrigger = false
                }
                .navigationDestination(for: String.self) { actorId in
                    if let actor = actors.first(where: { $0.actorId == actorId }) {
                        ActorDetailView(
                            actor: actor,
                            pairing: pairing,
                            mqtt: mqtt,
                            sessionViewModel: sessionViewModel,
                            store: store,
                            teamcluService: teamcluService,
                            connectedAgentsStore: connectedAgentsStore,
                            workspacesRepository: workspacesRepository,
                            agentAccessRepository: agentAccessRepository,
                            teamResourceRepository: teamResourceRepository,
                            currentActorID: currentActorID,
                            agentPresenceStore: agentPresenceStore
                        )
                    } else {
                        ContentUnavailableView(
                            "Actor Not Found",
                            systemImage: "person.crop.circle.badge.questionmark",
                            description: Text("This actor may have been removed.")
                        )
                    }
                }
        }
        // Keep tab-bar visibility tied to the root stack state, matching
        // SessionsTab and IdeasTab. If the modifier lives on ActorDetailView,
        // the bar waits for the destination to unmount before it appears.
        .toolbarVisibility(
            MembersTabPresentation.isTabBarVisible(navigationPath: navigationPath) ? .visible : .hidden,
            for: .tabBar
        )
    }
}
