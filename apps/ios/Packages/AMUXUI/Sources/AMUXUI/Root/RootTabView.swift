import SwiftUI
import AMUXCore

public struct RootTabView: View {
    let mqtt: MQTTService
    let hub: MQTTMessageHub
    let pairing: PairingManager
    let teamcluService: TeamcluService?
    let activeTeam: TeamSummary?
    let currentActorID: String?
    var onReconnect: (() -> Void)?
    var onSignOut: (() -> Void)?
    let preferencesAPI: (any PushPreferencesAPI)?

    @Environment(\.modelContext) private var modelContext
    @Environment(AppOnboardingCoordinator.self) private var coordinator: AppOnboardingCoordinator?
    @Environment(NavigationRouter.self) private var navigationRouter: NavigationRouter?
    @State private var viewModel = SessionListViewModel()
    @SceneStorage("rootTab") private var selection: AppTab = .sessions
    @State private var sessionsPath: [String] = []

    /// Drives the "add the team's first agent" reminder. Set once per app
    /// launch when we observe a team with zero agents; soft-dismissible so it
    /// doesn't reappear after the user closes it.
    @State private var showFirstAgentReminder: Bool = false
    /// Set when the user taps "Add agent" in the reminder sheet. Triggers the
    /// existing MemberInviteSheet on the Actors tab after the reminder closes.
    @State private var showInviteAfterReminder: Bool = false
    /// Tracks teams we've already shown the reminder for, persisted across
    /// launches so the zero-agent nag only fires once per team.
    @AppStorage("remindedTeamIDs") private var remindedTeamIDsRaw: String = ""

    private var remindedTeams: Set<String> {
        get { Set(remindedTeamIDsRaw.split(separator: ",").map(String.init)) }
    }

    private func markTeamReminded(_ teamID: String) {
        var ids = remindedTeams
        ids.insert(teamID)
        remindedTeamIDsRaw = ids.joined(separator: ",")
    }

    public init(mqtt: MQTTService,
                hub: MQTTMessageHub,
                pairing: PairingManager,
                teamcluService: TeamcluService?,
                activeTeam: TeamSummary? = nil,
                currentActorID: String? = nil,
                onReconnect: (() -> Void)? = nil,
                onSignOut: (() -> Void)? = nil,
                preferencesAPI: (any PushPreferencesAPI)? = nil) {
        self.mqtt = mqtt
        self.hub = hub
        self.pairing = pairing
        self.teamcluService = teamcluService
        self.activeTeam = activeTeam
        self.currentActorID = currentActorID
        self.onReconnect = onReconnect
        self.onSignOut = onSignOut
        self.preferencesAPI = preferencesAPI
    }

    private var teamRuntime: TeamRuntimeContext? { coordinator?.teamRuntimeContext }

