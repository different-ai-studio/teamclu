import Foundation

/// What a session's agent is doing right now, as the lock screen and the
/// Dynamic Island show it. Plain data: ActivityKit lives in the app, and
/// this package also builds for macOS.
public struct TurnActivitySnapshot: Equatable, Sendable {
    public enum Phase: String, Sendable { case running, waitingApproval }

    public let sessionID: String
    public let sessionTitle: String
    public let agentName: String
    public let phase: Phase
    /// The newest non-empty line of the agent's output, if any yet.
    public let latestLine: String?

    public init(sessionID: String, sessionTitle: String, agentName: String, phase: Phase, latestLine: String?) {
        self.sessionID = sessionID
        self.sessionTitle = sessionTitle
        self.agentName = agentName
        self.phase = phase
        self.latestLine = latestLine
    }
}

/// Receives turn progress from the open session. The app installs one
/// that drives a Live Activity; nothing is reported until it does.
@MainActor
public protocol TurnActivitySink: AnyObject {
    func update(_ snapshot: TurnActivitySnapshot)
    func finish(sessionID: String, finalLine: String?)
}

@MainActor
public enum TurnActivityCenter {
    public static var sink: (any TurnActivitySink)?

    /// The start of a finished answer on one line — what a notification
    /// would show; its closing line is too often "let me know if…".
    public static func summary(of text: String?, limit: Int = 160) -> String? {
        guard let text else { return nil }
        let flat = NotificationPreview.plain(text, limit: limit)
            .replacingOccurrences(of: "\n", with: " ")
        return flat.isEmpty ? nil : flat
    }

    /// The last non-blank line of `text`, as plain text, capped for a
    /// one-line slot.
    public static func lastLine(of text: String?, limit: Int = 120) -> String? {
        guard let text else { return nil }
        let line = NotificationPreview.plain(text, limit: .max)
            .split(whereSeparator: \.isNewline)
            .last { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        guard let line else { return nil }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.count > limit ? String(trimmed.prefix(limit)) + "…" : trimmed
    }
}
