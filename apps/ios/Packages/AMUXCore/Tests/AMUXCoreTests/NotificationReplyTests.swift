import XCTest
@testable import AMUXCore

final class NotificationReplyTests: XCTestCase {
    private let payload: [AnyHashable: Any] = [
        "session_id": "s-1", "team_id": "t-1", "message_id": "m-1",
        "sender_actor_id": "agent-1", "kind": "message",
    ]

    func testReadsTheTargetFromThePushPayload() {
        XCTAssertEqual(
            NotificationReply.target(from: payload),
            .init(sessionID: "s-1", teamID: "t-1", messageID: "m-1", senderActorID: "agent-1")
        )
    }

    func testAPushWithoutTeamHasNoReplyTarget() {
        XCTAssertNil(NotificationReply.target(from: ["session_id": "s-1", "message_id": "m-1"]))
    }

    func testReplyingToAnAgentMentionsItAndQuotesTheMessage() throws {
        let target = try XCTUnwrap(NotificationReply.target(from: payload))
        let input = NotificationReply.insertInput(text: "go on", target: target, myActorID: "me", senderIsAgent: true)
        XCTAssertEqual(input.sessionID, "s-1")
        XCTAssertEqual(input.teamID, "t-1")
        XCTAssertEqual(input.senderActorID, "me")
        XCTAssertEqual(input.mentionActorIDs, ["agent-1"])
        XCTAssertEqual(input.replyToMessageID, "m-1")
    }

    func testReplyingToAPersonMentionsNoOne() throws {
        let target = try XCTUnwrap(NotificationReply.target(from: payload))
        let input = NotificationReply.insertInput(text: "ok", target: target, myActorID: "me", senderIsAgent: false)
        XCTAssertEqual(input.mentionActorIDs, [])
    }

    func testRemembersTheOwnActorPerTeamUntilForgotten() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "NotificationReplyTests"))
        defer { defaults.removePersistentDomain(forName: "NotificationReplyTests") }
        NotificationReply.rememberActor("a-1", team: "t-1", defaults: defaults)
        NotificationReply.rememberActor("a-2", team: "t-2", defaults: defaults)
        XCTAssertEqual(NotificationReply.actorID(team: "t-1", defaults: defaults), "a-1")
        XCTAssertEqual(NotificationReply.actorID(team: "t-2", defaults: defaults), "a-2")
        NotificationReply.forgetActors(defaults: defaults)
        XCTAssertNil(NotificationReply.actorID(team: "t-1", defaults: defaults))
    }
}
