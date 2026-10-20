import Foundation

/// Message text as a notification or a Live Activity can show it: mention
/// scaffolding read as `@Name`, Markdown marks dropped, blank lines folded.
/// Also compiled into the notification service extension, so it depends on
/// nothing but Foundation and `MentionDisplayText`.
public enum NotificationPreview {
    public static func plain(_ text: String, limit: Int = 240) -> String {
        var s = MentionDisplayText.plainText(text)
        // Fenced code: keep the code, lose the fences.
        s = s.replacingOccurrences(of: #"(?m)^\s*```[^\n]*\n?"#, with: "", options: .regularExpression)
        // ![alt](url) → alt, [text](url) → text.
        s = s.replacingOccurrences(of: #"!\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        // Headings and quotes at line start; list bullets become "• ".
        s = s.replacingOccurrences(of: #"(?m)^\s{0,3}(#{1,6}|>)\s*"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"(?m)^\s*[-*+]\s+"#, with: "• ", options: .regularExpression)
        // Emphasis and inline code markers, never a lone `*` inside a word.
        for mark in ["**", "__", "~~", "`"] { s = s.replacingOccurrences(of: mark, with: "") }
        s = s.replacingOccurrences(of: #"(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])"#, with: "$1", options: .regularExpression)
        // Blank-line runs → one line break; trim.
        s = s.replacingOccurrences(of: #"\n[ \t]*\n+"#, with: "\n", options: .regularExpression)
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.count > limit else { return s }
        return String(s.prefix(limit)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }
}
