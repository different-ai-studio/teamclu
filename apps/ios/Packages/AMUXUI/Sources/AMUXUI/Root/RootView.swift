import SwiftUI
import AMUXCore

/// The signed-in app: the session list as the single root screen, plus the
/// app-wide work that has to outlive it — team runtime bring-up, the
/// session-list subscriptions, deep links, invites, and voice capture.
public struct RootView: View {
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
    /// Deployment feature flags from `/v1/config/bootstrap`. Absent in
    /// previews and tests, where the defaults (everything on) apply.
    @Environment(FeatureFlagsStore.self) private var featureFlags: FeatureFlagsStore?
    @State private var viewModel = SessionListViewModel()
    @State private var sessionsPath: [String] = []
    /// Shared by the ideas list and the idea detail, which are separate
    /// pushes on the session stack.
    @State private var ideaStore: IdeaStore?
    @State private var ideaStoreTeamID: String?
    /// Whether the voice capture screen is up. It covers the whole app, so
    /// it's drawn here rather than pushed.
    @State private var isCapturingVoice = false
    @State private var voiceRecorder = VoiceRecorder()
    @State private var isStartingVoiceSession = false
    @State private var voiceErrorMessage: String?
    /// Start of the current take, for the capture screen's elapsed readout.
    @State private var recordingStartedAt: Date?
    /// The finished transcript, held while the session is being created —
    /// the recorder has already been reset by then, and the capture screen
    /// should keep showing the words it is about to send.
    @State private var pendingVoiceTranscript: String = ""
    /// Set when a finished take has no default agent to go to — drives the
    /// picker, and carries the transcript waiting on that choice.
    @State private var voiceAgentChoice: VoiceAgentChoice?

    /// Reduces `session/{id}/live` into the session list's leading dots.
    /// Owned here, not by SessionsHome, so its MQTT subscriptions survive
    /// that screen's view identity being torn down and rebuilt.
    @State private var liveActivityStore = SessionLiveActivityStore()

    /// Drives the "add the team's first agent" reminder. Set once per app
    /// launch when we observe a team with zero agents; soft-dismissible so it
    /// doesn't reappear after the user closes it.
    @State private var showFirstAgentReminder: Bool = false
    /// Set when the user taps "Add agent" in the reminder sheet. Opens the
    /// actors list with its MemberInviteSheet after the reminder closes.
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

    /// Whether this deployment ships the team-apps surface. Defaults to on
    /// when no flags have arrived — the same fail-open the flags themselves
    /// use, so a slow or unreachable config endpoint does not hide a feature
    /// the deployment does have.
    private var appsEnabled: Bool { featureFlags?.flags.apps ?? true }

    // Split across three properties rather than one expression. As one, the
    // type-checker took over two seconds on CI to solve it — the same shape
    // that failed the release archive in SessionDetailView, one feature away
    // from doing it here. Each `some View` boundary is its own problem.

    private var home: some View {
        SessionsHome(mqtt: mqtt,
                     hub: hub,
                     pairing: pairing,
                     teamcluService: teamcluService,
                     activeTeam: activeTeam,
                     currentActorID: currentActorID,
                     viewModel: viewModel,
                     refreshSessionsFromBackend: refreshSessionsFromBackend,
                     navigationPath: $sessionsPath,
                     showMembersInvite: $showInviteAfterReminder,
                     connectedAgentsStore: teamRuntime?.connectedAgentsStore,
                     actorStore: teamRuntime?.actorStore,
                     agentPresenceStore: teamRuntime?.agentPresenceStore,
                     shortcutsStore: teamRuntime?.shortcutsStore,
                     teamAppsStore: appsEnabled ? teamRuntime?.teamAppsStore : nil,
                     ideaStore: ideaStore,
                     messagesRepository: teamRuntime?.messagesRepo,
                     workspacesRepository: teamRuntime?.workspacesRepo,
                     sessionsRepository: teamRuntime?.sessionRepo,
                     sessionsListRepository: teamRuntime?.sessionsRepo,
                     teamRepository: teamRuntime?.teamRepo,
                     actorRepository: teamRuntime?.actorRepo,
                     agentAccessRepository: teamRuntime?.agentAccessRepo,
                     teamResourceRepository: teamRuntime?.teamResourceRepo,
                     onReconnect: onReconnect,
                     onSignOut: onSignOut,
                     onStartVoice: startVoiceCapture,
                     preferencesAPI: preferencesAPI,
                     notificationPrefsStore: teamRuntime?.notificationPrefsStore,
                     liveActivityStore: liveActivityStore)
    }

