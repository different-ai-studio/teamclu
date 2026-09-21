import XCTest
@testable import AMUXCore

/// The merge rule for agent dots: the broker's retained state wins over the
/// heartbeat in both directions, and "no retain seen" is not "offline".
@MainActor
final class AgentPresenceStoreTests: XCTestCase {

    private func agent(secondsAgo: TimeInterval?) -> CachedActor {
        CachedActor(actorId: "ag-1", teamId: "t-1", actorType: "agent",
                    displayName: "Pi",
                    lastActiveAt: secondsAgo.map { Date().addingTimeInterval(-$0) })
    }

    func testUnknownUntilARetainArrives() {
        let store = AgentPresenceStore()
        XCTAssertEqual(store.presence(forAgent: "ag-1"), .unknown)
    }

    func testRecordsBothDirections() {
        let store = AgentPresenceStore()
        store.record(actorID: "ag-1", online: true)
        XCTAssertEqual(store.presence(forAgent: "ag-1"), .online)
        // The Last Will is an ordinary ActorPresence with online:false.
        store.record(actorID: "ag-1", online: false)
        XCTAssertEqual(store.presence(forAgent: "ag-1"), .offline)
    }

    func testLastWillBeatsAFreshHeartbeat() {
        // The exact case that kept a dead agent green: killed just now, so
        // last_active_at is seconds old, but the broker already said offline.
        let a = agent(secondsAgo: 5)
        XCTAssertTrue(a.isOnline)
        XCTAssertFalse(a.isOnline(currentActorID: nil, devicePresence: .offline))
    }

    func testRetainBeatsAnExpiredHeartbeat() {
        // A quiet but connected daemon: no activity for an hour, still online.
        let a = agent(secondsAgo: 60 * 60)
        XCTAssertFalse(a.isOnline)
        XCTAssertTrue(a.isOnline(currentActorID: nil, devicePresence: .online))
    }

    func testUnknownFallsBackToHeartbeatRatherThanClaimingOffline() {
        XCTAssertTrue(agent(secondsAgo: 30).isOnline(currentActorID: nil, devicePresence: .unknown))
        XCTAssertFalse(agent(secondsAgo: 60 * 60).isOnline(currentActorID: nil, devicePresence: .unknown))
    }

    func testDevicePresenceDoesNotApplyToMembers() {
        // Members have no daemon; an agent's retain must never colour a person.
        let member = CachedActor(actorId: "m-1", teamId: "t-1", actorType: "member",
                                 displayName: "Alice",
                                 lastActiveAt: Date().addingTimeInterval(-30))
        XCTAssertTrue(member.isOnline(currentActorID: nil, devicePresence: .offline))
    }

    func testExternalStaysOfflineEvenWithAnOnlineRetain() {
        let external = CachedActor(actorId: "x-1", teamId: "t-1", actorType: "external",
                                   displayName: "WeCom contact", lastActiveAt: Date())
        XCTAssertFalse(external.isOnline(currentActorID: nil, devicePresence: .online))
    }

    func testBlankActorIDIsIgnored() {
        let store = AgentPresenceStore()
        store.record(actorID: "   ", online: true)
        XCTAssertTrue(store.byActorID.isEmpty)
    }

    func testClearDropsEverything() {
        let store = AgentPresenceStore()
        store.record(actorID: "ag-1", online: true)
        store.clear()
        XCTAssertEqual(store.presence(forAgent: "ag-1"), .unknown)
    }
}
