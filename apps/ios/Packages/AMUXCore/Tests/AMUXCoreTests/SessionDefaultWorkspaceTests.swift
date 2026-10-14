import XCTest
@testable import AMUXCore

final class SessionDefaultWorkspaceTests: XCTestCase {
    private func ws(_ id: String, agent: String?) -> WorkspaceRecord {
        WorkspaceRecord(id: id, teamID: "t1", agentID: agent, path: "/\(id)", displayName: id)
    }

    func test_prefersAgentDefault_overListOrder() {
        // The list order put "/" first; the voice entry used `.first` and
        // seated sessions on a worktree the daemon had no warm host for.
        let workspaces = [ws("root", agent: "a1"), ws("default", agent: "a1")]
        XCTAssertEqual(
            SessionCreationInput.defaultWorkspace(agentID: "a1", defaultWorkspaceID: "default",
                                                  workspaces: workspaces)?.id,
            "default"
        )
    }

    func test_missingDefault_fallsBackToAgentsOwnWorkspace() {
        let workspaces = [ws("other", agent: "a2"), ws("mine", agent: "a1")]
        XCTAssertEqual(
            SessionCreationInput.defaultWorkspace(agentID: "a1", defaultWorkspaceID: "gone",
                                                  workspaces: workspaces)?.id,
            "mine"
        )
        XCTAssertEqual(
            SessionCreationInput.defaultWorkspace(agentID: "a1", defaultWorkspaceID: nil,
                                                  workspaces: workspaces)?.id,
            "mine"
        )
    }

    func test_neverBorrowsAnotherAgentsWorkspace() {
        XCTAssertNil(
            SessionCreationInput.defaultWorkspace(agentID: "a1", defaultWorkspaceID: nil,
                                                  workspaces: [ws("other", agent: "a2")])
        )
    }
}
