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

@Suite("SessionDetailViewModel — tool title updates")
@MainActor
struct ToolTitleUpdateTests {
    @Test("a renamed tool keeps its new title through the next sync")
    func renamedToolSurvivesSync() throws {
        let container = try ModelContainer(
            for: AgentEvent.self, Session.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let ctx = ModelContext(container)
        let session = Session(sessionId: "session-1", teamId: "team-1")
        ctx.insert(session)
        let mqtt = MQTTService()
        let vm = SessionDetailViewModel(
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer",
            session: session
        )
        vm._test_start(modelContext: ctx)

        var toolUse = Amux_AcpToolUse()
        toolUse.toolID = "call-1"
        toolUse.toolName = "bash"
        var use = Amux_AcpEvent()
        use.event = .toolUse(toolUse)
        vm._testHandleAcp(use, sequence: 1, runtimeID: "agent-1", modelContext: ctx)

        var rename = Amux_AcpRawJson()
        rename.method = "tool_title_update"
        rename.jsonPayload = Data("call-1|Run the tests".utf8)
        var raw = Amux_AcpEvent()
        raw.event = .raw(rename)
        vm._testHandleAcp(raw, sequence: 2, runtimeID: "agent-1", modelContext: ctx)
        #expect(vm.events.first { $0.toolId == "call-1" }?.toolName == "Run the tests")

        // The next input that changes entries syncs the reducer state onto
        // the rows.
        var thinking = Amux_AcpEvent()
        var text = Amux_AcpThinking()
        text.text = "checking"
        thinking.event = .thinking(text)
        vm._testHandleAcp(thinking, sequence: 3, runtimeID: "agent-1", modelContext: ctx)

        let stored = try #require(try ctx.fetch(FetchDescriptor<AgentEvent>()).first { $0.toolId == "call-1" })
        #expect(stored.toolName == "Run the tests")
    }
}
