import XCTest
import SwiftData
@testable import AMUXCore

@MainActor
final class LocalSearchTests: XCTestCase {
    private func message(_ text: String) -> FeedItem {
        let e = AgentEvent(agentId: "s", sequence: 0, eventType: "user_prompt")
        e.text = text
        return .userMessage(e)
    }

    private func reply(_ id: String, _ text: String) -> FeedItem {
        let e = AgentEvent(agentId: "s", sequence: 0, eventType: "output")
        e.text = text
        return .completedTurn(id: id, agentID: "a", finalEvent: e, runtimeEvents: [])
    }

    func testFindsMessagesAndRepliesInOrderIgnoringCase() {
        let a = message("Deploy failed again")
        let b = reply("t1", "The deploy needs a retry")
        let c = message("lunch?")
        XCTAssertEqual([a, b, c].feedItemIDs(matching: "DEPLOY"), [a.id, "t1"])
    }

    func testBlankQueryMatchesNothing() {
        XCTAssertEqual([message("anything")].feedItemIDs(matching: "  "), [])
    }

    func testMentionsMatchAsDisplayed() {
        let m = message("[Mentioned agents: oect-matt]\n\nhello")
        XCTAssertEqual([m].feedItemIDs(matching: "hello"), [m.id])
    }

    func testListSearchFindsSessionsByCachedMessageText() throws {
        let container = try ModelContainer(
            for: Session.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = container.mainContext
        let hit = AgentEvent(agentId: "session-a", sequence: 0, eventType: "output")
        hit.text = "the flaky test is in the outbox"
        let miss = AgentEvent(agentId: "session-b", sequence: 0, eventType: "output")
        miss.text = "nothing here"
        context.insert(hit)
        context.insert(miss)
        let vm = SessionListViewModel()
        vm.searchText = "outbox"
        vm.updateContentSearch(modelContext: context)
        XCTAssertEqual(vm.contentMatchSessionIDs, ["session-a"])

        vm.searchText = "o"
        vm.updateContentSearch(modelContext: context)
        XCTAssertTrue(vm.contentMatchSessionIDs.isEmpty, "one character is too broad")
        withExtendedLifetime(container) {}
    }
}
