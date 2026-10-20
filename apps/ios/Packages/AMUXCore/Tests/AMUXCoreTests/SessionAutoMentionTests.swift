import XCTest
@testable import AMUXCore

final class SessionAutoMentionTests: XCTestCase {
    private func spawn(_ id: String) -> SessionCreationInput.AgentSpawn {
        .init(actorID: id, routeActorID: id, workspaceID: "ws", workspacePath: "/tmp", agentType: .pi)
    }

    private func participant(_ id: String, _ name: String) -> Teamclu_Participant {
        var p = Teamclu_Participant()
        p.actorID = id
        p.displayName = name
        return p
    }

    private func input(summary: String, mentions: [String]) -> SessionCreationInput {
        SessionCreationInput(
            sessionID: "s1", teamID: "t1", currentActorID: "me", ideaID: nil,
            title: "t", summary: summary, createdAt: .now,
            participants: [],
            participantInfos: [participant("me", "Me"), participant("a1", "mini")],
            agentSpawns: [spawn("a1")],
            mentionAgentActorIDs: mentions
        )
    }

    func test_singleAccessibleAgent_isMentioned() {
        XCTAssertEqual(
            SessionCreationInput.autoMentionAgentIDs(agentSpawns: [spawn("a1")],
                                                     accessibleAgentIDs: ["a1", "a2"]),
            ["a1"]
        )
    }

    func test_multipleAgents_mentionNobody() {
        XCTAssertEqual(
            SessionCreationInput.autoMentionAgentIDs(agentSpawns: [spawn("a1"), spawn("a2")],
                                                     accessibleAgentIDs: ["a1", "a2"]),
            []
        )
    }

    func test_singleAgentWithoutGrant_mentionsNobody() {
        XCTAssertEqual(
            SessionCreationInput.autoMentionAgentIDs(agentSpawns: [spawn("a1")],
                                                     accessibleAgentIDs: ["a2"]),
            []
        )
    }

    func test_noAgents_mentionNobody() {
        XCTAssertEqual(
            SessionCreationInput.autoMentionAgentIDs(agentSpawns: [], accessibleAgentIDs: ["a1"]),
            []
        )
    }

    func test_firstMessageContent_prependsMentionedAgent() {
        XCTAssertEqual(input(summary: "top 10 news", mentions: ["a1"]).firstMessageContent,
                       "@mini top 10 news")
    }

    func test_firstMessageContent_skipsAlreadyTypedMention() {
        XCTAssertEqual(input(summary: "hey @mini top 10", mentions: ["a1"]).firstMessageContent,
                       "hey @mini top 10")
    }

    func test_firstMessageContent_unchangedWithoutMention() {
        XCTAssertEqual(input(summary: "top 10 news", mentions: []).firstMessageContent,
                       "top 10 news")
    }
}
