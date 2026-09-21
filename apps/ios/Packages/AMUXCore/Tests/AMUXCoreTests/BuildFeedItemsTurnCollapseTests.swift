import XCTest
@testable import AMUXCore

/// Coverage for the per-turn collapse rule documented on `AgentEvent.turnID`:
/// "buildFeedItems uses this to bundle them under a single .completedTurn".
/// The daemon flushes a single logical agent turn as multiple
/// `output{isComplete=true}` rows when a ToolUse cuts the stream mid-turn.
/// The chat feed must surface ONE bubble per turn — text+tool+text becomes
/// one `.completedTurn` whose `finalEvent` is the latest output and whose
/// `runtimeEvents` carry the earlier output plus the intervening tool.
final class BuildFeedItemsTurnCollapseTests: XCTestCase {

    private func makeEvent(
        sequence: Int,
        eventType: String,
        text: String? = nil,
        toolName: String? = nil,
        toolId: String? = nil,
        isComplete: Bool = false,
        sender: String = "agent-a",
        turnID: String? = nil
    ) -> AgentEvent {
        let e = AgentEvent(agentId: "scope", sequence: sequence, eventType: eventType)
        e.text = text
        e.toolName = toolName
        e.toolId = toolId
        e.isComplete = isComplete
        e.senderActorID = sender
        e.turnID = turnID
        e.timestamp = Date(timeIntervalSince1970: TimeInterval(1_700_000_000 + sequence))
        return e
    }

    // MARK: - Same-turn collapse

    func test_textThenToolThenText_sameTurn_collapsesToOneBubble() {
        let prompt = makeEvent(sequence: 1, eventType: "user_prompt", text: "Ok", sender: "user")
        let text1  = makeEvent(sequence: 2, eventType: "output", text: "First half.", isComplete: true, turnID: "T1")
        let tool   = makeEvent(sequence: 3, eventType: "tool_use", toolName: "Bash", toolId: "tool-1", isComplete: true, turnID: "T1")
        let text2  = makeEvent(sequence: 4, eventType: "output", text: "Second half.", isComplete: true, turnID: "T1")

        let feed = buildFeedItems([prompt, text1, tool, text2])

        XCTAssertEqual(feed.count, 2, "expected userMessage + one collapsed completedTurn")

        guard case .userMessage = feed[0] else {
            return XCTFail("first item should be userMessage")
        }
        guard case let .completedTurn(_, agentID, finalEvent, runtimeEvents) = feed[1] else {
            return XCTFail("second item should be .completedTurn")
        }
        XCTAssertEqual(agentID, "agent-a")
        XCTAssertEqual(finalEvent.text, "Second half.",
                       "finalEvent should be the latest output of the turn")
        let runtimeTexts = runtimeEvents.map { ($0.eventType, $0.text ?? "") }
        XCTAssertEqual(runtimeTexts.count, 2)
        XCTAssertEqual(runtimeTexts[0].0, "output")
        XCTAssertEqual(runtimeTexts[0].1, "First half.",
                       "earlier output should fold into runtimeEvents")
        XCTAssertEqual(runtimeTexts[1].0, "tool_use",
                       "tool that cut the stream stays in runtimeEvents for the detail view")
    }

    func test_threeOutputs_sameTurn_collapseShowsOnlyLatestText() {
        let text1 = makeEvent(sequence: 1, eventType: "output", text: "A", isComplete: true, turnID: "T1")
        let tool1 = makeEvent(sequence: 2, eventType: "tool_use", toolName: "Bash", toolId: "t1", isComplete: true, turnID: "T1")
        let text2 = makeEvent(sequence: 3, eventType: "output", text: "B", isComplete: true, turnID: "T1")
        let tool2 = makeEvent(sequence: 4, eventType: "tool_use", toolName: "Edit", toolId: "t2", isComplete: true, turnID: "T1")
        let text3 = makeEvent(sequence: 5, eventType: "output", text: "C", isComplete: true, turnID: "T1")

        let feed = buildFeedItems([text1, tool1, text2, tool2, text3])

        XCTAssertEqual(feed.count, 1)
        guard case let .completedTurn(_, _, finalEvent, runtimeEvents) = feed[0] else {
            return XCTFail("expected single completedTurn")
        }
        XCTAssertEqual(finalEvent.text, "C")
        XCTAssertEqual(runtimeEvents.count, 4, "two prior outputs + two tools should be in runtime")
        XCTAssertEqual(runtimeEvents.map(\.text), ["A", nil, "B", nil],
                       "runtime preserves chronological order")
    }

    // MARK: - Distinct turns stay separate

    func test_distinctTurnIDs_doNotCollapse() {
        let textA = makeEvent(sequence: 1, eventType: "output", text: "turn one", isComplete: true, turnID: "T1")
        let textB = makeEvent(sequence: 2, eventType: "output", text: "turn two", isComplete: true, turnID: "T2")

        let feed = buildFeedItems([textA, textB])

        XCTAssertEqual(feed.count, 2)
        let texts: [String] = feed.compactMap {
            if case let .completedTurn(_, _, finalEvent, _) = $0 { return finalEvent.text }
            return nil
        }
        XCTAssertEqual(texts, ["turn one", "turn two"])
    }