    /// The home screen, with the voice capture laid over it while a take is
    /// running. An overlay rather than a cover, so the agent picker and the
    /// error alert below can present over it without a second modal layer.
    private var screens: some View {
        ZStack {
            home
            if isCapturingVoice {
                VoiceCaptureView(
                    phase: voicePhase,
                    level: voiceRecorder.audioLevel,
                    transcript: pendingVoiceTranscript.isEmpty ? voiceRecorder.transcript : pendingVoiceTranscript,
                    startedAt: recordingStartedAt,
                    onDone: voiceRecorder.stopRecording,
                    onCancel: cancelVoiceCapture
                )
                .transition(.move(edge: .bottom))
                .zIndex(1)
            }
        }
        .animation(.spring(response: 0.38, dampingFraction: 0.9), value: isCapturingVoice)
    }

    /// The screens, plus what reacts to a voice take or the team loading.
    private var wiredScreens: some View {
        screens
        .onChange(of: isCapturingVoice) { _, capturing in
            // Belt and braces: whatever takes the capture screen down, a
            // running engine with no visible surface is the worst outcome.
            // Finished takes are already `.done` here, so this only catches a
            // genuine abandon.
            guard !capturing else { return }
            if voiceRecorder.state == .recording { voiceRecorder.cancel() }
            recordingStartedAt = nil
        }
        .onChange(of: voiceRecorder.state) { _, state in
            switch state {
            case .done:
                let transcript = voiceRecorder.transcribedText ?? ""
                voiceRecorder.reset()
                guard !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    isCapturingVoice = false
                    voiceErrorMessage = String(localized: "No speech was recognized. Try recording again.")
                    return
                }
                pendingVoiceTranscript = transcript
                isStartingVoiceSession = true
                Task { await startVoiceSession(transcript) }
            case .denied:
                isCapturingVoice = false
                voiceErrorMessage = String(localized: "Microphone and speech recognition access are required for voice chat.")
            case .error(let message):
                isCapturingVoice = false
                voiceErrorMessage = message
            case .recording:
                recordingStartedAt = Date()
            case .idle:
                break
            }
        }
        .alert("Voice chat couldn't start", isPresented: Binding(
            get: { voiceErrorMessage != nil },
            set: { if !$0 { voiceErrorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(voiceErrorMessage ?? "")
        }
        .task(id: IdeaStoreKey(teamID: activeTeam?.id, isConnected: teamRuntime?.ideasRepo != nil)) {
            // Keyed on the repository arriving too, not just the team: at a
            // cold launch the ideas list can be on screen before the team
            // runtime exists, and keyed on the team alone this ran once with
            // no repository and never again.
            await configureIdeaStore()
        }
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
            // Session-list activity dots. Started before the inbox
            // subscription below and the send path in TeamcluService, both of
            // which are triggers into it.
            liveActivityStore.start(
                mqtt: mqtt,
                hub: hub,
                teamID: activeTeam?.id ?? "",
                modelContext: modelContext
            )
            teamcluService?.liveActivityStore = liveActivityStore
            // Inbox red-dot subscription: per-user MQTT topic, populated by
            // FC fan-out after each message INSERT. Decoupled from the
            // per-runtime subscriptions in start() above.
            //
            // The id here is the authenticated user's, taken from the access
            // token's `sub`. FC publishes to `inbox/<auth user id>`, which is
            // a different UUID from `currentActorID` — this used to pass the
            // actor id and so subscribed to a topic nothing is published to.
            if let userID = await coordinator?.currentUserID() {
                viewModel.startInboxSubscription(
                    mqtt: mqtt,
                    hub: hub,
                    userID: userID,
                    teamID: activeTeam?.id ?? "",
                    sessionsRepo: teamRuntime?.sessionsRepo,
                    modelContext: modelContext,
                    liveActivityStore: liveActivityStore
                )
            } else {
                NSLog("[RootView] inbox: no access token subject; unread dot disabled")
            }
            await refreshSessionsFromBackend()
            if let team = activeTeam {
                await maybeShowFirstAgentReminder(team: team)
            }
        }
    }

    /// …plus the invite, deep-link and lifecycle observers.
    private var observedScreens: some View {
        wiredScreens
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
            // A push notification / deep link asked to open a session. Push
            // it onto the NavigationStack using the same `"session:<id>"`
            // path element that in-app navigation uses, then clear the
            // intent so the next deep link to the same session fires again.
            guard let sessionID, !sessionID.isEmpty else { return }
            openSessionFromDeepLink(sessionID)
        }
    }

