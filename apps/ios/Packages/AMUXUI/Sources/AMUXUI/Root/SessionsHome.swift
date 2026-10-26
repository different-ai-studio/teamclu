import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI
import os

private let sessionsHomeLogger = Logger(subsystem: "com.teamclu.mobile", category: "SessionsHome")

/// The app's one root screen: the session list, with ideas and actors behind
/// the top-right menu, shortcuts (and settings, team apps) behind the
/// top-left drawer, and a new session one tap away at the bottom.
///
/// Its NavigationStack is the only one in the app. Ideas, actors, and the
/// details under them all push onto `navigationPath` as strings —
/// `"session:<id>"`, `"ideas"`, `"idea:<id>"`, `"members"`, `"actor:<id>"` —
/// and `destination(for:)` below resolves every one of them, so a session
/// opened from an idea, or a push notification, lands on the same stack.
public struct SessionsHome: View {
    let mqtt: MQTTService
    let hub: MQTTMessageHub
    let pairing: PairingManager
    let teamcluService: TeamcluService?
    let activeTeam: TeamSummary?
    let currentActorID: String?
    @Bindable var viewModel: SessionListViewModel
    let refreshSessionsFromBackend: () async -> Void
    let connectedAgentsStore: ConnectedAgentsStore?
    let actorStore: ActorStore?
    /// Broker-backed agent presence for the dots drawn further down.
    let agentPresenceStore: AgentPresenceStore?
    let shortcutsStore: ShortcutsStore?
    /// nil when the deployment has the apps feature off, or no Cloud API
    /// config was available to build a repository from.
    let teamAppsStore: TeamAppsStore?
    /// Owned by RootView so the ideas list and an idea's detail, two
    /// separate pushes, read the same store.
    let ideaStore: IdeaStore?
    let messagesRepository: (any MessagesRepository)?
    let workspacesRepository: (any WorkspaceRepository)?
    let sessionsRepository: (any SessionRepository)?
    /// The unread-domain repository (list/flags/mark-viewed/mark-unread);
    /// distinct from `sessionsRepository` above, which is the
    /// create/participants `SessionRepository`.
    let sessionsListRepository: (any SessionsRepository)?
    let teamRepository: (any TeamRepository)?
    let actorRepository: (any ActorRepository)?
    let agentAccessRepository: (any AgentAccessRepository)?
    let teamResourceRepository: (any TeamResourceRepository)?
    var onReconnect: (() -> Void)?
    var onSignOut: (() -> Void)?
    /// The bottom bar's mic. RootView runs the capture over this screen.
    let onStartVoice: () -> Void
    let preferencesAPI: (any PushPreferencesAPI)?
    let notificationPrefsStore: NotificationPrefsStore?
    /// Drives the session rows' leading dots. Owned by RootView so it
    /// outlives this screen's view identity.
    let liveActivityStore: SessionLiveActivityStore?

    @Environment(\.modelContext) private var modelContext

    @State private var showShortcuts = false
    @State private var showSettings = false
    @State private var showApps = false
    @State private var showNewSession = false
    @State private var showInvite = false
    /// Set by RootView (the zero-agent reminder) to land on the actors list
    /// with its invite sheet open.
    @Binding var showMembersInvite: Bool
    @Binding var navigationPath: [String]

    @State private var isEditing = false
    @State private var selectedIDs: Set<String> = []
    /// The viewer's effective default agent, resolved against the agents
    /// they can reach. Names the bottom bar's placeholder and is the agent
    /// the new-session sheet starts with.
    @State private var defaultAgentID: String?

    @Namespace private var sheetTransition

