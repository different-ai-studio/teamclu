import Foundation
import Testing
@testable import AMUXCore

// MARK: - Gzip

@Suite("GzipDecoder")
struct GzipDecoderTests {
    @Test("decodes a gzip member written by another encoder")
    func decodesPlainMember() throws {
        let out = try GzipDecoder.decompress(TurnTraceFixtures.gzip, maxOutputBytes: 1 << 20)
        #expect(out == TurnTraceFixtures.jsonl)
    }

    @Test("skips FNAME, and FEXTRA + FCOMMENT + FHCRC together")
    func skipsOptionalHeaderFields() throws {
        for base64 in [TurnTraceFixtures.gzipWithFileNameBase64, TurnTraceFixtures.gzipWithAllHeaderFieldsBase64] {
            let data = try #require(Data(base64Encoded: base64))
            #expect(try GzipDecoder.decompress(data, maxOutputBytes: 1 << 20) == TurnTraceFixtures.jsonl)
        }
    }

    @Test("rejects a stream cut short instead of looping or returning a prefix")
    func rejectsTruncatedStream() {
        let gz = TurnTraceFixtures.gzip
        let truncated = gz.prefix(gz.count / 2) + gz.suffix(8)
        #expect(throws: TurnTraceError.malformedGzip) {
            try GzipDecoder.decompress(Data(truncated), maxOutputBytes: 1 << 20)
        }
    }

    @Test("rejects bytes that aren't gzip")
    func rejectsNonGzip() {
        #expect(throws: TurnTraceError.malformedGzip) {
            try GzipDecoder.decompress(TurnTraceFixtures.jsonl, maxOutputBytes: 1 << 20)
        }
    }

    @Test("stops at the output limit")
    func enforcesOutputLimit() {
        #expect(throws: TurnTraceError.tooLarge) {
            try GzipDecoder.decompress(TurnTraceFixtures.gzip, maxOutputBytes: 64)
        }
    }
}

// MARK: - Parser

@Suite("TurnTraceParser")
struct TurnTraceParserTests {
    private let turnID = "7a0c7b5e-5d1c-4c55-9a53-0f1f6b0d2e11"

    @Test("projects every line type into the entries the detail view renders")
    func projectsLines() throws {
        let detail = TurnTraceParser.parse(TurnTraceFixtures.jsonl, turnID: turnID, senderActorID: "agent-1")
        let entries = detail.entries

        #expect(entries.map(\.eventType) == [
            "thinking", "output", "tool_use", "permission_request", "tool_use", "error", "output",
        ])
        #expect(entries.allSatisfy { $0.senderActorID == "agent-1" && $0.turnID == turnID })
        #expect(entries.map(\.id).first == "trace:\(turnID):2", "ids are stable per turn_seq")
        #expect(detail.droppedEvents == 3)

        #expect(entries[0].text == "Let me look at the repo.")
        #expect(entries[0].model == "claude-sonnet-5")
        #expect(entries[0].timestamp == Date(timeIntervalSince1970: 1_789_000_000.1))
        #expect(entries[1].text == "Checking the tests first.")

        // Both tool_call lines and the tool_result fold into one card, with
        // the tool's input — which live events never carry — as its text.
        let bash = entries[2]
        #expect(bash.toolID == "call-1")
        #expect(bash.toolName == "bash")
        #expect(bash.isComplete)
        #expect(bash.success == true)
        #expect(bash.resultSummary == "total 8\ndrwxr-xr-x  3 me  staff  96 .")
        let input = try #require(bash.text?.data(using: .utf8))
        let object = try #require(try JSONSerialization.jsonObject(with: input) as? [String: Any])
        #expect(object["command"] as? String == "ls -la")
        #expect(object["timeout"] as? Int == 30)

        #expect(entries[3].toolID == "perm-1")
        #expect(entries[3].toolName == "bash")
        #expect(entries[3].text == "Run ls -la")

        // A result whose tool_call fell past the budget still gets a card.
        #expect(entries[4].toolID == "call-2")
        #expect(entries[4].success == false)
        #expect(entries[4].resultSummary == "No such file")

        #expect(entries[5].text == "rate limited")
        #expect(entries[6].text == "All tests pass.\n…", "a capped text run says so")
    }

    @Test("a tool still pending when the turn ended is shown as finished, outcome unknown")
    func pendingToolIsClosed() {
        let jsonl = Data(#"{"turn_seq":1,"type":"tool_call","ts_ms":1,"tool_id":"t","tool_name":"read","tool_kind":"read","status":"in_progress","raw_input":"README.md"}"#.utf8)
        let entries = TurnTraceParser.parse(jsonl, turnID: turnID, senderActorID: "a").entries
        #expect(entries.count == 1)
        #expect(entries[0].isComplete)
        #expect(entries[0].success == nil)
        #expect(entries[0].text == "README.md")
    }
}

