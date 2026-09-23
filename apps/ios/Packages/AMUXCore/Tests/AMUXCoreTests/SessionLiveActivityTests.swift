import XCTest
@testable import AMUXCore

/// The session list's dot, reduced from `session/{id}/live`.
///
/// Everything here is the pure half — no MQTT, no SwiftData — so the state
/// machine is pinned independently of the subscription plumbing around it.
final class SessionLiveActivityTests: XCTestCase {

    // MARK: - State machine

    func testQuietByDefault() {
        let state = SessionActivityState()
        XCTAssertEqual(state.activity, .quiet)
        XCTAssertFalse(state.isRunning)
    }

    func testTurnStartRunsAndTurnEndStops() {
        var state = SessionActivityState()
        state.apply(.turnStarted, at: .now)
        XCTAssertEqual(state.activity, .running)
        state.apply(.turnEnded, at: .now)
        XCTAssertEqual(state.activity, .quiet)
    }

    func testMidTurnTrafficImpliesRunning() {
        // Daemons don't always emit a leading statusChange — a turn can open
        // with its first output delta.
        var state = SessionActivityState()
        state.apply(.progress, at: .now)
        XCTAssertEqual(state.activity, .running)
    }

    func testPendingRequestOutranksRunning() {
        var state = SessionActivityState()
        state.apply(.turnStarted, at: .now)
        state.apply(.attentionRequested(id: "req-1"), at: .now)
        XCTAssertEqual(state.activity, .needsAttention)
    }

    func testResolvingOneOfTwoRequestsKeepsTheDotRed() {
        var state = SessionActivityState()
        state.apply(.attentionRequested(id: "req-1"), at: .now)
        state.apply(.attentionRequested(id: "req-2"), at: .now)
        state.apply(.attentionResolved(id: "req-1"), at: .now)
        XCTAssertEqual(state.activity, .needsAttention)
        state.apply(.attentionResolved(id: "req-2"), at: .now)
        // The turn resumes once the last request is answered.
        XCTAssertEqual(state.activity, .running)
    }

    func testResolvingAnUnknownRequestIsHarmless() {
        var state = SessionActivityState()
        state.apply(.turnStarted, at: .now)
        state.apply(.attentionResolved(id: "never-seen"), at: .now)
        XCTAssertEqual(state.activity, .running)
    }

    func testEmptyRequestIDIsIgnored() {
        // A malformed payload must not park the dot on red with a key no
        // resolve event can ever match.
        var state = SessionActivityState()
        state.apply(.attentionRequested(id: ""), at: .now)
        XCTAssertEqual(state.activity, .quiet)
    }

    func testIdleChatterOnlyMovesTheClock() {
        var state = SessionActivityState()
        let early = Date(timeIntervalSince1970: 1_000)
        state.apply(.idleChatter, at: early)
        XCTAssertEqual(state.activity, .quiet)
        XCTAssertEqual(state.lastSignalAt, early)
    }

    // MARK: - Watchdog

    func testStaleRunExpires() {
        var state = SessionActivityState()
        let start = Date(timeIntervalSince1970: 1_000)
        state.apply(.turnStarted, at: start)
        XCTAssertFalse(state.expireStaleRun(now: start.addingTimeInterval(30), timeout: 90))
        XCTAssertEqual(state.activity, .running)
        XCTAssertTrue(state.expireStaleRun(now: start.addingTimeInterval(120), timeout: 90))
        XCTAssertEqual(state.activity, .quiet)
    }

    func testPendingRequestIsExemptFromTheWatchdog() {
        // A turn blocked on a person is silent by definition; expiring it
        // would clear the one dot that matters.
        var state = SessionActivityState()
        let start = Date(timeIntervalSince1970: 1_000)
        state.apply(.attentionRequested(id: "req-1"), at: start)
        XCTAssertFalse(state.expireStaleRun(now: start.addingTimeInterval(9_000), timeout: 90))
        XCTAssertEqual(state.activity, .needsAttention)
    }

