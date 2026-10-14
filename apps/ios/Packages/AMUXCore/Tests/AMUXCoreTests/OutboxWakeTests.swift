import XCTest
import SwiftData
@testable import AMUXCore

private actor Published {
    private(set) var at: [ContinuousClock.Instant] = []
    func record() { at.append(.now) }
}

private actor AcceptAll: MessagesRepository {
    func listForSession(sessionID: String) async throws -> [MessageRecord] { [] }
    func insert(_ input: MessageInsertInput) async throws {}
    func patch(messageID: String, content: String) async throws {}
    func delete(messageID: String) async throws {}
    func submitFeedback(_ input: FeedbackInput) async throws {}
    func deleteFeedback(messageID: String, actorID: String) async throws {}
    func listFeedback(sessionID: String) async throws -> [FeedbackRecord] { [] }
    func turnTrace(teamID: String, sessionID: String, turnID: String) async throws -> TurnTraceLocation? { nil }
}

/// A message enqueued while the outbox is idle goes out right away, not on
/// the idle loop's next one-second tick.
@MainActor
final class OutboxWakeTests: XCTestCase {
    func testEnqueueWakesTheIdleLoop() async throws {
        let published = Published()
        let mqtt = MQTTService(
            subscribeHook: { _ in }, unsubscribeHook: { _ in },
            publishHook: { _, _, _ in await published.record() }
        )
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self, OutboxMessage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let service = TeamcluService()
        service.configureRuntimeForTesting(mqtt: mqtt, teamId: "team-1", peerId: "p",
                                           modelContainer: container, messagesRepository: AcceptAll())
        service.setLocalMemberIdForTesting("human-1")
        let outbox = OutboxSender(teamclu: service, modelContainer: container)
        await outbox.start()
        // Let the loop find nothing and go idle.
        try await Task.sleep(for: .milliseconds(150))

        let enqueued = ContinuousClock.now
        await outbox.enqueue(messageID: "m-1", sessionID: "s-1", senderActorID: "human-1",
                             content: "hi", mentionActorIDs: [], modelID: nil)
        for _ in 0..<40 where await published.at.isEmpty {
            try await Task.sleep(for: .milliseconds(25))
        }
        let times = await published.at
        let sentAt = try XCTUnwrap(times.first, "never published")
        let latency = sentAt - enqueued
        print("[outbox-wake] enqueue→publish \(latency)")
        XCTAssertLessThan(latency, .milliseconds(300))
        await outbox.stop()
        withExtendedLifetime(container) {}
    }
}
