import Foundation

/// One rule for "is this actor online", shared by every surface that draws a
/// presence dot.
///
/// Ported from the desktop's `packages/app/src/lib/actor/actor-online.ts` so the
/// two clients agree. iOS used to answer this inline with its own 90-second
/// window, which is why the same person could read green on desktop and grey on
/// the phone: a heartbeat lands at most every 30s and only while the Actors tab
/// is open, so a 90s window expires between two of them.
public enum ActorPresence {
    /// How long a heartbeat counts for. Matches `isActorOnline`'s 5 minutes on
    /// the desktop — long enough to survive the heartbeat cadence, short enough
    /// that a closed app goes grey while the user still remembers closing it.
    public static let onlineWindow: TimeInterval = 5 * 60

    /// - Parameters:
    ///   - actorType: `member` / `agent` / `external`.
    ///   - lastActiveAt: the directory's heartbeat column.
    ///   - isCurrentUser: true for the signed-in user's own actor row. They are
    ///     online by definition — they are holding the phone — and saying
    ///     otherwise is the one presence answer a user can always disprove.
    ///   - devicePresence: for agents, what the broker's retained state topic
    ///     says (see `AgentPresenceStore`). It wins over the heartbeat in both
    ///     directions, because the daemon's Last Will reports a dropped
    ///     connection immediately while `last_active_at` keeps the row warm for
    ///     the rest of the window. `.unknown` — no retain seen, e.g. an agent
    ///     this client never subscribed to — falls back to the heartbeat rather
    ///     than claiming offline.
    public static func isOnline(actorType: String,
                                lastActiveAt: Date?,
                                isCurrentUser: Bool = false,
                                devicePresence: AgentDevicePresence = .unknown) -> Bool {
        // Gateway contacts publish no presence, and their last_active_at is
        // bumped by every inbound message — lighting one green for five minutes
        // after a WeCom message would claim a signal we do not have.
        if actorType == "external" { return false }
        if isCurrentUser { return true }
        if actorType == "agent" {
            switch devicePresence {
            case .online:  return true
            case .offline: return false
            case .unknown: break
            }
        }
        guard let lastActiveAt else { return false }
        return Date().timeIntervalSince(lastActiveAt) < onlineWindow
    }
}
