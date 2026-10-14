import XCTest
@testable import AMUXCore

/// A reconnect is clean-start, so the broker forgets every subscription.
/// Consumers subscribe once and never see the reconnect (the hub keeps their
/// streams open across it), so `MQTTService` must replay what they claimed.
/// Before this, a foreground reconnect left the app with zero subscriptions.
final class MQTTReconnectTests: XCTestCase {

    func testReconnectReplaysEveryClaimedTopic() async throws {
        let mqtt = MQTTService(subscribeHook: { _ in }, unsubscribeHook: { _ in })
        try await mqtt.subscribe("team/session/s1/live", owner: MQTTSubscriptionOwner.foregroundSession)
        try await mqtt.subscribe("team/actor/a1/notify")
        try await mqtt.subscribe("team/actor/me/rpc/res")

        let before = mqtt.subscribedTopics.count
        await mqtt.simulateReconnectForTesting()

        XCTAssertEqual(
            Set(mqtt.subscribedTopics.dropFirst(before)),
            ["team/session/s1/live", "team/actor/a1/notify", "team/actor/me/rpc/res"]
        )
    }

    func testReconnectSkipsTopicsEveryOwnerReleased() async throws {
        let mqtt = MQTTService(subscribeHook: { _ in }, unsubscribeHook: { _ in })
        try await mqtt.subscribe("live", owner: MQTTSubscriptionOwner.foregroundSession)
        try await mqtt.subscribe("live", owner: MQTTSubscriptionOwner.sessionListActivity)
        try await mqtt.subscribe("gone")
        try await mqtt.unsubscribe("gone")
        // One owner of "live" leaves; the other still wants it.
        try await mqtt.unsubscribe("live", owner: MQTTSubscriptionOwner.foregroundSession)

        XCTAssertEqual(mqtt.claimedTopics(), ["live"])
    }

    func testResetSubscriptionsDropsEveryClaim() async throws {
        let mqtt = MQTTService(subscribeHook: { _ in }, unsubscribeHook: { _ in })
        try await mqtt.subscribe("a")
        try await mqtt.subscribe("b")

        mqtt.resetSubscriptions()

        let before = mqtt.subscribedTopics.count
        await mqtt.simulateReconnectForTesting()
        XCTAssertEqual(mqtt.subscribedTopics.count, before)
    }

    func testConnectionAcceptedAnnouncesEachReconnect() async throws {
        let mqtt = MQTTService(subscribeHook: { _ in }, unsubscribeHook: { _ in })
        let stream = mqtt.connectionAccepted()
        var iterator = stream.makeAsyncIterator()

        await mqtt.simulateReconnectForTesting()
        await mqtt.simulateReconnectForTesting()

        let first: Void? = await iterator.next()
        let second: Void? = await iterator.next()
        XCTAssertNotNil(first)
        XCTAssertNotNil(second)
    }

    func testConnectionAcceptedSurvivesExplicitDisconnect() async throws {
        let mqtt = MQTTService(subscribeHook: { _ in }, unsubscribeHook: { _ in })
        let stream = mqtt.connectionAccepted()
        var iterator = stream.makeAsyncIterator()

        await mqtt.disconnect()
        await mqtt.simulateReconnectForTesting()

        let event: Void? = await iterator.next()
        XCTAssertNotNil(event, "a forced reconnect (disconnect + connect) must still be announced")
    }

    func testProbeAliveIsFalseWithoutAConnection() async {
        let mqtt = MQTTService()
        let alive = await mqtt.probeAlive(timeout: .milliseconds(50))
        XCTAssertFalse(alive)
    }
}