    func testHotWhileRunningPendingOrRecentlyNoisy() {
        let start = Date(timeIntervalSince1970: 1_000)
        let later = start.addingTimeInterval(300)

        var quiet = SessionActivityState()
        quiet.apply(.idleChatter, at: start)
        XCTAssertTrue(quiet.isHot(now: start.addingTimeInterval(10), quietGrace: 120))
        XCTAssertFalse(quiet.isHot(now: later, quietGrace: 120))

        var running = SessionActivityState()
        running.apply(.turnStarted, at: start)
        XCTAssertTrue(running.isHot(now: later, quietGrace: 120))

        var pending = SessionActivityState()
        pending.apply(.attentionRequested(id: "req-1"), at: start)
        XCTAssertTrue(pending.isHot(now: later, quietGrace: 120))
    }

    // MARK: - Envelope decoding

    private func liveEnvelope(_ acp: Amux_AcpEvent) throws -> Teamclu_LiveEventEnvelope {
        var amux = Amux_Envelope()
        amux.payload = .acpEvent(acp)
        var live = Teamclu_LiveEventEnvelope()
        live.eventType = "acp.event"
        live.body = try amux.serializedData()
        return live
    }

    private func liveEnvelope(_ session: Amux_SessionEvent) throws -> Teamclu_LiveEventEnvelope {
        var amux = Amux_Envelope()
        amux.payload = .sessionEvent(session)
        var live = Teamclu_LiveEventEnvelope()
        live.eventType = "acp.event"
        live.body = try amux.serializedData()
        return live
    }

    func testStatusChangeDecoding() throws {
        func signal(for status: Amux_AgentStatus) throws -> SessionLiveSignal? {
            var change = Amux_AcpStatusChange()
            change.newStatus = status
            var acp = Amux_AcpEvent()
            acp.event = .statusChange(change)
            return SessionLiveSignalDecoder.signal(from: try liveEnvelope(acp))
        }

        XCTAssertEqual(try signal(for: .active), .turnStarted)
        XCTAssertEqual(try signal(for: .idle), .turnEnded)
        XCTAssertEqual(try signal(for: .stopped), .turnEnded)
        XCTAssertEqual(try signal(for: .error), .turnEnded)
        // Spinning the host up is not a turn.
        XCTAssertEqual(try signal(for: .starting), .idleChatter)
    }

    func testPermissionRequestAndResolveDecoding() throws {
        var request = Amux_AcpPermissionRequest()
        request.requestID = "perm-7"
        var acp = Amux_AcpEvent()
        acp.event = .permissionRequest(request)
        XCTAssertEqual(
            SessionLiveSignalDecoder.signal(from: try liveEnvelope(acp)),
            .attentionRequested(id: "perm-7")
        )

        var resolved = Amux_PermissionResolved()
        resolved.requestID = "perm-7"
        var session = Amux_SessionEvent()
        session.event = .permissionResolved(resolved)
        XCTAssertEqual(
            SessionLiveSignalDecoder.signal(from: try liveEnvelope(session)),
            .attentionResolved(id: "perm-7")
        )
    }

