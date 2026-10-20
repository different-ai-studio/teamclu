import XCTest
import SwiftData
@testable import AMUXCore

private actor InsertLog: MessagesRepository {
    private(set) var inserted: [MessageInsertInput] = []
    func listForSession(sessionID: String) async throws -> [MessageRecord] { [] }
    func insert(_ input: MessageInsertInput) async throws { inserted.append(input) }
    func patch(messageID: String, content: String) async throws {}
    func delete(messageID: String) async throws {}
    func submitFeedback(_ input: FeedbackInput) async throws {}
    func deleteFeedback(messageID: String, actorID: String) async throws {}
    func listFeedback(sessionID: String) async throws -> [FeedbackRecord] { [] }
    func turnTrace(teamID: String, sessionID: String, turnID: String) async throws -> TurnTraceLocation? { nil }
}

private actor PublishLog {
    private(set) var payloads: [(String, Data)] = []
    func append(_ topic: String, _ data: Data) { payloads.append((topic, data)) }
}

@MainActor
final class MessageTranscriptTests: XCTestCase {
    func testComposesSenderLinesUnderAHeader() {
        let mention = "[Mentioned agents: x]\n\nyes"
        let text = MessageTranscript.compose(
            [("Ann", "ship it?"), ("agent", mention)],
            header: "Forwarded from Release"
        )
        XCTAssertEqual(
            text,
            "Forwarded from Release\n\nAnn: ship it?\n\nagent: \(MentionDisplayText.plainText(mention))"
        )
        XCTAssertFalse(text.contains("[Mentioned"), "wire-form mentions read as @Name")
    }

    func testWithoutHeaderIsJustTheLines() {
        XCTAssertEqual(MessageTranscript.compose([("Ann", "hi")]), "Ann: hi")
    }

    func testOnlyMessagesAndRepliesAreSelectable() {
        let prompt = AgentEvent(agentId: "s", sequence: 0, eventType: "user_prompt")
        XCTAssertTrue(FeedItem.userMessage(prompt).selectableEvent === prompt)
        let reply = AgentEvent(agentId: "s", sequence: 1, eventType: "output")
        XCTAssertTrue(FeedItem.completedTurn(id: "t", agentID: "a", finalEvent: reply, runtimeEvents: []).selectableEvent === reply)
    }

    func testForwardPostsToTheTargetSessionMentioningNoOne() async throws {
        let log = PublishLog()
        let mqtt = MQTTService(
            subscribeHook: { _ in }, unsubscribeHook: { _ in },
            publishHook: { topic, payload, _ in await log.append(topic, payload) }
        )
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let repo = InsertLog()
        let service = TeamcluService()
        service.configureRuntimeForTesting(mqtt: mqtt, teamId: "team-1", peerId: "p",
                                           modelContainer: container, messagesRepository: repo)
        service.setLocalMemberIdForTesting("human-1")
        let session = Session(sessionId: "session-1", teamId: "team-1")
        container.mainContext.insert(session)
        let vm = SessionDetailViewModel(
            mqtt: mqtt, hub: MQTTMessageHub(mqtt: mqtt), teamID: "team-1", peerId: "p",
            session: session, teamcluService: service
        )

        try await vm.forward("Ann: hi", toSessionID: "session-2")

        let inserted = await repo.inserted
        XCTAssertEqual(inserted.map(\.sessionID), ["session-2"], "persisted before publishing")

        let sent = await log.payloads
        let (topic, payload) = try XCTUnwrap(sent.last)
        XCTAssertEqual(topic, MQTTTopics.sessionLive(teamID: "team-1", sessionID: "session-2"))
        let envelope = try Teamclu_SessionMessageEnvelope(
            serializedBytes: try Teamclu_LiveEventEnvelope(serializedBytes: payload).body
        )
        XCTAssertEqual(envelope.message.content, "Ann: hi")
        XCTAssertTrue(envelope.mentionActorIds.isEmpty)
        withExtendedLifetime(container) {}
    }
}
