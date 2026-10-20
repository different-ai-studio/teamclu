// apps/ios/Shared/AgentTurnAttributes.swift
// Compiled into both the app (which starts, updates and ends the activity)
// and the AMUXLiveActivity widget extension (which draws it). ActivityKit
// matches the two by this type, so it must be the same source in both.
import ActivityKit
import Foundation

struct AgentTurnAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Phase: String, Codable, Hashable { case running, waitingApproval, done }

        var phase: Phase
        /// Newest line of output while running; the answer's last line when done.
        var line: String
        var updatedAt: Date
    }

    var sessionID: String
    var sessionTitle: String
    var agentName: String

    /// Where tapping the activity goes: the session, via the app's own scheme.
    var sessionURL: URL? { URL(string: "teamclu://session/\(sessionID)") }
}
