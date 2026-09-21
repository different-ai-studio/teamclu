import Foundation
import SwiftUI
import AMUXCore


public enum ToolDisplay {
    /// Bounded FIFO cache keyed by description string. Tool descriptions
    /// are stable per AgentEvent, so the same key is hit on every body
    /// re-eval while a tool row is on screen. 256 entries covers a long
    /// session's visible rows with negligible memory; eviction is FIFO.
    private static let _cache = SummaryCache(capacity: 256)

    public static func summary(for description: String) -> String? {
        if let cached = _cache.get(description) { return cached }
        let computed = computeSummary(for: description)
        _cache.set(description, value: computed)
        return computed
    }

    private static func computeSummary(for description: String) -> String? {
        let trimmed = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "{}", trimmed != "null" else { return nil }

        if let object = parseJSON(trimmed) {
            return summarizeJSON(object)
        }
        return truncate(trimmed.replacingOccurrences(of: "\n", with: " "), to: 80)
    }

    private static func parseJSON(_ text: String) -> Any? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private static func summarizeJSON(_ object: Any) -> String? {
        if let dict = object as? [String: Any] {
            let preferred = [
                "file_path", "filepath", "path", "file", "filename",
                "query", "pattern", "q", "command", "cmd",
                "skill", "skill_name", "name", "url"
            ]
            var pairs: [(String, String)] = []
            for key in preferred {
                if let value = dict[key], let rendered = renderScalar(value) {
                    pairs.append((displayKey(key), rendered))
                }
            }
            if pairs.isEmpty {
                pairs = dict.keys.sorted().compactMap { key in
                    guard let rendered = renderScalar(dict[key] as Any) else { return nil }
                    return (displayKey(key), rendered)
                }
            }
            guard !pairs.isEmpty else { return nil }
            return pairs.prefix(2)
                .map { "\($0.0): \(truncate($0.1, to: 48))" }
                .joined(separator: " · ")
        }
        if let array = object as? [Any] {
            return "\(array.count) items"
        }
        return renderScalar(object).map { truncate($0, to: 80) }
    }

    private static func renderScalar(_ value: Any) -> String? {
        switch value {
        case let value as String:
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed.replacingOccurrences(of: "\n", with: " ")
        case let value as NSNumber:
            return value.stringValue
        case let value as [Any]:
            return "\(value.count) items"
        case let value as [String: Any]:
            if let path = value["path"] ?? value["file_path"] ?? value["name"] {
                return renderScalar(path)
            }
            return nil
        default:
            return nil
        }
    }

    private static func displayKey(_ key: String) -> String {
        key.replacingOccurrences(of: "_", with: " ")
    }

    private static func truncate(_ text: String, to limit: Int) -> String {
        guard text.count > limit else { return text }
        return String(text.prefix(limit - 1)) + "…"
    }
}

// MARK: - SummaryCache

/// Thread-safe, bounded FIFO key-value cache.
private final class SummaryCache: @unchecked Sendable {
    private let lock = NSLock()
    private var dict: [String: String?] = [:]
    private var order: [String] = []
    private let capacity: Int

    init(capacity: Int) { self.capacity = capacity }

    func get(_ key: String) -> String?? {
        lock.lock(); defer { lock.unlock() }
        guard dict[key] != nil else { return nil }
        return dict[key]
    }

    func set(_ key: String, value: String?) {
        lock.lock(); defer { lock.unlock() }
        if dict[key] == nil {
            order.append(key)
            if order.count > capacity {
                dict.removeValue(forKey: order.removeFirst())
            }
        }
        dict[key] = value
    }
}

// MARK: - ToolCallView

public struct ToolCallView: View {
    public let toolName: String
    public let toolId: String
    public let description: String
    public let status: String
    @State private var isExpanded = false
    @State private var pulse = false

    private var hasDetails: Bool {
        ToolDisplay.summary(for: description) != nil
    }

    private var detailSummary: String? {
        ToolDisplay.summary(for: description)
    }

    public init(toolName: String, toolId: String, description: String, status: String) {
        self.toolName = toolName
        self.toolId = toolId
        self.description = description
        self.status = status
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                if hasDetails { withAnimation(AMUXAnimation.fast) { isExpanded.toggle() } }
            } label: {
                HStack(spacing: 8) {
                    statusDot
                        .frame(width: 5, height: 5)

                    Text((toolName.isEmpty ? toolId : toolName).uppercased())
                        .font(.system(size: 10, design: .monospaced))
                        .tracking(1.5)
                        .foregroundStyle(Color.amux.basalt)
                        .lineLimit(1)

                    if let detailSummary {
                        Text(detailSummary)
                            .font(.caption2)
                            .foregroundStyle(Color.amux.slate)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!hasDetails)

            if isExpanded && hasDetails {
                HStack(alignment: .top, spacing: 12) {
                    Rectangle()
                        .fill(Color.amux.hairline)
                        .frame(width: 0.5)
                    Text(description)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Color.amux.basalt)
                        .lineLimit(10)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.leading, 13) // align under the mono tool name (dot 5 + gap 8)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    @ViewBuilder
    private var statusDot: some View {
        switch status {
        case "running":
            Circle()
                .fill(Color.amux.sage)
                .opacity(pulse ? 0.45 : 1.0)
                .onAppear {
                    withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                        pulse = true
                    }
                }
        case "completed":
            Circle().fill(Color.amux.slate)
        case "failed":
            Circle().fill(Color.amux.cinnabarDeep)
        default:
            Circle().fill(Color.amux.slate.opacity(0.4))
        }
    }
}

// MARK: - CompactToolLine

public struct CompactToolLine: View {
    public let event: AgentEvent
    @State private var isExpanded = false

