import SwiftUI
import UIKit
import os
import AMUXCore
import AMUXUI

private let logger = Logger(subsystem: "com.teamclu.mobile", category: "MQTT")

struct ContentView: View {
    let pairing: PairingManager
    @State private var mqtt = MQTTService()
    @State private var hub: MQTTMessageHub
    @State private var teamcluService = TeamcluService()
    @State private var onboarding: AppOnboardingCoordinator
    /// Bridges push/deep-link "open session" intents into RootTabView's
    /// session NavigationStack (which owns `sessionsPath`).
    @State private var navigationRouter = NavigationRouter()
    /// Deployment feature flags, refreshed with the broker config on every
    /// launch. Starts fail-open so the UI is not gated on a round trip.
    @State private var featureFlags = FeatureFlagsStore()
    @State private var isConnecting = false
    /// Set by the splash once its lap has played out.
    @State private var splashLapFinished = false
    @State private var connectTask: Task<Void, Never>?
    /// One-shot legacy→CloudAPI session migration, run before the first
    /// `bootstrap()`. Nil when no cloud config is resolvable (Supabase
    /// fallback) — nothing to migrate. Cleared after it runs once.
    @State private var pendingSessionMigration: (@Sendable () async -> Void)?
    /// Bumped whenever the Cloud API base URL changes (pre-auth server
    /// sheet). The `.task(id:)` modifiers key on it, so bootstrap re-runs
    /// against the rebuilt store and the token-refresh listener re-attaches.
    @State private var backendEpoch = 0
    /// Presents the server sheet from the `.failed` route — the rescue hatch
    /// when the configured server is mistyped or gone.
    @State private var showServerSettings = false
    /// The Cloud API base the current onboarding store was built against.
    /// `rebuildCloudBackend` compares against it to detect a real server
    /// move (vs a same-URL re-save) before tearing down session + MQTT.
    @State private var activeCloudBaseURL = CloudAPIConfigurationStore.configuration()?.baseURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.modelContext) private var modelContext

    init(pairing: PairingManager) {
        self.pairing = pairing
        let mqtt = MQTTService()
        _mqtt = State(initialValue: mqtt)
        _hub = State(initialValue: MQTTMessageHub(mqtt: mqtt))
        _onboarding = State(initialValue: Self.makeOnboardingCoordinator())
        _pendingSessionMigration = State(initialValue: nil)
    }

    /// Cloud API is the only client backend. Build the Cloud-API-backed
    /// onboarding store from the resolved cloud endpoint; if none is
    /// configured, surface a failing store rather than a Supabase fallback
    /// (the Supabase SDK was removed in the cutover endgame). Existing
    /// sessions persisted only in the old Supabase keychain are not migrated
    /// — affected users re-authenticate once.
    private static func makeOnboardingCoordinator() -> AppOnboardingCoordinator {
        if let cloudConfig = CloudAPIConfigurationStore.configuration() {
            let store = CloudAPIAppOnboardingStore(
                configuration: cloudConfig,
                storage: KeychainSessionStorage()
            )
            return AppOnboardingCoordinator(store: store)
        }
        return AppOnboardingCoordinator(
            store: FailingOnboardingStore(
                error: NSError(
                    domain: "CloudAPI", code: 0,
                    userInfo: [NSLocalizedDescriptionKey: String(localized: "Cloud API is not configured.")]
                )
            )
        )
    }

    /// Re-points the whole Cloud API stack at the currently stored server —
    /// called after the user saves an address in ServerSettingsSheet
    /// (reachable from the welcome route AND from `.failed`, which can carry
    /// a signed-in session whose server just became unreachable).
    ///
    /// When the base URL actually changed, everything scoped to the old
    /// server is torn down: the MQTT socket (still pumping server-A data)
    /// and the keychain session — its service key is fixed, not URL-scoped,
    /// so without a signOut the rebuilt store would replay server A's
    /// refresh token against server B. A same-URL re-save keeps the
    /// session: that's a retry, not a move.
    private func rebuildCloudBackend() {
        let newBaseURL = CloudAPIConfigurationStore.configuration()?.baseURL
        if newBaseURL != activeCloudBaseURL {
            let oldStore = onboarding.store
            connectTask?.cancel()
            isConnecting = false
            Task {
                await mqtt.disconnect()
                // Best-effort remote revoke; always clears the shared
                // keychain locally even when server A is unreachable.
                try? await oldStore.signOut()
            }
        }
        activeCloudBaseURL = newBaseURL
        onboarding = Self.makeOnboardingCoordinator()
        backendEpoch += 1
    }

    @ViewBuilder
    private var readyView: some View {
        RootTabView(
            mqtt: mqtt,
            hub: hub,
            pairing: pairing,
            teamcluService: teamcluService,
            activeTeam: onboarding.currentContext?.team,
            currentActorID: onboarding.currentContext?.memberActorID,
            onReconnect: {
                forceReconnect()
            },
            onSignOut: {
                signOut()
            },
            preferencesAPI: PushBootstrap.shared.preferencesAPI
        )
        .environment(onboarding)
        .environment(navigationRouter)
        .environment(featureFlags)
        .task(id: onboarding.isOfflineLaunch) {
            // Entered on the cached team without network: recheck memberships
            // as soon as a path comes back, without leaving the app.
            guard onboarding.isOfflineLaunch else { return }
            for await _ in NetworkPathUpdates.becameReachable() {
                await onboarding.revalidateAfterOfflineLaunch()
                if !onboarding.isOfflineLaunch { break }
            }
        }
        .task {
            // Asked here, once signed in and in a team, rather than at launch:
            // at launch the system prompt lands on top of the intro cards,
            // before the user knows what the app would notify them about.
            _ = await PushPermissionManager.requestIfUndetermined()
        }
        .task {
            if let team = onboarding.currentContext?.team {
                OnboardingLocalCacheBootstrapper.ensureWorkspaceExists(team: team, modelContext: modelContext)
            }
            // Broker address before dial: it lives in Cloud API env, not the
            // bundle, so a moved broker doesn't need an App Store release.
            await refreshBrokerConfig()
            await connectMQTT()
        }
    }

    /// The splash stays up until BOTH the work is done and its lap has played.
    /// Bootstrap frequently finishes in well under a lap — on a warm start it
    /// is near-instant — and without this the animation is torn down before it
    /// is visible at all.
    private var showSplash: Bool {
        onboarding.route == .loading || !splashLapFinished
    }

    var body: some View {
        ZStack {
            routeContent

            if showSplash {
                ApertureSplashView { splashLapFinished = true }
                    .transition(.opacity)
                    .zIndex(1)
            }
        }
        .animation(.easeOut(duration: 0.3), value: showSplash)
    }

    @ViewBuilder
    private var routeContent: some View {
        Group {
            switch onboarding.route {
            case .loading:
                // Covered by the splash; only needs to not be blank underneath
                // while it fades out.
                Color(.systemBackground).ignoresSafeArea()
            case .needsAuth:
                WelcomeView(coordinator: onboarding, onServerChanged: { rebuildCloudBackend() })
            case .createTeam:
                CreateTeamView(coordinator: onboarding)
            case .selectTeam:
                OrgTeamPickerView(coordinator: onboarding)
            case .noTeam:
                NoTeamView(coordinator: onboarding, onSignOut: { signOut() })
            case .ready:
                readyView
            case .failed:
                OnboardingErrorView(
                    message: onboarding.errorMessage ?? String(localized: "Unknown setup error."),
                    onRetry: {
                        Task { await onboarding.bootstrap() }
                    },
                    onSignOut: {
                        signOut()
                    },
                    onServerSettings: {
                        showServerSettings = true
                    }
                )
            }
        }
        .sheet(isPresented: $showServerSettings) {
            ServerSettingsSheet(onSaved: { rebuildCloudBackend() })
        }
        .task(id: backendEpoch) {
            // Seed the Cloud API SessionStore from any pre-existing Supabase
            // session exactly once, BEFORE the first bootstrap, so existing
            // users stay signed in across the cutover. No-op (nil) on the
            // Supabase fallback path.
            if let migrate = pendingSessionMigration {
                pendingSessionMigration = nil
                await migrate()
            }
            await onboarding.bootstrap()
        }
        .task(id: backendEpoch) {
            // Reconnect MQTT every time the auth provider rotates the
            // access token. MQTT uses the JWT as its CONNECT password
            // and the broker stops accepting publishes once the token
            // hits its ~1h expiry — without a reconnect the socket
            // appears live but every publish is silently dropped and
            // the user has no clue until they sign out + sign back in.
            // Supabase-swift auto-refreshes the session in the
            // background; this loop just listens for the resulting
            // `.tokenRefreshed` event and rebuilds the connection.
            for await _ in onboarding.store.tokenRefreshes() {
                logger.info("Auth token refreshed; reconnecting MQTT")
                guard pairing.isPaired, onboarding.route == .ready else { continue }
                forceReconnect()
            }
        }
        .task(id: backendEpoch) {
            // The server refused the refresh token: the session was ended
            // somewhere else. Every screen would otherwise sit on a spinner
            // until its request failed with a bare AuthRequired, so go back to
            // sign-in and clear this account's data like a sign-out does.
            for await _ in onboarding.store.sessionRevocations() {
                guard onboarding.handleSessionRevoked() else { continue }
                logger.info("Auth session was revoked; returning to sign-in")
                connectTask?.cancel()
                isConnecting = false
                await mqtt.disconnect()
                await onboarding.wipeLocalCache(modelContext: modelContext)
            }
        }
        .onChange(of: onboarding.route) { _, route in
            // Anyone who has made it into the app — including people upgrading
            // from a build without the intro — never needs the intro cards.
            if route == .ready {
                UserDefaults.standard.set(true, forKey: OnboardingFlags.hasSeenIntroKey)
            }
        }
        .onChange(of: onboarding.pendingCreatedTeam) { _, createdTeam in
            guard let createdTeam else { return }
            OnboardingLocalCacheBootstrapper.prime(createdTeam: createdTeam, modelContext: modelContext)
        }
        .onChange(of: pairing.isPaired) { _, paired in
            guard paired else { return }
            Task { await connectMQTT() }
        }
        .onChange(of: onboarding.teamRuntimeContext?.team.id) { _, newID in
            // start() is keyed on the active team and is idempotent
            // (cancels any prior listener), so a single onChange covers
            // first appearance + team switches.
            guard let id = newID, let runtime = onboarding.teamRuntimeContext else { return }
            teamcluService.start(
                mqtt: mqtt,
                hub: hub,
                teamId: id,
                peerId: "ios-\(pairing.authToken.prefix(6))",
                modelContext: modelContext,
                connectedAgentsStore: runtime.connectedAgentsStore,
                currentActorID: runtime.memberActorID,
                messagesRepository: runtime.messagesRepo
            )
        }
        .onReceive(NotificationCenter.default.publisher(for: .amuxAuthCallbackReceived)) { notification in
            guard let url = notification.object as? URL else { return }
            Task { await onboarding.handleAuthCallback(url: url) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .amuxOpenSession)) { note in
            guard let sid = note.userInfo?["session_id"] as? String else { return }
            // Record the intent on the shared router. RootTabView observes
            // `pendingSessionID`, switches to the Sessions tab, and pushes the
            // session onto its NavigationStack. We record even before
            // onboarding is `.ready` (cold launch from a push): RootTabView
            // consumes any already-pending intent when it first mounts, so the
            // deep link survives the launch-time onboarding gap.
            logger.info("Open-session deep link received; routing to \(sid, privacy: .public)")
            navigationRouter.openSession(sid)
        }
        .onChange(of: scenePhase) { _, phase in
            // iOS freezes sockets when backgrounded but rarely delivers a
            // clean disconnect callback, so `connectionState` can stay
            // `.connected` on a dead socket ("zombie"). On foreground we
            // force a full reconnect regardless of reported state; the
            // SessionDetailViewModel loop will resubscribe and trigger an
            // incremental history sync once MQTT is back up.
            if phase == .active && pairing.isPaired && onboarding.route == .ready {
                logger.info("App became active, forcing MQTT reconnect…")
                forceReconnect()
            }
        }
    }

    private func signOut() {
        connectTask?.cancel()
        isConnecting = false
        Task {
            await mqtt.disconnect()
            await onboarding.signOutAndWipeCache(modelContext: modelContext)
        }
    }

    /// User-initiated reconnect: cancels any in-flight connect Task (so a
    /// hung MQTTService.connect can't leave `isConnecting` stuck `true`),
    /// clears the flag, then disconnects and reconnects.
    private func forceReconnect() {
        connectTask?.cancel()
        isConnecting = false
        connectTask = Task {
            await mqtt.disconnect()
            await connectMQTT()
        }
    }

    /// One-shot attach of an MQTTTraceRecorder to the hub. Idempotent —
    /// re-attaching across reconnects keeps appending to the same file,
    /// which is what we want for cross-session captures.
    private func attachTraceRecorder() async {
        let docs = try? FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        guard let docs else { return }
        let url = docs.appendingPathComponent("teamclu-trace.jsonl")
        let recorder = MQTTTraceRecorder(fileURL: url)
        do {
            try await recorder.start()
            await hub.attachRecorder(recorder)
            logger.info("MQTT trace recording enabled → \(url.path)")
        } catch {
            logger.error("Failed to start MQTT trace recorder: \(error)")
        }
    }

    /// Pull the broker address from `GET /v1/config/bootstrap` and hand it to
    /// the PairingManager (which caches it and ignores it when the user has
    /// chosen their own server). Best-effort: on failure the cached address
    /// from the last successful fetch is what `connectMQTT` dials.
    private func refreshBrokerConfig() async {
        guard let config = CloudAPIConfigurationStore.configuration() else { return }
        // Resolve the bearer up front so the client's token closure captures a
        // plain String rather than the non-Sendable coordinator.
        let token: String
        do {
            token = try await onboarding.accessToken()
        } catch {
            logger.error("Failed to get access token for broker config: \(error)")
            return
        }
        let client = CloudAPIClient(configuration: config, accessToken: { token })
        do {
            let bootstrap = try await ServerBrokerConfig.fetchBootstrap(client: client)
            // Flags ride the same answer, so they land even when this
            // deployment ships no broker block and the early return below
            // fires.
            featureFlags.apply(bootstrap.features)
            guard let endpoint = bootstrap.broker else {
                logger.warning("Cloud API returned no MQTT broker config")
                return
            }
            pairing.applyServerBrokerConfig(endpoint)
        } catch {
            logger.error("Failed to fetch broker config: \(error)")
        }
    }

    private func connectMQTT() async {
        guard onboarding.route == .ready, pairing.isPaired, !isConnecting else { return }
        isConnecting = true
        defer { isConnecting = false }

        let token: String
        do {
            token = try await onboarding.accessToken()
        } catch {
            logger.error("Failed to get access token for MQTT: \(error)")
            return
        }

        let userID = onboarding.currentContext?.memberActorID ?? "teamclu-ios"
        let clientId = "teamclu-ios-\(userID.prefix(8))"
        logger.info("Connecting to \(pairing.brokerHost):\(pairing.brokerPort) tls=\(pairing.useTLS)")
        do {
            try await mqtt.connect(
                host: pairing.brokerHost, port: pairing.brokerPort,
                username: userID, password: token,
                clientId: clientId, useTLS: pairing.useTLS
            )
            logger.info("MQTT connected")
            // Hub consumes MQTTService.messages() once and fans out per
            // topic-filter to every downstream consumer. Restart on every
            // (re)connect so the listener picks up the fresh upstream
            // stream — `start()` cancels any prior task.
            await hub.start()
            // Debug-only MQTT trace capture: enable by writing
            // `UserDefaults.standard.set(true, forKey: "TeamcluRecordMQTT")`
            // before launch. Captured JSONL lands in
            // Documents/teamclu-trace.jsonl on the device/simulator.
            // Used to capture Phase 4 reducer fixtures from a real session.
            if UserDefaults.standard.bool(forKey: "TeamcluRecordMQTT") ||
                UserDefaults.standard.bool(forKey: "AMUXRecordMQTT") {
                await attachTraceRecorder()
            }
            // Coordinator-driven team runtime preparation runs from
            // RootTabView's .task; TeamcluService start follows from
            // the onChange(teamRuntimeContext) hook above.
        } catch {
            logger.error("MQTT connect failed: \(error)")
        }
    }
}