    public init(mqtt: MQTTService,
                hub: MQTTMessageHub,
                pairing: PairingManager,
                teamcluService: TeamcluService?,
                activeTeam: TeamSummary?,
                currentActorID: String?,
                viewModel: SessionListViewModel,
                refreshSessionsFromBackend: @escaping () async -> Void,
                navigationPath: Binding<[String]>,
                showMembersInvite: Binding<Bool>,
                connectedAgentsStore: ConnectedAgentsStore? = nil,
                actorStore: ActorStore? = nil,
                agentPresenceStore: AgentPresenceStore? = nil,
                shortcutsStore: ShortcutsStore? = nil,
                teamAppsStore: TeamAppsStore? = nil,
                ideaStore: IdeaStore? = nil,
                messagesRepository: (any MessagesRepository)? = nil,
                workspacesRepository: (any WorkspaceRepository)? = nil,
                sessionsRepository: (any SessionRepository)? = nil,
                sessionsListRepository: (any SessionsRepository)? = nil,
                teamRepository: (any TeamRepository)? = nil,
                actorRepository: (any ActorRepository)? = nil,
                agentAccessRepository: (any AgentAccessRepository)? = nil,
                teamResourceRepository: (any TeamResourceRepository)? = nil,
                onReconnect: (() -> Void)? = nil,
                onSignOut: (() -> Void)? = nil,
                onStartVoice: @escaping () -> Void = {},
                preferencesAPI: (any PushPreferencesAPI)? = nil,
                notificationPrefsStore: NotificationPrefsStore? = nil,
                liveActivityStore: SessionLiveActivityStore? = nil) {
        self.mqtt = mqtt
        self.hub = hub
        self.pairing = pairing
        self.teamcluService = teamcluService
        self.activeTeam = activeTeam
        self.currentActorID = currentActorID
        self.viewModel = viewModel
        self.refreshSessionsFromBackend = refreshSessionsFromBackend
        self._navigationPath = navigationPath
        self._showMembersInvite = showMembersInvite
        self.connectedAgentsStore = connectedAgentsStore
        self.actorStore = actorStore
        self.agentPresenceStore = agentPresenceStore
        self.shortcutsStore = shortcutsStore
        self.teamAppsStore = teamAppsStore
        self.ideaStore = ideaStore
        self.messagesRepository = messagesRepository
        self.workspacesRepository = workspacesRepository
        self.sessionsRepository = sessionsRepository
        self.sessionsListRepository = sessionsListRepository
        self.teamRepository = teamRepository
        self.actorRepository = actorRepository
        self.agentAccessRepository = agentAccessRepository
        self.teamResourceRepository = teamResourceRepository
        self.onReconnect = onReconnect
        self.onSignOut = onSignOut
        self.onStartVoice = onStartVoice
        self.preferencesAPI = preferencesAPI
        self.notificationPrefsStore = notificationPrefsStore
        self.liveActivityStore = liveActivityStore
    }

    public var body: some View {
        ZStack(alignment: .leading) {
            NavigationStack(path: $navigationPath) {
                sessionList
                    .navigationDestination(for: String.self) { id in
                        destination(for: id)
                    }
            }

            if let shortcutsStore {
                ShortcutsDrawer(isPresented: $showShortcuts,
                                store: shortcutsStore,
                                currentActorID: currentActorID,
                                activeTeam: activeTeam,
                                onOpenSettings: { showSettings = true },
                                appsStore: teamAppsStore,
                                onOpenApps: { showApps = true })
            }
        }
        .onChange(of: navigationPath) { old, new in
            // M1 starts at the push itself — list tap, push notification
            // and new session all land here — so it includes building the
            // destination, not just what the view model does.
            guard new.count > old.count, let pushed = new.last, pushed.hasPrefix("session:") else { return }
            ChatMetrics.shared.begin(.openSession, key: String(pushed.dropFirst("session:".count)), restart: true)
        }
        .onChange(of: showMembersInvite) { _, show in
            // The actors list opens its own invite sheet off this binding.
            guard show, navigationPath.last != "members" else { return }
            navigationPath = ["members"]
        }
        // Hide the navbar (shortcuts button, title, menu) while the drawer is
        // open. Otherwise the leading grid icon peeks out above the drawer's
        // top edge, competing with its immersive content.
        .toolbarVisibility(
            showShortcuts ? .hidden : .automatic,
            for: .navigationBar
        )
        .overlay(alignment: .top) {
            if navigationPath.isEmpty {
                ConnectionBannerOverlay(mqtt: mqtt, onReconnect: onReconnect)
            }
        }
    }