    private var toolName: String { event.toolName ?? "" }
    private var description: String { event.text ?? "" }
    private var succeeded: Bool { event.success != false }

    /// Present when the tool's envelope carried an `AcpToolCallDiff` —
    /// i.e. the agent edited a file and this row can show what changed.
    private var hasDiff: Bool {
        event.diffNewText != nil || event.diffOldText != nil
    }

    private var detailSummary: String? {
        ToolDisplay.summary(for: description)
    }

    private var resultSummary: String? {
        guard let s = event.resultSummary, !s.isEmpty else { return nil }
        return s
    }

    /// What sits beside the tool name on the head row: the call's own
    /// arguments when it has readable ones, otherwise the opening line of
    /// what came back. A tool with neither — `bash` with an unparseable
    /// command and a long stdout — used to render as a bare name on one
    /// line with an empty RESULT row hanging under it.
    private var headPreview: String? {
        if let detailSummary { return detailSummary }
        guard let resultSummary else { return nil }
        let firstLine = resultSummary.prefix(while: { !$0.isNewline })
        let trimmed = firstLine.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Anything to reveal. Drives the chevron too, so a row without a
    /// disclosure doesn't advertise one.
    private var isExpandable: Bool {
        detailSummary != nil || resultSummary != nil || hasDiff
    }

    public init(event: AgentEvent) {
        self.event = event
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // One head row, one disclosure. The call's arguments, its diff and
            // its output used to be three sibling rows each with its own
            // chevron, so a single tool call could occupy four lines of a
            // phone screen before revealing anything.
            Button {
                if isExpandable { withAnimation(AMUXAnimation.fast) { isExpanded.toggle() } }
            } label: {
                HStack(spacing: 8) {
                    Circle()
                        .fill(succeeded ? Color.amux.slate : Color.amux.cinnabarDeep)
                        .frame(width: 5, height: 5)

                    Text((toolName.isEmpty ? (event.toolId ?? "") : toolName).uppercased())
                        .font(.system(size: 10, design: .monospaced))
                        .tracking(1.5)
                        .foregroundStyle(Color.amux.basalt)
                        .lineLimit(1)
                        .layoutPriority(1)

                    if let headPreview {
                        Text(headPreview)
                            .font(.caption2)
                            .foregroundStyle(Color.amux.slate)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    Spacer(minLength: 0)

                    if isExpandable {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .medium))
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .foregroundStyle(Color.amux.slate.opacity(0.6))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!isExpandable)
            .accessibilityIdentifier("toolLine.disclosure")

            if isExpanded {
                HStack(alignment: .top, spacing: 12) {
                    Rectangle()
                        .fill(Color.amux.hairline)
                        .frame(width: 0.5)
                    VStack(alignment: .leading, spacing: 10) {
                        if detailSummary != nil, !description.isEmpty {
                            expandedSection("INPUT") {
                                Text(description)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(Color.amux.basalt)
                                    .lineLimit(10)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        if hasDiff {
                            expandedSection("DIFF") {
                                ToolCallDiffView(
                                    path: event.diffPath ?? "",
                                    oldText: event.diffOldText,
                                    newText: event.diffNewText ?? ""
                                )
                            }
                        }
                        if let resultSummary {
                            expandedSection("RESULT") {
                                Text(resultSummary)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(Color.amux.basalt)
                                    .textSelection(.enabled)
                                    .lineLimit(20)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.leading, 13) // align under the mono tool name (dot 5 + gap 8)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }

    /// One labelled block inside the expanded body. The label is a mono
    /// eyebrow, never translated — these are field names, not prose.
    @ViewBuilder
    private func expandedSection<Content: View>(
        _ label: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: label)
                .font(.system(size: 9, design: .monospaced))
                .tracking(2)
                .foregroundStyle(Color.amux.slate)
            content()
        }
    }
}


// MARK: - Event Grouping

// GroupedEvent and groupEvents live in AMUXCore so SessionDetailViewModel
// can maintain a cached grouping that updates only when events change,
// avoiding an O(n) regroup on every body recompute (streaming deltas
// previously forced a regroup on every frame).
