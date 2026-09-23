import Foundation

/// Turns the structured tokens a desktop client writes into a user message
/// into what a reader should see.
///
/// The desktop composer (`packages/app/src/lib/actor/outgoing-mention-content.ts`)
/// sends mentions and invocations as text the agent reads:
///
/// - a leading `[Mentioned agents: A, B]` / `[Mentioned humans: A]` line;
/// - an inline `[Mentioned: Name|instruction: …]` chip for a human;
/// - `[Skill: x|instruction: …]`, `[Role: x|…]`, `[Command: x|…]` chips.
///
/// Shown raw they bury the message under bracketed prompt scaffolding. The
/// desktop renders them as chips (`UserMessageWithMentions.tsx`); this is the
/// same reading for iOS: mentions become `@Name`, invocations `/name`, and
/// every `|instruction:` payload — meant for the model — is dropped.
public enum MentionDisplayText {
    public struct Segment: Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            case text
            /// `@Name` — an agent or human mention.
            case mention
            /// `/name` — a skill, role, or command invocation.
            case invocation
        }

        public let kind: Kind
        public let text: String

        public init(_ kind: Kind, _ text: String) {
            self.kind = kind
            self.text = text
        }
    }

    public static func segments(_ raw: String) -> [Segment] {
        var out: [Segment] = []
        var body = Substring(raw)

        // Leading structured lines: one per mention kind, each optionally
        // followed by a newline, as the desktop writes them.
        var leading: [String] = []
        while let match = body.prefixMatch(of: leadingLine) {
            leading += match.output.1.split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            body = body[match.range.upperBound...]
        }
        if !leading.isEmpty {
            body = body.drop(while: { $0.isWhitespace || $0.isNewline })
            for (index, name) in leading.enumerated() {
                if index > 0 { out.append(Segment(.text, " ")) }
                out.append(Segment(.mention, at(name)))
            }
            if !body.isEmpty { out.append(Segment(.text, " ")) }
        }

        var cursor = body.startIndex
        for match in body.matches(of: inlineChip) {
            if cursor < match.range.lowerBound {
                out.append(Segment(.text, String(body[cursor..<match.range.lowerBound])))
            }
            let label = String(match.output.1)
            let name = stripInstruction(String(match.output.2))
            if name.isEmpty {
                // Nothing a reader could use — drop the token entirely.
            } else if label == "Mentioned" {
                // A legacy chip without `|instruction:` can list several.
                let people = name.split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
                for (index, person) in people.enumerated() {
                    if index > 0 { out.append(Segment(.text, " ")) }
                    out.append(Segment(.mention, at(person)))
                }
            } else {
                out.append(Segment(.invocation, "/" + name))
            }
            cursor = match.range.upperBound
        }
        if cursor < body.endIndex {
            out.append(Segment(.text, String(body[cursor...])))
        }

        return trimmed(merged(out))
    }

    /// The message as plain text, tokens rewritten — for copy and share.
    public static func plainText(_ raw: String) -> String {
        segments(raw).map(\.text).joined()
    }

    // MARK: - Private

    // Computed, not stored: `Regex` isn't Sendable, and these are cheap.
    private static var leadingLine: Regex<(Substring, Substring)> {
        /\[Mentioned (?:agents|humans): ([^\]]*)\][ \t]*\r?\n?/
    }
    private static var inlineChip: Regex<(Substring, Substring, Substring)> {
        /\[(Mentioned|Skill|Role|Command): ([^\]]+)\]/
    }

    private static func stripInstruction(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard let range = trimmed.range(of: "|instruction:") else { return trimmed }
        return trimmed[..<range.lowerBound].trimmingCharacters(in: .whitespaces)
    }

    private static func at(_ name: String) -> String {
        name.hasPrefix("@") ? name : "@" + name
    }

    /// Adjacent text runs joined, so callers see one run per stretch of prose.
    private static func merged(_ segments: [Segment]) -> [Segment] {
        var out: [Segment] = []
        for segment in segments {
            if segment.kind == .text, let last = out.last, last.kind == .text {
                out[out.count - 1] = Segment(.text, last.text + segment.text)
            } else {
                out.append(segment)
            }
        }
        return out
    }

    /// Whitespace a removed token leaves at either end of the message.
    private static func trimmed(_ segments: [Segment]) -> [Segment] {
        var out = segments
        if let first = out.first, first.kind == .text {
            let text = String(first.text.drop(while: { $0.isWhitespace || $0.isNewline }))
            if text.isEmpty { out.removeFirst() } else { out[0] = Segment(.text, text) }
        }
        if let last = out.last, last.kind == .text {
            var text = last.text
            while let c = text.last, c.isWhitespace || c.isNewline { text.removeLast() }
            if text.isEmpty { out.removeLast() } else { out[out.count - 1] = Segment(.text, text) }
        }
        return out
    }
}
