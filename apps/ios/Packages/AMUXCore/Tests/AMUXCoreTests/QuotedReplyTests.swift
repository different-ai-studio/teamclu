import XCTest
import SwiftData
@testable import AMUXCore

private actor PublishLog {
    private(set) var payloads: [Data] = []
    func append(_ data: Data) { payloads.append(data) }
}

/// A reply composed on iOS carries the quoted message's id the whole way:
/// the local bubble, the MQTT message the daemon reads, and the history row.
@MainActor
final class QuotedReplyTests: XCTestCase {

    func testHistoryRowKeepsItsReplyTarget() {
        var state = TimelineState()
        ChatTimelineReducer.apply(.historyMessage(HistoryInput(
            supabaseMessageID: "m-2", kind: .userPrompt, senderActorID: "human-2",
            content: "agreed", createdAt: .now, replyToMessageID: "m-1"
        )), to: &state)
        XCTAssertEqual(state.entries.first?.replyToMessageID, "m-1")
    }

    func testTheSeedFillsTheReplyTargetOfALocalPromptItMergesInto() {
        var state = TimelineState()
        ChatTimelineReducer.apply(.localPrompt(LocalPromptInput(
            clientID: "c-1", senderActorID: "me", content: "agreed", createdAt: .now
        )), to: &state)
        ChatTimelineReducer.apply(.historyMessage(HistoryInput(
            supabaseMessageID: "m-2", kind: .userPrompt, senderActorID: "me",
            content: "agreed", createdAt: .now, replyToMessageID: "m-1"
        )), to: &state)
        XCTAssertEqual(state.entries.count, 1)
        XCTAssertEqual(state.entries.first?.replyToMessageID, "m-1")
    }

    func testSendingAReplyCarriesTheTargetOnTheBubbleAndOnTheWire() async throws {
        let log = PublishLog()
        let mqtt = MQTTService(
            subscribeHook: { _ in }, unsubscribeHook: { _ in },
            publishHook: { _, payload, _ in await log.append(payload) }
        )
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let service = TeamcluService()
        service.configureRuntimeForTesting(mqtt: mqtt, teamId: "team-1", peerId: "p", modelContainer: container)
        service.setLocalMemberIdForTesting("human-1")
        let context = container.mainContext
        let session = Session(sessionId: "session-1", teamId: "team-1")
        context.insert(session)
        let vm = SessionDetailViewModel(
            mqtt: mqtt, hub: MQTTMessageHub(mqtt: mqtt), teamID: "team-1", peerId: "p",
            session: session, teamcluService: service
        )

        try await vm.sendPrompt("agreed", replyTo: "m-1", modelContext: context)

        let bubble = try XCTUnwrap(vm.events.last { $0.eventType == "user_prompt" })
        XCTAssertEqual(bubble.replyToMessageID, "m-1")

        let payloads = await log.payloads
        let payload = try XCTUnwrap(payloads.first)
        let live = try Teamclu_LiveEventEnvelope(serializedBytes: payload)
        let message = try Teamclu_SessionMessageEnvelope(serializedBytes: live.body).message
        XCTAssertEqual(message.replyToMessageID, "m-1")
        withExtendedLifetime(container) {}
    }

    func testQuoteResolvesTheQuotedMessageFromTheFeed() throws {
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = container.mainContext
        let session = Session(sessionId: "session-1", teamId: "team-1")
        context.insert(session)
        let mqtt = MQTTService()
        let vm = SessionDetailViewModel(
            mqtt: mqtt, hub: MQTTMessageHub(mqtt: mqtt), teamID: "team-1", peerId: "p", session: session
        )
        vm._installPerfFixture(turns: 1, modelContext: context)
        let quoted = try XCTUnwrap(vm.events.first)
        let reply = AgentEvent(agentId: "session-1", sequence: 0, eventType: "user_prompt")
        reply.replyToMessageID = quoted.supabaseMessageId

        let quote = try XCTUnwrap(vm.replyQuote(for: reply))
        XCTAssertEqual(quote.content, quoted.text)
        withExtendedLifetime(container) {}
    }
}
