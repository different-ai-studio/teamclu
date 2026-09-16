import Foundation
import Observation
import SwiftData
#if canImport(UIKit)
import UIKit
#endif

public struct TeamSummary: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let slug: String
    public let role: String
    public let orgID: String?

    public init(id: String, name: String, slug: String, role: String, orgID: String? = nil) {
        self.id = id
        self.name = name
        self.slug = slug
        self.role = role
        self.orgID = orgID
    }
}

public struct AppBootstrap: Equatable, Sendable {
    public let memberActorID: String?
    public let teams: [TeamSummary]
    /// Map of team id → the user's member-actor id within that team. A user
    /// has a distinct actor row per team they belong to, so this lets the
    /// coordinator switch the active context to a specific team (e.g. the
    /// one a freshly-claimed invite landed in) without re-querying the
    /// backend.
    public let memberActorIDByTeam: [String: String]

    public init(memberActorID: String?,
                teams: [TeamSummary],
                memberActorIDByTeam: [String: String] = [:]) {
        self.memberActorID = memberActorID
        self.teams = teams
        self.memberActorIDByTeam = memberActorIDByTeam
    }
}

public struct CreatedTeam: Equatable, Sendable {
    public let team: TeamSummary
    public let memberActorID: String
    public let workspaceID: String
    public let workspaceName: String

    public init(team: TeamSummary, memberActorID: String, workspaceID: String, workspaceName: String) {
        self.team = team
        self.memberActorID = memberActorID
        self.workspaceID = workspaceID
        self.workspaceName = workspaceName
    }
}

/// A team the user belongs to, with its org — used by the org→team login picker
/// (GET /v1/teams?scope=all). See
/// docs/specs/2026-06-17-teamclu-phone-login-and-tenancy.md §6.
public struct MembershipTeam: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let slug: String
    public let orgID: String?
    public let orgName: String?
    public init(id: String, name: String, slug: String, orgID: String?, orgName: String?) {
        self.id = id; self.name = name; self.slug = slug; self.orgID = orgID; self.orgName = orgName
    }
}

/// Result of switching the active team (mints a fresh session for the team's org).
public struct TeamSwitchResult: Equatable, Sendable {
    public let actorID: String?
    public let teamID: String
    public let refreshToken: String
    public init(actorID: String?, teamID: String, refreshToken: String) {
        self.actorID = actorID; self.teamID = teamID; self.refreshToken = refreshToken
    }
}

public struct AppContext: Equatable, Sendable {
    public let team: TeamSummary
    public let memberActorID: String

    public init(team: TeamSummary, memberActorID: String) {
        self.team = team
        self.memberActorID = memberActorID
    }
}

public enum AuthRequired: Error {
    case notAuthenticated
}

public enum AppOnboardingRoute: Equatable, Sendable {
    case loading
    case needsAuth
    case createTeam
    /// The user belongs to >1 team (across orgs) and hasn't a remembered choice
    /// — show the org→team picker (`teamChoices`). See
    /// docs/specs/2026-06-17-teamclu-phone-login-and-tenancy.md §6.
    case selectTeam
    case ready
    case failed
}

public protocol AppOnboardingStore: Sendable {
    func ensureSession() async throws
    func loadBootstrap() async throws -> AppBootstrap
    func createTeam(named name: String) async throws -> CreatedTeam
    /// Login onboarding via `POST /v1/teams/bootstrap`. The server resolves
    /// the caller's org — minting one named after them when they have none —
    /// and returns that org's public default team, creating it on first use.
    func bootstrapTeam() async throws -> CreatedTeam
    /// All teams the caller belongs to, across orgs (GET /v1/teams?scope=all).
    /// Backs the org→team login picker.
    func listAllMyTeams() async throws -> [MembershipTeam]
    /// Switch the active team, minting a fresh session for that team's org.
    func switchActiveTeam(teamID: String) async throws -> TeamSwitchResult
    /// Direct invite-claim entry used by bootstrap so an invitee joins the
    /// inviter's team before the auto-create-team branch fires (otherwise they
    /// end up with an orphan team alongside the one they wanted to join).
    func claimInvite(token: String) async throws -> ClaimResult
    /// Invites addressed to the caller's verified email/phone
    /// (`GET /v1/invites/pending`). Defaulted so non-cloud stores and test
    /// fakes report none.
    func listPendingInvites() async throws -> [PendingInvite]
    /// Joins the invite's team (`POST /v1/invites/:id/accept`) — equivalent
    /// to claiming its token.
    func acceptPendingInvite(inviteID: String) async throws -> ClaimResult
    /// Marks the invite declined (`POST /v1/invites/:id/decline`).
    func declinePendingInvite(inviteID: String) async throws

