import SwiftUI
import SwiftData
import AMUXCore

public struct IdeasTab: View {
    let pairing: PairingManager
    let teamcluService: TeamcluService?
    let activeTeam: TeamSummary?
    let mqtt: MQTTService
    let hub: MQTTMessageHub
    let sessionViewModel: SessionListViewModel
    let connectedAgentsStore: ConnectedAgentsStore?
    let messagesRepository: (any MessagesRepository)?
    let workspacesRepository: (any WorkspaceRepository)?
    let sessionsRepository: (any SessionRepository)?
    let ideasRepository: (any IdeaRepository)?
    /// Drives the "Mine" filter on the ideas list — compared against
    /// `IdeaRecord.createdByActorID`. `nil` hides the chip.
    let currentActorID: String?
    /// Forwarded through the detail views to the member picker, so it can
    /// refresh presence when it opens.
    let actorStore: ActorStore?
    let agentPresenceStore: AgentPresenceStore?

    @Environment(\.modelContext) private var modelContext

    @Query(sort: \CachedActor.displayName) private var actors: [CachedActor]
    @Query(sort: \Workspace.displayName)   private var workspaces: [Workspace]

    @State private var showCreate = false
    @State private var showStats = false
    @State private var navigationPath: [String] = []
    @State private var ideaStore: IdeaStore?
    @State private var ideaStoreTeamID: String?
    @State private var ideaSetupError: String?

    public init(
        mqtt: MQTTService,
        hub: MQTTMessageHub,
        pairing: PairingManager,
        teamcluService: TeamcluService?,
        activeTeam: TeamSummary?,
        sessionViewModel: SessionListViewModel,
        connectedAgentsStore: ConnectedAgentsStore? = nil,
        messagesRepository: (any MessagesRepository)? = nil,
        workspacesRepository: (any WorkspaceRepository)? = nil,
        sessionsRepository: (any SessionRepository)? = nil,
        ideasRepository: (any IdeaRepository)? = nil,
        currentActorID: String? = nil,
        actorStore: ActorStore? = nil,
        agentPresenceStore: AgentPresenceStore? = nil
    ) {
        self.mqtt = mqtt
        self.hub = hub
        self.pairing = pairing
        self.teamcluService = teamcluService
        self.activeTeam = activeTeam
        self.sessionViewModel = sessionViewModel
        self.connectedAgentsStore = connectedAgentsStore
        self.messagesRepository = messagesRepository
        self.workspacesRepository = workspacesRepository
        self.sessionsRepository = sessionsRepository
        self.ideasRepository = ideasRepository
        self.currentActorID = currentActorID
        self.actorStore = actorStore
        self.agentPresenceStore = agentPresenceStore
    }

    public var body: some View {
        NavigationStack(path: $navigationPath) {
            content
                .navigationTitle(IdeaUIPresentation.pluralTitle)
                .navigationBarTitleDisplayMode(.large)
                .toolbar {
                    if ideaStore != nil {
                        ToolbarItem(placement: .navigationBarLeading) {
                            Button { showStats = true } label: {
                                Image(systemName: "chart.bar.xaxis")
                                    .font(.title3)
                                    .foregroundStyle(.primary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Idea Statistics")
                            .accessibilityIdentifier("ideas.statsButton")
                        }
                        ToolbarItem(placement: .navigationBarTrailing) {
                            Button { showCreate = true } label: {
                                Image(systemName: "plus").font(.title3).foregroundStyle(.primary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .sheet(isPresented: $showStats) {
                    if let ideaStore {
                        IdeaStatsSheet(
                            ideas: ideaStore.ideas,
                            archivedIdeas: ideaStore.archivedIdeas,
                            actors: actors,
                            workspaces: workspaces
                        )
                    }
                }
                .navigationDestination(for: String.self) { id in
                    if id.hasPrefix("idea:") {
                        let ideaID = String(id.dropFirst("idea:".count))
                        if let ideaStore {
                            IdeaDetailView(
                                ideaID: ideaID,
                                ideaStore: ideaStore,
                                sessionViewModel: sessionViewModel,
                                teamcluService: teamcluService,
                                mqtt: mqtt,
                                hub: hub,
                                peerId: "ios-\(pairing.authToken.prefix(6))",
                                sessionsRepository: sessionsRepository,
                                connectedAgentsStore: connectedAgentsStore,
                                actorStore: actorStore,
                                agentPresenceStore: agentPresenceStore,
                                navigationPath: $navigationPath
                            )
                        } else {
                            Text("Idea store unavailable")
                        }
                    } else if id.hasPrefix("session:") {
                        let sessionId = String(id.dropFirst("session:".count))
                        let descriptor = FetchDescriptor<Session>(
                            predicate: #Predicate { $0.sessionId == sessionId }
                        )
                        if let session = (try? modelContext.fetch(descriptor))?.first {
                            SessionDetailView(
                                session: session,
                                mqtt: mqtt,
                                hub: hub,
                                peerId: "ios-\(pairing.authToken.prefix(6))",
                                teamcluService: teamcluService,
                                connectedAgentsStore: connectedAgentsStore,
                                messagesRepository: messagesRepository,
                                workspacesRepository: workspacesRepository,
                                sessionsRepository: sessionsRepository,
                                actorStore: actorStore,
                                agentPresenceStore: agentPresenceStore
                            )
                        } else {
                            Text("Session not found")
                        }
                    } else {
                        Text("Unknown destination")
                    }
                }
        }
        .task(id: activeTeam?.id) {
            await configureIdeaStore()
        }
        // Mirror SessionsTab: drive tab-bar visibility from the stack
        // root so the bar animates back in alongside the pop transition
        // instead of waiting for the destination view to fully unmount.
        .toolbarVisibility(navigationPath.isEmpty ? .visible : .hidden, for: .tabBar)
    }

    @ViewBuilder
    private var content: some View {
        if activeTeam == nil {
            ContentUnavailableView(
                "No Team Selected",
                systemImage: "person.3",
                description: Text("Create or join a team to manage ideas.")
            )
        } else if let ideaSetupError {
            ContentUnavailableView(
                "Couldn’t Set Up Ideas",
                systemImage: "exclamationmark.triangle",
                description: Text(ideaSetupError)
            )
        } else if let ideaStore {
            IdeaListView(
                ideaStore: ideaStore,
                showCreate: $showCreate,
                navigationPath: $navigationPath,
                currentActorID: currentActorID
            )
        } else {
            ProgressView("Loading ideas…")
        }
    }

    @MainActor
    private func configureIdeaStore() async {
        guard let activeTeam else {
            ideaStore = nil
            ideaStoreTeamID = nil
            ideaSetupError = nil
            return
        }

        if ideaStore == nil || ideaStoreTeamID != activeTeam.id {
            do {
                guard let repository = ideasRepository else {
                    ideaStore = nil
                    ideaStoreTeamID = nil
                    ideaSetupError = String(localized: "Cloud API is not configured.")
                    return
                }
                ideaStore = IdeaStore(
                    teamID: activeTeam.id,
                    repository: repository,
                    modelContext: modelContext
                )
                ideaStoreTeamID = activeTeam.id
                ideaSetupError = nil
            } catch {
                ideaStore = nil
                ideaStoreTeamID = nil
                ideaSetupError = error.localizedDescription
                return
            }
        }

        await ideaStore?.reload()
    }
}
