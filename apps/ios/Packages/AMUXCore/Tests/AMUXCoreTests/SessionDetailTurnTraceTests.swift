import Foundation
import SwiftData
import Testing
@testable import AMUXCore

private actor SeedRepository: MessagesRepository {
    let messages: [MessageRecord]
    let location: TurnTraceLocation?
    private(set) var traceRequests = 0

    init(messages: [MessageRecord], location: TurnTraceLocation?) {
        self.messages = messages
        self.location = location
    }

    func listForSession(sessionID: String) async throws -> [MessageRecord] { messages }
    func insert(_ input: MessageInsertInput) async throws {}
    func patch(messageID: String, content: String) async throws {}
    func delete(messageID: String) async throws {}
    func submitFeedback(_ input: FeedbackInput) async throws {}
    func deleteFeedback(messageID: String, actorID: String) async throws {}
    func listFeedback(sessionID: String) async throws -> [FeedbackRecord] { [] }

    func turnTrace(teamID: String, sessionID: String, turnID: String) async throws -> TurnTraceLocation? {
        traceRequests += 1
        return location
    }
}

@Suite("SessionDetailViewModel — turn traces")
@MainActor
struct SessionDetailTurnTraceTests {
    private let sessionID = "0b8f5f2a-9c3e-4d7a-8a61-2f4c3d5e6f70"
    private let tracedTurn = "7a0c7b5e-5d1c-4c55-9a53-0f1f6b0d2e11"
    private let otherTurn = "3c2d1e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f"

    private struct Harness {
        let vm: SessionDetailViewModel
        let ctx: ModelContext
        let container: ModelContainer
        let repo: SeedRepository
        let cacheDirectory: URL
    }

    private func record(_ id: String, turnID: String, content: String, at seconds: TimeInterval,
                        trace: TurnTracePointer?) -> MessageRecord {
        MessageRecord(
            id: id, teamID: "team-1", sessionID: sessionID, senderActorID: "agent-1",
            kind: "agent_reply", content: content,
            createdAt: Date(timeIntervalSince1970: seconds), updatedAt: nil, model: nil,
            turnID: turnID, replyToMessageID: nil, mentionActorIDs: [], sequence: 0,
            trace: trace
        )
    }

    private func pointer(status: String) -> TurnTracePointer {
        TurnTracePointer(key: "turns/k", size: TurnTraceFixtures.gzipSize,
                         sha256: TurnTraceFixtures.gzipSHA256, status: status)
    }

