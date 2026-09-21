import Foundation
import SwiftData

@Model
public final class CachedActor {
    @Attribute(.unique) public var actorId: String
    public var teamId: String
    public var actorType: String
    public var userId: String?
    public var invitedByActorId: String?
    public var displayName: String
    public var avatarURL: String?
    public var lastActiveAt: Date?
    public var createdAt: Date
    public var updatedAt: Date
    public var memberStatus: String?
    /// Org role assignments (`roles_users`). Source of truth for role display —
    /// see [ActorRoleRef]. Defaulted so rows written by an earlier schema
    /// version migrate in as "no roles cached yet" and fall back to `teamRole`.
    public var roles: [ActorRoleRef] = []
    /// Transitional highest-privilege derivation. Read only as a fallback when
    /// `roles` is empty.
    public var teamRole: String?
    public var agentTypes: [String]
    public var agentKind: String?
    public var defaultAgentType: String?
    public var agentStatus: String?
    public var defaultWorkspaceId: String?

    // Member contact — nil for agents and anonymous members.
    public var email: String?
    public var phone: String?

    public init(
        actorId: String, teamId: String, actorType: String,
        userId: String? = nil, invitedByActorId: String? = nil,
        displayName: String, avatarURL: String? = nil, lastActiveAt: Date? = nil,
        createdAt: Date = .now, updatedAt: Date = .now,
        memberStatus: String? = nil, roles: [ActorRoleRef] = [], teamRole: String? = nil,
        agentTypes: [String] = [], agentKind: String? = nil, defaultAgentType: String? = nil,
        agentStatus: String? = nil, defaultWorkspaceId: String? = nil,
        email: String? = nil, phone: String? = nil
    ) {
        self.actorId = actorId; self.teamId = teamId; self.actorType = actorType
        self.userId = userId; self.invitedByActorId = invitedByActorId
        self.displayName = displayName; self.avatarURL = avatarURL; self.lastActiveAt = lastActiveAt
        self.createdAt = createdAt; self.updatedAt = updatedAt
        self.memberStatus = memberStatus; self.roles = roles; self.teamRole = teamRole
        self.agentTypes = agentTypes; self.agentKind = agentKind; self.defaultAgentType = defaultAgentType
        self.agentStatus = agentStatus; self.defaultWorkspaceId = defaultWorkspaceId
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
                               isCurrentUser: currentActorID != nil && currentActorID == actorId,
                               devicePresence: devicePresence)
    }
    public var roleLabel: String {
        ActorRoleResolution.roleLabel(isMember: isMember, roles: roles, teamRole: teamRole)
    }

    /// Every org role to render as a chip, with a synthetic "member" chip when
    /// the member has no binding — a member row is never chip-less.
    public var displayRoles: [ActorRoleRef] {
        ActorRoleResolution.displayRoles(isMember: isMember, roles: roles, teamRole: teamRole)
    }
}