    // Auth sign-in methods
    func signIn(email: String, password: String) async throws
    func signUp(email: String, password: String) async throws
    func sendEmailOTP(email: String) async throws
    func verifyOTP(email: String, token: String) async throws
    func sendPhoneOTP(phone: String) async throws
    func verifyPhoneOTP(phone: String, token: String) async throws
    func signInWithAppleCredential(idToken: String, nonce: String) async throws
    func signInWithGoogle() async throws
    func handleAuthCallback(url: URL) async throws
    func accessToken() async throws -> String
    func signOut() async throws

    /// Establish a Supabase session from a refresh_token (e.g. one returned
    /// by `claim_team_invite` for an agent claim or member-reinvite claim).
    /// Used by `claimInviteSmart` to land on the target's existing user_id.
    func setSession(refreshToken: String) async throws

    /// True iff the current session belongs to an anonymous user
    /// (`auth.users.is_anonymous`). Returns false when no session exists.
    ///
    /// Anonymous sign-in has been removed from the product, so on a current
    /// deployment this is always false. It is kept as a read-only predicate:
    /// accounts created before the removal still exist, and the branches that
    /// consult it are the ones that must not treat such a session as a normal
    /// account.
    func isAnonymous() async -> Bool

    /// Email address for the currently authenticated user, or nil for Apple
    /// Sign-In accounts without one.
    func currentUserEmail() async -> String?

    /// Emits each time the underlying auth provider rotates the access
    /// token. Consumers (notably the MQTT layer) must rebuild any
    /// long-lived connection whose password was set to a prior JWT;
    /// otherwise the broker silently rejects publishes once the token
    /// hits its expiry (~1h on Supabase default config) and the user is
    /// left with a dead-looking app that needs a relogin to recover.
    nonisolated func tokenRefreshes() -> AsyncStream<Void>
}

/// An invite addressed to the caller's verified email/phone, still pending.
public struct PendingInvite: Identifiable, Equatable, Sendable {
    /// inviteId — the accept/decline routing key.
    public let id: String
    public let teamID: String
    public let teamName: String?
    public let teamRole: String?
    public let invitedByDisplayName: String?

    public init(id: String, teamID: String, teamName: String?,
                teamRole: String?, invitedByDisplayName: String?) {
        self.id = id
        self.teamID = teamID
        self.teamName = teamName
        self.teamRole = teamRole
        self.invitedByDisplayName = invitedByDisplayName
    }
}

/// Defaults so non-cloud stores (previews, failing store, test fakes) don't
/// have to know about pending invites: they report none, and accept/decline
/// fail loudly rather than pretending to succeed.
public extension AppOnboardingStore {
    func listPendingInvites() async throws -> [PendingInvite] { [] }
    func acceptPendingInvite(inviteID: String) async throws -> ClaimResult {
        throw NSError(
            domain: "AppOnboardingStore", code: 0,
            userInfo: [NSLocalizedDescriptionKey: String(localized: "Pending invites are not supported by this backend.")]
        )
    }
    func declinePendingInvite(inviteID: String) async throws {
        throw NSError(
            domain: "AppOnboardingStore", code: 0,
            userInfo: [NSLocalizedDescriptionKey: String(localized: "Pending invites are not supported by this backend.")]
        )
    }
}

@Observable
@MainActor
public final class AppOnboardingCoordinator {
    public var route: AppOnboardingRoute = .loading
    /// Teams shown by the org→team picker when `route == .selectTeam`.
    public var teamChoices: [MembershipTeam] = []
    public var currentContext: AppContext?
    public var pendingCreatedTeam: CreatedTeam?
    public var errorMessage: String?
    public var pendingEmailOTPEmail: String?
    /// E.164 phone awaiting an SMS code. Mirrors `pendingEmailOTPEmail`; the
    /// login UI shows the code step when either is non-nil.
    public var pendingPhoneOTPPhone: String?
    public var isBusy = false
    /// True iff the current session is an anonymous Supabase user. UI uses
    /// this to surface the "upgrade your account" affordance.
    public var isAnonymous: Bool = false
    /// Invite token captured pre-auth (e.g. user pasted a link on the
    /// onboarding screen). Stashed here so it can replay through the
    /// existing `amuxInviteTokenReceived` pipeline after sign-in.
    public var pendingInviteToken: String?

    /// Users returned by a multi-account phone login. Non-empty triggers the
    /// account-picker sheet in the login UI.
    public var phoneMultipleUsers: [PhoneUser] = []
    /// The OTP token stashed while the multi-user picker is shown, so
    /// `selectPhoneUser` can complete the login without re-prompting.
    public var pendingPhoneOTPTokenForMultiUser: String = ""

    /// Set when an anonymous-account upgrade collided with an identifier that
    /// already belongs to another account. The upgrade UI reads this to offer a
    /// "sign in to that account instead" path rather than showing GoTrue's raw
    /// error. Cleared at the start of each upgrade attempt.
    public var upgradeCollision: UpgradeOutcome?