    public var body: some View {
        TabView(selection: $selection) {
            Tab("Sessions", systemImage: "bubble.left.and.bubble.right", value: AppTab.sessions) {
                SessionsTab(mqtt: mqtt,
                            hub: hub,
                            pairing: pairing,
                            teamcluService: teamcluService,
                            activeTeam: activeTeam,
                            currentActorID: currentActorID,
                            viewModel: viewModel,
                            refreshSessionsFromBackend: refreshSessionsFromBackend,
                            navigationPath: $sessionsPath,
                            connectedAgentsStore: teamRuntime?.connectedAgentsStore,
                            actorStore: teamRuntime?.actorStore,
                            agentPresenceStore: teamRuntime?.agentPresenceStore,
                            shortcutsStore: teamRuntime?.shortcutsStore,
                            messagesRepository: teamRuntime?.messagesRepo,
                            workspacesRepository: teamRuntime?.workspacesRepo,
                            sessionsRepository: teamRuntime?.sessionRepo,
                            sessionsListRepository: teamRuntime?.sessionsRepo,
                            teamRepository: teamRuntime?.teamRepo,
                            actorRepository: teamRuntime?.actorRepo,
                            onReconnect: onReconnect,
                            onSignOut: onSignOut,
                            preferencesAPI: preferencesAPI,
                            notificationPrefsStore: teamRuntime?.notificationPrefsStore)
            }
            Tab(IdeaUIPresentation.pluralTitle, systemImage: IdeaUIPresentation.systemImage, value: AppTab.ideas) {
                IdeasTab(mqtt: mqtt,
                         hub: hub,
                         pairing: pairing,
                         teamcluService: teamcluService,
                         activeTeam: activeTeam,
                         sessionViewModel: viewModel,
                         connectedAgentsStore: teamRuntime?.connectedAgentsStore,
                         messagesRepository: teamRuntime?.messagesRepo,
                         workspacesRepository: teamRuntime?.workspacesRepo,
                         sessionsRepository: teamRuntime?.sessionRepo,
                         ideasRepository: teamRuntime?.ideasRepo,
                         currentActorID: currentActorID,
                         actorStore: teamRuntime?.actorStore,
                         agentPresenceStore: teamRuntime?.agentPresenceStore)
            }
            Tab("Actors", systemImage: "person.2", value: AppTab.members) {
                if let actorStore = teamRuntime?.actorStore {
                    MembersTab(pairing: pairing,
                               mqtt: mqtt,
                               sessionViewModel: viewModel,
                               teamcluService: teamcluService,
                               activeTeam: activeTeam,
                               currentActorID: currentActorID,
                               store: actorStore,
                               connectedAgentsStore: teamRuntime?.connectedAgentsStore,
                               agentPresenceStore: teamRuntime?.agentPresenceStore,
                               workspacesRepository: teamRuntime?.workspacesRepo,
                               agentAccessRepository: teamRuntime?.agentAccessRepo,
                               teamResourceRepository: teamRuntime?.teamResourceRepo,
                               showInvite: $showInviteAfterReminder)
                } else {
                    ContentUnavailableView("No Team Selected",
                                          systemImage: "person.2",
                                          description: Text("Create or join a team to see actors."))
                }
            }
            Tab(value: AppTab.search, role: .search) {
                SearchTab(mqtt: mqtt,
                          pairing: pairing,
                          teamcluService: teamcluService,
                          viewModel: viewModel,
                          rootSelection: $selection,
                          sessionsPath: $sessionsPath)
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .task(id: activeTeam?.id) {
            await coordinator?.prepareTeamRuntime(modelContext: modelContext)
            // SessionListVM observes ConnectedAgentsStore directly and fans
            // its `{actor}/state` subscriptions out per known daemon, so we
            // start it after prepareTeamRuntime so the initial agent set is
            // already loaded.
            viewModel.start(
                mqtt: mqtt,
                hub: hub,
                teamID: activeTeam?.id ?? "",
                connectedAgentsStore: teamRuntime?.connectedAgentsStore,
                modelContext: modelContext,
                teamcluService: teamcluService,
                agentPresenceStore: teamRuntime?.agentPresenceStore
            )
            // Inbox red-dot subscription: per-user MQTT topic, populated by
            // FC fan-out after each message INSERT. Decoupled from the
            // per-runtime subscriptions in start() above.
            if let actorID = currentActorID {
                viewModel.startInboxSubscription(
                    mqtt: mqtt,
                    hub: hub,
                    actorID: actorID,
                    teamID: activeTeam?.id ?? "",
                    sessionsRepo: teamRuntime?.sessionsRepo,
                    modelContext: modelContext
                )
            }
            await refreshSessionsFromBackend()
            if let team = activeTeam {
                await maybeShowFirstAgentReminder(team: team)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .amuxInviteTokenReceived)) { note in
            guard let token = note.userInfo?["token"] as? String,
                  let store = teamRuntime?.actorStore else { return }
            Task { await claimAndSwitch(token: token, store: store) }
        }
        .onChange(of: teamRuntime?.actorStore != nil) { _, ready in
            // Replay a token captured by ChooseAuthView (pre-auth) once the
            // post-auth ActorStore is alive — without it the existing
            // notification path doesn't fire (ChooseAuthView posts the token
            // before this view is mounted).
            if ready { replayPendingInviteIfNeeded() }
        }
        .onAppear {
            // Cold launch from a push: the intent may have been recorded
            // before this view mounted, so `onChange` never sees the
            // transition. Consume any already-pending session here.
            if let pending = navigationRouter?.pendingSessionID, !pending.isEmpty {
                openSessionFromDeepLink(pending)
            }
        }
        .onChange(of: navigationRouter?.pendingSessionID) { _, sessionID in
            // A push notification / deep link asked to open a session. Switch
            // to the Sessions tab and push it onto the NavigationStack using
            // the same `"session:<id>"` path element that in-app navigation
            // (SearchTab, session list) uses, then clear the intent so the
            // next deep link to the same session fires again.
            guard let sessionID, !sessionID.isEmpty else { return }
            openSessionFromDeepLink(sessionID)
        }
        .sheet(isPresented: $showFirstAgentReminder) {
            ZeroAgentReminderSheet {
                // Switch to the Actors tab and present its existing
                // invite sheet on the next runloop tick. Doing the switch
                // here keeps the reminder copy short while sending the
                // user to the canonical invite UI.
                selection = .members
                showInviteAfterReminder = true
            }
        }
    }

    /// Push/deep-link entry point: reveal the Sessions tab and push the given
    /// session, mirroring the `"session:<id>"` path convention that
    /// `SessionsTab.navigationDestination` resolves. Idempotent — skips the
    /// push if the session is already on top of the stack.
    @MainActor
    private func openSessionFromDeepLink(_ sessionID: String) {
        selection = .sessions
        let element = "session:\(sessionID)"
        if sessionsPath.last != element {
            sessionsPath.append(element)
        }
        // Consume the intent so a repeat deep link to the same session
        // re-triggers the observer (nil -> id transition).
        navigationRouter?.pendingSessionID = nil
    }

    @MainActor
    private func maybeShowFirstAgentReminder(team: TeamSummary) async {
        guard !remindedTeams.contains(team.id),
              let repo = teamRuntime?.agentAccessRepo else { return }
        // `actor_directory` filters out `visibility != 'team'` agents
        // (see `202605160004_actor_profile_avatar.sql:22`), so
        // teamAgentCount alone reports 0 for users who only have private
        // agents and would nag them every launch. Cross-check against
        // ConnectedAgentsStore, which sources from `agent_member_access`
        // and surfaces every agent the current user has access to —
        // public OR private. The reminder only fires when *both*
        // signals say zero.
        do {
            let publicCount = try await repo.teamAgentCount(teamID: team.id)
            let accessibleCount = teamRuntime?.connectedAgentsStore.agents.count ?? 0
            markTeamReminded(team.id)
            if publicCount == 0 && accessibleCount == 0 {
                showFirstAgentReminder = true
            }
        } catch {
            // Soft prompt; failure to count is not user-visible.
        }
    }

    private func replayPendingInviteIfNeeded() {
        guard let coordinator,
              let token = coordinator.pendingInviteToken,
              !token.isEmpty,
              let store = teamRuntime?.actorStore else { return }
        // Clear first so a transient store re-creation can't trigger a second
        // claim against the same token.
        coordinator.pendingInviteToken = nil
        Task { await claimAndSwitch(token: token, store: store) }
    }

    /// Single entry point used by every flow that ends in a claim:
    ///   - the `teamclu://invite?token=…` deeplink (NotificationCenter)
    ///   - the pre-auth paste path on ChooseAuthView (`pendingInviteToken`)
    ///
    /// If the claim returns a `refreshToken` (agent or member re-invite),
    /// adopt that session before bootstrapping — the RT is bound to the
    /// target actor's `user_id` and the previously-signed-in user is no
    /// longer relevant. Without this, the invite is silently consumed and
    /// the recipient is stranded.
    ///
    /// If the claim returns no refresh token (fresh-member invite using
    /// the existing `auth.uid()` path), keep the legacy behavior: just
    /// bootstrap into the joined team if it differs from the active one.
    private func claimAndSwitch(token: String, store: ActorStore) async {
        guard let result = await store.claimInvite(token: token) else { return }
        if let rt = result.refreshToken, let coordinator {
            do {
                try await coordinator.store.setSession(refreshToken: rt)
            } catch {
                // Claim consumed the invite but we couldn't adopt the
                // session. Nothing recoverable here — the invite is spent.
                return
            }
            await coordinator.bootstrap(preferringTeamID: result.teamID)
            return
        }
        // Fresh-member path: same team optimization unchanged.
        if let activeID = activeTeam?.id, activeID == result.teamID { return }
        await coordinator?.bootstrap(preferringTeamID: result.teamID)
    }

    @MainActor
    private func refreshSessionsFromBackend() async {
        guard let activeTeam, let runtime = teamRuntime else { return }

        let teamID = activeTeam.id
        let workspacesRepoLocal = runtime.workspacesRepo
        let sessionsRepoLocal = runtime.sessionsRepo
        let sessionIDsRepoLocal = runtime.sessionIDsRepo
        async let workspacesTask: [WorkspaceRecord]? = {
            guard let repo = workspacesRepoLocal else { return nil }
            return try? await repo.listWorkspaces(teamID: teamID, agentID: nil)
        }()

        if let repo = sessionsRepoLocal,
           let records = try? await repo.listSessions(teamID: teamID) {
            viewModel.syncSessionRecords(records, modelContext: modelContext)
            // Overlay server-side has_unread on top of the just-synced rows.
            // Same RPC the desktop session list uses — the source of truth
            // is session_read_markers.last_read_at vs sessions.last_message_at.
            if let flags = try? await repo.fetchUnreadFlags(teamID: teamID, limit: 100) {
                viewModel.applyUnreadFlags(flags, modelContext: modelContext)
            }
        } else if let repo = sessionIDsRepoLocal,
                  let ids = try? await repo.listSessionIDs(teamID: teamID) {
            viewModel.validSessionIDs = ids
            viewModel.reloadSessions(modelContext: modelContext)
        }
    }
}
