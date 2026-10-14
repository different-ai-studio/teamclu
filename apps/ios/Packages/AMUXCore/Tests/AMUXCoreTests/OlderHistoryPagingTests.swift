import XCTest
import SwiftData
@testable import AMUXCore

/// Two pages of history: the newest (what the seed loads) and the one before
/// it. Records which cursors were asked for.
private actor PagedMessagesRepository: MessagesRepository {
    let sessionID: String
    private(set) var requestedCursors: [String?] = []

    init(sessionID: String) { self.sessionID = sessionID }

    private func row(_ n: Int) -> MessageRecord {
        MessageRecord(
            id: "msg-\(n)", teamID: "team-1", sessionID: sessionID, senderActorID: "human-2",
            kind: "user_message", content: "message \(n)",
            createdAt: Date(timeIntervalSince1970: TimeInterval(n * 60)), updatedAt: nil, model: nil,
            turnID: nil, replyToMessageID: nil, mentionActorIDs: [], sequence: 0, trace: nil
        )
    }

    func listForSession(sessionID: String) async throws -> [MessageRecord] { [row(3), row(4)] }

    func listPage(sessionID: String, limit: Int?, cursor: String?) async throws -> MessagePage {
        requestedCursors.append(cursor)
        switch cursor {
        case nil: return MessagePage(messages: [row(3), row(4)], nextCursor: "before-3")
        case "before-3": return MessagePage(messages: [row(1), row(2)], nextCursor: nil)
        default: return MessagePage(messages: [], nextCursor: nil)
        }
    }

    func insert(_ input: MessageInsertInput) async throws {}
    func patch(messageID: String, content: String) async throws {}
    func delete(messageID: String) async throws {}
    func submitFeedback(_ input: FeedbackInput) async throws {}
    func deleteFeedback(messageID: String, actorID: String) async throws {}
    func listFeedback(sessionID: String) async throws -> [FeedbackRecord] { [] }
    func turnTrace(teamID: String, sessionID: String, turnID: String) async throws -> TurnTraceLocation? { nil }
}

@MainActor
final class OlderHistoryPagingTests: XCTestCase {
    private let sessionID = "0b8f5f2a-9c3e-4d7a-8a61-2f4c3d5e6f70"

    private func makeViewModel(repo: PagedMessagesRepository) throws -> (SessionDetailViewModel, ModelContext, ModelContainer) {
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = container.mainContext
        let session = Session(sessionId: sessionID, teamId: "team-1")
        context.insert(session)
        let mqtt = MQTTService()
        let vm = SessionDetailViewModel(
            mqtt: mqtt, hub: MQTTMessageHub(mqtt: mqtt), teamID: "team-1", peerId: "p",
            session: session, messagesRepository: repo
        )
        return (vm, context, container)
    }

    func testScrollingBackLoadsThePageBeforeTheSeedUntilTheStart() async throws {
        let repo = PagedMessagesRepository(sessionID: sessionID)
        let (vm, context, container) = try makeViewModel(repo: repo)

        await vm.seedFromSupabaseMessages(modelContext: context)
        XCTAssertEqual(vm.events.count, 2)
        XCTAssertTrue(vm.hasOlderHistory)

        await vm.loadOlderHistory(modelContext: context)
        XCTAssertEqual(vm.events.map(\.text), ["message 1", "message 2", "message 3", "message 4"])
        XCTAssertFalse(vm.hasOlderHistory, "the server said there is nothing before page two")

        // Nothing left: another scroll to the top asks for nothing.
        await vm.loadOlderHistory(modelContext: context)
        let cursors = await repo.requestedCursors
        XCTAssertEqual(cursors, [nil, "before-3"])
        withExtendedLifetime(container) {}
    }

    func testAReseedDoesNotRewindAReaderWhoPagedBack() async throws {
        let repo = PagedMessagesRepository(sessionID: sessionID)
        let (vm, context, container) = try makeViewModel(repo: repo)

        await vm.seedFromSupabaseMessages(modelContext: context)
        await vm.loadOlderHistory(modelContext: context)
        // Reconnect: the seed runs again and gets the newest page's cursor.
        await vm.seedFromSupabaseMessages(modelContext: context)

        XCTAssertFalse(vm.hasOlderHistory, "the reseed must not resurrect a cursor already paged past")
        XCTAssertEqual(vm.events.count, 4)
        withExtendedLifetime(container) {}
    }
}
