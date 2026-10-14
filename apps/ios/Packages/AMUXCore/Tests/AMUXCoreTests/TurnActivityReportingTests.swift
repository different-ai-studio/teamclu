import XCTest
import SwiftData
@testable import AMUXCore

@MainActor
private final class RecordingSink: TurnActivitySink {
    var updates: [TurnActivitySnapshot] = []
    var finishes: [(String, String?)] = []
    func update(_ snapshot: TurnActivitySnapshot) { updates.append(snapshot) }
    func finish(sessionID: String, finalLine: String?) { finishes.append((sessionID, finalLine)) }
}

/// The session view tells the Live Activity when its agent starts and
/// stops, and the stop carries the answer that just landed.
@MainActor
final class TurnActivityReportingTests: XCTestCase {
    override func tearDown() {
        TurnActivityCenter.sink = nil
        super.tearDown()
    }

    func testWorkingThenDoneReportsRunningThenTheFinalAnswer() throws {
        let sink = RecordingSink()
        TurnActivityCenter.sink = sink
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.title = "Release notes"
        container.mainContext.insert(session)
        let mqtt = MQTTService()
        let vm = SessionDetailViewModel(
            mqtt: mqtt, hub: MQTTMessageHub(mqtt: mqtt), teamID: "team-1", peerId: "p", session: session
        )

        vm._test_markAgentWorking()
        let running = try XCTUnwrap(sink.updates.last)
        XCTAssertEqual(running.sessionID, "session-1")
        XCTAssertEqual(running.sessionTitle, "Release notes")
        XCTAssertEqual(running.phase, .running)

        vm._installPerfFixture(turns: 1, modelContext: container.mainContext)
        vm._test_markAgentDone()
        let (sessionID, finalLine) = try XCTUnwrap(sink.finishes.last)
        XCTAssertEqual(sessionID, "session-1")
        XCTAssertNotNil(finalLine, "ends with the answer, not a blank")
        XCTAssertEqual(sink.finishes.count, 1)
        withExtendedLifetime(container) {}
    }

    func testNothingIsReportedWithoutWork() throws {
        let sink = RecordingSink()
        TurnActivityCenter.sink = sink
        let session = Session(sessionId: "session-1", teamId: "team-1")
        let mqtt = MQTTService()
        let vm = SessionDetailViewModel(
            mqtt: mqtt, hub: MQTTMessageHub(mqtt: mqtt), teamID: "team-1", peerId: "p", session: session
        )
        vm._test_markAgentDone()
        XCTAssertTrue(sink.updates.isEmpty)
        XCTAssertTrue(sink.finishes.isEmpty, "no turn was open, so nothing to finish")
    }
}