    public var body: some View {
        observedScreens
        .modifier(AppIconBadgeSync(teamID: activeTeam?.id ?? ""))
        .sheet(item: $voiceAgentChoice) {
            // Swipe-dismiss and the picker's own Cancel both land here. A
            // pick has already flipped `isStartingVoiceSession`, so this only
            // fires for a genuine abandon.
            if !isStartingVoiceSession { cancelVoiceCapture() }
        } content: { choice in
            VoiceAgentPicker(agents: choice.agents,
                             agentPresenceStore: teamRuntime?.agentPresenceStore) { agent in
                voiceAgentChoice = nil
                isStartingVoiceSession = true
                Task { await startVoiceSession(choice.transcript, with: agent) }
            }
        }
        .sheet(isPresented: $showFirstAgentReminder) {
            ZeroAgentReminderSheet {
                // SessionsHome pushes the actors list, which presents its
                // existing invite sheet. Keeps the reminder copy short while
                // sending the user to the canonical invite UI.
                showInviteAfterReminder = true
            }
        }
    }

    private var voicePhase: VoiceCaptureView.Phase {
        if isStartingVoiceSession { return .startingSession }
        if voiceAgentChoice != nil { return .awaitingAgent }
        return voiceRecorder.state == .recording ? .recording : .preparing
    }

    /// The bottom bar's mic: bring up the capture screen and start the take.
    @MainActor
    private func startVoiceCapture() {
        guard !isCapturingVoice,
              voiceRecorder.state != .recording,
              !isStartingVoiceSession
        else { return }
        // A refused or failed take leaves the recorder parked in that
        // state; a second refusal would then be no change at all, and the
        // capture screen would wait on `.onChange` forever.
        switch voiceRecorder.state {
        case .denied, .error: voiceRecorder.reset()
        default: break
        }
        isCapturingVoice = true
        voiceRecorder.startRecording()
    }

    @MainActor
    private func cancelVoiceCapture() {
        voiceRecorder.cancel()
        recordingStartedAt = nil
        pendingVoiceTranscript = ""
        voiceAgentChoice = nil
        isCapturingVoice = false
    }

    /// Push/deep-link entry point: push the given session, mirroring the
    /// `"session:<id>"` path convention that `SessionsHome` resolves.
    /// Idempotent — skips the push if the session is already on top of the
    /// stack.
    @MainActor
    private func openSessionFromDeepLink(_ sessionID: String) {
        let element = "session:\(sessionID)"
        if sessionsPath.last != element {
            sessionsPath.append(element)
        }
        // Consume the intent so a repeat deep link to the same session
        // re-triggers the observer (nil -> id transition).
        navigationRouter?.pendingSessionID = nil
    }

    @MainActor
    private func startVoiceSession(_ transcript: String) async {
        do {
            let context = try voiceContext()
            switch try await VoiceSessionStarter.resolveTarget(context) {
            case .agent(let agent):
                try await createVoiceSession(transcript: transcript, agent: agent, context: context)
            case .needsPick(let agents):
                // Park the take on the capture screen and hand over to the
                // picker; creation resumes in `startVoiceSession(_:with:)`.
                isStartingVoiceSession = false
                voiceAgentChoice = VoiceAgentChoice(transcript: transcript, agents: agents)
            }
        } catch {
            failVoiceSession(error)
        }
    }

    /// Resumes a parked take once the user has picked an agent, and remembers
    /// the choice as their personal default so the next take doesn't ask.
    @MainActor
    private func startVoiceSession(_ transcript: String, with agent: ConnectedAgent) async {
        do {
            let context = try voiceContext()
            _ = await context.actorStore.setMemberDefaultAgent(agentID: agent.id)
            try await createVoiceSession(transcript: transcript, agent: agent, context: context)
        } catch {
            failVoiceSession(error)
        }
    }