    func test_missingTurnID_doesNotCollapse() {
        // Pre-turnID rows: each complete output emits its own bubble
        // (the safe legacy fallback — collapsing without a stable key
        // could cross-bind unrelated outputs).
        let textA = makeEvent(sequence: 1, eventType: "output", text: "a", isComplete: true, turnID: nil)
        let textB = makeEvent(sequence: 2, eventType: "output", text: "b", isComplete: true, turnID: nil)

        let feed = buildFeedItems([textA, textB])

        XCTAssertEqual(feed.count, 2)
    }

    // MARK: - Mid-turn fold into activeStream

    func test_completedTextThenLiveTool_foldsIntoActiveStream() {
        // text completed, tool currently running, no new output yet. The
        // chat should show ONE in-progress item, not bubble + card.
        let text1 = makeEvent(sequence: 1, eventType: "output", text: "Now I will run cd.", isComplete: true, turnID: "T1")
        let toolOpen = makeEvent(sequence: 2, eventType: "tool_use", toolName: "Bash", toolId: "t1", isComplete: false, turnID: "T1")

        let feed = buildFeedItems([text1, toolOpen])

        XCTAssertEqual(feed.count, 1, "completed bubble folds into the live stream")
        guard case let .activeStream(_, agentID, runtimeEvents) = feed[0] else {
            return XCTFail("expected single .activeStream")
        }
        XCTAssertEqual(agentID, "agent-a")
        XCTAssertEqual(runtimeEvents.count, 2)
        XCTAssertEqual(runtimeEvents[0].text, "Now I will run cd.",
                       "prior output text is preserved so activeStreamLastLine can surface it")
        XCTAssertEqual(runtimeEvents[1].eventType, "tool_use")
    }

    func test_streamingOnlyAfterCompletedTurn_doesNotFoldWithoutTurnID() {
        // Pure text streaming starts AFTER a completed turn closed and
        // openTurnsByAgent is empty. No turnID on streaming buffer yet,
        // so the prior bubble stays put — this is a new turn beginning.
        let text1 = makeEvent(sequence: 1, eventType: "output", text: "old", isComplete: true, turnID: "T1")
        let feed = buildFeedItems([text1], streamingAgentIDs: ["agent-a"])

        XCTAssertEqual(feed.count, 2, "completed bubble stays; fresh active stream card appears")
        guard case .completedTurn = feed[0] else { return XCTFail("first should be completedTurn") }
        guard case .activeStream = feed[1] else { return XCTFail("second should be activeStream") }
    }

    // MARK: - Multi-agent isolation

    func test_multiAgentSameTurnIDsDoNotCrossCollapse() {
        // Two concurrent agents with coincidentally-equal turnID strings
        // must not be folded together. Keying by (agent, turnID).
        let aText1 = makeEvent(sequence: 1, eventType: "output", text: "A1", isComplete: true, sender: "agent-a", turnID: "T1")
        let bText1 = makeEvent(sequence: 2, eventType: "output", text: "B1", isComplete: true, sender: "agent-b", turnID: "T1")
        let aText2 = makeEvent(sequence: 3, eventType: "output", text: "A2", isComplete: true, sender: "agent-a", turnID: "T1")

        let feed = buildFeedItems([aText1, bText1, aText2])

        // Expect: A collapsed to A2, B stays at B1 → 2 completedTurns.
        XCTAssertEqual(feed.count, 2)
        let finals: [(String, String?)] = feed.compactMap {
            if case let .completedTurn(_, agentID, finalEvent, _) = $0 {
                return (agentID, finalEvent.text)
            }
            return nil
        }
        XCTAssertEqual(finals.count, 2)
        XCTAssertTrue(finals.contains(where: { $0.0 == "agent-a" && $0.1 == "A2" }))
        XCTAssertTrue(finals.contains(where: { $0.0 == "agent-b" && $0.1 == "B1" }))
    }

    // MARK: - Pass-through cases

    func test_planUpdateStaysVisible_andPendingPermissionReadsUnderItsTurn() {
        let prompt = makeEvent(sequence: 1, eventType: "user_prompt", text: "go", sender: "user")
        let plan = makeEvent(sequence: 2, eventType: "plan_update", text: "[wip] step", isComplete: true, turnID: "T1")
        let perm = makeEvent(sequence: 3, eventType: "permission_request", text: "approve?", isComplete: false, turnID: "T1")
        let text = makeEvent(sequence: 4, eventType: "output", text: "done", isComplete: true, turnID: "T1")

        let feed = buildFeedItems([prompt, plan, perm, text])

        XCTAssertEqual(feed.count, 4)
        guard case .userMessage = feed[0] else { return XCTFail("expected userMessage") }
        guard case .todo = feed[1] else { return XCTFail("expected todo for plan_update") }
        guard case .completedTurn = feed[2] else { return XCTFail("expected completedTurn") }
        guard case .permission = feed[3] else {
            return XCTFail("a pending permission reads under the turn that asked it")
        }
    }