    /// Email address of the current auth user. Nil for anonymous sessions
    /// and Apple accounts without an email address. Set during bootstrap.
    public var currentUserEmail: String?

    /// Active team-scoped runtime state. Built by `prepareTeamRuntime` once
    /// the user has a `currentContext`, replaced atomically when the active
    /// team changes, nilled on sign-out. Views read team-scoped repositories
    /// and observable stores from here instead of constructing their own.
    public private(set) var teamRuntimeContext: TeamRuntimeContext?

    public let store: AppOnboardingStore
    private let defaults: UserDefaults
    private let injectedDeviceID: String?

    /// `deviceID` overrides the system identifier; tests inject a known value.
    public init(store: AppOnboardingStore,
                defaults: UserDefaults = .standard,
                deviceID: String? = nil) {
        self.store = store
        self.defaults = defaults
        self.injectedDeviceID = deviceID
    }

    /// Stable per-install identifier, or nil when the system has none
    /// (`identifierForVendor` is briefly nil before first device unlock).
    ///
    /// Nil rather than a placeholder string on purpose: this value is the key
    /// the server reuses guest teams by, so a shared constant like
    /// "ios-unknown" would hand every device that hit the nil window the *same*
    /// guest team. Nil just means "no reuse" — a fresh team, which is the
    /// behaviour we already had.
    private var deviceID: String? {
        if let injectedDeviceID { return injectedDeviceID }
        #if canImport(UIKit)
        return UIDevice.current.identifierForVendor?.uuidString
        #else
        return nil
        #endif
    }

    // MARK: - Active team persistence

    /// Last team the user actively viewed. Persisted so a multi-team user lands
    /// back on the same team across launches instead of an arbitrary
    /// `teams.first`. Only a hint — bootstrap validates it against the user's
    /// current memberships before honoring it.
    private static let activeTeamIDKey = "teamclu.activeTeamID"

    private var persistedActiveTeamID: String? {
        defaults.string(forKey: Self.activeTeamIDKey)
    }

    private func persistActiveTeam(_ teamID: String?) {
        if let teamID {
            defaults.set(teamID, forKey: Self.activeTeamIDKey)
        } else {
            defaults.removeObject(forKey: Self.activeTeamIDKey)
        }
    }

    /// Set the active context and remember the team for next launch. A nil
    /// context only clears in-memory state; the persisted preference survives a
    /// transient bootstrap failure (cleared explicitly on sign-out).
    private func setCurrentContext(_ context: AppContext?) {
        currentContext = context
        if let teamID = context?.team.id {
            persistActiveTeam(teamID)
        }
    }

    /// Commit the org→team picker choice: switch the active team (mints a fresh
    /// session for that team's org), then land on it. Remembered for next launch.
    public func selectTeam(teamID: String) async {
        route = .loading
        errorMessage = nil
        do {
            let result = try await store.switchActiveTeam(teamID: teamID)
            try await store.setSession(refreshToken: result.refreshToken)
            let bootstrap = try await store.loadBootstrap()
            guard let team = bootstrap.teams.first(where: { $0.id == teamID }) else {
                throw AuthRequired.notAuthenticated
            }
            let actorID = result.actorID
                ?? bootstrap.memberActorIDByTeam[teamID]
                ?? bootstrap.memberActorID
                ?? ""
            teamChoices = []
            setCurrentContext(AppContext(team: team, memberActorID: actorID))
            route = .ready
        } catch {
            errorMessage = error.localizedDescription
            // Stay on the picker so the user can retry / pick another team.
            route = .selectTeam
        }
    }

