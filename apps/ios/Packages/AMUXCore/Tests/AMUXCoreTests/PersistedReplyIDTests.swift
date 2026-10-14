import XCTest
@testable import AMUXCore

/// A live-rendered agent reply learns its row id from the daemon's
/// persisted `message.created`, whichever of the two arrives first.
final class PersistedReplyIDTests: XCTestCase {
    private func complete(_ text: String, turn: String?, sequence: UInt64 = 1, into state: inout TimelineState) {
        var acp = Amux_AcpEvent()
        var out = Amux_AcpOutput()
        out.text = text
        out.isComplete = true
        acp.event = .output(out)
        ChatTimelineReducer.apply(.acp(AcpInput(
            envelopeSequence: sequence, agentBucketKey: "agent-1", timestamp: .now,
            turnID: turn, acpEvent: acp
        )), to: &state)
    }

    private func persisted(_ id: String, _ text: String, turn: String? = "t-1") -> TimelineInput {
        .persistedReply(PersistedReplyInput(messageID: id, senderActorID: "agent-1", content: text, turnID: turn))
    }

    func testIdLandsOnTheCompletedOutput() {
        var state = TimelineState()
        complete("1234", turn: "t-1", into: &state)
        ChatTimelineReducer.apply(persisted("row-1", "1234"), to: &state)
        XCTAssertEqual(state.entries.map(\.supabaseMessageID), ["row-1"])
        XCTAssertEqual(state.entries.count, 1, "never draws a second bubble")
    }

    func testIdArrivingFirstWaitsForTheOutput() {
        var state = TimelineState()
        ChatTimelineReducer.apply(persisted("row-1", "1234"), to: &state)
        XCTAssertTrue(state.entries.isEmpty)
        complete("1234", turn: "t-1", into: &state)
        XCTAssertEqual(state.entries.map(\.supabaseMessageID), ["row-1"])
        XCTAssertTrue(state.pendingPersistedReplies.isEmpty)
    }

    func testEachSegmentOfASplitTurnGetsItsOwnRow() {
        var state = TimelineState()
        complete("Looking it up.", turn: "t-1", sequence: 1, into: &state)
        complete("Found it: 42.", turn: "t-2", sequence: 2, into: &state)
        ChatTimelineReducer.apply(persisted("row-b", "Found it: 42.", turn: "t-2"), to: &state)
        ChatTimelineReducer.apply(persisted("row-a", "Looking it up.", turn: "t-1"), to: &state)
        XCTAssertEqual(state.entries.map(\.supabaseMessageID), ["row-a", "row-b"])
    }

    func testAnOutputThatAlreadyHasAnIdIsLeftAlone() {
        var state = TimelineState()
        complete("1234", turn: "t-1", into: &state)
        ChatTimelineReducer.apply(persisted("row-1", "1234"), to: &state)
        ChatTimelineReducer.apply(persisted("row-2", "1234"), to: &state)
        XCTAssertEqual(state.entries.map(\.supabaseMessageID), ["row-1"])
    }
}

extension PersistedReplyIDTests {
    /// The order the live capture showed: the final text arrives as deltas,
    /// the row id next, and the idle status last flushes the output.
    func testIdBeforeTheIdleFlushLandsOnTheFlushedOutput() {
        var state = TimelineState()
        var delta = Amux_AcpEvent()
        var out = Amux_AcpOutput()
        out.text = "15"
        delta.event = .output(out)
        ChatTimelineReducer.apply(.acp(AcpInput(
            envelopeSequence: 1, agentBucketKey: "agent-1", timestamp: .now, turnID: "t-1", acpEvent: delta
        )), to: &state)
        ChatTimelineReducer.apply(persisted("row-1", "15"), to: &state)

        var idle = Amux_AcpEvent()
        var status = Amux_AcpStatusChange()
        status.newStatus = .idle
        idle.event = .statusChange(status)
        ChatTimelineReducer.apply(.acp(AcpInput(
            envelopeSequence: 2, agentBucketKey: "agent-1", timestamp: .now, turnID: "t-1", acpEvent: idle
        )), to: &state)

        XCTAssertEqual(state.entries.map(\.supabaseMessageID), ["row-1"])
        XCTAssertTrue(state.pendingPersistedReplies.isEmpty)
    }
}
