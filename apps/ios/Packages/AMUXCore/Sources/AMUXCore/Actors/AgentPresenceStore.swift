import Foundation
import Observation

/// What the broker says about an agent's daemon right now.
///
/// `unknown` is not `offline`: no retain has been seen for that actor (we may
/// not even be subscribed to it), so the caller falls back to the heartbeat.
public enum AgentDevicePresence: Sendable, Equatable {
    case online
    case offline
    case unknown
}

/// Per-agent device presence, fed by the retained `amux/{team}/{actor}/state`
/// publishes that `SessionListViewModel` already consumes.
///
/// This is the authoritative answer to "is this agent's daemon reachable right
/// now?", because the daemon registers a Last Will at connect time and the
/// broker publishes it — `ActorPresence { online: false }`, retained — the
/// moment the connection drops (`apps/daemon/src/mqtt/client.rs`). A heartbeat
/// column cannot say that: `last_active_at` only records when a row was last
/// touched, so a daemon killed thirty seconds ago still reads "online" for the
/// rest of the window.
///
/// Mirrors the desktop's `stores/actor-presence-store.ts`. The desktop also
/// merges a loopback probe of its own local daemon; the phone is always a
/// remote client, so the MQTT retain is the whole story here.
@Observable @MainActor
public final class AgentPresenceStore {
    public struct Entry: Sendable, Equatable {
        public let online: Bool
        public let updatedAt: Date

        public init(online: Bool, updatedAt: Date) {
            self.online = online
            self.updatedAt = updatedAt
        }
    }

    public private(set) var byActorID: [String: Entry] = [:]

    public init() {}

    /// Record what a retained publish said. Callers pass `presence.online`
    /// straight through — including from the LWT, which is an ordinary encoded
    /// message with `online: false`.
    public func record(actorID: String, online: Bool, at: Date = Date()) {
        let id = actorID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { return }
        byActorID[id] = Entry(online: online, updatedAt: at)
    }

    public func presence(forAgent actorID: String) -> AgentDevicePresence {
        guard let entry = byActorID[actorID] else { return .unknown }
        return entry.online ? .online : .offline
    }

    /// Called on team switch / sign-out — presence is team-scoped, and a stale
    /// entry would outlive the subscription that produced it.
    public func clear() {
        byActorID.removeAll()
    }
}
