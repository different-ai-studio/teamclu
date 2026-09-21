import XCTest
@testable import AMUXCore

/// Role display reads `roles` (org roles, `roles_users`) and only falls back to
/// the legacy derived `teamRole`. These pin the precedence and the two cases the
/// old `teamRole`-only mapping got wrong: a custom org role, and a member with
/// no binding at all.
final class ActorRoleResolutionTests: XCTestCase {

    private func role(_ code: String, _ name: String) -> ActorRoleRef {
        ActorRoleRef(id: "role-\(code)", code: code, name: name)
    }

    private func member(roles: [ActorRoleRef] = [], teamRole: String? = nil) -> ActorRecord {
        ActorRecord(
            id: "a-1", teamID: "t-1", actorType: "member",
            userID: "u-1", invitedByActorID: nil,
            displayName: "Alice", lastActiveAt: nil,
            createdAt: .now, updatedAt: .now,
            memberStatus: "active", roles: roles, teamRole: teamRole,
            agentStatus: nil
        )
    }

    func testRolesWinOverTeamRole() {
        // A stale cached teamRole must not outvote a live role assignment.
        let a = member(roles: [role("admin", "Admin")], teamRole: "owner")
        XCTAssertTrue(a.isAdmin)
        XCTAssertFalse(a.isOwner)
        XCTAssertEqual(a.roleLabel, String(localized: "Admin"))
    }

    func testTeamRoleUsedOnlyWhenRolesEmpty() {
        let a = member(roles: [], teamRole: "owner")
        XCTAssertTrue(a.isOwner)
        XCTAssertEqual(a.roleLabel, String(localized: "Owner"))
    }

    func testHighestPrivilegeMatchesServerOrdering() {
        let roles = [role("member", "Member"), role("owner", "Owner"), role("admin", "Admin")]
        XCTAssertEqual(roles.highestPrivilege?.code, "owner")
        XCTAssertEqual([role("finance", "Finance"), role("member", "Member")].highestPrivilege?.code,
                       "finance")
    }

    func testCustomRoleKeepsItsOwnName() {
        // The old owner/admin/member switch rendered anything else as "—".
        let a = member(roles: [role("reviewer", "Code Reviewer")])
        XCTAssertEqual(a.roleLabel, "Code Reviewer")
    }

    func testCustomRoleFallsBackToCodeWhenNameEmpty() {
        XCTAssertEqual(role("reviewer", "").label, "reviewer")
    }

    func testMemberWithNoRoleAtAllReadsAsMember() {
        // Mirrors current_team_role's server-side 'member' fallback, which every
        // authz guard already depends on.
        let a = member(roles: [], teamRole: nil)
        XCTAssertFalse(a.isOwner)
        XCTAssertEqual(a.roleLabel, String(localized: "Member"))
    }

    func testAgentsHaveNoRole() {
        let agent = ActorRecord(
            id: "ag-1", teamID: "t-1", actorType: "agent",
            userID: nil, invitedByActorID: nil,
            displayName: "Pi", lastActiveAt: nil,
            createdAt: .now, updatedAt: .now,
            memberStatus: nil, roles: [], teamRole: nil,
            agentStatus: "online"
        )
        XCTAssertEqual(agent.roleLabel, "—")
        XCTAssertTrue(ActorRoleResolution.displayRoles(isMember: false, roles: [], teamRole: nil).isEmpty)
    }

    func testDisplayRolesFallsBackToASyntheticMemberChip() {
        let chips = ActorRoleResolution.displayRoles(isMember: true, roles: [], teamRole: nil)
        XCTAssertEqual(chips.map(\.code), ["member"])
        XCTAssertEqual(chips.first?.label, String(localized: "Member"))
    }

    func testCachedActorAndRecordAgree() {
        let roles = [role("finance", "Finance")]
        let cached = CachedActor(actorId: "a-1", teamId: "t-1", actorType: "member",
                                 displayName: "Alice", roles: roles, teamRole: "member")
        XCTAssertEqual(cached.roleLabel, member(roles: roles, teamRole: "member").roleLabel)
        XCTAssertEqual(cached.displayRoles.map(\.code), ["finance"])
    }
}
