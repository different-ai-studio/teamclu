import XCTest
@testable import AMUXCore

@MainActor
final class SessionReadPositionTests: XCTestCase {
    private let suite = "SessionReadPositionTests"
    private var defaults: UserDefaults!

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    private func message(_ seconds: TimeInterval, from sender: String) -> FeedItem {
        let event = AgentEvent(agentId: "s", sequence: 0, eventType: "user_prompt")
        event.timestamp = Date(timeIntervalSince1970: seconds)
        event.senderActorID = sender
        return .userMessage(event)
    }

    func testPositionSurvivesANewStore() {
        let position = SessionReadPosition(lastSeenAt: Date(timeIntervalSince1970: 100), anchorItemID: "row-7")
        SessionReadPositionStore(defaults: defaults).save(position, for: "s1")
        XCTAssertEqual(SessionReadPositionStore(defaults: defaults).position(for: "s1"), position)
        XCTAssertNil(SessionReadPositionStore(defaults: defaults).position(for: "s2"))
    }

    func testRemoveAllForgetsEverything() {
        let store = SessionReadPositionStore(defaults: defaults)
        store.save(SessionReadPosition(lastSeenAt: .now), for: "s1")
        store.removeAll()
        XCTAssertNil(SessionReadPositionStore(defaults: defaults).position(for: "s1"))
    }

    func testFirstUnreadSkipsWhatWasSeenAndWhatIWrote() throws {
        let seen = message(100, from: "other")
        let mine = message(200, from: "me")
        let new1 = message(300, from: "other")
        let new2 = message(400, from: "other")
        let result = try XCTUnwrap(firstUnread(
            in: [seen, mine, new1, new2],
            after: Date(timeIntervalSince1970: 150),
            excludingSender: "me"
        ))
        XCTAssertEqual(result.id, new1.id)
        XCTAssertEqual(result.count, 2)
    }

    func testNothingUnreadIsNil() {
        let items = [message(100, from: "other"), message(200, from: "me")]
        XCTAssertNil(firstUnread(in: items, after: Date(timeIntervalSince1970: 100), excludingSender: "me"))
    }
}