    private var sessionList: some View {
        SessionListContent(
            viewModel: viewModel,
            refreshSessionsFromBackend: refreshSessionsFromBackend,
            navigationPath: $navigationPath,
            isEditing: $isEditing,
            selectedIDs: $selectedIDs,
            teamcluService: teamcluService,
            actorId: "ios-\(pairing.authToken.prefix(6))",
            currentActorID: currentActorID,
            noAccessibleAgent: connectedAgentsStore?.agents.isEmpty == true,
            onInviteFirstAgent: actorStore == nil ? nil : { showInvite = true },
            notificationPrefsStore: notificationPrefsStore,
            sessionsListRepository: sessionsListRepository,
            liveActivityStore: liveActivityStore
        )
        .navigationTitle("Sessions")
        .navigationBarTitleDisplayMode(.large)
        .onChange(of: viewModel.sessions.isEmpty, initial: true) { _, isEmpty in
            // M4 ends when the list first shows rows. No-op once
            // ended, and on every later launch-less change.
            guard !isEmpty else { return }
            ChatMetrics.shared.set(.coldStart, "sessions", Double(viewModel.sessions.count))
            ChatMetrics.shared.end(.coldStart)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !isEditing && !showShortcuts {
                HomeComposerBar(
                    agentName: defaultAgentName,
                    transitionNamespace: sheetTransition,
                    onCompose: { showNewSession = true },
                    onVoice: onStartVoice
                )
            }
        }
        .toolbar {
            // Shortcuts drawer — and through it settings and team apps.
            ToolbarItem(placement: .navigationBarLeading) {
                Button { showShortcuts = true } label: {
                    Image(systemName: "square.grid.2x2").font(.title3).foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Shortcuts")
                .accessibilityIdentifier("sessions.shortcutsButton")
                .disabled(shortcutsStore == nil)
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                menu
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(connectedAgentsStore: connectedAgentsStore,
                         agentPresenceStore: agentPresenceStore,
                         activeTeam: activeTeam,
                         onSignOut: onSignOut,
                         notificationPrefsStore: notificationPrefsStore,
                         teamRepository: teamRepository,
                         actorRepository: actorRepository)
        }
        .sheet(isPresented: $showApps) {
            if let teamAppsStore {
                TeamAppsView(store: teamAppsStore) { sessionID in
                    // Close the sheet first, then push: presenting and
                    // pushing in the same transaction leaves the stack
                    // animating behind a sheet that is still up.
                    showApps = false
                    DispatchQueue.main.async {
                        navigationPath.append("session:\(sessionID)")
                    }
                }
            }
        }
        .sheet(isPresented: $showNewSession) {
            NewSessionSheet(mqtt: mqtt,
                            peerId: "ios-\(pairing.authToken.prefix(6))",
                            teamcluService: teamcluService,
                            teamID: activeTeam?.id ?? "",
                            currentActorID: currentActorID,
                            isAgentAvailable: pairing.isPaired,
                            connectedAgentsStore: connectedAgentsStore,
                            actorStore: actorStore,
                            agentPresenceStore: agentPresenceStore,
                            workspacesRepository: workspacesRepository,
                            sessionsRepository: sessionsRepository,
                            teamAppsStore: teamAppsStore,
                            viewModel: viewModel,
                            defaultAgentID: defaultAgentID,
                            ideaStore: ideaStore) { agentId in
                navigationPath = [agentId]
                // Pull the freshly-created Supabase rows (sessions +
                // workspaces) into the local cache so
                // the row's agent type / workspace populate without
                // waiting for the user to pull-to-refresh.
                Task { await refreshSessionsFromBackend() }
            }
            .modifier(ZoomTransitionModifier(sourceID: "newSession", namespace: sheetTransition))
        }
        .sheet(isPresented: $showInvite) {
            if let actorStore {
                MemberInviteSheet(store: actorStore, canManage: canManageTeam)
            }
        }
        .task {
            viewModel.start(
                mqtt: mqtt,
                hub: hub,
                teamID: activeTeam?.id ?? "",
                connectedAgentsStore: connectedAgentsStore,
                modelContext: modelContext,
                teamcluService: teamcluService,
                agentPresenceStore: agentPresenceStore
            )
        }
        // Re-resolved whenever the list is back on top: the default may
        // have just been changed by a voice take's agent pick or in an
        // actor's settings.
        .task(id: DefaultAgentKey(agentIDs: connectedAgentsStore?.agents.map(\.id) ?? [],
                                  isOnTop: navigationPath.isEmpty && !showNewSession)) {
            guard navigationPath.isEmpty, !showNewSession else { return }
            await resolveDefaultAgent()
        }
        .onChange(of: teamcluService?.sessions.count) {
            viewModel.reloadSessions(modelContext: modelContext)
        }
    }

    /// The team's other two places. A system menu rather than a tab bar:
    /// neither is somewhere you stay.
    private var menu: some View {
        Menu {
            Button {
                navigationPath.append("ideas")
            } label: {
                Label("Ideas", systemImage: IdeaUIPresentation.systemImage)
            }
            .accessibilityIdentifier("sessions.menu.ideas")
            Button {
                navigationPath.append("members")
            } label: {
                Label("Actors", systemImage: "person.2")
            }
            .accessibilityIdentifier("sessions.menu.members")
            .disabled(actorStore == nil)
        } label: {
            Image(systemName: "ellipsis")
                .font(.title3)
                .foregroundStyle(.primary)
        }
        .buttonStyle(.plain)
        // The menu's icons otherwise take the cinnabar accent; neither entry
        // is the verb that earns it.
        .tint(Color.amux.onyx)
        .accessibilityLabel("Menu")
        .accessibilityIdentifier("sessions.menuButton")
    }

    /// Resolves every path element any screen on the stack pushes.
    @ViewBuilder
    private func destination(for id: String) -> some View {
        if id == "ideas" {
            IdeasScreen(activeTeam: activeTeam,
                        ideaStore: ideaStore,
                        currentActorID: currentActorID,
                        navigationPath: $navigationPath)
        } else if id.hasPrefix("idea:") {
            if let ideaStore {
                IdeaDetailView(
                    ideaID: String(id.dropFirst("idea:".count)),
                    ideaStore: ideaStore,
                    sessionViewModel: viewModel,
                    teamcluService: teamcluService,
                    mqtt: mqtt,
                    hub: hub,
                    peerId: "ios-\(pairing.authToken.prefix(6))",
                    sessionsRepository: sessionsRepository,
                    connectedAgentsStore: connectedAgentsStore,
                    actorStore: actorStore,
                    agentPresenceStore: agentPresenceStore,
                    currentActorID: currentActorID,
                    workspacesRepository: workspacesRepository,
                    navigationPath: $navigationPath
                )
            } else {
                Text("Idea store unavailable")
            }
        } else if id == "members" {
            if let actorStore {
                MembersScreen(pairing: pairing,
                              mqtt: mqtt,
                              sessionViewModel: viewModel,
                              teamcluService: teamcluService,
                              activeTeam: activeTeam,
                              currentActorID: currentActorID,
                              store: actorStore,
                              connectedAgentsStore: connectedAgentsStore,
                              agentPresenceStore: agentPresenceStore,
                              externalInviteTrigger: $showMembersInvite)
            } else {
                ContentUnavailableView("No Team Selected",
                                       systemImage: "person.2",
                                       description: Text("Create or join a team to see actors."))
            }
        } else if id.hasPrefix("actor:") {
            ActorDestinationView(
                actorID: String(id.dropFirst("actor:".count)),
                pairing: pairing,
                mqtt: mqtt,
                sessionViewModel: viewModel,
                store: actorStore,
                teamcluService: teamcluService,
                connectedAgentsStore: connectedAgentsStore,
                workspacesRepository: workspacesRepository,
                agentAccessRepository: agentAccessRepository,
                teamResourceRepository: teamResourceRepository,
                currentActorID: currentActorID,
                agentPresenceStore: agentPresenceStore
            )
        } else {
            // Every session push goes through "session:<sid>"; the bare-id
            // fallback was the legacy entry from when the session list
            // emitted runtime ids.
            let sessionId = id.hasPrefix("session:")
                ? String(id.dropFirst("session:".count))
                : id
            SessionDestinationView(
                sessionId: sessionId,
                mqtt: mqtt,
                hub: hub,
                pairing: pairing,
                teamcluService: teamcluService,
                currentActorID: currentActorID,
                refreshSessionsFromBackend: refreshSessionsFromBackend,
                navigationPath: $navigationPath,
                connectedAgentsStore: connectedAgentsStore,
                messagesRepository: messagesRepository,
                workspacesRepository: workspacesRepository,
                sessionsRepository: sessionsRepository,
                preferencesAPI: preferencesAPI,
                notificationPrefsStore: notificationPrefsStore,
                actorStore: actorStore,
                agentPresenceStore: agentPresenceStore
            )
        }
    }

    private var defaultAgentName: String? {
        guard let defaultAgentID else { return nil }
        return connectedAgentsStore?.agents.first { $0.id == defaultAgentID }?.displayName
    }

    /// A default pointing at an agent the viewer can no longer reach counts
    /// as none — the same rule the voice path applies.
    @MainActor
    private func resolveDefaultAgent() async {
        guard let actorStore, let agents = connectedAgentsStore?.agents, !agents.isEmpty else {
            defaultAgentID = nil
            return
        }
        let id = await actorStore.getEffectiveDefaultAgent()
        guard !Task.isCancelled else { return }
        defaultAgentID = agents.contains { $0.id == id } ? id : nil
    }

    private struct DefaultAgentKey: Equatable {
        let agentIDs: [String]
        let isOnTop: Bool
    }

    private var canManageTeam: Bool {
        guard let id = currentActorID else { return false }
        guard let actor = actorStore?.actors.first(where: { $0.id == id }) else { return false }
        return actor.isOwner || actor.isAdmin
    }

}

/// `"actor:<id>"` on the root stack. Looks the actor up in the local cache the
/// actors list was drawn from.
private struct ActorDestinationView: View {
    let actorID: String
    let pairing: PairingManager
    let mqtt: MQTTService
    let sessionViewModel: SessionListViewModel
    let store: ActorStore?
    let teamcluService: TeamcluService?
    let connectedAgentsStore: ConnectedAgentsStore?
    let workspacesRepository: (any WorkspaceRepository)?
    let agentAccessRepository: (any AgentAccessRepository)?
    let teamResourceRepository: (any TeamResourceRepository)?
    let currentActorID: String?
    let agentPresenceStore: AgentPresenceStore?

    @Query(sort: \CachedActor.displayName) private var actors: [CachedActor]

    var body: some View {
        if let store, let actor = actors.first(where: { $0.actorId == actorID }) {
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

private struct SessionDestinationView: View {
    let sessionId: String
    let mqtt: MQTTService
    let hub: MQTTMessageHub
    let pairing: PairingManager
    let teamcluService: TeamcluService?
    let currentActorID: String?
    let refreshSessionsFromBackend: () async -> Void
    @Binding var navigationPath: [String]
    let connectedAgentsStore: ConnectedAgentsStore?
    let messagesRepository: (any MessagesRepository)?
    let workspacesRepository: (any WorkspaceRepository)?
    let sessionsRepository: (any SessionRepository)?
    let preferencesAPI: (any PushPreferencesAPI)?
    let notificationPrefsStore: NotificationPrefsStore?
    /// Reaches AddMemberSheet's picker, which refreshes presence on open.
    let actorStore: ActorStore?
    let agentPresenceStore: AgentPresenceStore?

    @Environment(\.modelContext) private var modelContext

    @State private var session: Session?
    @State private var attemptedRefresh = false

    var body: some View {
        Group {
            if let session {
                // Single detail surface — SessionDetailView handles the
                // session-only case (no runtime yet, no pairing, etc.) by
                // seeding past messages from Supabase and skipping the
                // MQTT subscribe / composer-send paths until a runtime
                // resolves. The previous SessionView/CollabSessionView
                // branch was a parallel storage backed by SessionMessage;
                // dropped here as part of the unified detail-view sweep.
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
                    pushPrefs: preferencesAPI,
                    notificationPrefsStore: notificationPrefsStore,
                    actorStore: actorStore,
                    agentPresenceStore: agentPresenceStore
                )
                .id("session:\(session.sessionId)")
            } else {
                // Don't flash "Session not found" while SwiftData /
                // Supabase round-trip is still in flight (e.g. right
                // after navigating from NewSessionSheet). Only declare
                // missing once we've actually attempted a refresh.
                Group {
                    if attemptedRefresh {
                        Text("Session not found")
                    } else {
                        ProgressView()
                    }
                }
                .task(id: sessionId) {
                    await reloadSessionIfNeeded()
                }
            }
        }
        .task(id: sessionId) {
            await loadSession()
        }
    }

    @MainActor
    private func fetchSession() -> Session? {
        let descriptor = FetchDescriptor<Session>(
            predicate: #Predicate { $0.sessionId == sessionId }
        )
        return (try? modelContext.fetch(descriptor))?.first
    }

    private func loadSession() async {
        await MainActor.run {
            session = fetchSession()
        }
    }

    @MainActor
    private func logKnownSessions() {
        let knownSessions: [Session] = (try? modelContext.fetch(FetchDescriptor<Session>())) ?? []
        let knownIDs = knownSessions.map(\.sessionId).joined(separator: ",")
        sessionsHomeLogger.error(
            "session lookup failed requested=\(sessionId, privacy: .public) knownCount=\(knownSessions.count) knownIDs=\(knownIDs, privacy: .public)"
        )
    }

    private func reloadSessionIfNeeded() async {
        await loadSession()
        guard session == nil, !attemptedRefresh else {
            if session == nil {
                await MainActor.run {
                    logKnownSessions()
                }
            }
            return
        }

        // Run the refresh + reload BEFORE flipping `attemptedRefresh`. The
        // flag gates the "Session not found" copy, so flipping it before
        // the network round-trip completes flashes that copy on screen
        // for the duration of `refreshSessionsFromBackend()` — exactly the
        // bug we're trying to suppress.
        await refreshSessionsFromBackend()
        await loadSession()
        await MainActor.run {
            attemptedRefresh = true
        }
        if session == nil {
            await MainActor.run {
                logKnownSessions()
            }
        }
    }
}