    // MARK: - Permission placement

    func test_answeredPermission_leavesFeedAndFoldsIntoItsTurn() {
        // Once the user has answered, the card is spent: it stops taking up a
        // row between the prompt and the reply, and is only reachable in the
        // turn detail next to the tool it was gating.
        let reply = makeEvent(sequence: 10, eventType: "output", text: "Done.", isComplete: true, turnID: "T1")
        let perm = makeEvent(sequence: 5, eventType: "permission_request", text: "WebSearch",
                             toolId: "perm-1", isComplete: true, turnID: "T1")

        let feed = buildFeedItems([reply, perm])

        XCTAssertEqual(feed.count, 1, "the answered permission must not hold a feed row")
        guard case let .completedTurn(_, _, _, runtimeEvents) = feed[0] else {
            return XCTFail("expected the turn's bubble")
        }
        XCTAssertTrue(
            runtimeEvents.contains { $0.toolId == "perm-1" },
            "it folds into the turn so the detail view can still show it"
        )
    }

    func test_answeredPermissionWithNoTurnInFeed_keepsItsRow() {
        // Nothing to fold into means nowhere left to read it, so the row
        // survives rather than the request disappearing outright.
        let perm = makeEvent(sequence: 5, eventType: "permission_request", text: "WebSearch",
                             toolId: "perm-1", isComplete: true, turnID: "T-gone")

        let feed = buildFeedItems([perm])

        XCTAssertEqual(feed.count, 1)
        guard case .permission = feed[0] else { return XCTFail("expected the permission row to survive") }
    }

    func test_pendingPermission_alsoReachesTheTurnDetail() {
        // It must be answerable from the process view too, so it rides in the
        // turn's runtime events while keeping its own feed row.
        let reply = makeEvent(sequence: 10, eventType: "output", text: "Done.", isComplete: true, turnID: "T1")
        let perm = makeEvent(sequence: 5, eventType: "permission_request", text: "Bash",
                             toolId: "perm-1", turnID: "T1")

        let feed = buildFeedItems([reply, perm])

        XCTAssertEqual(feed.count, 2)
        guard case let .completedTurn(_, _, _, runtimeEvents) = feed[0] else {
            return XCTFail("bubble first")
        }
        guard case .permission = feed[1] else { return XCTFail("and its own row under it") }
        XCTAssertTrue(runtimeEvents.contains { $0.toolId == "perm-1" })
    }

    func test_pendingPermission_readsUnderTheActiveStreamCard() {
        // The agent thinks, then asks. The stream card is appended after the
        // whole walk, so without placement the request sorts above it.
        let think = makeEvent(sequence: 1, eventType: "thinking", text: "hm", turnID: "T1")
        let perm = makeEvent(sequence: 2, eventType: "permission_request", text: "Bash",
                             toolId: "perm-1", turnID: "T1")

        let feed = buildFeedItems([think, perm], streamingAgentIDs: ["agent-a"])

        XCTAssertEqual(feed.count, 2)
        guard case .activeStream = feed[0] else { return XCTFail("stream card first") }
        guard case .permission = feed[1] else { return XCTFail("pending permission reads under it") }
    }

    func test_pendingPermissionForNewTurn_staysPut() {
        let reply = makeEvent(sequence: 10, eventType: "output", text: "Done.", isComplete: true, turnID: "T1")
        let perm = makeEvent(sequence: 11, eventType: "permission_request", text: "Bash",
                             toolId: "perm-2", turnID: "T2")

        let feed = buildFeedItems([reply, perm])

        XCTAssertEqual(feed.count, 2)
        guard case .completedTurn = feed[0] else { return XCTFail("bubble first") }
        guard case .permission = feed[1] else { return XCTFail("new turn's pending permission stays below") }
    }

    func test_severalPendingPermissions_keepTheOrderTheyWereAskedIn() {
        let reply = makeEvent(sequence: 10, eventType: "output", text: "Done.", isComplete: true, turnID: "T1")
        let first = makeEvent(sequence: 5, eventType: "permission_request", text: "Bash",
                              toolId: "perm-1", turnID: "T1")
        let second = makeEvent(sequence: 6, eventType: "permission_request", text: "WebSearch",
                               toolId: "perm-2", turnID: "T1")

        let feed = buildFeedItems([first, second, reply])

        XCTAssertEqual(feed.count, 3)
        guard case .completedTurn = feed[0] else { return XCTFail("bubble first") }
        guard case let .permission(a) = feed[1], case let .permission(b) = feed[2] else {
            return XCTFail("both permissions read under the turn")
        }
        XCTAssertEqual(a.toolId, "perm-1")
        XCTAssertEqual(b.toolId, "perm-2")
    }
}