    func testQuestionAskedAndAnsweredDecoding() throws {
        func raw(_ method: String, _ json: String) throws -> SessionLiveSignal? {
            var rawEvent = Amux_AcpRawJson()
            rawEvent.method = method
            rawEvent.jsonPayload = Data(json.utf8)
            var acp = Amux_AcpEvent()
            acp.event = .raw(rawEvent)
            return SessionLiveSignalDecoder.signal(from: try liveEnvelope(acp))
        }

        // `question_asked` keys the id as `id`…
        XCTAssertEqual(
            try raw("question_asked", #"{"id":"q-1","questions":[]}"#),
            .attentionRequested(id: "q-1")
        )
        // …the replies use `requestID`, falling back to `id`.
        XCTAssertEqual(
            try raw("question_replied", #"{"requestID":"q-1"}"#),
            .attentionResolved(id: "q-1")
        )
        XCTAssertEqual(
            try raw("question_rejected", #"{"id":"q-1"}"#),
            .attentionResolved(id: "q-1")
        )
        // An unparseable payload must not strand the dot.
        XCTAssertEqual(try raw("question_asked", "not json"), .idleChatter)
        // An unrelated raw event is chatter, not a crash.
        XCTAssertEqual(try raw("tool_title_update", "id|New title"), .idleChatter)
    }

    func testDeltaEventsAreProgress() throws {
        var output = Amux_AcpOutput()
        output.text = "hello"
        var acp = Amux_AcpEvent()
        acp.event = .output(output)
        XCTAssertEqual(SessionLiveSignalDecoder.signal(from: try liveEnvelope(acp)), .progress)

        var tool = Amux_AcpToolUse()
        tool.toolName = "bash"
        var toolEvent = Amux_AcpEvent()
        toolEvent.event = .toolUse(tool)
        XCTAssertEqual(
            SessionLiveSignalDecoder.signal(from: try liveEnvelope(toolEvent)),
            .progress
        )
    }

    func testMessageCreatedIsChatterNotProgress() {
        // The agent's reply is published at turn *end*. Treating it as
        // progress would re-open a turn that just closed and leave the dot
        // green until the watchdog fires.
        var live = Teamclu_LiveEventEnvelope()
        live.eventType = "message.created"
        live.body = Data()
        XCTAssertEqual(SessionLiveSignalDecoder.signal(from: live), .idleChatter)
    }

    func testUndecodableACPBodyYieldsNil() {
        var live = Teamclu_LiveEventEnvelope()
        live.eventType = "acp.event"
        live.body = Data([0xFF, 0xFF, 0xFF, 0xFF])
        XCTAssertNil(SessionLiveSignalDecoder.signal(from: live))
    }

    // MARK: - Store surface

    @MainActor
    func testStoreOnlyPublishesLitSessions() {
        // `litSessions` is what SwiftUI observes, and the session list's body
        // is expensive. A quiet session must not hold an entry, so a turn
        // ending is one re-render rather than a permanent subscription to
        // every row's churn.
        let store = SessionLiveActivityStore()
        XCTAssertEqual(store.activity(for: "sess-1"), .quiet)
        XCTAssertTrue(store.litSessions.isEmpty)

        store.noteLocalPrompt(sessionID: "sess-1")
        XCTAssertEqual(store.activity(for: "sess-1"), .running)
        XCTAssertEqual(store.litSessions, ["sess-1": .running])

        // Chatter on an untouched session stays quiet and unpublished.
        store.noteActivity(sessionID: "sess-2")
        XCTAssertEqual(store.activity(for: "sess-2"), .quiet)
        XCTAssertNil(store.litSessions["sess-2"])
    }

    @MainActor
    func testStoreIgnoresEmptySessionIDs() {
        let store = SessionLiveActivityStore()
        store.noteLocalPrompt(sessionID: "")
        store.noteActivity(sessionID: "")
        XCTAssertTrue(store.litSessions.isEmpty)
    }

    // MARK: - Topic parsing

    func testSessionLiveTopicParsing() {
        XCTAssertEqual(
            SessionLiveActivityStore.parseSessionLiveTopic(
                "amux/team1/session/sess-1/live", teamID: "team1"
            ),
            "sess-1"
        )
        // Team-less devices ride the fallback id, same as the daemon.
        XCTAssertEqual(
            SessionLiveActivityStore.parseSessionLiveTopic(
                "amux/teamclaw/session/sess-1/live", teamID: ""
            ),
            "sess-1"
        )
        XCTAssertNil(
            SessionLiveActivityStore.parseSessionLiveTopic(
                "amux/other/session/sess-1/live", teamID: "team1"
            )
        )
        XCTAssertNil(
            SessionLiveActivityStore.parseSessionLiveTopic(
                "amux/team1/actor-9/state", teamID: "team1"
            )
        )
        XCTAssertNil(
            SessionLiveActivityStore.parseSessionLiveTopic(
                "amux/team1/session//live", teamID: "team1"
            )
        )
    }
}
