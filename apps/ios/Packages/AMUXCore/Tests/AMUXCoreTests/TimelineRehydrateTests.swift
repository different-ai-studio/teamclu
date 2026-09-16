import Foundation
import SwiftData
import Testing
@testable import AMUXCore

@Suite("SessionDetailViewModel — rehydrate keeps every persisted field")
@MainActor
struct TimelineRehydrateTests {
    @Test("a tool's result and diff survive reopening the session")
    func toolResultAndDiffSurviveReopen() throws {
        let container = try ModelContainer(
            for: AgentEvent.self, Session.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let ctx = ModelContext(container)
        let session = Session(sessionId: "session-1", teamId: "team-1")
        ctx.insert(session)

        let tool = AgentEvent(agentId: "session-1", sequence: 5, eventType: "tool_use")
        tool.toolId = "call-1"
        tool.toolName = "edit"
        tool.senderActorID = "agent-1"
        tool.isComplete = true
        tool.success = true
        tool.resultSummary = "1 file changed"
        tool.diffPath = "README.md"
        tool.diffOldText = "old"
        tool.diffNewText = "new"
        ctx.insert(tool)
        try ctx.save()

        // Reopen: start() rebuilds the reducer state from the stored rows.
        let mqtt = MQTTService()
        let vm = SessionDetailViewModel(
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer",
            session: session
        )
        vm._test_start(modelContext: ctx)

        // Any input that changes entries projects the whole state back onto
        // the rows.
        var thinking = Amux_AcpEvent()
        var text = Amux_AcpThinking()
        text.text = "next turn"
        thinking.event = .thinking(text)
        vm._testApplyAcp(thinking, sequence: 6, agentBucketKey: "agent-1", modelContext: ctx)

        let stored = try #require(try ctx.fetch(FetchDescriptor<AgentEvent>()).first { $0.toolId == "call-1" })
        #expect(stored.resultSummary == "1 file changed")
        #expect(stored.diffPath == "README.md")
        #expect(stored.diffOldText == "old")
        #expect(stored.diffNewText == "new")
    }
}
