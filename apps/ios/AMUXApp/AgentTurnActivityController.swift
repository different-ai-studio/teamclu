// apps/ios/AMUXApp/AgentTurnActivityController.swift
import ActivityKit
import Foundation
import AMUXCore

/// Drives one Live Activity per session whose agent is working, from the
/// snapshots the session view reports (`TurnActivitySink`).
///
/// Started only while the app is in front — ActivityKit refuses a request
/// from the background — and ended by whichever comes first: the open
/// session seeing the turn finish, the session list seeing it go quiet, or
/// the agent's reply arriving as a push while the app is in the background.
/// A turn that ends with the app killed is left to `staleDate`.
@MainActor
final class AgentTurnActivityController: TurnActivitySink {
    static let shared = AgentTurnActivityController()

    /// Live Activity budget: ActivityKit throttles frequent updates, and a
    /// line that changes ten times a second is unreadable anyway.
    private let minimumUpdateInterval: TimeInterval = 2
    /// Past this with no update the system greys the activity ("No recent
    /// updates"), which is the honest state when nothing will end it.
    private let staleAfter: TimeInterval = 15 * 60
    private var lastUpdate: [String: (state: AgentTurnAttributes.ContentState, at: Date)] = [:]
    /// Ends with no answer to show (the session list saw the turn go quiet),
    /// held back briefly: the same idle event usually also reaches an open
    /// session view, which ends it with the answer's opening instead.
    private var deferredEnds: [String: Task<Void, Never>] = [:]
    private let deferredEndDelay: Duration = .milliseconds(1500)

    private func activity(for sessionID: String) -> Activity<AgentTurnAttributes>? {
        Self.live(sessionID)
    }

    nonisolated private static func live(_ sessionID: String) -> Activity<AgentTurnAttributes>? {
        Activity<AgentTurnAttributes>.activities.first {
            $0.attributes.sessionID == sessionID && $0.activityState == .active
        }
    }

    func update(_ snapshot: TurnActivitySnapshot) {
        // A new turn started before a deferred end fired: keep the activity.
        deferredEnds.removeValue(forKey: snapshot.sessionID)?.cancel()
        let state = AgentTurnAttributes.ContentState(
            phase: snapshot.phase == .waitingApproval ? .waitingApproval : .running,
            line: snapshot.latestLine ?? lastUpdate[snapshot.sessionID]?.state.line ?? "",
            updatedAt: .now
        )
        if let previous = lastUpdate[snapshot.sessionID] {
            let samePhase = previous.state.phase == state.phase
            if samePhase, previous.state.line == state.line { return }
            if samePhase, Date.now.timeIntervalSince(previous.at) < minimumUpdateInterval { return }
        }
        lastUpdate[snapshot.sessionID] = (state, .now)
        let content = ActivityContent(state: state, staleDate: .now.addingTimeInterval(staleAfter))

        if activity(for: snapshot.sessionID) != nil {
            let sessionID = snapshot.sessionID
            // Looked up again off the main actor: `Activity` isn't Sendable.
            Task.detached { await Self.live(sessionID)?.update(content) }
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        do {
            _ = try Activity.request(
                attributes: AgentTurnAttributes(
                    sessionID: snapshot.sessionID,
                    sessionTitle: snapshot.sessionTitle,
                    agentName: snapshot.agentName
                ),
                content: content,
                pushType: nil
            )
        } catch {
            // Background, disabled by the user, or over the system cap:
            // nothing to show, nothing to retry.
            NSLog("[live-activity] request failed: \(error.localizedDescription)")
        }
    }

    func finish(sessionID: String, finalLine: String?) {
        guard finalLine != nil else {
            guard deferredEnds[sessionID] == nil, activity(for: sessionID) != nil else { return }
            deferredEnds[sessionID] = Task { [weak self, deferredEndDelay] in
                try? await Task.sleep(for: deferredEndDelay)
                guard let self, !Task.isCancelled else { return }
                self.deferredEnds[sessionID] = nil
                self.end(sessionID: sessionID, finalLine: nil)
            }
            return
        }
        deferredEnds.removeValue(forKey: sessionID)?.cancel()
        end(sessionID: sessionID, finalLine: finalLine)
    }

    private func end(sessionID: String, finalLine: String?) {
        let previous = lastUpdate.removeValue(forKey: sessionID)
        guard let activity = activity(for: sessionID) else { return }
        let state = AgentTurnAttributes.ContentState(
            phase: .done,
            line: finalLine ?? previous?.state.line ?? activity.content.state.line,
            updatedAt: .now
        )
        Task.detached {
            // Kept briefly on the lock screen so a glance shows the result.
            await Self.live(sessionID)?.end(ActivityContent(state: state, staleDate: nil),
                                            dismissalPolicy: .after(.now.addingTimeInterval(10 * 60)))
        }
    }
}
