import Foundation

/// Replying from a message notification without opening the app.
///
/// The app may be woken cold in the background for this, with no MQTT
/// connection and no `TeamcluService` state, so the reply goes out over
/// HTTP only. That is enough: FC fans every inserted message out to the
/// session's agent inboxes, which is how agents hear messages (#1455).
public enum NotificationReply {
    /// `aps.category` FC puts on message pushes.
    public static let categoryID = "SESSION_MESSAGE"
    public static let replyActionID = "REPLY"

    /// Where a reply to a given notification goes, read from its payload.
    public struct Target: Equatable, Sendable {
        public let sessionID: String
        public let teamID: String
        /// The notified message; the reply quotes it.
        public let messageID: String?
        public let senderActorID: String?
    }

    /// Nil unless the payload names both the session and its team — a push
    /// from an FC older than this feature carries no team.
    public static func target(from userInfo: [AnyHashable: Any]) -> Target? {
        func string(_ key: String) -> String? {
            guard let value = userInfo[key] as? String, !value.isEmpty else { return nil }
            return value
        }
        guard let sessionID = string("session_id"), let teamID = string("team_id") else { return nil }
        return Target(
            sessionID: sessionID,
            teamID: teamID,
            messageID: string("message_id"),
            senderActorID: string("sender_actor_id")
        )
    }

    /// The message to insert. It quotes the notified message, and mentions
    /// its sender when that is an agent — otherwise the agent would take the
    /// reply in as context and never answer it.
    public static func insertInput(
        text: String,
        target: Target,
        myActorID: String,
        senderIsAgent: Bool
    ) -> MessageInsertInput {
        let mentions = senderIsAgent ? target.senderActorID.map { [$0] } ?? [] : []
        return MessageInsertInput(
            teamID: target.teamID,
            sessionID: target.sessionID,
            senderActorID: myActorID,
            content: text,
            mentionActorIDs: mentions,
            replyToMessageID: target.messageID
        )
    }

    // MARK: - Own actor per team

    private static let actorsKey = "notificationReply.actorByTeam.v1"

    /// Records the signed-in user's actor in `teamID`. A message must name
    /// its sender, and a push cannot carry it: one payload goes to everyone.
    public static func rememberActor(_ actorID: String, team teamID: String, defaults: UserDefaults = .standard) {
        guard !actorID.isEmpty, !teamID.isEmpty else { return }
        var map = defaults.dictionary(forKey: actorsKey) as? [String: String] ?? [:]
        guard map[teamID] != actorID else { return }
        map[teamID] = actorID
        defaults.set(map, forKey: actorsKey)
    }

    public static func actorID(team teamID: String, defaults: UserDefaults = .standard) -> String? {
        (defaults.dictionary(forKey: actorsKey) as? [String: String])?[teamID]
    }

    /// Sign-out: the next account must not send as this one.
    public static func forgetActors(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: actorsKey)
    }
}
