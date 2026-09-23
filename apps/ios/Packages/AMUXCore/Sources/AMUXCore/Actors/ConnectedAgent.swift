import Foundation

public struct ConnectedAgent: Identifiable, Hashable, Sendable {
    public let id: String
    public let displayName: String
    public let agentTypes: [String]
    public let agentKind: String
    /// Preferred LLM backend for this agent. Nil = daemon's compiled-in default.
    public let defaultAgentType: String?
    public let permissionLevel: String
    public let visibility: String
    public let isOwner: Bool
    public let lastActiveAt: Date?

    public init(id: String, displayName: String, agentTypes: [String] = [], agentKind: String = "",
                defaultAgentType: String? = nil,
                permissionLevel: String, lastActiveAt: Date?,
                visibility: String = "team",
                isOwner: Bool = false) {
        self.id = id
        self.displayName = displayName
        self.agentTypes = agentTypes
        self.agentKind = agentKind
        self.defaultAgentType = defaultAgentType
        self.permissionLevel = permissionLevel
        self.visibility = visibility
        self.isOwner = isOwner
        self.lastActiveAt = lastActiveAt
    }

    /// Heartbeat-only presence. Prefer `isOnline(devicePresence:)` wherever an
    /// `AgentPresenceStore` is in reach — the broker knows sooner.
    public var isOnline: Bool { isOnline(devicePresence: .unknown) }

    public func isOnline(devicePresence: AgentDevicePresence) -> Bool {
        ActorPresence.isOnline(actorType: "agent",
                               lastActiveAt: lastActiveAt,
                               devicePresence: devicePresence)
    }
}

public struct AgentAuthorizedHuman: Identifiable, Hashable, Sendable {
    public let id: String
    public let displayName: String
    public let permissionLevel: String
    public let grantedByActorID: String?
    public let lastActiveAt: Date?

    public init(id: String, displayName: String, permissionLevel: String,
                grantedByActorID: String?, lastActiveAt: Date?) {
        self.id = id
        self.displayName = displayName
        self.permissionLevel = permissionLevel
        self.grantedByActorID = grantedByActorID
        self.lastActiveAt = lastActiveAt
    }

    public var isOnline: Bool {
        ActorPresence.isOnline(actorType: "member", lastActiveAt: lastActiveAt)
    }
}
