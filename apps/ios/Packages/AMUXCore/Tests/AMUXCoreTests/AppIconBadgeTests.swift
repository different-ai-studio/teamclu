import XCTest
@testable import AMUXCore

final class AppIconBadgeTests: XCTestCase {
    private func session(_ id: String,
                         team: String = "t1",
                         unread: Bool = true,
                         archived: Bool = false,
                         source: String = "") -> Session {
        let s = Session(
            sessionId: id, teamId: team, title: id, createdBy: "me", createdAt: .now,
            summary: "", participantCount: 2, lastMessagePreview: "", lastMessageAt: nil,
            ideaId: "", hasUnread: unread
        )
        s.isArchived = archived
        s.source = source
        return s
    }

    func testCountsUnreadSessionsOfTheTeam() {
        let sessions = [session("a"), session("b"), session("c", unread: false)]
        XCTAssertEqual(AppIconBadge.unreadCount(in: sessions, teamID: "t1"), 2)
    }

    func testNothingUnreadIsZero() {
        XCTAssertEqual(AppIconBadge.unreadCount(in: [session("a", unread: false)], teamID: "t1"), 0)
        XCTAssertEqual(AppIconBadge.unreadCount(in: [], teamID: "t1"), 0)
    }

    /// The list shows neither, so their red dot can never be cleared — counting
    /// them would bring back the badge that never goes away.
    func testSkipsArchivedAndCronSessions() {
        let sessions = [
            session("a", archived: true),
            session("b", source: "cron"),
            session("c"),
        ]
        XCTAssertEqual(AppIconBadge.unreadCount(in: sessions, teamID: "t1"), 1)
    }

    /// Rows cached from the previous team linger until the next sync.
    func testSkipsOtherTeamsAndNoTeam() {
        let sessions = [session("a", team: "t2"), session("b")]
        XCTAssertEqual(AppIconBadge.unreadCount(in: sessions, teamID: "t1"), 1)
        XCTAssertEqual(AppIconBadge.unreadCount(in: sessions, teamID: ""), 0)
    }

    func testDeliveredNotificationsAreMatchedBySessionThread() {
        let delivered = [
            (id: "n1", threadID: "s1"),
            (id: "n2", threadID: "s2"),
            (id: "n3", threadID: "s1"),
        ]
        XCTAssertEqual(AppIconBadge.notificationIDs(delivered, inSession: "s1"), ["n1", "n3"])
        XCTAssertEqual(AppIconBadge.notificationIDs(delivered, inSession: "s9"), [])
        XCTAssertEqual(AppIconBadge.notificationIDs(delivered, inSession: ""), [])
    }
}
