import XCTest
@testable import AMUXCore

/// Pins the presence rule to the desktop's `actor-online.ts`, since the two
/// disagreeing is what made the same person read green on desktop and grey in
/// the phone's actor picker.
final class ActorPresenceTests: XCTestCase {

    private func member(secondsAgo: TimeInterval?) -> CachedActor {
        CachedActor(actorId: "a-1", teamId: "t-1", actorType: "member",
                    displayName: "Alice",
                    lastActiveAt: secondsAgo.map { Date().addingTimeInterval(-$0) })
    }

    func testWindowIsFiveMinutesLikeDesktop() {
        XCTAssertEqual(ActorPresence.onlineWindow, 5 * 60)
    }

    func testHeartbeatOlderThanNinetySecondsIsStillOnline() {
        // The old iOS window was 90s — shorter than the gap between two
        // heartbeats, so this case used to read offline.
        XCTAssertTrue(member(secondsAgo: 120).isOnline)
        XCTAssertTrue(member(secondsAgo: 4 * 60).isOnline)
    }

    func testPastTheWindowIsOffline() {
        XCTAssertFalse(member(secondsAgo: 6 * 60).isOnline)
    }

    func testNeverActiveIsOffline() {
        XCTAssertFalse(member(secondsAgo: nil).isOnline)
    }

    func testCurrentUserIsOnlineEvenWithAStaleHeartbeat() {
        let me = member(secondsAgo: 60 * 60)
        XCTAssertFalse(me.isOnline)
        XCTAssertTrue(me.isOnline(currentActorID: "a-1"))
    }

    func testAnotherActorsIdDoesNotGrantPresence() {
        XCTAssertFalse(member(secondsAgo: 60 * 60).isOnline(currentActorID: "someone-else"))
    }

    func testExternalContactsAreNeverOnline() {
        // Their last_active_at is bumped by every inbound gateway message,
        // which is not a presence signal.
        let external = CachedActor(actorId: "x-1", teamId: "t-1", actorType: "external",
                                   displayName: "WeCom contact",
                                   lastActiveAt: Date())
        XCTAssertFalse(external.isOnline)
    }

    func testRecordAndCachedActorAgree() {
        let at = Date().addingTimeInterval(-120)
        let record = ActorRecord(
            id: "a-1", teamID: "t-1", actorType: "member",
            userID: nil, invitedByActorID: nil,
            displayName: "Alice", lastActiveAt: at,
            createdAt: .now, updatedAt: .now,
            memberStatus: "active", teamRole: "member",
            agentStatus: nil
        )
        XCTAssertEqual(record.isOnline, member(secondsAgo: 120).isOnline)
        XCTAssertTrue(record.isOnline(currentActorID: "a-1"))
    }
}
