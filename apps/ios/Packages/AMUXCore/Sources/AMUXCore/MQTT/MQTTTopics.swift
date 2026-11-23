import Foundation

public enum MQTTTopics {
    /// Team-id stand-in used in MQTT topics when the device has no team yet.
    ///
    /// A wire constant, not a brand string: it is a path segment in
    /// `amux/<team>/<actor>/…` that this app and the desktop daemon — which
    /// update independently — have to agree on, so the teamclaw → teamclu
    /// rebrand deliberately left it alone. A rendezvous point has no migration
    /// available; renaming it would silently stop every mixed-version, team-less
    /// device pair from seeing each other's messages.
    ///
    /// Mirrors `teamclu_types::mqtt::MQTT_FALLBACK_TEAM_ID`; keep the two equal.
    public static let fallbackTeamID = "teamclaw"

    public static func normalizedTeamID(_ teamID: String) -> String {
        teamID.isEmpty ? fallbackTeamID : teamID
    }

    public static func actorBase(teamID: String, actorID: String) -> String {
        "amux/\(normalizedTeamID(teamID))/\(actorID)"
    }

    public static func teamcluBase(teamID: String) -> String {
        "amux/\(normalizedTeamID(teamID))"
    }

    /// Fixed actor-scoped request channel for the MQTT rearchitecture.
    public static func actorRpcRequest(teamID: String, actorID: String) -> String {
        "\(actorBase(teamID: teamID, actorID: actorID))/rpc/req"
    }

    /// Fixed actor-scoped response channel for the MQTT rearchitecture.
    public static func actorRpcResponse(teamID: String, actorID: String) -> String {
        "\(actorBase(teamID: teamID, actorID: actorID))/rpc/res"
    }

    /// Targeted actor notification channel used to invalidate local state.
    public static func actorNotify(teamID: String, actorID: String) -> String {
        "\(actorBase(teamID: teamID, actorID: actorID))/notify"
    }

    /// Single realtime stream for live session events in the new contract.
    public static func sessionLive(teamID: String, sessionID: String) -> String {
        "\(teamcluBase(teamID: teamID))/session/\(sessionID)/live"
    }

    /// Actor-scoped retained presence topic. The daemon publishes its state
    /// transitions here and its LWT fires here too (the legacy `/status`
    /// topic is retired), so an offline payload on this topic is authoritative.
    public static func actorState(teamID: String, actorID: String) -> String {
        "\(actorBase(teamID: teamID, actorID: actorID))/state"
    }
}
