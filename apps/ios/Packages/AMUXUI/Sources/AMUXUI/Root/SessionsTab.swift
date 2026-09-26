import SwiftUI
import SwiftData
import AMUXCore
import os

private let sessionsTabLogger = Logger(subsystem: "com.teamclu.mobile", category: "SessionsTab")

public struct SessionsTab: View {
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
    let messagesRepository: (any MessagesRepository)?
    let workspacesRepository: (any WorkspaceRepository)?
    let sessionsRepository: (any SessionRepository)?
    /// The unread-domain repository (list/flags/mark-viewed/mark-unread);
    /// distinct from `sessionsRepository` above, which is the
    /// create/participants `SessionRepository`.
    let sessionsListRepository: (any SessionsRepository)?
    let teamRepository: (any TeamRepository)?
    let actorRepository: (any ActorRepository)?
    var onReconnect: (() -> Void)?
    var onSignOut: (() -> Void)?
    let preferencesAPI: (any PushPreferencesAPI)?
    let notificationPrefsStore: NotificationPrefsStore?
    /// Drives the session rows' leading dots. Owned by RootTabView so it
    /// outlives this tab's view identity.
    let liveActivityStore: SessionLiveActivityStore?

    @Environment(\.modelContext) private var modelContext

    @State private var showShortcuts = false
    @State private var showSettings = false
    @State private var showApps = false
    @State private var showNewSession = false
    @State private var showInvite = false
    @Binding var navigationPath: [String]

    @State private var isEditing = false
    @State private var selectedIDs: Set<String> = []

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
                connectedAgentsStore: ConnectedAgentsStore? = nil,
                actorStore: ActorStore? = nil,
                agentPresenceStore: AgentPresenceStore? = nil,
                shortcutsStore: ShortcutsStore? = nil,
                teamAppsStore: TeamAppsStore? = nil,
                messagesRepository: (any MessagesRepository)? = nil,
                workspacesRepository: (any WorkspaceRepository)? = nil,
                sessionsRepository: (any SessionRepository)? = nil,
                sessionsListRepository: (any SessionsRepository)? = nil,
                teamRepository: (any TeamRepository)? = nil,
                actorRepository: (any ActorRepository)? = nil,
                onReconnect: (() -> Void)? = nil,
                onSignOut: (() -> Void)? = nil,
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
        self.connectedAgentsStore = connectedAgentsStore
        self.actorStore = actorStore
        self.agentPresenceStore = agentPresenceStore
        self.shortcutsStore = shortcutsStore
        self.teamAppsStore = teamAppsStore
        self.messagesRepository = messagesRepository
        self.workspacesRepository = workspacesRepository
        self.sessionsRepository = sessionsRepository
        self.sessionsListRepository = sessionsListRepository
        self.teamRepository = teamRepository
        self.actorRepository = actorRepository
        self.onReconnect = onReconnect
        self.onSignOut = onSignOut
        self.preferencesAPI = preferencesAPI
        self.notificationPrefsStore = notificationPrefsStore
        self.liveActivityStore = liveActivityStore
    }

    public var body: some View {
        ZStack(alignment: .leading) {
            NavigationStack(path: $navigationPath) {
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
                .toolbar {
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
                        Button { showNewSession = true } label: {
                            Image(systemName: "square.and.pencil").font(.title3).foregroundStyle(.primary)
                        }
                        .accessibilityIdentifier("sessions.newSessionButton")
                        .buttonStyle(.plain)
                        .matchedTransitionSource(id: "newSession", in: sheetTransition)
                    }
                }
                .navigationDestination(for: String.self) { id in
                    // Every iOS-side push goes through "session:<sid>" now;
                    // the runtime-only fallback path was the legacy entry from
                    // when the session list emitted bare runtime ids.
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
                                   viewModel: viewModel) { agentId in
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
                        MemberInviteSheet(store: actorStore)
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
                .onChange(of: teamcluService?.sessions.count) {
                    viewModel.reloadSessions(modelContext: modelContext)
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
        // Hoisted from the destination view: when the modifier lives on
        // SessionDetailView, the tab bar can't start re-appearing until
        // that view fully unmounts at the end of the pop transition, so
        // the bar visibly lags the back swipe. Driving it from the stack
        // root means visibility flips in the same SwiftUI transaction
        // that mutates `navigationPath`, and the tab bar animates back
        // in alongside the pop instead of waiting it out.
        //
        // Also hide while shortcuts is presented — the drawer occupies
        // ~86% width + full height; the tab bar peeking out underneath
        // competes with the drawer's right-side rounded corner and
        // adds nothing the user can act on in that state.
        .toolbarVisibility(
            (navigationPath.isEmpty && !showShortcuts) ? .visible : .hidden,
            for: .tabBar
        )
        // Hide the Sessions navbar (leading grid icon + title + trailing
        // new-session icon) while the drawer is open. Otherwise the leading
        // grid icon peeks out above the drawer's top edge, competing with
        // the drawer's immersive content.
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
        sessionsTabLogger.error(
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
