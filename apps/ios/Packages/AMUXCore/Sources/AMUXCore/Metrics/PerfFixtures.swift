import Foundation

/// Synthetic sessions for performance work (IM-parity plan, phase 1): a fixed
/// small and large session, plus a scripted agent turn to replay as if it
/// streamed in. Same content every run, so M1/M2 measure the code rather than
/// whatever a real account happens to hold. Nothing here touches the network.
///
/// The app installs them only in DEBUG with `-AMUXPerfFixtures YES`.
public enum PerfFixtures {
    public static let smallSessionID = "perf-fixture-small"
    public static let largeSessionID = "perf-fixture-large"
    /// The agent the fixture turns are attributed to.
    public static let agentID = "perf-fixture-agent"

    public struct Spec: Sendable {
        public let sessionID: String
        public let title: String
        public let turns: Int
    }

    /// Turns, not messages: each turn is one prompt and one reply, so the
    /// large session carries 220 rows — the Cloud API's default page.
    public static let specs: [Spec] = [
        Spec(sessionID: smallSessionID, title: "Perf · small (20)", turns: 10),
        Spec(sessionID: largeSessionID, title: "Perf · large (220)", turns: 110),
    ]

    /// The streamed reply's last line, and only it: a UI test waits for
    /// this to know the whole turn has arrived, not just its first chunk.
    public static let streamedTurnEnding = "Live replay finished."

    public static func isFixture(_ sessionID: String) -> Bool {
        sessionID == smallSessionID || sessionID == largeSessionID
    }

    /// The prompt / reply pair of turn `index`, oldest first, two minutes
    /// apart and ending `now`.
    public static func history(turns: Int, now: Date = Date()) -> [HistoryInput] {
        (0..<turns).flatMap { turn -> [HistoryInput] in
            let at = now.addingTimeInterval(Double(turn - turns) * 120)
            return [
                HistoryInput(
                    supabaseMessageID: "perf-u-\(turn)",
                    kind: .userPrompt,
                    senderActorID: nil,
                    content: prompt(turn),
                    createdAt: at
                ),
                HistoryInput(
                    supabaseMessageID: "perf-a-\(turn)",
                    kind: .output,
                    senderActorID: agentID,
                    content: reply(turn),
                    createdAt: at.addingTimeInterval(20),
                    turnID: "perf-turn-\(turn)"
                ),
            ]
        }
    }

    /// One live agent turn as the daemon sends it: active, thinking,
    /// `toolCalls` tool use/result pairs, the reply streamed as `deltas`
    /// output chunks and a final complete, then idle.
    public static func streamedTurn(toolCalls: Int = 6, deltas: Int = 120) -> [Amux_AcpEvent] {
        var events: [Amux_AcpEvent] = [statusChange(from: .idle, to: .active)]
        var thinking = Amux_AcpThinking()
        thinking.text = "Looking at the build log and the failing test first."
        events.append(acp(.thinking(thinking)))

        for call in 0..<toolCalls {
            var use = Amux_AcpToolUse()
            use.toolID = "perf-tool-\(call)"
            use.toolName = call % 2 == 0 ? "Read Sources/App/ContentView.swift" : "Run swift test --filter Perf"
            use.toolKind = call % 2 == 0 ? "read" : "execute"
            use.status = "in_progress"
            events.append(acp(.toolUse(use)))
            var result = Amux_AcpToolResult()
            result.toolID = use.toolID
            result.success = true
            result.summary = "ok · \(40 + call * 13) lines"
            events.append(acp(.toolResult(result)))
        }

        let full = reply(999) + "\n\n" + streamedTurnEnding
        let chunk = max(1, full.count / max(deltas, 1))
        var text = ""
        var index = full.startIndex
        while index < full.endIndex {
            let end = full.index(index, offsetBy: chunk, limitedBy: full.endIndex) ?? full.endIndex
            text += full[index..<end]
            var output = Amux_AcpOutput()
            output.text = String(full[index..<end])
            events.append(acp(.output(output)))
            index = end
        }
        var complete = Amux_AcpOutput()
        complete.text = text
        complete.isComplete = true
        events.append(acp(.output(complete)))
        events.append(statusChange(from: .active, to: .idle))
        return events
    }

    private static func statusChange(from old: Amux_AgentStatus, to new: Amux_AgentStatus) -> Amux_AcpEvent {
        var change = Amux_AcpStatusChange()
        change.oldStatus = old
        change.newStatus = new
        return acp(.statusChange(change))
    }

    private static func acp(_ event: Amux_AcpEvent.OneOf_Event) -> Amux_AcpEvent {
        var acp = Amux_AcpEvent()
        acp.event = event
        acp.model = "team/default"
        return acp
    }

    private static func prompt(_ turn: Int) -> String {
        let asks = [
            "Why does the session list jump when a new message arrives?",
            "Summarise yesterday's deploy failures and what fixed them.",
            "Can you add a retry with back-off to the upload client?",
            "Compare the two caching options and recommend one.",
        ]
        return "@perf-agent \(asks[turn % asks.count]) (#\(turn))"
    }

    /// Markdown shaped like real agent replies: a heading, a list, a table
    /// every few turns, and a fenced code block — the parts MarkdownUI is
    /// slowest to lay out.
    private static func reply(_ turn: Int) -> String {
        var parts = [
            "## Turn \(turn): findings",
            "The list re-sorts on every insert because the view reads `lastMessageAt` directly.",
            "- Cause: the sort key changes before the row is inserted\n- Effect: the scroll offset is lost\n- Fix: insert, then sort once",
        ]
        if turn % 3 == 0 {
            parts.append("| Option | Cost | Notes |\n|---|---|---|\n| NSCache | low | per process |\n| Disk | medium | survives launch |\n| Both | higher | best hit rate |")
        }
        parts.append("```swift\nfunc retry<T>(_ attempts: Int, _ body: () async throws -> T) async throws -> T {\n    var delay: Duration = .milliseconds(500)\n    for attempt in 1...attempts {\n        do { return try await body() } catch where attempt < attempts {\n            try await Task.sleep(for: delay)\n            delay *= 2\n        }\n    }\n    fatalError(\"unreachable\")\n}\n```")
        parts.append("Want me to open a PR with this change?")
        return parts.joined(separator: "\n\n")
    }
}
