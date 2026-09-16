import Foundation

/// Projects a turn trace's JSONL (see `apps/daemon/src/runtime/turn_trace.rs`
/// for the line format) into the `TimelineEntry` shapes the turn detail view
/// already renders.
///
/// ```text
/// every line          turn_seq, type, ts_ms, [sequence], [child_session], [model]
/// thinking | reply    text              consecutive deltas coalesced into one line
/// tool_call           tool_id, tool_name, tool_kind, status, [raw_input], [raw_output]
/// tool_result         tool_id, success, summary, [raw_output]
/// permission_request  request_id, tool_name, description
/// status_change       old_status, new_status
/// error               message, details
/// trace_truncated     dropped_events    last line, only when the budget ran out
/// ```
///
/// Every tool_call and tool_result for one `tool_id` folds into a single
/// `tool_use` entry, like the live reducer does. Lines that don't parse are
/// skipped rather than failing the whole trace.
public enum TurnTraceParser {

    public static func parse(_ jsonl: Data, turnID: String, senderActorID: String) -> TurnTraceDetail {
        var entries: [TimelineEntry] = []
        var toolIndexByID: [String: Int] = [:]
        var droppedEvents = 0

        func append(_ line: [String: Any], eventType: String) -> Int {
            let turnSeq = (line["turn_seq"] as? NSNumber)?.uint64Value ?? UInt64(entries.count + 1)
            let tsMillis = (line["ts_ms"] as? NSNumber)?.doubleValue ?? 0
            let model = (line["model"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            entries.append(TimelineEntry(
                id: "trace:\(turnID):\(turnSeq)",
                sequence: turnSeq,
                eventType: eventType,
                isComplete: true,
                senderActorID: senderActorID,
                timestamp: Date(timeIntervalSince1970: tsMillis / 1000),
                model: model,
                turnID: turnID
            ))
            return entries.count - 1
        }

        for rawLine in jsonl.split(separator: UInt8(ascii: "\n")) where !rawLine.isEmpty {
            guard let line = (try? JSONSerialization.jsonObject(with: Data(rawLine))) as? [String: Any],
                  let type = line["type"] as? String
            else { continue }

            switch type {
            case "thinking", "reply":
                guard var text = line["text"] as? String, !text.isEmpty else { continue }
                // Text runs past the cap keep only their head, with no marker
                // of their own.
                if let original = (line["text_original_size"] as? NSNumber)?.intValue,
                   original > text.utf8.count {
                    text += "\n…"
                }
                let idx = append(line, eventType: type == "reply" ? "output" : "thinking")
                entries[idx].text = text

            case "tool_call":
                guard let toolID = line["tool_id"] as? String, !toolID.isEmpty else { continue }
                let idx: Int
                if let existing = toolIndexByID[toolID] {
                    idx = existing
                } else {
                    idx = append(line, eventType: "tool_use")
                    entries[idx].toolID = toolID
                    entries[idx].isComplete = false
                    toolIndexByID[toolID] = idx
                }
                if let name = line["tool_name"] as? String, !name.isEmpty {
                    entries[idx].toolName = name
                }
                if let input = render(line["raw_input"]) {
                    entries[idx].text = input
                }
                if let output = render(line["raw_output"]), entries[idx].resultSummary == nil {
                    entries[idx].resultSummary = output
                }
                switch line["status"] as? String {
                case "completed":
                    entries[idx].isComplete = true
                case "failed":
                    entries[idx].isComplete = true
                    entries[idx].success = false
                default:
                    break
                }

            case "tool_result":
                guard let toolID = line["tool_id"] as? String, !toolID.isEmpty else { continue }
                let idx: Int
                if let existing = toolIndexByID[toolID] {
                    idx = existing
                } else {
                    // The tool_call line fell past the budget. Still worth a
                    // card: the result is the part the user came for.
                    idx = append(line, eventType: "tool_use")
                    entries[idx].toolID = toolID
                    toolIndexByID[toolID] = idx
                }
                entries[idx].isComplete = true
                if let success = line["success"] as? Bool {
                    entries[idx].success = success
                }
                if let summary = render(line["summary"]) ?? render(line["raw_output"]) {
                    entries[idx].resultSummary = summary
                }

            case "permission_request":
                let idx = append(line, eventType: "permission_request")
                entries[idx].toolID = line["request_id"] as? String
                entries[idx].toolName = line["tool_name"] as? String
                entries[idx].text = line["description"] as? String

            case "error":
                guard let message = render(line["message"]) ?? render(line["details"]) else { continue }
                let idx = append(line, eventType: "error")
                entries[idx].text = message

            case "trace_truncated":
                droppedEvents += (line["dropped_events"] as? NSNumber)?.intValue ?? 0

            default:
                // status_change and anything newer: nothing to draw.
                continue
            }
        }

        // The trace is written after the turn ended, so a tool still marked
        // running never got its result (the turn was interrupted).
        for idx in entries.indices where entries[idx].eventType == "tool_use" {
            entries[idx].isComplete = true
        }
        return TurnTraceDetail(entries: entries, droppedEvents: droppedEvents)
    }

    /// A payload field as display text. Valid JSON is embedded in the trace
    /// verbatim, so objects come back as objects; anything over the daemon's
    /// field cap is already a head-and-tail string.
    private static func render(_ value: Any?) -> String? {
        switch value {
        case let text as String:
            return text.isEmpty ? nil : text
        case let number as NSNumber:
            return number.stringValue
        case .some(let object) where object is [String: Any] || object is [Any]:
            guard let data = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            ) else { return nil }
            return String(data: data, encoding: .utf8)
        default:
            return nil
        }
    }
}
