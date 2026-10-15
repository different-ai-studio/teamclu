import XCTest
@testable import AMUXCore

@MainActor
final class SessionDetailLoadingStateTests: XCTestCase {

    // MARK: - markAgentDone clears streamingAgentSet

    func test_markAgentDone_clearsStreamingAgentSet() {
        let vm = SessionDetailViewModel.testInstance()
        vm._test_seedStreamingBuffer(bucket: "agent-a", text: "hello", model: nil)
        XCTAssertTrue(vm.streamingAgentSet.contains("agent-a"))

        vm._test_markAgentDone()

        XCTAssertFalse(vm.streamingAgentSet.contains("agent-a"),
            "markAgentDone must clear streamingAgentSet so loading card disappears")
        XCTAssertFalse(vm.isAgentWorking)
    }

    // MARK: - stop/start restores streamingAgentSet from incomplete output

    func test_stopStart_restoresStreamingAgentSet_whenIncompleteOutputExists() {
        let vm = SessionDetailViewModel.testInstance()
        vm._test_seedStreamingBuffer(bucket: "agent-a", text: "partial text", model: "claude-sonnet")
        vm._test_markAgentWorking()
        XCTAssertTrue(vm.isAgentWorking)

        let container = vm._test_makeInMemoryContainer()
        vm._test_stop(modelContext: container.mainContext)

        XCTAssertFalse(vm.streamingAgentSet.contains("agent-a"),
            "stop() must clear streamingAgentSet")

        vm._test_start(modelContext: container.mainContext)

        XCTAssertTrue(vm.streamingAgentSet.contains("agent-a"),
            "start() must restore streamingAgentSet from persisted incomplete output when text is non-empty")
    }

    func test_stopStart_doesNotRestoreStreamingAgentSet_whenAgentFinishedCleanly() {
        let vm = SessionDetailViewModel.testInstance()
        vm._test_seedStreamingBuffer(bucket: "agent-a", text: "", model: nil)
        vm._test_markAgentDone()

        let container = vm._test_makeInMemoryContainer()
        vm._test_stop(modelContext: container.mainContext)
        vm._test_start(modelContext: container.mainContext)

        XCTAssertFalse(vm.streamingAgentSet.contains("agent-a"),
            "clean finish: streamingAgentSet must NOT be restored after stop/start")
    }

    func test_stop_doesNotPersistEvent_whenSetNonEmptyButTextIsEmpty() {
        let vm = SessionDetailViewModel.testInstance()
        // Agent started (set is non-empty) but no text sent yet (empty buffer)
        vm._test_seedStreamingBuffer(bucket: "agent-a", text: "", model: nil)
        XCTAssertTrue(vm.streamingAgentSet.contains("agent-a"))

        let container = vm._test_makeInMemoryContainer()
        vm._test_stop(modelContext: container.mainContext)

        // stop() should skip agents with empty text (no event written)
        // So after start(), streamingAgentSet should be empty
        vm._test_start(modelContext: container.mainContext)

        XCTAssertFalse(vm.streamingAgentSet.contains("agent-a"),
            "agent with empty text buffer must NOT be restored after stop/start — no incomplete event was persisted")
    }

    func test_completeOutputFallbackClearsOptimisticLoadingCard() async {
        let vm = SessionDetailViewModel.testInstance()
        vm._test_markAgentWorking()
        XCTAssertTrue(vm.isAgentWorking)

        await vm._test_armCompletedOutputSettle(bucket: "agent-a")?.value

        XCTAssertFalse(vm.isAgentWorking,
            "complete output should dismiss Agent loading even when idle is missing")
    }

    func test_followOnWorkCancelsCompleteOutputFallback() async {
        let vm = SessionDetailViewModel.testInstance()
        vm._test_markAgentWorking()
        let settle = vm._test_armCompletedOutputSettle(bucket: "agent-a")

        vm._test_markAgentWorking()
        await settle?.value

        XCTAssertTrue(vm.isAgentWorking,
            "a follow-on tool/output event should keep the loading card active")
        vm._test_markAgentDone()
    }
}