private actor FailingOnboardingStore: AppOnboardingStore {
    let error: Error

    init(error: Error) {
        self.error = error
    }

    func ensureSession() async throws {
        throw error
    }

    func loadBootstrap() async throws -> AppBootstrap {
        throw error
    }

    func createTeam(named name: String) async throws -> CreatedTeam {
        throw error
    }
    func bootstrapTeam() async throws -> CreatedTeam { throw error }
    func listAllMyTeams() async throws -> [MembershipTeam] { throw error }
    func switchActiveTeam(teamID: String) async throws -> TeamSwitchResult { throw error }

    func signIn(email: String, password: String) async throws { throw error }
    func signUp(email: String, password: String) async throws { throw error }
    func sendEmailOTP(email: String) async throws { throw error }
    func verifyOTP(email: String, token: String) async throws { throw error }
    func sendPhoneOTP(phone: String) async throws { throw error }
    func verifyPhoneOTP(phone: String, token: String) async throws { throw error }
    func signInWithAppleCredential(idToken: String, nonce: String) async throws { throw error }
    func signInWithGoogle() async throws { throw error }
    func handleAuthCallback(url: URL) async throws { throw error }
    func accessToken() async throws -> String { throw error }
    func signOut() async throws { throw error }
    func isAnonymous() async -> Bool { false }
    func currentUserEmail() async -> String? { nil }
    func claimInvite(token: String) async throws -> ClaimResult { throw error }
    func setSession(refreshToken: String) async throws { throw error }
    nonisolated func tokenRefreshes() -> AsyncStream<Void> { AsyncStream { $0.finish() } }
}
