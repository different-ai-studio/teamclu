import XCTest
import SwiftData
@testable import AMUXCore

/// 200 rows, a prompt and its answer per turn, newest page only.
private actor TurnsRepository: MessagesRepository {
    let rows: [MessageRecord]

    init(sessionID: String, turns: Int) {
        rows = (0..<turns).flatMap { n -> [MessageRecord] in
            let at = Date(timeIntervalSince1970: TimeInterval(1_700_000_000 + n * 120))
            return [
                MessageRecord(
                    id: "p-\(n)", teamID: "team-1", sessionID: sessionID, senderActorID: "human-1",
                    kind: "user_message", content: "question \(n)", createdAt: at, updatedAt: nil,
                    model: nil, turnID: nil, replyToMessageID: nil, mentionActorIDs: ["agent-1"],
                    sequence: 0, trace: nil
                ),
                MessageRecord(
                    id: "r-\(n)", teamID: "team-1", sessionID: sessionID, senderActorID: "agent-1",
                    kind: "agent_reply", content: "answer \(n)\n\nwith a second paragraph",
                    createdAt: at.addingTimeInterval(30), updatedAt: nil, model: "m",
                    turnID: "t-\(n)", replyToMessageID: nil, mentionActorIDs: [], sequence: 0, trace: nil
                ),
            ]
        }
    }

    func listForSession(sessionID: String) async throws -> [MessageRecord] { rows }
    func listPage(sessionID: String, limit: Int?, cursor: String?) async throws -> MessagePage {
        MessagePage(messages: rows, nextCursor: nil)
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
final class HistorySeedPerformanceTests: XCTestCase {
    private func makeViewModel(turns: Int) throws -> (SessionDetailViewModel, ModelContext, ModelContainer) {
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = container.mainContext
        let session = Session(sessionId: "s-1", teamId: "team-1")
        context.insert(session)
        let mqtt = MQTTService()
        let vm = SessionDetailViewModel(
            mqtt: mqtt, hub: MQTTMessageHub(mqtt: mqtt), teamID: "team-1", peerId: "p",
            session: session, messagesRepository: TurnsRepository(sessionID: "s-1", turns: turns)
        )
        return (vm, context, container)
    }

    /// The seed lands every row once, in time order, and a second seed (the
    /// reconnect / return-to-foreground path) changes nothing.
    func testSeedAndReseedProduceTheSameOrderedFeed() async throws {
        let (vm, context, container) = try makeViewModel(turns: 100)
        await vm.seedFromSupabaseMessages(modelContext: context)
        let first = vm.events.map { "\($0.eventType):\($0.text ?? "")" }
        XCTAssertEqual(first.count, 200)
        XCTAssertEqual(first.first, "user_prompt:question 0")
        XCTAssertEqual(first.last, "output:answer 99\n\nwith a second paragraph")
        XCTAssertEqual(Set(vm.events.compactMap(\.supabaseMessageId)).count, 200)

        await vm.seedFromSupabaseMessages(modelContext: context)
        XCTAssertEqual(vm.events.map { "\($0.eventType):\($0.text ?? "")" }, first)
        withExtendedLifetime(container) {}
    }

    /// Timing only (printed, not asserted): the seed runs on the main actor
    /// when a session opens and again on every reconnect.
    func testSeedTiming() async throws {
        let (vm, context, container) = try makeViewModel(turns: 100)
        let clock = ContinuousClock()
        let cold = await clock.measure { await vm.seedFromSupabaseMessages(modelContext: context) }
        let warm = await clock.measure { await vm.seedFromSupabaseMessages(modelContext: context) }
        print("[seed-perf] 200 rows cold=\(cold) reseed=\(warm)")
        withExtendedLifetime(container) {}
    }
}
