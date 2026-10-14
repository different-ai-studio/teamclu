import XCTest
import SwiftData
@testable import AMUXCore

/// Correctness of the perf fixtures, plus benchmarks of the two main-thread
/// paths phase 4 will optimise: applying a history seed (P1) and handling a
/// streamed turn (P2). The benchmarks print timings for comparison across
/// commits; they assert only that the work happened.
/// Counts fetches, so a test can tell "skipped" from "fetched nothing".
private actor CountingMessagesRepository: MessagesRepository {
    private(set) var listCalls = 0
    func listForSession(sessionID: String) async throws -> [MessageRecord] {
        listCalls += 1
        return []
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
final class PerfFixturesTests: XCTestCase {

    /// The container is returned so the caller keeps it alive: SwiftData
    /// invalidates every model once its container is released.
    private func makeViewModel(
        sessionID: String,
        messagesRepository: (any MessagesRepository)? = nil
    ) throws -> (SessionDetailViewModel, ModelContext, ModelContainer) {
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = container.mainContext
        let session = Session(sessionId: sessionID, teamId: "team-1")
        context.insert(session)
        let mqtt = MQTTService()
        let vm = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            messagesRepository: messagesRepository
        )
        return (vm, context, container)
    }

    func testLargeFixtureInstallsEveryRow() throws {
        let (vm, context, container) = try makeViewModel(sessionID: PerfFixtures.largeSessionID)
        vm._installPerfFixture(turns: 110, modelContext: context)
        withExtendedLifetime(container) {}
        XCTAssertEqual(vm.events.count, 220)
        XCTAssertEqual(vm.events.filter { $0.eventType == "user_prompt" }.count, 110)
    }

    func testStreamedTurnEndsWithTheFullReply() throws {
        let events = PerfFixtures.streamedTurn(toolCalls: 2, deltas: 40)
        let deltas = events.compactMap { event -> String? in
            if case .output(let output) = event.event, !output.isComplete { return output.text }
            return nil
        }
        let outputs = events.compactMap { event -> Amux_AcpOutput? in
            if case .output(let output) = event.event { return output } else { return nil }
        }
        let last = try XCTUnwrap(outputs.last)
        XCTAssertTrue(last.isComplete)
        // Bracketed like a daemon turn: active first, idle last.
        guard case .statusChange(let opening) = events.first?.event,
              case .statusChange(let closing) = events.last?.event else {
            return XCTFail("the turn must open and close with a status change")
        }
        XCTAssertEqual(opening.newStatus, .active)
        XCTAssertEqual(closing.newStatus, .idle)
        XCTAssertEqual(last.text, deltas.joined())
        XCTAssertEqual(events.filter { if case .toolUse = $0.event { return true } else { return false } }.count, 2)
    }

    func testFixtureSessionsSkipTheNetworkSeedButRealOnesFetch() async throws {
        let repo = CountingMessagesRepository()
        let (fixture, fixtureContext, fixtureContainer) = try makeViewModel(
            sessionID: PerfFixtures.smallSessionID, messagesRepository: repo
        )
        await fixture.seedFromSupabaseMessages(modelContext: fixtureContext)
        let afterFixture = await repo.listCalls
        XCTAssertEqual(afterFixture, 0, "a fixture session must never hit the Cloud API")

        let (real, realContext, realContainer) = try makeViewModel(
            sessionID: "0b8f5f2a-9c3e-4d7a-8a61-2f4c3d5e6f70", messagesRepository: repo
        )
        await real.seedFromSupabaseMessages(modelContext: realContext)
        let afterReal = await repo.listCalls
        XCTAssertEqual(afterReal, 1)
        withExtendedLifetime((fixtureContainer, realContainer)) {}
    }

    /// P1 baseline: 220 history rows through the reducer, one by one.
    func testBenchmarkHistorySeedApply() throws {
        measure(metrics: [XCTClockMetric()]) {
            guard let (vm, context, container) = try? makeViewModel(sessionID: PerfFixtures.largeSessionID) else { return }
            vm._installPerfFixture(turns: 110, modelContext: context)
            XCTAssertEqual(vm.events.count, 220)
            withExtendedLifetime(container) {}
        }
    }

    /// P2 baseline: one streamed turn (thinking, 6 tool calls, 120 output
    /// deltas) handled on top of the 220-row session.
    func testBenchmarkStreamedTurnOnLargeSession() throws {
        let turn = PerfFixtures.streamedTurn()
        measure(metrics: [XCTClockMetric()]) {
            guard let (vm, context, container) = try? makeViewModel(sessionID: PerfFixtures.largeSessionID) else { return }
            vm._installPerfFixture(turns: 110, modelContext: context)
            let before = vm.events.count
            for (index, acp) in turn.enumerated() {
                vm._testHandleAcp(acp, sequence: index + 1, runtimeID: PerfFixtures.agentID, modelContext: context)
            }
            XCTAssertGreaterThan(vm.events.count, before)
            withExtendedLifetime(container) {}
        }
    }
}