    /// Entry point for switching teams after login (Settings → Switch Team).
    /// Loads the full membership list (grouped by org, like the login-time
    /// picker) and routes to the org→team picker. The current context stays
    /// live so `cancelTeamSwitch()` can drop straight back to `.ready`.
    public func beginTeamSwitch() async {
        guard currentContext != nil else { return }
        do {
            teamChoices = try await store.listAllMyTeams()
            errorMessage = nil
            route = .selectTeam
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Backs the picker's Cancel button when it was reached from Settings
    /// rather than login: the previous team context is still intact, so
    /// returning to `.ready` is a pure route flip.
    public func cancelTeamSwitch() {
        guard currentContext != nil else { return }
        teamChoices = []
        errorMessage = nil
        route = .ready
    }

    // MARK: - Pending invites

    /// Invites addressed to the signed-in user's verified contact,
    /// refreshed on demand (Settings → Team). Empty when none, or when the
    /// backend can't answer.
    public private(set) var pendingInvites: [PendingInvite] = []

    public func refreshPendingInvites() async {
        pendingInvites = (try? await store.listPendingInvites()) ?? []
    }

    /// Accepts a pending invite: joins its team (adopting the returned
    /// session when the server mints one) and lands on it.
    public func acceptPendingInvite(_ invite: PendingInvite) async -> Bool {
        do {
            let result = try await store.acceptPendingInvite(inviteID: invite.id)
            pendingInvites.removeAll { $0.id == invite.id }
            if let rt = result.refreshToken {
                try await store.setSession(refreshToken: rt)
            }
            await bootstrap(preferringTeamID: result.teamID)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    public func declinePendingInvite(_ invite: PendingInvite) async -> Bool {
        do {
            try await store.declinePendingInvite(inviteID: invite.id)
            pendingInvites.removeAll { $0.id == invite.id }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    // MARK: - Team-scoped runtime lifecycle

    /// Build (or reuse) the team-scoped repository + store bundle for the
    /// active context. Idempotent: returns immediately when the existing
    /// context already covers `currentContext.team`. Nils the runtime when
    /// `currentContext` is absent (e.g. sign-out, no team yet).
    ///
    /// Repository construction reads from `Info.plist` via
    /// `SupabaseProjectConfiguration.fromMainBundle()`; if the actor or
    /// access repo can't be built, `teamRuntimeContext` stays nil and
    /// callers should surface the configuration error elsewhere.
    public func prepareTeamRuntime(modelContext: ModelContext) async {
        guard let ctx = currentContext else {
            teamRuntimeContext = nil
            return
        }
        if let existing = teamRuntimeContext, existing.team.id == ctx.team.id {
            return
        }

        guard let agentAccessConfig = CloudAPIConfigurationStore.configuration() else {
            teamRuntimeContext = nil
            return
        }
        let actorRepo = CloudAPIRepositoryFactory.actorRepository(
            configuration: agentAccessConfig
        ) { [store] in try await store.accessToken() }
        let agentAccessRepo = CloudAPIRepositoryFactory.agentAccessRepository(
            configuration: agentAccessConfig,
            memberActorID: ctx.memberActorID
        ) { [store] in try await store.accessToken() }
        let teamResourceRepo = CloudAPIRepositoryFactory.teamResourceRepository(
            configuration: agentAccessConfig
        ) { [store] in try await store.accessToken() }

        let actorStore = ActorStore(teamID: ctx.team.id,
                                    repository: actorRepo,
                                    modelContext: modelContext)
        let connectedAgentsStore = ConnectedAgentsStore(teamID: ctx.team.id,
                                                       repository: agentAccessRepo)
        // Eager reload so first-frame consumers (member pickers, session
        // composer @-suggestions) have rows without bouncing through an
        // empty state.
        await actorStore.reload()
        await connectedAgentsStore.reload()

        let shortcutsStore: ShortcutsStore? = {
            guard let config = CloudAPIConfigurationStore.configuration() else { return nil }
            let repo = CloudAPIRepositoryFactory.shortcutsRepository(configuration: config) { [store] in
                try await store.accessToken()
            }
            let scStore = ShortcutsStore(
                teamID: ctx.team.id,
                repository: repo,
                modelContext: modelContext
            )
            scStore.hydrateFromCache()
            return scStore
        }()
        if let shortcutsStore { Task { await shortcutsStore.reload() } }

        // Notification prefs + per-session mutes are user-scoped, not
        // team-scoped — rebuilding on team switch just re-fetches the same
        // row, which keeps the store's lifecycle identical to its siblings.
        let notificationPrefsStore: NotificationPrefsStore? = {
            guard let config = CloudAPIConfigurationStore.configuration() else { return nil }
            let repo = CloudAPIRepositoryFactory.notificationsRepository(configuration: config) { [store] in
                try await store.accessToken()
            }
            return NotificationPrefsStore(repository: repo)
        }()
        if let notificationPrefsStore { Task { await notificationPrefsStore.reload() } }

        let cloudAPIConfig = CloudAPIConfigurationStore.configuration()
        let cloudAPISessionsRepo: (any SessionsRepository)? = cloudAPIConfig.map { config in
            CloudAPIRepositoryFactory.sessionsRepository(configuration: config) { [store] in
                try await store.accessToken()
            }
        }
        let cloudAPIMessagesRepo: (any MessagesRepository)? = cloudAPIConfig.map { config in
            CloudAPIRepositoryFactory.messagesRepository(configuration: config) { [store] in
                try await store.accessToken()
            }
        }
        let cloudAPISessionIDsRepo: (any SessionIDsRepository)? = cloudAPIConfig.map { config in
            CloudAPIRepositoryFactory.sessionIDsRepository(configuration: config) { [store] in
                try await store.accessToken()
            }
        }
        let cloudAPIWorkspacesRepo: (any WorkspaceRepository)? = cloudAPIConfig.map { config in
            CloudAPIRepositoryFactory.workspacesRepository(configuration: config) { [store] in
                try await store.accessToken()
            }
        }
        let cloudAPITeamRepo: (any TeamRepository)? = cloudAPIConfig.map { config in
            CloudAPIRepositoryFactory.teamRepository(configuration: config) { [store] in
                try await store.accessToken()
            }
        }
        let cloudAPISessionRepo: (any SessionRepository)? = cloudAPIConfig.map { config in
            CloudAPIRepositoryFactory.sessionRepository(configuration: config) { [store] in
                try await store.accessToken()
            }
        }
        let cloudAPIIdeasRepo: (any IdeaRepository)? = cloudAPIConfig.map { config in
            CloudAPIRepositoryFactory.ideasRepository(configuration: config, memberActorID: ctx.memberActorID) { [store] in
                try await store.accessToken()
            }
        }

        // Report ios client version + build (telemetry; fire-and-forget)
        if let versionConfig = cloudAPIConfig {
            let versionClient = CloudAPIRepositoryFactory.client(
                configuration: versionConfig
            ) { [store] in try await store.accessToken() }
            let versionRepo = CloudAPIRepositoryFactory.clientVersion(client: versionClient)
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
            let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String
            // Telemetry wants a value in every row, so an unidentifiable device
            // is bucketed rather than dropped. Safe here precisely because
            // nothing is keyed off it — unlike the guest-team reuse above.
            let reportedDeviceID = deviceID ?? "ios-unknown"
            Task { await versionRepo.report(teamID: ctx.team.id, version: version, build: build, deviceID: reportedDeviceID) }
        }

        teamRuntimeContext = TeamRuntimeContext(
            team: ctx.team,
            memberActorID: ctx.memberActorID,
            actorStore: actorStore,
            connectedAgentsStore: connectedAgentsStore,
            shortcutsStore: shortcutsStore,
            notificationPrefsStore: notificationPrefsStore,
            sessionIDsRepo: cloudAPISessionIDsRepo,
            sessionsRepo: cloudAPISessionsRepo,
            messagesRepo: cloudAPIMessagesRepo,
            workspacesRepo: cloudAPIWorkspacesRepo,
            agentAccessRepo: agentAccessRepo,
            teamResourceRepo: teamResourceRepo,
            teamRepo: cloudAPITeamRepo,
            sessionRepo: cloudAPISessionRepo,
            ideasRepo: cloudAPIIdeasRepo,
            actorRepo: actorRepo
        )
    }

    /// Drop the current team runtime. Used on sign-out and on team switches
    /// before rebuilding for the next team.
    public func clearTeamRuntime() {
        teamRuntimeContext = nil
    }

    /// Wipe every SwiftData row owned by the signed-in user, then sign out.
    ///
    /// Every model in the container is a snapshot of remote state for the
    /// current user; leaving rows around lets the next signed-in user (or
    /// the same user after switching teams via invite) see stale actors,
    /// sessions, and workspaces until a per-team reload overwrites them.
    /// The ones we don't actively reload (other-team rows) never get cleared
    /// otherwise.
    public func signOutAndWipeCache(modelContext: ModelContext) async {
        do {
            try modelContext.delete(model: AgentAttachment.self)
            try modelContext.delete(model: AgentEvent.self)
            try modelContext.delete(model: CachedActor.self)
            try modelContext.delete(model: Workspace.self)
            try modelContext.delete(model: Session.self)
            try modelContext.delete(model: SessionMessage.self)
            try modelContext.delete(model: SessionIdea.self)
            try modelContext.delete(model: CachedShortcut.self)
            try modelContext.save()
        } catch {
            // Sign-out path; surface only via errorMessage on the
            // signOut() flow itself.
        }
        // Downloaded turn traces are this account's session content too.
        await TurnTraceCache.shared.removeAll()
        await signOut()
    }

    public func bootstrap(preferringTeamID: String? = nil) async {
        guard !isBusy else { return }
        isBusy = true
        route = .loading
        errorMessage = nil
        defer { isBusy = false }

        let bootStart = Date()
        let bootInterval = onboardingSignposter.beginInterval("bootstrap")
        defer {
            onboardingSignposter.endInterval("bootstrap", bootInterval)
            let ms = Int(Date().timeIntervalSince(bootStart) * 1000)
            onboardingLogger.info("bootstrap total: \(ms) ms")
        }

        do {
            try await measureOnboarding("ensureSession") { try await store.ensureSession() }
            isAnonymous = await measureOnboarding("isAnonymous") { await store.isAnonymous() }
            currentUserEmail = await store.currentUserEmail()
            var bootstrap = try await measureOnboarding("loadBootstrap") { try await store.loadBootstrap() }
            pendingCreatedTeam = nil
            var preferred = preferringTeamID

            // Hydrate a cold-launch invite deeplink token. AMUXApp.handle(url)
            // stashes it in UserDefaults because at cold launch the
            // NotificationCenter listener isn't mounted yet (route is still
            // .loading). Pull it into pendingInviteToken so the claim block below
            // runs BEFORE the auto-create branch — otherwise we'd strand the user
            // in a throwaway team next to the one the invite actually targets.
            // Read-and-remove so it is consumed exactly once.
            if let stashed = defaults.string(forKey: InviteDeepLink.pendingTokenDefaultsKey) {
                defaults.removeObject(forKey: InviteDeepLink.pendingTokenDefaultsKey)
                if (pendingInviteToken?.isEmpty ?? true) && !stashed.isEmpty {
                    pendingInviteToken = stashed
                }
            }

            // If a pending invite token is sitting on the coordinator (the
            // user pasted it in ChooseAuthView before sign-in), claim it
            // now — BEFORE the anonymous auto-create branch — so we never
            // strand the user with an orphan workspace alongside the team
            // they actually wanted to join. After claim, re-load bootstrap
            // and prefer the claimed team for the active context.
            if let token = pendingInviteToken, !token.isEmpty {
                do {
                    let result = try await measureOnboarding("claimInvite") {
                        try await store.claimInvite(token: token)
                    }
                    pendingInviteToken = nil
                    // Agent and member re-invites (target_actor_id set) rotate
                    // credentials onto an EXISTING actor and return a refresh
                    // token bound to that actor's user. We must adopt that
                    // session before reloading — otherwise we stay signed in as
                    // the throwaway anonymous user that opened the link, find it
                    // has no team, and auto-create a junk team instead of joining
                    // the invited one. Mirrors RootTabView.claimAndSwitch.
                    if let rt = result.refreshToken, !rt.isEmpty {
                        try await store.setSession(refreshToken: rt)
                        isAnonymous = await store.isAnonymous()
                        currentUserEmail = await store.currentUserEmail()
                    }
                    preferred = preferred ?? result.teamID
                    bootstrap = try await measureOnboarding("loadBootstrap.afterClaim") {
                        try await store.loadBootstrap()
                    }
                } catch {
                    pendingInviteToken = nil
                    if isAnonymous {
                        // The session is a throwaway anonymous user created just
                        // to join via this invite. Falling through to the
                        // auto-create branch would strand them in a fresh orphan
                        // team. Roll back and bounce to needsAuth so they can
                        // paste a fresh token (expired/consumed/network blip).
                        errorMessage = error.localizedDescription
                        try? await store.signOut()
                        persistActiveTeam(nil)
                        currentContext = nil
                        isAnonymous = false
                        route = .needsAuth
                        return
                    }
                    // A real signed-in user (the sign-in-then-join path) tried to
                    // claim into the team. Never sign them out over a failed
                    // claim — they have a legitimate account and (possibly other)
                    // teams. "Already a member" is benign; surface other failures
                    // as a note but still land them on their existing teams.
                    if !AuthErrorClassifier.isAlreadyTeamMember(error) {
                        errorMessage = error.localizedDescription
                    }
                    // fall through to the normal team pick below.
                }
            }

            // Pick the active team: prefer (1) an explicit request, (2) the team
            // just claimed via invite, then (3) the last team this user viewed —
            // so a multi-team user lands where they expect instead of an
            // arbitrary first team. Validate against current memberships; if the
            // remembered team is gone, fall back to the first team.
            preferred = preferred ?? persistedActiveTeamID
            // A remembered / explicitly-requested team always wins — skip the picker.
            if let preferred,
               let team = bootstrap.teams.first(where: { $0.id == preferred }) {
                let result = try await store.switchActiveTeam(teamID: team.id)
                if !result.refreshToken.isEmpty {
                    try await store.setSession(refreshToken: result.refreshToken)
                }
                if let memberActorID = result.actorID ?? bootstrap.memberActorIDByTeam[team.id] ?? bootstrap.memberActorID {
                    setCurrentContext(AppContext(team: team, memberActorID: memberActorID))
                    route = .ready
                    return
                }
            }

            // No remembered choice but the user belongs to >1 team — let them
            // pick (grouped by org). Load org info; fall back to bootstrap teams
            // (no org grouping) if the scope=all call fails.
            if bootstrap.teams.count > 1 {
                teamChoices = (try? await store.listAllMyTeams())
                    ?? bootstrap.teams.map {
                        MembershipTeam(id: $0.id, name: $0.name, slug: $0.slug, orgID: nil, orgName: nil)
                    }
                route = .selectTeam
                return
            }

            // Exactly one team — adopt it directly.
            if let team = bootstrap.teams.first {
                let result = try await store.switchActiveTeam(teamID: team.id)
                if !result.refreshToken.isEmpty {
                    try await store.setSession(refreshToken: result.refreshToken)
                }
                if let memberActorID = result.actorID ?? bootstrap.memberActorIDByTeam[team.id] ?? bootstrap.memberActorID {
                    setCurrentContext(AppContext(team: team, memberActorID: memberActorID))
                    route = .ready
                    return
                }
            }

            // No team yet. Auto-create one after invite handling so newly
            // registered users who were not invited anywhere land directly
            // in the app instead of getting stuck on the manual team screen.
            //
            // Always the bootstrap endpoint now: the server owns the decision
            // (mint an org named after the caller when they have none, then
            // enter that org's public default team, creating it on first use).
            // The client used to pick a random name here, which is what put
            // every new user's team in the shared default org under a name
            // nobody recognised.
            let created = try await measureOnboarding("bootstrapTeam.auto") {
                try await store.bootstrapTeam()
            }
            pendingCreatedTeam = created
            setCurrentContext(AppContext(team: created.team, memberActorID: created.memberActorID))
            route = .ready
        } catch is AuthRequired {
            currentContext = nil
            isAnonymous = false
            route = .needsAuth
        } catch {
            // A session whose user no longer exists server-side (e.g. an
            // anonymous account that was deleted) keeps a locally-valid-looking
            // JWT, so it slips past ensureSession and only fails when an
            // authenticated call rejects it ("User from sub claim in JWT does
            // not exist"). Dead-ending on the Setup-Failed/Retry screen loops
            // forever because the stored token is permanently useless. Clear the
            // session and bounce to auth so a fresh (anonymous) session can be
            // minted instead.
            if AuthErrorClassifier.isInvalidSession(error) {
                try? await store.signOut()
                persistActiveTeam(nil)
                currentContext = nil
                isAnonymous = false
                route = .needsAuth
                return
            }
            currentContext = nil
            isAnonymous = false
            route = .failed
            errorMessage = error.localizedDescription
        }
    }

    public func createTeam(named rawName: String) async {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            errorMessage = String(localized: "Team name is required.")
            route = .createTeam
            return
        }

        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }

        do {
            let created = try await store.createTeam(named: name)
            pendingCreatedTeam = created
            setCurrentContext(AppContext(team: created.team, memberActorID: created.memberActorID))
            route = .ready
        } catch {
            route = .createTeam
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Auth sign-in

    public func signIn(email: String, password: String) async {
        await performAuth { try await self.store.signIn(email: email, password: password) }
    }

    public func signUp(email: String, password: String) async {
        await performAuth { try await self.store.signUp(email: email, password: password) }
    }

    public func sendEmailOTP(email: String) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            try await store.sendEmailOTP(email: email)
            pendingEmailOTPEmail = email
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func verifyOTP(email: String, token: String) async {
        await performAuth { try await self.store.verifyOTP(email: email, token: token) }
    }

    public func resetPendingEmailOTP() {
        pendingEmailOTPEmail = nil
        errorMessage = nil
    }

    public func sendPhoneOTP(phone: String) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            try await store.sendPhoneOTP(phone: phone)
            pendingPhoneOTPPhone = phone
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func verifyPhoneOTP(phone: String, token: String) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        upgradeCollision = nil
        defer { isBusy = false }
        do {
            guard let cloudStore = store as? CloudAPIAppOnboardingStore else {
                // Fallback for non-cloud stores (e.g. mocks): protocol throws, no result.
                try await store.verifyPhoneOTP(phone: phone, token: token)
                await bootstrap()
                return
            }
            let result = try await cloudStore.verifyPhoneOTPResult(phone: phone, token: token)
            switch result {
            case .session:
                phoneMultipleUsers = []
                pendingPhoneOTPTokenForMultiUser = ""
                // Clear busy before bootstrap() — it guards on !isBusy and would
                // otherwise no-op, leaving the user stuck on the login screen.
                isBusy = false
                await bootstrap()
            case .multiUser(let users):
                phoneMultipleUsers = users
                pendingPhoneOTPTokenForMultiUser = token
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Complete sign-in after the user picks one of the multi-account options.
    public func selectPhoneUser(_ user: PhoneUser) async {
        guard !isBusy else { return }
        guard let phone = pendingPhoneOTPPhone, !phone.isEmpty else { return }
        let token = pendingPhoneOTPTokenForMultiUser
        guard !token.isEmpty else { return }

        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            guard let cloudStore = store as? CloudAPIAppOnboardingStore else {
                return
            }
            try await cloudStore.loginWithPhoneUser(phone: phone, token: token, userId: user.id)
            phoneMultipleUsers = []
            pendingPhoneOTPTokenForMultiUser = ""
            // Clear busy before bootstrap() — it guards on !isBusy and would
            // otherwise no-op, leaving the user stuck on the picker.
            isBusy = false
            await bootstrap()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func resetPendingPhoneOTP() {
        pendingPhoneOTPPhone = nil
        errorMessage = nil
    }

    public func signInWithApple() async {
#if os(iOS)
        await performAuth {
            let (idToken, nonce) = try await AppleSignInHandler.shared.request()
            try await self.store.signInWithAppleCredential(idToken: idToken, nonce: nonce)
        }
#endif
    }

    public func signInWithGoogle() async {
        await performAuth { try await self.store.signInWithGoogle() }
    }

    /// Returns the FC OAuth authorize URL (with a fresh PKCE challenge already
    /// embedded) that the UI layer should open in ASWebAuthenticationSession.
    /// Returns nil if the underlying store does not support PKCE OAuth (e.g.
    /// the Supabase store — callers should guard accordingly).
    public func oauthAuthorizeURL() async -> URL? {
        await (store as? CloudAPIAppOnboardingStore)?.oauthAuthorizeURL()
    }

    /// Claim an invite without knowing in advance whether it's a fresh member
    /// invite or an agent / member re-invite (which returns a refresh_token we
    /// adopt directly). Tries the unauthenticated claim first; if the RPC says
    /// auth is required, the token is stashed and the user is sent to sign-in —
    /// `bootstrap()` claims it for them once a real account exists.
    ///
    /// That stash-then-sign-in shape replaced "sign in anonymously, then
    /// claim". A member invite cannot be claimed anonymously anyway
    /// (claim_team_invite refuses it server-side), so the old path only ever
    /// worked by minting a throwaway user first — which is exactly what this
    /// product no longer does.
    public func claimInviteSmart(token: String) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil

        // We're claiming this token explicitly now, so drop any cold-launch
        // deeplink stash for it — otherwise the bootstrap() call below would
        // re-claim the (now consumed) token, fail, and sign out the session we
        // just adopted.
        defaults.removeObject(forKey: InviteDeepLink.pendingTokenDefaultsKey)

        // Make sure no stale session lingers — re-invite should land us on
        // the target's user_id, not whoever was signed in before.
        try? await store.signOut()

        let result: ClaimResult
        do {
            result = try await store.claimInvite(token: token)
        } catch {
            // Most likely: 'member claim requires authentication' (42501).
            // The token is unconsumed — keep it and route to sign-in; the
            // bootstrap() after authentication picks the stash back up and
            // claims it.
            defaults.set(token, forKey: InviteDeepLink.pendingTokenDefaultsKey)
            errorMessage = nil
            isBusy = false
            route = .needsAuth
            return
        }

        if let rt = result.refreshToken {
            do {
                try await store.setSession(refreshToken: rt)
            } catch {
                // Claim succeeded (token consumed) but session adoption
                // failed — falling back would re-attempt with a spent
                // token and produce a misleading error. Surface the real
                // failure instead and require a fresh invite.
                errorMessage = String(localized: "Sign-in failed after redeeming the invite. Ask the team admin for a fresh link. (\(error.localizedDescription))")
                isBusy = false
                return
            }
            isBusy = false
            await bootstrap(preferringTeamID: result.teamID)
            return
        }

        // No refresh token: fresh-member invite that succeeded
        // unauthenticated (shouldn't normally happen, but bootstrap anyway).
        isBusy = false
        await bootstrap(preferringTeamID: result.teamID)
    }

    public func accessToken() async throws -> String {
        try await store.accessToken()
    }

    public func signOut() async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        do {
            try await store.signOut()
        } catch {
            errorMessage = error.localizedDescription
        }
        currentContext = nil
        persistActiveTeam(nil)
        teamRuntimeContext = nil
        pendingCreatedTeam = nil
        pendingEmailOTPEmail = nil
        upgradeCollision = nil
        isAnonymous = false
        currentUserEmail = nil
        route = .needsAuth
        isBusy = false
    }

    public func handleAuthCallback(url: URL) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        do {
            try await store.handleAuthCallback(url: url)
            pendingEmailOTPEmail = nil
            isBusy = false
            await bootstrap()
        } catch {
            isBusy = false
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Private helpers

    private func performAuth(_ action: @escaping () async throws -> Void) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        upgradeCollision = nil
        do {
            try await action()
            isBusy = false
            await bootstrap()
        } catch let outcome as UpgradeOutcome {
            // Anonymous upgrade hit an email/phone already owned by another
            // account. Surface it as a typed collision (not a raw error) so the
            // upgrade UI can offer the "sign in instead" path.
            isBusy = false
            upgradeCollision = outcome
        } catch {
            isBusy = false
            errorMessage = error.localizedDescription
        }
    }
}
