import XCTest
@testable import AMUXCore

final class FeedItemLookupTests: XCTestCase {
    private func event(_ type: String, server: String?) -> AgentEvent {
        let e = AgentEvent(agentId: "s", sequence: 0, eventType: type)
        e.supabaseMessageId = server
        return e
    }

    func testFindsAChatMessageByItsServerID() {
        let message = event("user_prompt", server: "m-1")
        let items: [FeedItem] = [.userMessage(event("user_prompt", server: "m-0")), .userMessage(message)]
        XCTAssertEqual(items.feedItemID(containingServerMessageID: "m-1"), "user-\(message.id)")
    }

    func testFindsTheTurnWhoseReplyIsTheMessage() {
        let reply = event("output", server: "reply-9")
        let items: [FeedItem] = [.completedTurn(id: "turn-9", agentID: "a", finalEvent: reply, runtimeEvents: [])]
        XCTAssertEqual(items.feedItemID(containingServerMessageID: "reply-9"), "turn-9")
    }

    func testMatchesRegardlessOfCase() {
        let message = event("user_prompt", server: "abcdef")
        XCTAssertEqual([FeedItem.userMessage(message)].feedItemID(containingServerMessageID: "ABCDEF"), "user-\(message.id)")
    }

    func testUnknownIDIsNil() {
        XCTAssertNil([FeedItem.userMessage(event("user_prompt", server: "x"))].feedItemID(containingServerMessageID: "y"))
    }
}
