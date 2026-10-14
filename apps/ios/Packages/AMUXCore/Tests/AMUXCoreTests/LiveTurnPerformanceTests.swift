import XCTest
import SwiftData
@testable import AMUXCore

/// Main-actor cost of streaming one scripted turn (thinking, six tool calls,
/// 120 output deltas) into a 220-turn session — the work M2's `main_ms`
/// counts, without the view layer. Printed, not asserted.
@MainActor
final class LiveTurnPerformanceTests: XCTestCase {
    func testStreamedTurnMainActorCost() async throws {
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = container.mainContext
        let session = Session(sessionId: PerfFixtures.largeSessionID, teamId: "team-1")
        context.insert(session)
        let mqtt = MQTTService()
        let vm = SessionDetailViewModel(
            mqtt: mqtt, hub: MQTTMessageHub(mqtt: mqtt), teamID: "team-1", peerId: "p", session: session
        )
        vm._test_start(modelContext: context)
        let install = ContinuousClock().measure { vm._installPerfFixture(turns: 110, modelContext: context) }
        let before = vm.events.count
        let replay = await ContinuousClock().measure { await vm._replayPerfTurn(interval: .zero) }
        XCTAssertGreaterThan(vm.events.count, before)
        print("[live-perf] install110turns=\(install) replay=\(replay) events=\(vm.events.count)")
        withExtendedLifetime(container) {}
    }
}