    /// Local rows for two turns: `tracedTurn` (thinking, a tool, a mid-turn
    /// reply segment, the final reply and a resolved permission) and
    /// `otherTurn` (a tool and its reply).
    private func makeHarness(traceStatus: String? = "uploaded") throws -> Harness {
        let container = try ModelContainer(
            for: AgentEvent.self, Session.self, SessionMessage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let ctx = ModelContext(container)
        let session = Session(sessionId: sessionID, teamId: "team-1")
        ctx.insert(session)

        func row(_ id: String, _ type: String, turn: String?, text: String? = nil, at seconds: TimeInterval) {
            let event = AgentEvent(agentId: sessionID, sequence: 0, eventType: type)
            event.id = id
            event.text = text
            event.turnID = turn
            event.senderActorID = type == "user_prompt" ? "me" : "agent-1"
            event.isComplete = true
            event.timestamp = Date(timeIntervalSince1970: seconds)
            ctx.insert(event)
        }
        row("prompt", "user_prompt", turn: nil, text: "run the tests", at: 1)
        row("thinking", "thinking", turn: tracedTurn, text: "hm", at: 2)
        row("tool", "tool_use", turn: tracedTurn, at: 3)
        row("segment", "output", turn: tracedTurn, text: "Let me check.", at: 4)
        row("permission", "permission_request", turn: tracedTurn, text: "Run ls -la", at: 5)
        row("final", "output", turn: tracedTurn, text: "All done.", at: 6)
        row("other-tool", "tool_use", turn: otherTurn, at: 7)
        row("other-final", "output", turn: otherTurn, text: "Second.", at: 8)
        try ctx.save()
        let permission = try #require(try ctx.fetch(FetchDescriptor<AgentEvent>()).first { $0.id == "permission" })
        permission.toolId = "perm-1"
        permission.success = true
        try ctx.save()

        let repo = SeedRepository(
            messages: [
                record("m1", turnID: tracedTurn, content: "All done.", at: 2,
                       trace: traceStatus.map { pointer(status: $0) }),
                record("m2", turnID: otherTurn, content: "Second.", at: 7, trace: nil),
            ],
            location: TurnTraceLocation(
                downloadURL: URL(string: "https://oss.example.com/k")!,
                size: TurnTraceFixtures.gzipSize,
                sha256: TurnTraceFixtures.gzipSHA256
            )
        )
        let cacheDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("vm-turn-trace-\(UUID().uuidString)", isDirectory: true)
        let loader = TurnTraceLoader(
            repository: repo,
            cache: TurnTraceCache(directory: cacheDirectory, byteLimit: 1 << 20),
            download: { url in
                (TurnTraceFixtures.gzip, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }
        )
        let mqtt = MQTTService()
        let vm = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer",
            session: session,
            messagesRepository: repo,
            turnTraceLoader: loader
        )
        vm._test_start(modelContext: ctx)
        return Harness(vm: vm, ctx: ctx, container: container, repo: repo, cacheDirectory: cacheDirectory)
    }

    @Test("the seed drops a traced turn's process rows and keeps what the feed shows")
    func prunesTracedTurn() async throws {
        let h = try makeHarness()
        defer { try? FileManager.default.removeItem(at: h.cacheDirectory) }

        await h.vm.seedFromSupabaseMessages(modelContext: h.ctx)

        let ids = Set(h.vm.events.map(\.id))
        #expect(ids == ["prompt", "permission", "final", "other-tool", "other-final"])
        #expect(h.vm.events.first { $0.id == "final" }?.supabaseMessageId == "m1")
        let stored = Set(try h.ctx.fetch(FetchDescriptor<AgentEvent>()).map(\.id))
        #expect(stored == ids, "pruned rows are deleted from SwiftData too")
    }

    @Test("a failed upload keeps the local rows — they are the only copy")
    func keepsRowsWhenUploadFailed() async throws {
        let h = try makeHarness(traceStatus: "failed")
        defer { try? FileManager.default.removeItem(at: h.cacheDirectory) }

        await h.vm.seedFromSupabaseMessages(modelContext: h.ctx)

        #expect(Set(h.vm.events.map(\.id)).isSuperset(of: ["thinking", "tool", "segment"]))
    }

    @Test("the turn detail loads the trace, carrying over how a permission was answered")
    func loadsTraceForDetail() async throws {
        let h = try makeHarness()
        defer { try? FileManager.default.removeItem(at: h.cacheDirectory) }
        await h.vm.seedFromSupabaseMessages(modelContext: h.ctx)

        await h.vm.loadTurnDetail(modelContext: h.ctx, turnID: tracedTurn, agentID: "agent-1")

        let trace = try #require(h.vm.loadedTurnTraces[tracedTurn])
        #expect(trace.events.map(\.eventType) == [
            "thinking", "output", "tool_use", "permission_request", "tool_use", "error", "output",
        ])
        #expect(trace.events.first { $0.eventType == "permission_request" }?.success == true)
        #expect(trace.droppedEvents == 3)
        #expect(!h.vm.turnTraceFallbackTurnIDs.contains(tracedTurn))
        #expect(trace.events.allSatisfy { $0.modelContext == nil }, "trace rows never enter SwiftData")

        // Second open: served from memory, FC isn't asked again.
        await h.vm.loadTurnDetail(modelContext: h.ctx, turnID: tracedTurn, agentID: "agent-1")
        #expect(await h.repo.traceRequests == 1)
    }

    @Test("a turn the seed saw fail, or one with a local-only id, falls back to the daemon")
    func fallsBackWithoutTrace() async throws {
        let h = try makeHarness(traceStatus: "failed")
        defer { try? FileManager.default.removeItem(at: h.cacheDirectory) }
        await h.vm.seedFromSupabaseMessages(modelContext: h.ctx)

        await h.vm.loadTurnDetail(modelContext: h.ctx, turnID: tracedTurn, agentID: "agent-1")
        await h.vm.loadTurnDetail(modelContext: h.ctx, turnID: "turn-final-row", agentID: "agent-1")

        #expect(h.vm.loadedTurnTraces.isEmpty)
        #expect(h.vm.turnTraceFallbackTurnIDs == [tracedTurn, "turn-final-row"])
        #expect(await h.repo.traceRequests == 0)
    }

    @Test("a stream the seed closes by trace is settled and its trace fetched ahead")
    func settlesAndPrefetchesClosedStream() async throws {
        let h = try makeHarness()
        defer { try? FileManager.default.removeItem(at: h.cacheDirectory) }
        h.vm._test_seedStreamingBuffer(bucket: "agent-1", text: "Let me check.", turnID: tracedTurn)

        await h.vm.seedFromSupabaseMessages(modelContext: h.ctx)

        #expect(h.vm.streamingAgentSet.isEmpty, "nothing left for the reconnect replay to ask the daemon")
        #expect(h.vm.streamingTextByAgent.isEmpty)
        for _ in 0..<100 where await h.repo.traceRequests == 0 {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(await h.repo.traceRequests == 1)
    }
}
