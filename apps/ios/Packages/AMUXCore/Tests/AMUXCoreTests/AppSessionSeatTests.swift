import XCTest
@testable import AMUXCore

final class AppSessionSeatTests: XCTestCase {
    private func app(workspaceID: String?) -> TeamAppRecord {
        TeamAppRecord(id: "app1", teamID: "t1", name: "Shop", slug: "shop",
                      type: .imported, visibility: .team, provisionStatus: .ready,
                      workspaceID: workspaceID, createdAt: .now, updatedAt: .now)
    }

    private func ws(_ id: String, agent: String?, path: String) -> WorkspaceRecord {
        WorkspaceRecord(id: id, teamID: "t1", agentID: agent, path: path, displayName: id)
    }

    private func input(appID: String?, spawns: [(String, String)]) -> SessionCreationInput {
        SessionCreationInput(
            sessionID: "s1", teamID: "t1", currentActorID: "me", ideaID: nil, appID: appID,
            title: "t", summary: "hi", createdAt: .now, participants: [], participantInfos: [],
            agentSpawns: spawns.map {
                .init(actorID: $0.0, routeActorID: $0.0, workspaceID: $0.1, workspacePath: "/p", agentType: .pi)
            },
            mentionAgentActorIDs: []
        )
    }

    func test_checkout_isAppRowOwnedByAgentWithPath() {
        let rows = [ws("w0", agent: "a1", path: "/home"), ws("w1", agent: "a1", path: "/apps/shop")]
        XCTAssertEqual(SessionCreationInput.appCheckoutWorkspace(
            app: app(workspaceID: "w1"), agentID: "a1", workspaces: rows)?.id, "w1")
    }

    func test_checkout_otherAgentsRow_isNotUsed() {
        let rows = [ws("w1", agent: "a2", path: "/apps/shop")]
        XCTAssertNil(SessionCreationInput.appCheckoutWorkspace(
            app: app(workspaceID: "w1"), agentID: "a1", workspaces: rows))
    }

    func test_checkout_pathlessRow_isNotUsed() {
        let rows = [ws("w1", agent: "a1", path: "  ")]
        XCTAssertNil(SessionCreationInput.appCheckoutWorkspace(
            app: app(workspaceID: "w1"), agentID: "a1", workspaces: rows))
    }

    func test_checkout_appWithoutWorkspace_isNil() {
        XCTAssertNil(SessionCreationInput.appCheckoutWorkspace(
            app: app(workspaceID: nil), agentID: "a1", workspaces: [ws("w1", agent: "a1", path: "/x")]))
    }

    func test_seatBindings_onlyForAppSessions() {
        XCTAssertEqual(input(appID: "app1", spawns: [("a1", "w1")]).seatWorkspaceByActorID, ["a1": "w1"])
        XCTAssertEqual(input(appID: nil, spawns: [("a1", "w1")]).seatWorkspaceByActorID, [:])
    }
}
