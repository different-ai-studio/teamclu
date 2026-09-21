import Foundation

public struct ActorRecord: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let teamID: String
    public let actorType: String
    public let userID: String?
    public let invitedByActorID: String?
    public let displayName: String
    public let avatarURL: String?
    public let lastActiveAt: Date?
    public let createdAt: Date
    public let updatedAt: Date

    public let memberStatus: String?
    /// Org role assignments (`roles_users`). Source of truth for role display —
    /// see [ActorRoleRef].
    public let roles: [ActorRoleRef]
    /// Transitional highest-privilege derivation. Read only as a fallback when
    /// `roles` is empty.
    public let teamRole: String?

    public let agentTypes: [String]
    public let agentKind: String?
    public let defaultAgentType: String?
    public let agentStatus: String?
    public let defaultWorkspaceID: String?

    // Member contact — nil for agents and anonymous members.
    public let email: String?
    public let phone: String?

    public init(
        id: String, teamID: String, actorType: String,
        userID: String?, invitedByActorID: String?,
        displayName: String, avatarURL: String? = nil, lastActiveAt: Date?,
        createdAt: Date, updatedAt: Date,
        memberStatus: String?, roles: [ActorRoleRef] = [], teamRole: String?,
        agentTypes: [String] = [], agentKind: String? = nil, defaultAgentType: String? = nil,
        agentStatus: String?, defaultWorkspaceID: String? = nil,
        email: String? = nil, phone: String? = nil
    ) {
        self.id = id; self.teamID = teamID; self.actorType = actorType
        self.userID = userID; self.invitedByActorID = invitedByActorID
        self.displayName = displayName; self.avatarURL = avatarURL; self.lastActiveAt = lastActiveAt
        self.createdAt = createdAt; self.updatedAt = updatedAt
        self.memberStatus = memberStatus; self.roles = roles; self.teamRole = teamRole
        self.agentTypes = agentTypes; self.agentKind = agentKind; self.defaultAgentType = defaultAgentType
        self.agentStatus = agentStatus; self.defaultWorkspaceID = defaultWorkspaceID
        self.email = email; self.phone = phone
    }

    public var isMember: Bool { actorType == "member" }
    public var isAgent: Bool  { actorType == "agent" }
    public var isOwner: Bool  { ActorRoleResolution.hasRole("owner", roles: roles, teamRole: teamRole) }
    public var isAdmin: Bool  { ActorRoleResolution.hasRole("admin", roles: roles, teamRole: teamRole) }

    /// Presence without knowing who is signed in — see
    /// `isOnline(currentActorID:)` for the caller-aware form.
    public var isOnline: Bool { isOnline(currentActorID: nil) }

    public func isOnline(currentActorID: String?,
                         devicePresence: AgentDevicePresence = .unknown) -> Bool {
        ActorPresence.isOnline(actorType: actorType,
                               lastActiveAt: lastActiveAt,
                               isCurrentUser: currentActorID != nil && currentActorID == id,
                               devicePresence: devicePresence)
    }

    public var roleLabel: String {
        ActorRoleResolution.roleLabel(isMember: isMember, roles: roles, teamRole: teamRole)
    }
}
