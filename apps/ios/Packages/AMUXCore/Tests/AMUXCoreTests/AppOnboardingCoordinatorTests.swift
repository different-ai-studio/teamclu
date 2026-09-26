import Foundation
import Testing
@testable import AMUXCore

@Suite("AppOnboardingCoordinator")
struct AppOnboardingCoordinatorTests {

    @MainActor
    @Test("bootstrap auto-creates a team for signed-in users without teams")
    func bootstrapWithoutTeamsAutoCreatesTeam() async throws {
        let created = CreatedTeam(
            team: TeamSummary(id: "team-auto", name: "Auto Team", slug: "auto-team", role: "owner"),
            memberActorID: "member-auto",
            workspaceID: "workspace-auto",
            workspaceName: "General"
        )
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            createdTeam: created
        )
        let coordinator = AppOnboardingCoordinator(store: store)

        await coordinator.bootstrap()

        #expect(await store.recordedEnsureSessionCallCount() == 1)
        // Everyone goes through bootstrap now — the server resolves the org
        // (minting one named after the caller when they have none) and returns
        // its public default team. The client no longer invents a random name.
        #expect(await store.recordedBootstrapCallCount() == 1)
        #expect(await store.recordedCreatedTeamNames().isEmpty)
        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-auto")
        #expect(coordinator.currentContext?.memberActorID == "member-auto")
        #expect(coordinator.pendingCreatedTeam == created)
    }

    @MainActor
    @Test("a session ended by the server sends the user back to sign-in with a reason")
    func revokedSessionReturnsToSignIn() async throws {
        let team = TeamSummary(id: "team-1", name: "Alpha", slug: "alpha", role: "owner")
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "member-1", teams: [team])
        )
        let coordinator = AppOnboardingCoordinator(store: store)
        await coordinator.bootstrap()
        #expect(coordinator.route == .ready)

        coordinator.handleSessionRevoked()

        #expect(coordinator.route == .needsAuth)
        #expect(coordinator.currentContext == nil)
        #expect(coordinator.teamRuntimeContext == nil)
        #expect(coordinator.errorMessage?.isEmpty == false)
        // The server already ended the session: there is nothing left to sign out of.
        #expect(await store.recordedSignOutCallCount() == 0)
    }

    @MainActor
    @Test("a session ending while already on sign-in leaves that screen alone")
    func revokedSessionWhileSignedOutIsIgnored() async throws {
        let store = InMemoryOnboardingStore(bootstrap: AppBootstrap(memberActorID: nil, teams: []))
        let coordinator = AppOnboardingCoordinator(store: store)
        await coordinator.signOut()
        #expect(coordinator.route == .needsAuth)
        #expect(coordinator.errorMessage == nil)

        coordinator.handleSessionRevoked()

        #expect(coordinator.route == .needsAuth)
        #expect(coordinator.errorMessage == nil)
    }

    @MainActor
    @Test("bootstrap routes users with a team into the app")
    func bootstrapWithTeamShowsApp() async throws {
        let team = TeamSummary(
            id: "team-1",
            name: "Alpha",
            slug: "alpha",
            role: "owner"
        )
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "member-1", teams: [team])
        )
        let coordinator = AppOnboardingCoordinator(store: store)

        await coordinator.bootstrap()

        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-1")
        #expect(coordinator.currentContext?.memberActorID == "member-1")
    }

    @MainActor
    @Test("create team transitions into ready")
    func createTeamTransitionsToReady() async throws {
        let created = CreatedTeam(
            team: TeamSummary(id: "team-2", name: "Beta", slug: "beta", role: "owner"),
            memberActorID: "member-2",
            workspaceID: "workspace-1",
            workspaceName: "General"
        )
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            createdTeam: created
        )
        let coordinator = AppOnboardingCoordinator(store: store)

        await coordinator.createTeam(named: "Beta")

        #expect(await store.recordedCreatedTeamNames() == ["Beta"])
        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-2")
    }

    @MainActor
    @Test("blank team names are rejected without store calls")
    func blankTeamNamesAreRejected() async throws {
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: [])
        )
        let coordinator = AppOnboardingCoordinator(store: store)

        await coordinator.createTeam(named: "   ")

        #expect(await store.recordedCreatedTeamNames().isEmpty)
        #expect(coordinator.route == .createTeam)
        #expect(coordinator.errorMessage == "Team name is required.")
    }

    // MARK: - Active team persistence

    private func ephemeralDefaults() -> UserDefaults {
        let suite = "coordinator-test-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!
        d.removePersistentDomain(forName: suite)
        return d
    }

    @MainActor
    @Test("bootstrap honors the persisted active team for a multi-team user")
    func bootstrapHonorsPersistedActiveTeam() async throws {
        let teamA = TeamSummary(id: "team-a", name: "A", slug: "a", role: "member")
        let teamB = TeamSummary(id: "team-b", name: "B", slug: "b", role: "member")
        let defaults = ephemeralDefaults()
        defaults.set("team-b", forKey: "teamclu.activeTeamID")
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "m", teams: [teamA, teamB])
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: defaults)

        await coordinator.bootstrap()

        #expect(coordinator.currentContext?.team.id == "team-b")
    }

    @MainActor
    @Test("bootstrap falls back to first team when the persisted team is gone")
    func bootstrapFallsBackWhenPersistedTeamGone() async throws {
        let teamA = TeamSummary(id: "team-a", name: "A", slug: "a", role: "member")
        let defaults = ephemeralDefaults()
        defaults.set("team-removed", forKey: "teamclu.activeTeamID")
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "m", teams: [teamA])
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: defaults)

        await coordinator.bootstrap()

        #expect(coordinator.currentContext?.team.id == "team-a")
    }

    @MainActor
    @Test("active team is persisted on land and cleared on sign-out")
    func activeTeamPersistedAndClearedOnSignOut() async throws {
        let teamA = TeamSummary(id: "team-a", name: "A", slug: "a", role: "member")
        let defaults = ephemeralDefaults()
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "m", teams: [teamA])
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: defaults)

        await coordinator.bootstrap()
        #expect(defaults.string(forKey: "teamclu.activeTeamID") == "team-a")

        await coordinator.signOut()
        #expect(defaults.string(forKey: "teamclu.activeTeamID") == nil)
    }

    // MARK: - Onboarding intent (join vs create)

    private static let autoCreated = CreatedTeam(
        team: TeamSummary(id: "team-auto", name: "Auto Team", slug: "auto-team", role: "owner"),
        memberActorID: "member-auto",
        workspaceID: "workspace-auto",
        workspaceName: "General"
    )

    @MainActor
    @Test("a user who chose to join an existing team is not given a fresh team when they have none")
    func joinIntentWithoutTeamsShowsNoTeam() async throws {
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            createdTeam: Self.autoCreated
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())
        coordinator.onboardingIntent = .join

        await coordinator.bootstrap()

        #expect(coordinator.route == .noTeam)
        #expect(await store.recordedBootstrapCallCount() == 0)
        #expect(coordinator.currentContext == nil)
        // Still waiting on an invite: the choice must survive a relaunch.
        #expect(coordinator.onboardingIntent == .join)
    }

    @MainActor
    @Test("a user who chose to create a team gets one, and the choice is cleared")
    func createIntentAutoCreatesAndClears() async throws {
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            createdTeam: Self.autoCreated
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())
        coordinator.onboardingIntent = .create

        await coordinator.bootstrap()

        #expect(coordinator.route == .ready)
        #expect(await store.recordedBootstrapCallCount() == 1)
        #expect(coordinator.onboardingIntent == nil)
    }

    @MainActor
    @Test("a joiner who already belongs to a team lands on it, and the choice is cleared")
    func joinIntentWithTeamLandsAndClears() async throws {
        let team = TeamSummary(id: "team-1", name: "Alpha", slug: "alpha", role: "member")
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "member-1", teams: [team])
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())
        coordinator.onboardingIntent = .join

        await coordinator.bootstrap()

        #expect(coordinator.route == .ready)
        #expect(coordinator.onboardingIntent == nil)
    }

    @MainActor
    @Test("the onboarding choice is persisted across launches")
    func intentPersistsAcrossInstances() async throws {
        let defaults = ephemeralDefaults()
        let store = InMemoryOnboardingStore(bootstrap: AppBootstrap(memberActorID: nil, teams: []))
        AppOnboardingCoordinator(store: store, defaults: defaults).onboardingIntent = .join

        let relaunched = AppOnboardingCoordinator(store: store, defaults: defaults)

        #expect(relaunched.onboardingIntent == .join)
    }

    @MainActor
    @Test("from the no-team screen, choosing to create a team creates one")
    func createFromNoTeamCreates() async throws {
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            createdTeam: Self.autoCreated
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())
        coordinator.onboardingIntent = .join
        await coordinator.bootstrap()
        #expect(coordinator.route == .noTeam)

        await coordinator.createTeamFromNoTeam()

        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-auto")
        #expect(await store.recordedBootstrapCallCount() == 1)
        #expect(coordinator.onboardingIntent == nil)
    }

    @MainActor
    @Test("from the no-team screen, pasting an invite joins as the signed-in user")
    func joinFromNoTeamClaimsWithoutSigningOut() async throws {
        let invited = TeamSummary(id: "team-invited", name: "Invited", slug: "invited", role: "member")
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            createdTeam: Self.autoCreated,
            claimResult: ClaimResult(actorID: "member-invited", teamID: "team-invited", actorType: "member",
                                     displayName: "Me", refreshToken: nil),
            bootstrapAfterClaim: AppBootstrap(
                memberActorID: "member-invited",
                teams: [invited],
                memberActorIDByTeam: ["team-invited": "member-invited"]
            )
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())
        coordinator.onboardingIntent = .join
        await coordinator.bootstrap()

        await coordinator.joinWithInvite(token: "tok-1")

        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-invited")
        #expect(await store.recordedSignOutCallCount() == 0)
        #expect(await store.recordedBootstrapCallCount() == 0)
    }

    @MainActor
    @Test("a failed invite from the no-team screen stays there with the error")
    func failedJoinFromNoTeamStays() async throws {
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            createdTeam: Self.autoCreated,
            claimError: CloudAPIError.requestFailed(status: 410, code: nil, message: "invite already consumed")
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())
        coordinator.onboardingIntent = .join
        await coordinator.bootstrap()

        await coordinator.joinWithInvite(token: "tok-spent")

        #expect(coordinator.route == .noTeam)
        #expect(coordinator.errorMessage?.isEmpty == false)
        #expect(await store.recordedBootstrapCallCount() == 0)
        #expect(await store.recordedSignOutCallCount() == 0)
    }

    @MainActor
    @Test("refreshing the no-team screen stays put while there is still no team")
    func refreshNoTeamWithoutTeamStays() async throws {
        let store = InMemoryOnboardingStore(bootstrap: AppBootstrap(memberActorID: nil, teams: []))
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())
        coordinator.onboardingIntent = .join
        await coordinator.bootstrap()

        await coordinator.refreshNoTeam()

        #expect(coordinator.route == .noTeam)
        #expect(await store.recordedEnsureSessionCallCount() == 1)
    }

    @MainActor
    @Test("refreshing the no-team screen lands in a team someone added the user to")
    func refreshNoTeamLandsOnNewTeam() async throws {
        let team = TeamSummary(id: "team-1", name: "Alpha", slug: "alpha", role: "member")
        let store = InMemoryOnboardingStore(bootstrap: AppBootstrap(memberActorID: nil, teams: []))
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())
        coordinator.onboardingIntent = .join
        await coordinator.bootstrap()

        await store.setBootstrap(AppBootstrap(memberActorID: "member-1", teams: [team]))
        await coordinator.refreshNoTeam()

        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-1")
    }

    // MARK: - Home-org narrowing

    @MainActor
    @Test("with no remembered team, lands on the only team in the account's home org")
    func homeOrgNarrowsToSingleTeam() async throws {
        let betly = TeamSummary(id: "team-betly", name: "Betly", slug: "betly", role: "member", orgID: "org-betly")
        let test = TeamSummary(id: "team-test", name: "Test", slug: "test", role: "member", orgID: "org-test")
        let banana = TeamSummary(id: "team-banana", name: "Banana", slug: "banana", role: "member", orgID: "org-banana")
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "m", teams: [betly, test, banana], homeOrgID: "org-banana")
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())

        await coordinator.bootstrap()

        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-banana")
    }

    @MainActor
    @Test("a remembered team outside the home org still wins across a relaunch")
    func rememberedTeamOutsideHomeOrgSurvivesRelaunch() async throws {
        // Sign-out clears the remembered team, so one that survives is a
        // cross-org switch made in Settings; narrowing must not undo it.
        let betly = TeamSummary(id: "team-betly", name: "Betly", slug: "betly", role: "member", orgID: "org-betly")
        let banana = TeamSummary(id: "team-banana", name: "Banana", slug: "banana", role: "member", orgID: "org-banana")
        let defaults = ephemeralDefaults()
        defaults.set("team-betly", forKey: "teamclu.activeTeamID")
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "m", teams: [betly, banana], homeOrgID: "org-banana")
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: defaults)

        await coordinator.bootstrap()

        #expect(coordinator.currentContext?.team.id == "team-betly")
    }

    @MainActor
    @Test("without a home org every team stays on offer")
    func noHomeOrgKeepsPicker() async throws {
        let a = TeamSummary(id: "team-a", name: "A", slug: "a", role: "member", orgID: "org-a")
        let b = TeamSummary(id: "team-b", name: "B", slug: "b", role: "member", orgID: "org-b")
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "m", teams: [a, b])
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())

        await coordinator.bootstrap()

        #expect(coordinator.route == .selectTeam)
    }

    @Test("org scope narrows, and falls back to everything when the org has nothing")
    func scopedFallsBack() {
        let items: [(id: String, org: String?)] = [("t1", "o1"), ("t2", "o2"), ("t3", "o1")]
        #expect(AppOnboardingCoordinator.scoped(items, toOrg: "o1") { $0.org }.map(\.id) == ["t1", "t3"])
        #expect(AppOnboardingCoordinator.scoped(items, toOrg: "o9") { $0.org }.map(\.id) == ["t1", "t2", "t3"])
        #expect(AppOnboardingCoordinator.scoped(items, toOrg: nil) { $0.org }.map(\.id) == ["t1", "t2", "t3"])
    }

    // MARK: - Invite claim during bootstrap

    @MainActor
    @Test("signed-in user claiming an invite lands on the joined team, keeping others")
    func signedInClaimPrefersJoinedTeam() async throws {
        let teamZ = TeamSummary(id: "team-z", name: "Z", slug: "z", role: "member")
        let teamY = TeamSummary(id: "team-y", name: "Y", slug: "y", role: "member")
        let claim = ClaimResult(actorID: "actor-y", teamID: "team-y",
                                actorType: "human", displayName: "Me", refreshToken: nil)
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "m", teams: [teamZ]),
            isAnonymous: false,
            claimResult: claim,
            bootstrapAfterClaim: AppBootstrap(memberActorID: "m", teams: [teamZ, teamY])
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())
        coordinator.pendingInviteToken = "tok"

        await coordinator.bootstrap()

        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-y")
        #expect(await store.recordedSignOutCallCount() == 0)
    }

    @MainActor
    @Test("signed-in user already a member is not signed out and stays in the app")
    func signedInAlreadyMemberIsBenign() async throws {
        let teamY = TeamSummary(id: "team-y", name: "Y", slug: "y", role: "member")
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "m", teams: [teamY]),
            isAnonymous: false,
            claimError: CloudAPIError.requestFailed(status: 409, code: nil,
                                                    message: "already a member of this team")
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())
        coordinator.pendingInviteToken = "tok"

        await coordinator.bootstrap()

        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-y")
        #expect(coordinator.errorMessage == nil)
        #expect(await store.recordedSignOutCallCount() == 0)
    }

    @MainActor
    @Test("signed-in user with a consumed invite keeps their session but sees a note")
    func signedInConsumedInviteKeepsSession() async throws {
        let teamZ = TeamSummary(id: "team-z", name: "Z", slug: "z", role: "member")
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "m", teams: [teamZ]),
            isAnonymous: false,
            claimError: CloudAPIError.requestFailed(status: 409, code: nil,
                                                    message: "invite already consumed")
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())
        coordinator.pendingInviteToken = "tok"

        await coordinator.bootstrap()

        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-z")
        #expect(coordinator.errorMessage != nil)
        #expect(await store.recordedSignOutCallCount() == 0)
    }

    @MainActor
    @Test("anonymous user with a failed claim is rolled back to auth")
    func anonymousClaimFailureRollsBack() async throws {
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            isAnonymous: true,
            claimError: CloudAPIError.requestFailed(status: 410, code: nil,
                                                    message: "invite already consumed")
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())
        coordinator.pendingInviteToken = "tok"

        await coordinator.bootstrap()

        #expect(coordinator.route == .needsAuth)
        #expect(coordinator.currentContext == nil)
        #expect(await store.recordedSignOutCallCount() == 1)
    }

    @MainActor
    @Test("cold-launch invite deeplink token claims instead of auto-creating a team")
    func coldLaunchDeeplinkTokenClaimsBeforeAutoCreate() async throws {
        // Regression: opening amux://invite?token=… on a fresh anonymous iOS
        // device used to auto-create a throwaway team because the deeplink token
        // (delivered via NotificationCenter to a not-yet-mounted listener) never
        // reached bootstrap's claim-before-auto-create check. AMUXApp.handle(url)
        // now stashes the token in UserDefaults; bootstrap must pick it up.
        let teamY = TeamSummary(id: "team-y", name: "Y", slug: "y", role: "member")
        let claim = ClaimResult(actorID: "actor-y", teamID: "team-y",
                                actorType: "human", displayName: "Me", refreshToken: nil)
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),   // anonymous, no team
            isAnonymous: true,
            claimResult: claim,
            bootstrapAfterClaim: AppBootstrap(memberActorID: "m", teams: [teamY])
        )
        let defaults = ephemeralDefaults()
        defaults.set("tok", forKey: InviteDeepLink.pendingTokenDefaultsKey)
        let coordinator = AppOnboardingCoordinator(store: store, defaults: defaults)

        await coordinator.bootstrap()

        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-y")        // joined the invited team
        #expect(await store.recordedCreatedTeamNames().isEmpty)         // did NOT auto-create a junk team
        #expect(await store.recordedBootstrapCallCount() == 0)       // ...nor bootstrap one
        // Token consumed exactly once — must not replay on the next launch.
        #expect(defaults.string(forKey: InviteDeepLink.pendingTokenDefaultsKey) == nil)
    }

    @MainActor
    @Test("re-invite deeplink adopts the returned refresh token and joins the invited team")
    func reinviteDeeplinkAdoptsRefreshTokenSession() async throws {
        // A member/agent re-invite (target_actor_id set) returns a refresh token
        // bound to the TARGET actor's user. bootstrap must adopt that session
        // before reloading — otherwise the device stays on the throwaway
        // anonymous user that opened the link, finds no team, and auto-creates a
        // junk team (the "still anonymous + wrong team" bug).
        let teamY = TeamSummary(id: "team-y", name: "Y", slug: "y", role: "admin")
        let claim = ClaimResult(actorID: "actor-y", teamID: "team-y",
                                actorType: "human", displayName: "Me", refreshToken: "rt-target")
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),   // throwaway anon, no team
            isAnonymous: true,
            claimResult: claim,
            bootstrapAfterClaim: AppBootstrap(memberActorID: "actor-y", teams: [teamY])
        )
        let defaults = ephemeralDefaults()
        defaults.set("tok", forKey: InviteDeepLink.pendingTokenDefaultsKey)
        let coordinator = AppOnboardingCoordinator(store: store, defaults: defaults)

        await coordinator.bootstrap()

        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-y")          // joined the invited team
        #expect(await store.recordedSetSessionTokens() == ["rt-target"])  // adopted the target session
        #expect(await store.recordedCreatedTeamNames().isEmpty)           // did NOT auto-create a junk team
        #expect(await store.recordedBootstrapCallCount() == 0)         // ...nor bootstrap one
    }

    @MainActor
    @Test("claimInviteSmart clears the deeplink stash so bootstrap does not double-claim and sign out")
    func claimInviteSmartClearsStashNoDoubleClaim() async throws {
        // Regression: a cold-launch deeplink stashes the token in UserDefaults.
        // When the user then claims via the Continue-to-join sheet
        // (claimInviteSmart), the claim succeeds and adopts the target session —
        // but the trailing bootstrap() would re-read the stash, re-claim the now
        // consumed token, fail "already consumed", and (being anonymous) SIGN OUT
        // the good session, dumping the user back to Welcome. claimInviteSmart
        // must clear the stash so bootstrap claims at most once.
        let teamY = TeamSummary(id: "team-y", name: "Y", slug: "y", role: "admin")
        let claim = ClaimResult(actorID: "actor-y", teamID: "team-y",
                                actorType: "human", displayName: "Me", refreshToken: "rt-target")
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            isAnonymous: true,
            claimResult: claim,
            bootstrapAfterClaim: AppBootstrap(memberActorID: "actor-y", teams: [teamY])
        )
        let defaults = ephemeralDefaults()
        defaults.set("tok", forKey: InviteDeepLink.pendingTokenDefaultsKey)
        let coordinator = AppOnboardingCoordinator(store: store, defaults: defaults)

        await coordinator.claimInviteSmart(token: "tok")

        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-y")
        #expect(await store.recordedClaimCallCount() == 1)   // claimed once, not twice
        #expect(await store.recordedSignOutCallCount() == 1)  // only the intentional pre-claim signOut
        #expect(defaults.string(forKey: InviteDeepLink.pendingTokenDefaultsKey) == nil)
    }

    @MainActor
    @Test("a deleted session user (invalid JWT) clears the session and routes to auth, not a Setup-Failed dead-end")
    func invalidSessionUserRecoversToAuth() async throws {
        // The stored anonymous user was deleted server-side, so an authenticated
        // call rejects the still-locally-valid JWT. This must NOT dead-end on the
        // Setup-Failed/Retry screen (Retry loops the same dead token) — clear the
        // session and route to needsAuth so a fresh session can be minted.
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            isAnonymous: true,
            loadBootstrapError: CloudAPIError.requestFailed(
                status: 403, code: nil, message: "User from sub claim in JWT does not exist")
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())

        await coordinator.bootstrap()

        #expect(coordinator.route == .needsAuth)              // NOT .failed
        #expect(coordinator.currentContext == nil)
        #expect(await store.recordedSignOutCallCount() == 1)  // dead session cleared
        #expect(await store.recordedCreatedTeamNames().isEmpty)
    }

    @MainActor
    @Test("an expired FC access token clears the session and returns to auth")
    func expiredAccessTokenRecoversToAuth() async {
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            isAnonymous: false,
            loadBootstrapError: CloudAPIError.requestFailed(
                status: 401, code: nil, message: "Invalid or expired access token")
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())

        await coordinator.bootstrap()

        #expect(coordinator.route == .needsAuth)
        #expect(await store.recordedSignOutCallCount() == 1)
    }

    // MARK: - Offline launch

    private static let offline = URLError(.notConnectedToInternet)

    /// Bootstraps once online so the device has a last context, then fails the
    /// network for the next launch.
    @MainActor
    private func coordinatorWithCachedTeam(
        _ team: TeamSummary,
        defaults: UserDefaults
    ) async -> (AppOnboardingCoordinator, InMemoryOnboardingStore) {
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "member-1", teams: [team])
        )
        let online = AppOnboardingCoordinator(store: store, defaults: defaults)
        await online.bootstrap()
        #expect(online.route == .ready)
        await store.setLoadBootstrapError(Self.offline)
        return (AppOnboardingCoordinator(store: store, defaults: defaults), store)
    }

    @MainActor
    @Test("offline launch enters the last team instead of Setup Failed")
    func offlineLaunchUsesCachedTeam() async throws {
        let team = TeamSummary(id: "team-1", name: "Alpha", slug: "alpha", role: "owner")
        let (coordinator, _) = await coordinatorWithCachedTeam(team, defaults: ephemeralDefaults())

        await coordinator.bootstrap()

        #expect(coordinator.route == .ready)
        #expect(coordinator.isOfflineLaunch)
        #expect(coordinator.currentContext == AppContext(team: team, memberActorID: "member-1"))
    }

    @MainActor
    @Test("offline launch with no cached team still fails")
    func offlineLaunchWithoutCacheFails() async throws {
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            loadBootstrapError: Self.offline
        )
        let coordinator = AppOnboardingCoordinator(store: store, defaults: ephemeralDefaults())

        await coordinator.bootstrap()

        #expect(coordinator.route == .failed)
        #expect(!coordinator.isOfflineLaunch)
    }

    @MainActor
    @Test("a server error is not treated as offline")
    func serverErrorStillFails() async throws {
        let team = TeamSummary(id: "team-1", name: "Alpha", slug: "alpha", role: "owner")
        let (coordinator, store) = await coordinatorWithCachedTeam(team, defaults: ephemeralDefaults())
        await store.setLoadBootstrapError(
            CloudAPIError.requestFailed(status: 500, code: nil, message: "boom"))

        await coordinator.bootstrap()

        #expect(coordinator.route == .failed)
        #expect(coordinator.currentContext == nil)
    }

    @MainActor
    @Test("signing out forgets the offline fallback")
    func signOutClearsCachedTeam() async throws {
        let team = TeamSummary(id: "team-1", name: "Alpha", slug: "alpha", role: "owner")
        let defaults = ephemeralDefaults()
        let (coordinator, _) = await coordinatorWithCachedTeam(team, defaults: defaults)
        await coordinator.signOut()

        await coordinator.bootstrap()

        #expect(coordinator.route == .failed)
    }

    @MainActor
    @Test("back online with the team still there: stays put, flag clears")
    func revalidateKeepsTeam() async throws {
        let team = TeamSummary(id: "team-1", name: "Alpha", slug: "alpha", role: "owner")
        let (coordinator, store) = await coordinatorWithCachedTeam(team, defaults: ephemeralDefaults())
        await coordinator.bootstrap()
        await store.setLoadBootstrapError(nil)

        await coordinator.revalidateAfterOfflineLaunch()

        #expect(!coordinator.isOfflineLaunch)
        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-1")
    }

    @MainActor
    @Test("back online but still unreachable: stays flagged")
    func revalidateStillOffline() async throws {
        let team = TeamSummary(id: "team-1", name: "Alpha", slug: "alpha", role: "owner")
        let (coordinator, _) = await coordinatorWithCachedTeam(team, defaults: ephemeralDefaults())
        await coordinator.bootstrap()

        await coordinator.revalidateAfterOfflineLaunch()

        #expect(coordinator.isOfflineLaunch)
        #expect(coordinator.currentContext?.team.id == "team-1")
    }

    @MainActor
    @Test("back online and removed from the team: full bootstrap moves on")
    func revalidateRemovedFromTeam() async throws {
        let team = TeamSummary(id: "team-1", name: "Alpha", slug: "alpha", role: "owner")
        let other = TeamSummary(id: "team-2", name: "Beta", slug: "beta", role: "member")
        let (coordinator, store) = await coordinatorWithCachedTeam(team, defaults: ephemeralDefaults())
        await coordinator.bootstrap()
        await store.setBootstrap(AppBootstrap(memberActorID: "member-2", teams: [other]))
        await store.setLoadBootstrapError(nil)

        await coordinator.revalidateAfterOfflineLaunch()

        #expect(!coordinator.isOfflineLaunch)
        #expect(coordinator.currentContext?.team.id == "team-2")
    }
}