// MARK: - Loader + cache

private actor TraceRepository: MessagesRepository {
    var location: TurnTraceLocation?
    private(set) var traceRequests = 0

    init(location: TurnTraceLocation?) { self.location = location }

    func listForSession(sessionID: String) async throws -> [MessageRecord] { [] }
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

private actor DownloadCounter {
    private(set) var count = 0
    func increment() { count += 1 }
}

@Suite("TurnTraceLoader")
struct TurnTraceLoaderTests {
    private let sessionID = "0b8f5f2a-9c3e-4d7a-8a61-2f4c3d5e6f70"
    private let turnID = "7a0c7b5e-5d1c-4c55-9a53-0f1f6b0d2e11"
    private let downloadURL = URL(string: "https://oss.example.com/turns/trace.jsonl.gz?sig=1")!

    private func makeCache(byteLimit: Int = 1 << 20) -> (TurnTraceCache, URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("turn-trace-tests-\(UUID().uuidString)", isDirectory: true)
        return (TurnTraceCache(directory: dir, byteLimit: byteLimit), dir)
    }

    private func location(sha256: String = TurnTraceFixtures.gzipSHA256) -> TurnTraceLocation {
        TurnTraceLocation(downloadURL: downloadURL, size: TurnTraceFixtures.gzipSize, sha256: sha256)
    }

    private func download(_ counter: DownloadCounter, body: Data = TurnTraceFixtures.gzip) -> TurnTraceLoader.Download {
        { url in
            await counter.increment()
            return (body, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
    }

    @Test("downloads, verifies and caches once; the next load never leaves the device")
    func cachesAfterFirstLoad() async throws {
        let (cache, dir) = makeCache()
        defer { try? FileManager.default.removeItem(at: dir) }
        let repo = TraceRepository(location: location())
        let counter = DownloadCounter()
        let loader = TurnTraceLoader(repository: repo, cache: cache, download: download(counter))

        let first = try await loader.load(teamID: "team", sessionID: sessionID, turnID: turnID, senderActorID: "agent")
        let second = try await loader.load(teamID: "team", sessionID: sessionID, turnID: turnID, senderActorID: "agent")

        #expect(first?.entries.count == 7)
        #expect(second == first)
        #expect(await repo.traceRequests == 1)
        #expect(await counter.count == 1)
    }

    @Test("a download that doesn't match the recorded digest is rejected and not cached")
    func rejectsDigestMismatch() async throws {
        let (cache, dir) = makeCache()
        defer { try? FileManager.default.removeItem(at: dir) }
        let repo = TraceRepository(location: location(sha256: String(repeating: "0", count: 64)))
        let loader = TurnTraceLoader(repository: repo, cache: cache, download: download(DownloadCounter()))

        await #expect(throws: TurnTraceError.integrityMismatch) {
            try await loader.load(teamID: "team", sessionID: sessionID, turnID: turnID, senderActorID: "agent")
        }
        #expect(await cache.read(sessionID: sessionID, turnID: turnID) == nil)
    }

    @Test("no uploaded trace is nil, and a non-UUID turn id never reaches FC")
    func missingTrace() async throws {
        let (cache, dir) = makeCache()
        defer { try? FileManager.default.removeItem(at: dir) }
        let repo = TraceRepository(location: nil)
        let loader = TurnTraceLoader(repository: repo, cache: cache, download: download(DownloadCounter()))

        #expect(try await loader.load(teamID: "team", sessionID: sessionID, turnID: turnID, senderActorID: "a") == nil)
        #expect(try await loader.load(teamID: "team", sessionID: sessionID, turnID: "turn-local-1", senderActorID: "a") == nil)
        #expect(await repo.traceRequests == 1)
    }

    @Test("a damaged cached blob is replaced by a fresh download")
    func replacesDamagedCacheEntry() async throws {
        let (cache, dir) = makeCache()
        defer { try? FileManager.default.removeItem(at: dir) }
        await cache.write(Data("not gzip".utf8), sessionID: sessionID, turnID: turnID)
        let counter = DownloadCounter()
        let loader = TurnTraceLoader(repository: TraceRepository(location: location()), cache: cache, download: download(counter))

        let detail = try await loader.load(teamID: "team", sessionID: sessionID, turnID: turnID, senderActorID: "a")
        #expect(detail?.entries.isEmpty == false)
        #expect(await counter.count == 1)
        #expect(await cache.read(sessionID: sessionID, turnID: turnID) == TurnTraceFixtures.gzip)
    }

    @Test("prefetch fills the cache without decoding, and skips what's already there")
    func prefetchFillsCache() async throws {
        let (cache, dir) = makeCache()
        defer { try? FileManager.default.removeItem(at: dir) }
        let counter = DownloadCounter()
        let loader = TurnTraceLoader(repository: TraceRepository(location: location()), cache: cache, download: download(counter))

        await loader.prefetch(teamID: "team", sessionID: sessionID, turnID: turnID)
        await loader.prefetch(teamID: "team", sessionID: sessionID, turnID: turnID)

        #expect(await counter.count == 1)
        #expect(await cache.read(sessionID: sessionID, turnID: turnID) == TurnTraceFixtures.gzip)
    }

    @Test("the cache evicts least recently used blobs past its budget")
    func evictsLeastRecentlyUsed() async throws {
        let (cache, dir) = makeCache(byteLimit: 250)
        defer { try? FileManager.default.removeItem(at: dir) }
        let blob = Data(repeating: 1, count: 100)
        let turns = (0..<3).map { _ in UUID().uuidString.lowercased() }

        await cache.write(blob, sessionID: sessionID, turnID: turns[0])
        try await Task.sleep(for: .milliseconds(20))
        await cache.write(blob, sessionID: sessionID, turnID: turns[1])
        try await Task.sleep(for: .milliseconds(20))
        _ = await cache.read(sessionID: sessionID, turnID: turns[0]) // now the newest use
        try await Task.sleep(for: .milliseconds(20))
        await cache.write(blob, sessionID: sessionID, turnID: turns[2])

        #expect(await cache.read(sessionID: sessionID, turnID: turns[0]) != nil)
        #expect(await cache.read(sessionID: sessionID, turnID: turns[1]) == nil)
        #expect(await cache.read(sessionID: sessionID, turnID: turns[2]) != nil)
    }

    @Test("ids that aren't UUIDs never become file names")
    func refusesNonUUIDKeys() async {
        let (cache, dir) = makeCache()
        defer { try? FileManager.default.removeItem(at: dir) }
        await cache.write(Data("x".utf8), sessionID: "../../escape", turnID: turnID)
        #expect(!FileManager.default.fileExists(atPath: dir.path))
    }
}

// MARK: - Cloud API

@Suite("Cloud API turn traces")
struct CloudAPITurnTraceTests {
    private func client(_ handler: @escaping @Sendable (URLRequest) throws -> (Data, HTTPURLResponse)) -> CloudAPIClient {
        CloudAPIClient(
            configuration: CloudAPIConfiguration(baseURL: URL(string: "https://fc.example.com")!),
            accessToken: { "access-token" },
            send: { try handler($0) }
        )
    }

    private static func reply(_ request: URLRequest, _ json: String, status: Int = 200) -> (Data, HTTPURLResponse) {
        (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    @Test("messages carry metadata.trace, and a malformed pointer doesn't sink the page")
    func decodesTracePointer() async throws {
        let repo = CloudAPIMessagesRepository(client: client { request in
            Self.reply(request, """
            {"items": [
              {"id": "m1", "teamId": "t", "sessionId": "s", "turnId": "turn-1", "senderActorId": "agent",
               "replyToMessageId": null, "kind": "agent_reply", "content": "done", "model": null,
               "metadata": {"sequence": 4, "trace": {"key": "turns/k.jsonl.gz", "size": 934, "sha256": "df94", "status": "uploaded"}},
               "createdAt": "2026-09-16T10:00:00Z", "updatedAt": null},
              {"id": "m2", "teamId": "t", "sessionId": "s", "turnId": "turn-2", "senderActorId": "agent",
               "replyToMessageId": null, "kind": "agent_reply", "content": "done", "model": null,
               "metadata": {"trace": {"status": 7}, "mention_actor_ids": ["a"]},
               "createdAt": "2026-09-16T10:01:00Z", "updatedAt": null}
            ], "nextCursor": null}
            """)
        })

        let messages = try await repo.listForSession(sessionID: "s")
        #expect(messages.first?.trace == TurnTracePointer(key: "turns/k.jsonl.gz", size: 934, sha256: "df94", status: "uploaded"))
        #expect(messages.last?.trace == nil)
        #expect(messages.last?.mentionActorIDs == ["a"])
    }

    @Test("GET …/turns/:turnId/trace with teamId; 404 means no trace")
    func fetchesTraceLocation() async throws {
        let seen = LockedURLs()
        let repo = CloudAPIMessagesRepository(client: client { request in
            seen.append(request.url!)
            if request.url!.path.hasSuffix("/turns/turn-404/trace") {
                return Self.reply(request, #"{"error": {"code": "not_found", "message": "turn trace not found"}}"#, status: 404)
            }
            return Self.reply(request, """
            {"ossKey": "turns/k", "downloadUrl": "https://oss.example.com/k?sig=1", "expiresIn": 900, "size": 934, "sha256": "df94"}
            """)
        })

        let location = try await repo.turnTrace(teamID: "team-1", sessionID: "s-1", turnID: "turn-1")
        #expect(location == TurnTraceLocation(downloadURL: URL(string: "https://oss.example.com/k?sig=1")!, size: 934, sha256: "df94"))
        #expect(try await repo.turnTrace(teamID: "team-1", sessionID: "s-1", turnID: "turn-404") == nil)

        let first = try #require(seen.urls.first)
        #expect(first.path == "/v1/sessions/s-1/turns/turn-1/trace")
        #expect(first.query == "teamId=team-1")
    }
}

private final class LockedURLs: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [URL] = []
    var urls: [URL] { lock.withLock { stored } }
    func append(_ url: URL) { lock.withLock { stored.append(url) } }
}

// MARK: - Reducer

@Suite("ChatTimelineReducer — history rows that close a turn")
struct ReducerTraceClosesTurnTests {
    private func streamingState(turnID: String) -> TimelineState {
        var state = TimelineState()
        state.entries = [
            TimelineEntry(id: "tool", eventType: "tool_use", toolID: "call-1", isComplete: false,
                          senderActorID: "agent-1", timestamp: Date(timeIntervalSince1970: 10), turnID: turnID),
        ]
        state.streamingAgentSet = ["agent-1"]
        // The text before the tool call — not a prefix of the final reply.
        state.streamingTextByAgent = ["agent-1": "Let me check."]
        state.streamingTurnIDByAgent = ["agent-1": turnID]
        return state
    }

    private func reply(turnID: String, closesTurn: Bool) -> TimelineInput {
        .historyMessage(HistoryInput(
            supabaseMessageID: "m1", kind: .output, senderActorID: "agent-1",
            content: "All done.", createdAt: Date(timeIntervalSince1970: 5),
            turnID: turnID, closesTurn: closesTurn
        ))
    }

    @Test("a reply with a trace pointer ends its turn even when the partial isn't a prefix")
    func closesMatchingTurn() {
        var state = streamingState(turnID: "turn-1")
        ChatTimelineReducer.apply(reply(turnID: "turn-1", closesTurn: true), to: &state)

        #expect(state.streamingAgentSet.isEmpty)
        #expect(state.streamingTextByAgent["agent-1"] == nil)
        #expect(state.streamingTurnIDByAgent["agent-1"] == nil)
        #expect(state.entries.first(where: { $0.id == "tool" })?.isComplete == true)
    }

    @Test("without a pointer the old prefix rule still decides")
    func keepsStreamWithoutPointer() {
        var state = streamingState(turnID: "turn-1")
        ChatTimelineReducer.apply(reply(turnID: "turn-1", closesTurn: false), to: &state)
        #expect(state.streamingAgentSet == ["agent-1"])
    }

    @Test("a pointer for another turn leaves the running turn alone")
    func ignoresOtherTurn() {
        var state = streamingState(turnID: "turn-2")
        ChatTimelineReducer.apply(reply(turnID: "turn-1", closesTurn: true), to: &state)
        #expect(state.streamingAgentSet == ["agent-1"])
        #expect(state.entries.first(where: { $0.id == "tool" })?.isComplete == false)
    }
}

// MARK: - Splicing a trace onto local rows

@Suite("LoadedTurnTrace.merged(withLocal:)")
struct LoadedTurnTraceMergeTests {

    private func event(
        _ id: String,
        _ eventType: String,
        at offset: TimeInterval,
        isComplete: Bool = true
    ) -> AgentEvent {
        let e = AgentEvent(agentId: "scope", sequence: Int(offset), eventType: eventType)
        e.id = id
        e.isComplete = isComplete
        e.timestamp = Date(timeIntervalSince1970: 1_700_000_000 + offset)
        return e
    }

    @Test("local rows inside the trace's span are dropped, not reconciled")
    func dropsOverlappingLocalRows() {
        let trace = LoadedTurnTrace(
            events: [event("t1", "thinking", at: 1), event("t2", "output", at: 2)],
            droppedEvents: 0
        )
        // The same thinking the trace already holds, as the finer-grained
        // local copy. Merging these by content is what produced the
        // duplicated-head-plus-fragments rows.
        let local = [event("l1", "thinking", at: 1), event("l2", "output", at: 2)]

        let merged = trace.merged(withLocal: local)

        #expect(merged.map(\.id) == ["t1", "t2"])
    }

    @Test("rows past the trace's last event are spliced on in order")
    func splicesTheTail() {
        let trace = LoadedTurnTrace(
            events: [event("t1", "thinking", at: 1)],
            droppedEvents: 4
        )
        let local = [
            event("l-early", "thinking", at: 1),
            event("l-late", "tool_use", at: 5),
            event("l-later", "output", at: 9),
        ]

        let merged = trace.merged(withLocal: local)

        #expect(merged.map(\.id) == ["t1", "l-late", "l-later"])
    }

    @Test("a trimmed trace that lost the reply keeps the local one regardless of its timestamp")
    func keepsTheReplyATrimmedTraceLost() {
        // The local reply carries the turn's START time (Supabase
        // `created_at`), so it never clears the boundary on its own.
        let trace = LoadedTurnTrace(
            events: [event("t1", "thinking", at: 4)],
            droppedEvents: 2
        )
        let local = [event("reply", "output", at: 1)]

        let merged = trace.merged(withLocal: local)

        #expect(merged.map(\.id) == ["t1", "reply"])
    }

    @Test("a trace that already carries the reply doesn't take the local copy too")
    func doesNotDoubleTheReply() {
        let trace = LoadedTurnTrace(
            events: [event("t1", "thinking", at: 4), event("t-reply", "output", at: 6)],
            droppedEvents: 0
        )
        let local = [event("reply", "output", at: 1)]

        let merged = trace.merged(withLocal: local)

        #expect(merged.map(\.id) == ["t1", "t-reply"])
    }

    @Test("an empty trace falls back to the local rows in order")
    func emptyTraceFallsBack() {
        let trace = LoadedTurnTrace(events: [], droppedEvents: 0)
        let local = [event("b", "output", at: 5), event("a", "thinking", at: 1)]

        #expect(trace.merged(withLocal: local).map(\.id) == ["a", "b"])
    }
}