    @MainActor
    private func createVoiceSession(transcript: String,
                                    agent: ConnectedAgent,
                                    context: VoiceSessionStarter.Context) async throws {
        let sessionID = try await VoiceSessionStarter.start(
            transcript: transcript,
            agent: agent,
            context: context,
            viewModel: viewModel,
            modelContext: modelContext
        )
        isStartingVoiceSession = false
        pendingVoiceTranscript = ""
        isCapturingVoice = false
        sessionsPath = ["session:\(sessionID)"]
    }

    @MainActor
    private func failVoiceSession(_ error: Error) {
        isStartingVoiceSession = false
        pendingVoiceTranscript = ""
        voiceAgentChoice = nil
        isCapturingVoice = false
        voiceErrorMessage = error.localizedDescription
    }

    private func voiceContext() throws -> VoiceSessionStarter.Context {
        try VoiceSessionStarter.Context(
            teamID: activeTeam?.id ?? "",
            currentActorID: currentActorID,
            teamcluService: teamcluService,
            actorStore: teamRuntime?.actorStore,
            connectedAgentsStore: teamRuntime?.connectedAgentsStore,
            workspacesRepository: teamRuntime?.workspacesRepo,
            sessionsRepository: teamRuntime?.sessionRepo
        )
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
            await refreshSessionContextNames(records: records, runtime: runtime, teamID: teamID)
        } else if let repo = sessionIDsRepoLocal,
                  let ids = try? await repo.listSessionIDs(teamID: teamID) {
            viewModel.validSessionIDs = ids
            viewModel.reloadSessions(modelContext: modelContext)
        }
    }
}

extension RootView {
    fileprivate struct IdeaStoreKey: Equatable {
        let teamID: String?
        let isConnected: Bool
    }

    @MainActor
    fileprivate func configureIdeaStore() async {
        guard let activeTeam else {
            ideaStore = nil
            ideaStoreTeamID = nil
            return
        }

        if ideaStore == nil || ideaStoreTeamID != activeTeam.id {
            // Made before the repository is here, so the cached list shows at
            // once; a missing repository at this point means "not up yet".
            ideaStore = IdeaStore(
                teamID: activeTeam.id,
                repository: teamRuntime?.ideasRepo,
                modelContext: modelContext
            )
            ideaStoreTeamID = activeTeam.id
        } else if let repository = teamRuntime?.ideasRepo, ideaStore?.isConnected == false {
            ideaStore?.attach(repository: repository)
        }
    }

    /// Fills the names on the session list's third line: the app a session
    /// was created from, or its idea. Both are cached on the session, so this
    /// only reaches the network for what the cache can't answer — the apps
    /// list when any session has an app, the ideas list when an idea has no
    /// title cached yet.
    @MainActor
    fileprivate func refreshSessionContextNames(
        records: [SessionRecord],
        runtime: TeamRuntimeContext,
        teamID: String
    ) async {
        if appsEnabled, let appsStore = runtime.teamAppsStore,
           records.contains(where: { !($0.appID ?? "").isEmpty }) {
            await appsStore.reload()
            if appsStore.errorMessage == nil {
                let names = Dictionary(
                    appsStore.apps.map { ($0.id, $0.name) },
                    uniquingKeysWith: { a, _ in a }
                )
                viewModel.applyAppNames(names, modelContext: modelContext)
            }
        }

        if let ideasRepo = runtime.ideasRepo,
           !viewModel.ideaIDsMissingTitle(modelContext: modelContext).isEmpty,
           let ideas = try? await ideasRepo.listIdeas(teamID: teamID) {
            // Upsert only: the ideas list owns pruning its cache.
            IdeaCacheSynchronizer.upsert(ideas, modelContext: modelContext)
            viewModel.fillIdeaTitlesFromCache(modelContext: modelContext)
        }
    }
}

/// A finished take waiting on an agent choice. Identifiable so the picker can
/// be a `sheet(item:)` — its identity is the take, so a second take always
/// re-presents.
private struct VoiceAgentChoice: Identifiable {
    let id = UUID()
    let transcript: String
    let agents: [ConnectedAgent]
}