private actor InMemoryOnboardingStore: AppOnboardingStore {
    var bootstrapResult: AppBootstrap
    let bootstrapAfterClaimResult: AppBootstrap?
    let createdTeamResult: CreatedTeam?
    let anonymous: Bool
    let claimResult: ClaimResult?
    let claimError: Error?
    var loadBootstrapError: Error?
    var ensureSessionCallCount = 0
    var createdTeamNames: [String] = []
    var bootstrapCallCount = 0
    var signOutCallCount = 0
    var didClaim = false
    var setSessionRefreshTokens: [String] = []

    init(bootstrap: AppBootstrap,
         createdTeam: CreatedTeam? = nil,
         isAnonymous: Bool = false,
         claimResult: ClaimResult? = nil,
         claimError: Error? = nil,
         bootstrapAfterClaim: AppBootstrap? = nil,
         loadBootstrapError: Error? = nil) {
        self.bootstrapResult = bootstrap
        self.createdTeamResult = createdTeam
        self.anonymous = isAnonymous
        self.claimResult = claimResult
        self.claimError = claimError
        self.bootstrapAfterClaimResult = bootstrapAfterClaim
        self.loadBootstrapError = loadBootstrapError
    }

    func ensureSession() async throws {
        ensureSessionCallCount += 1
    }

    func loadBootstrap() async throws -> AppBootstrap {
        if let loadBootstrapError { throw loadBootstrapError }
        if didClaim, let after = bootstrapAfterClaimResult { return after }
        return bootstrapResult
    }

    func recordedSignOutCallCount() -> Int { signOutCallCount }

    func setBootstrap(_ bootstrap: AppBootstrap) { bootstrapResult = bootstrap }

    func setLoadBootstrapError(_ error: Error?) { loadBootstrapError = error }

    func createTeam(named name: String) async throws -> CreatedTeam {
        createdTeamNames.append(name)
        if let createdTeamResult {
            return createdTeamResult
        }
        throw InMemoryError.missingCreatedTeam
    }

    func bootstrapTeam() async throws -> CreatedTeam {
        bootstrapCallCount += 1
        if let createdTeamResult {
            return createdTeamResult
        }
        throw InMemoryError.missingCreatedTeam
    }
    func listAllMyTeams() async throws -> [MembershipTeam] { [] }
    func switchActiveTeam(teamID: String) async throws -> TeamSwitchResult {
        TeamSwitchResult(actorID: nil, teamID: teamID, refreshToken: "")
    }

    func recordedEnsureSessionCallCount() -> Int {
        ensureSessionCallCount
    }

    func recordedCreatedTeamNames() -> [String] {
        createdTeamNames
    }

    func recordedBootstrapCallCount() -> Int {
        bootstrapCallCount
    }

    // MARK: - Auth stub methods (not used in tests)

    func signIn(email: String, password: String) async throws {
        // no-op
    }

    func signUp(email: String, password: String) async throws {
        // no-op
    }

    func sendEmailOTP(email: String) async throws {
        // no-op
    }

    func verifyOTP(email: String, token: String) async throws {
        // no-op
    }

    func sendPhoneOTP(phone: String) async throws {
        // no-op
    }

    func verifyPhoneOTP(phone: String, token: String) async throws {
        // no-op
    }

    func signInWithAppleCredential(idToken: String, nonce: String) async throws {
        // no-op
    }

    func signInWithGoogle() async throws {
        // no-op
    }

    func handleAuthCallback(url: URL) async throws {
        // no-op
    }

    func accessToken() async throws -> String {
        ""
    }

    func signOut() async throws {
        signOutCallCount += 1
    }

    func isAnonymous() async -> Bool { anonymous }

    func currentUserEmail() async -> String? { nil }

    var claimCallCount = 0
    func recordedClaimCallCount() -> Int { claimCallCount }

    func claimInvite(token: String) async throws -> ClaimResult {
        claimCallCount += 1
        // A token can only be claimed once. A second claim of the same token
        // (the double-claim bug) realistically fails "already consumed".
        if claimCallCount > 1 {
            throw CloudAPIError.requestFailed(status: 410, code: nil, message: "invite already consumed")
        }
        if let claimError { throw claimError }
        if let claimResult {
            didClaim = true
            return claimResult
        }
        throw InMemoryError.claimNotConfigured
    }

    func setSession(refreshToken: String) async throws {
        setSessionRefreshTokens.append(refreshToken)
    }

    func recordedSetSessionTokens() -> [String] { setSessionRefreshTokens }

    nonisolated func tokenRefreshes() -> AsyncStream<Void> {
        AsyncStream { $0.finish() }
    }

    enum InMemoryError: Error {
        case missingCreatedTeam
        case claimNotConfigured
    }
}
