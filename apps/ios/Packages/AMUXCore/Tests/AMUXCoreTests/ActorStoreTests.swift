import XCTest
import SwiftData
@testable import AMUXCore

@MainActor
final class ActorStoreTests: XCTestCase {

    private func makeContext() throws -> ModelContext {
        let schema = Schema([CachedActor.self])
        let c = try ModelContainer(for: schema,
                                   configurations: [ModelConfiguration(isStoredInMemoryOnly: true)])
        return ModelContext(c)
    }

    private func sampleMember(id: String = "a-1", name: String = "Alice") -> ActorRecord {
        ActorRecord(
            id: id, teamID: "t-1", actorType: "member",
            userID: "u-1", invitedByActorID: nil, displayName: name,
            avatarURL: "https://example.com/avatar.jpg",
            lastActiveAt: Date(), createdAt: Date(), updatedAt: Date(),
            memberStatus: "active", teamRole: "member",
            agentKind: nil, agentStatus: nil
        )
    }

    func testReloadPopulates() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.configure(actors: [sampleMember()])
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        await store.reload()
        XCTAssertEqual(store.actors.count, 1)
        let cached = try ctx.fetch(FetchDescriptor<CachedActor>())
        XCTAssertEqual(cached.count, 1)
    }

    func testReloadPersistsAvatarURL() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.configure(actors: [sampleMember()])
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        await store.reload()
        let cached = try XCTUnwrap(ctx.fetch(FetchDescriptor<CachedActor>()).first)
        XCTAssertEqual(cached.avatarURL, "https://example.com/avatar.jpg")
    }

    func testReloadPurgesForeignTeamActors() async throws {
        let ctx = try makeContext()
        // Simulate a team the device viewed earlier whose actors are still cached.
        // The unscoped @Query in the Actors/Members views would otherwise surface
        // these stale rows alongside the current team's members.
        ctx.insert(CachedActor(actorId: "ghost-1", teamId: "t-OTHER",
                               actorType: "member", displayName: "Ghost"))
        try ctx.save()

        let repo = MockActorRepository()
        await repo.configure(actors: [sampleMember(id: "a-1")]) // sampleMember is team t-1
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        await store.reload()

        let cached = try ctx.fetch(FetchDescriptor<CachedActor>())
        XCTAssertEqual(cached.count, 1, "foreign-team actors must be purged from the local cache")
        XCTAssertEqual(cached.first?.teamId, "t-1")
        XCTAssertFalse(cached.contains { $0.actorId == "ghost-1" })
    }

    func testReloadPurgesForeignTeamActorsEvenOnFetchError() async throws {
        let ctx = try makeContext()
        ctx.insert(CachedActor(actorId: "ghost-1", teamId: "t-OTHER",
                               actorType: "member", displayName: "Ghost"))
        try ctx.save()

        let repo = MockActorRepository()
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        await repo.setNextError(URLError(.notConnectedToInternet))
        await store.reload()

        // The purge runs before the network fetch, so a failed reload still
        // leaves no foreign-team rows to flash in the unscoped @Query views.
        let cached = try ctx.fetch(FetchDescriptor<CachedActor>())
        XCTAssertFalse(cached.contains { $0.teamId == "t-OTHER" })
        XCTAssertNotNil(store.errorMessage)
    }

    func testReloadFailureSetsError() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        await repo.setNextError(URLError(.notConnectedToInternet))
        await store.reload()
        XCTAssertNotNil(store.errorMessage)
    }

    func testCreateMemberInvite() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.configure(inviteCreated: InviteCreated(token: "tok",
                                                          expiresAt: Date().addingTimeInterval(3600),
                                                          deeplink: "teamclu://invite?token=tok"))
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        let r = await store.createInvite(.init(kind: .member, displayName: "Bob", teamRole: .admin))
        XCTAssertEqual(r?.token, "tok")
        let lastInput = await repo.lastInviteInput
        XCTAssertEqual(lastInput?.kind, .member)
        XCTAssertEqual(lastInput?.teamRole, .admin)
    }

    func testCreateAgentInvite() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.configure(inviteCreated: InviteCreated(token: "tok-a", expiresAt: Date(),
                                                          deeplink: "teamclu://invite?token=tok-a"))
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        _ = await store.createInvite(.init(kind: .agent, displayName: "M1 Studio",
                                           agentKind: "daemon"))
        let lastInput = await repo.lastInviteInput
        XCTAssertEqual(lastInput?.kind, .agent)
        XCTAssertEqual(lastInput?.agentKind, "daemon")
    }

    func testClaimInviteSurfacesError() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.setNextError(NSError(domain: "Supabase", code: 0,
                                        userInfo: [NSLocalizedDescriptionKey: "invite expired"]))
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        let r = await store.claimInvite(token: "x")
        XCTAssertNil(r)
        XCTAssertEqual(store.errorMessage, "invite expired")
    }

    func testHeartbeatThrottled() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        await store.heartbeat(); await store.heartbeat(); await store.heartbeat()
        let count = await repo.heartbeatCallCount
        XCTAssertEqual(count, 1)
    }

    // MARK: - Team default agent

    func testGetTeamDefaultAgentReturnsValue() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.setTeamDefaultAgentID("agent-42")
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        let id = await store.getTeamDefaultAgent()
        XCTAssertEqual(id, "agent-42")
    }

    func testGetTeamDefaultAgentReturnsNilOnError() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.setNextError(URLError(.notConnectedToInternet))
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        let id = await store.getTeamDefaultAgent()
        XCTAssertNil(id)
        XCTAssertNotNil(store.errorMessage)
    }

    func testSetTeamDefaultAgentPersistsValue() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        let (ok, value) = await store.setTeamDefaultAgent(agentID: "agent-7")
        XCTAssertTrue(ok)
        XCTAssertEqual(value, "agent-7")
        let stored = await repo.teamDefaultAgentID
        XCTAssertEqual(stored, "agent-7")
    }

    func testSetTeamDefaultAgentErrorReturnsFalse() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.setNextError(NSError(domain: "API", code: 403,
                                        userInfo: [NSLocalizedDescriptionKey: "forbidden"]))
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        let (ok, value) = await store.setTeamDefaultAgent(agentID: "agent-x")
        XCTAssertFalse(ok)
        XCTAssertNil(value)
        XCTAssertEqual(store.errorMessage, "forbidden")
    }

    func testGetEffectiveDefaultAgentCallsThrough() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.setEffectiveDefaultAgentID("eff-agent")
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        let id = await store.getEffectiveDefaultAgent()
        XCTAssertEqual(id, "eff-agent")
    }

    func testGetEffectiveDefaultAgentReturnsNilAndSetsErrorOnFailure() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.setNextError(URLError(.notConnectedToInternet))
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        let id = await store.getEffectiveDefaultAgent()
        XCTAssertNil(id)
        XCTAssertNotNil(store.errorMessage)
    }
}

