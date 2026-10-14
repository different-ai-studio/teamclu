#if DEBUG
import Foundation
import SwiftData
import AMUXCore

/// Puts the `PerfFixtures` sessions into the local store when the app runs
/// with `-AMUXPerfFixtures YES` (the perf UI tests pass it). Local only: the
/// sessions never reach the server, are exempt from the list's prune, and
/// skip the Cloud API seed, so M1/M2 measured on them are network-free.
/// With `-AMUXPerfReplay YES` as well, opening one replays a streamed turn.
@MainActor
enum PerfFixtureInstaller {
    static var isEnabled: Bool { UserDefaults.standard.bool(forKey: "AMUXPerfFixtures") }

    static func installIfEnabled(teamID: String?, modelContext: ModelContext) {
        guard isEnabled, let teamID else { return }
        for spec in PerfFixtures.specs {
            let id = spec.sessionID
            // The events are rebuilt every launch — replays append turns, and
            // a fixture that grows run over run is no longer fixed. The
            // session row is kept, so a UI test holding the list cell does
            // not lose it to a delete-and-insert.
            let events = try? modelContext.fetch(FetchDescriptor<AgentEvent>(predicate: #Predicate { $0.agentId == id }))
            for event in events ?? [] { modelContext.delete(event) }

            let existing = try? modelContext.fetch(FetchDescriptor<Session>(predicate: #Predicate { $0.sessionId == id }))
            let session = existing?.first ?? Session(sessionId: id, teamId: teamID)
            if existing?.first == nil { modelContext.insert(session) }
            session.teamId = teamID
            session.title = spec.title
            session.lastMessagePreview = "Want me to open a PR with this change?"
            session.lastMessageAt = Date()

            let mqtt = MQTTService()
            let viewModel = SessionDetailViewModel(
                mqtt: mqtt,
                hub: MQTTMessageHub(mqtt: mqtt),
                teamID: teamID,
                peerId: "perf-fixture",
                session: session
            )
            viewModel._installPerfFixture(turns: spec.turns, modelContext: modelContext)
        }
        try? modelContext.save()
    }
}
#endif
