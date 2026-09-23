import SwiftUI
import Foundation
import MarkdownUI

/// Renders CommonMark + GFM markdown (headings, lists, fenced code blocks,
/// tables, inline emphasis/links/code, blockquotes) as SwiftUI views.
///
/// Backed by `swift-markdown-ui` (gonzalezreal). Apple's built-in
/// `AttributedString(markdown:)` only handles inline syntax, so before
/// this swap the chat bubbles dropped raw `##`, table pipes, and bullet
/// dashes into the rendered text whenever the agent replied with
/// anything block-structured.
public struct MarkdownRenderer: View {
    public let content: String

    public init(content: String) {
        self.content = content
    }

    public var body: some View {
        Markdown(Self.parsedContent(content))
            .markdownTheme(Theme.chatBubble)
            .textSelection(.enabled)
    }

    /// `Markdown(String)` runs the cmark parse in its initializer, so every
    /// rebuild of a bubble — each one scrolled back into the lazy transcript,
    /// every parent re-render — re-parsed the whole reply on the main thread
    /// and dropped frames mid-scroll. Parse once per distinct text instead.
    @MainActor
    private static let parseCache: NSCache<NSString, ParsedBox> = {
        let cache = NSCache<NSString, ParsedBox>()
        cache.countLimit = 256
        return cache
    }()

    @MainActor
    static func parsedContent(_ content: String) -> MarkdownContent {
        let key = content as NSString
        if let hit = parseCache.object(forKey: key) { return hit.content }
        let parsed = MarkdownContent(sanitizedContent(content))
        parseCache.setObject(ParsedBox(parsed), forKey: key)
        return parsed
    }

    private final class ParsedBox {
        let content: MarkdownContent
        init(_ content: MarkdownContent) { self.content = content }
    }

    static func sanitizedContent(_ content: String) -> String {
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var output: [String] = []
        var index = 0

        while index < lines.count {
            if index + 1 < lines.count,
               isTableRow(lines[index]),
               isTableSeparator(lines[index + 1]) {
                if output.last?.isEmpty == false {
                    output.append("")
                }

                while index < lines.count, isTableRow(lines[index]) || isTableSeparator(lines[index]) {
                    output.append("    \(lines[index])")
                    index += 1
                }

                if index < lines.count, !lines[index].isEmpty {
                    output.append("")
                }
            } else {
                output.append(lines[index])
                index += 1
            }
        }

        return output.joined(separator: "\n")
    }

    private static func isTableRow(_ line: String) -> Bool {
        line.contains("|") && !line.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "|"))
        let cells = trimmed.split(separator: "|", omittingEmptySubsequences: false)
        guard cells.count >= 2 else { return false }

        return cells.allSatisfy { cell in
            let value = cell.trimmingCharacters(in: .whitespaces)
            let withoutColons = value.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            return withoutColons.count >= 3 && withoutColons.allSatisfy { $0 == "-" }
        }
    }
}

@MainActor
private extension Theme {
    /// Chat-bubble theme: subheadline-sized body to match the rest of
    /// the bubble's typography, tightened heading scale (we render
    /// inside a narrow column), and a monospaced code font that keeps
    /// inline `code` legible against the gray glass background.
    ///
    /// `@MainActor` because `Theme` is non-Sendable; SwiftUI body
    /// already runs on the main actor so accessing this from a chat
    /// view is free. A stored `let` so the theme is built once rather than
    /// on every bubble render.
    static let chatBubble: Theme =
        Theme()
        // Match the user-bubble's `.subheadline` (15pt) so the two
        // sides of the conversation read at the same visual weight.
        // MarkdownUI's default body is `.body` (17pt) which made
        // user prompts look one notch larger than agent replies.
        .text {
            FontSize(15)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.92))
        }
        .heading1 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.35))
                }
                .padding(.vertical, 4)
        }
        .heading2 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.2))
                }
                .padding(.vertical, 3)
        }
        .heading3 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.08))
                }
                .padding(.vertical, 2)
        }
        .codeBlock { configuration in
            ScrollView(.horizontal) {
                configuration.label
                    .relativeLineSpacing(.em(0.2))
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.88))
                    }
                    .padding(10)
            }
            .background(Color.secondary.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .table { configuration in
            ScrollView(.horizontal) {
                configuration.label
                    .padding(.vertical, 2)
            }
        }
}