private actor MockActorRepository: ActorRepository {
    private(set) var actorsToReturn: [ActorRecord] = []
    private(set) var inviteCreatedToReturn: InviteCreated?
    private(set) var claimResultToReturn: ClaimResult?
    private(set) var nextError: Error?
    private(set) var lastInviteInput: InviteCreateInput?
    private(set) var heartbeatCallCount: Int = 0

    func configure(actors: [ActorRecord] = [], inviteCreated: InviteCreated? = nil,
                   claimResult: ClaimResult? = nil) {
        actorsToReturn = actors
        inviteCreatedToReturn = inviteCreated
        claimResultToReturn = claimResult
    }

    func setNextError(_ error: Error) {
        nextError = error
    }

    func listActors(teamID: String) async throws -> [ActorRecord] {
        if let e = nextError { nextError = nil; throw e }
        return actorsToReturn
    }
    func createInvite(teamID: String, input: InviteCreateInput) async throws -> InviteCreated {
        lastInviteInput = input
        if let e = nextError { nextError = nil; throw e }
        return inviteCreatedToReturn
            ?? InviteCreated(token: "", expiresAt: Date(), deeplink: "")
    }
    func getJoinLink(teamID: String) async throws -> TeamJoinLink? {
        if let e = nextError { nextError = nil; throw e }
        return nil
    }
    func putJoinLink(teamID: String, input: TeamJoinLinkInput) async throws -> TeamJoinLink {
        if let e = nextError { nextError = nil; throw e }
        return TeamJoinLink(
            token: "tok", url: "https://api.acme.test/join/tok",
            expiresAt: nil, maxUses: input.maxUses, useCount: 0,
            status: "active", createdAt: Date()
        )
    }
    func revokeJoinLink(teamID: String) async throws {
        if let e = nextError { nextError = nil; throw e }
    }
    func joinByLink(token: String, cloudAPIURL: URL?) async throws -> JoinByLinkResult {
        if let e = nextError { nextError = nil; throw e }
        return JoinByLinkResult(teamID: "t-joined")
    }
    func upgradeAccount(teamID: String, orgName: String, contact: String?) async throws -> OrgUpgradeResult {
        if let e = nextError { nextError = nil; throw e }
        return OrgUpgradeResult(orgID: "org", teamID: teamID, teamName: orgName)
    }
    func claimInvite(token: String) async throws -> ClaimResult {
        if let e = nextError { nextError = nil; throw e }
        return claimResultToReturn
            ?? ClaimResult(actorID: "", teamID: "", actorType: "member",
                           displayName: "", refreshToken: nil)
    }
    func heartbeat() async throws { heartbeatCallCount += 1 }
    func removeActor(actorID: String) async throws {
        if let e = nextError { nextError = nil; throw e }
    }
    func uploadAvatar(actorID: String, imageData: Data, contentType: String) async throws -> String {
        if let e = nextError { nextError = nil; throw e }
        return "https://example.com/avatar.jpg"
    }
    func updateCurrentActorProfile(actorID: String, displayName: String, avatarURL: String?) async throws -> ActorRecord {
        if let e = nextError { nextError = nil; throw e }
        return ActorRecord(
            id: actorID,
            teamID: "t-1",
            actorType: "member",
            userID: "u-1",
            invitedByActorID: nil,
            displayName: displayName,
            avatarURL: avatarURL,
            lastActiveAt: Date(),
            createdAt: Date(),
            updatedAt: Date(),
            memberStatus: "active",
            teamRole: "member",
            agentKind: nil,
            agentStatus: nil
        )
    }
    func updateAgentDefaults(actorID: String, defaultWorkspaceID: String?, agentKind: String?, defaultAgentType: String?) async throws -> AgentDefaults {
        if let e = nextError { nextError = nil; throw e }
        return AgentDefaults(
            agentID: actorID,
            defaultWorkspaceID: defaultWorkspaceID,
            agentKind: agentKind,
            defaultAgentType: defaultAgentType
        )
    }
    var memberDefaultAgentID: String?
    func getMemberDefaultAgent(teamID: String) async throws -> String? {
        if let e = nextError { nextError = nil; throw e }
        return memberDefaultAgentID
    }
    func setMemberDefaultAgent(teamID: String, agentID: String?) async throws -> String? {
        if let e = nextError { nextError = nil; throw e }
        memberDefaultAgentID = agentID
        return agentID
    }
    func setTeamDefaultAgentID(_ id: String?) { teamDefaultAgentID = id }
    func setEffectiveDefaultAgentID(_ id: String?) { effectiveDefaultAgentID = id }
    var teamDefaultAgentID: String?
    func getTeamDefaultAgent(teamID: String) async throws -> String? {
        if let e = nextError { nextError = nil; throw e }
        return teamDefaultAgentID
    }
    func setTeamDefaultAgent(teamID: String, agentID: String?) async throws -> String? {
        if let e = nextError { nextError = nil; throw e }
        teamDefaultAgentID = agentID
        return agentID
    }
    var effectiveDefaultAgentID: String?
    func getEffectiveDefaultAgent(teamID: String) async throws -> String? {
        if let e = nextError { nextError = nil; throw e }
        return effectiveDefaultAgentID
    }
}
