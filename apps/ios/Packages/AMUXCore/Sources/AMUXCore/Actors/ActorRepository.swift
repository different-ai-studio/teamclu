import Foundation

public enum InviteKind: String, Codable, Sendable { case member, agent }
public enum TeamRole:   String, Codable, Sendable { case member, admin }

public struct InviteCreateInput: Equatable, Sendable {
    public let kind: InviteKind
    public let displayName: String
    public let teamRole: TeamRole?
    public let agentKind: String?
    public let ttlSeconds: Int
    /// When non-nil, the claim rotates credentials on this existing actor
    /// instead of creating a new one — the "re-invite" flow from
    /// ActorDetailView. Valid for `.agent`, and for `.member` when the
    /// target user is anonymous (`auth.users.is_anonymous = true`).
    public let targetActorID: String?

    public init(
        kind: InviteKind,
        displayName: String,
        teamRole: TeamRole? = nil,
        agentKind: String? = nil,
        ttlSeconds: Int = 604_800,
        targetActorID: String? = nil
    ) {
        self.kind = kind; self.displayName = displayName
        self.teamRole = teamRole; self.agentKind = agentKind
        self.ttlSeconds = ttlSeconds
        self.targetActorID = targetActorID
    }
}

public struct InviteCreated: Equatable, Sendable {
    public let token: String
    public let expiresAt: Date
    public let deeplink: String

    /// - Parameter cloudAPIURL: the endpoint this invite was minted against.
    ///   It rides along in the link so the invitee's onboarding reaches the
    ///   right backend without being told to type an address — the same
    ///   `cloud_api_url` parameter the daemon already reads off an agent invite
    ///   (`apps/daemon/src/onboarding/invite_url.rs`). Optional so callers with
    ///   no endpoint resolved emit the bare link rather than a lie.
    public init(token: String, expiresAt: Date, deeplink: String, cloudAPIURL: URL? = nil) {
        self.token = token
        self.expiresAt = expiresAt
        self.deeplink = Self.appDeeplink(from: deeplink, cloudAPIURL: cloudAPIURL)
    }

    private static func appDeeplink(from deeplink: String, cloudAPIURL: URL?) -> String {
        // The backend mints `amux://`, a scheme no build registers with the OS.
        var link = deeplink.hasPrefix("amux://")
            ? "teamclu://" + deeplink.dropFirst("amux://".count)
            : deeplink
        guard let cloudAPIURL, !link.isEmpty, !link.contains("cloud_api_url=") else { return link }
        let base = cloudAPIURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let encoded = base.addingPercentEncoding(withAllowedCharacters: .alphanumerics)
        else { return link }
        link += link.contains("?") ? "&" : "?"
        return link + "cloud_api_url=" + encoded
    }
}

public struct ClaimResult: Equatable, Sendable {
    public let actorID: String
    public let teamID: String
    public let actorType: String
    public let displayName: String
    public let refreshToken: String?   // non-nil only for kind='agent'

    public init(actorID: String, teamID: String, actorType: String,
                displayName: String, refreshToken: String?) {
        self.actorID = actorID; self.teamID = teamID
        self.actorType = actorType; self.displayName = displayName
        self.refreshToken = refreshToken
    }
}

public struct AgentDefaults: Equatable, Sendable {
    public let agentID: String
    public let defaultWorkspaceID: String?
    public let agentKind: String?
    public let defaultAgentType: String?
    public init(agentID: String, defaultWorkspaceID: String?, agentKind: String?,
                defaultAgentType: String? = nil) {
        self.agentID = agentID
        self.defaultWorkspaceID = defaultWorkspaceID
        self.agentKind = agentKind
        self.defaultAgentType = defaultAgentType
    }
}

public enum ActorRepositoryError: LocalizedError {
    case missingDisplayName
    case missingAgentKind
    case missingTeamRole
    case unsupportedAvatarContentType(String)
    case emptyResponse(String)

    public var errorDescription: String? {
        switch self {
        case .missingDisplayName: return "Display name is required."
        case .missingAgentKind:   return "Agent kind is required."
        case .missingTeamRole:    return "Team role is required."
        case .unsupportedAvatarContentType(let contentType):
            return "Unsupported avatar content type: \(contentType)."
        case .emptyResponse(let fn): return "\(fn) returned no rows."
        }
    }
}

/// Result of graduating the account out of the shared default org (org name +
/// contact -> own org, team reparented + renamed). See
/// docs/specs/2026-06-17-teamclu-phone-login-and-tenancy.md §8.
public struct OrgUpgradeResult: Sendable {
    public let orgID: String
    public let teamID: String
    public let teamName: String
    public init(orgID: String, teamID: String, teamName: String) {
        self.orgID = orgID; self.teamID = teamID; self.teamName = teamName
    }
}

public protocol ActorRepository: Sendable {
    func listActors(teamID: String) async throws -> [ActorRecord]
    func createInvite(teamID: String, input: InviteCreateInput) async throws -> InviteCreated
    /// Graduate the account into its own org (create org + reparent/rename team).
    func upgradeAccount(teamID: String, orgName: String, contact: String?) async throws -> OrgUpgradeResult
    func claimInvite(token: String) async throws -> ClaimResult
    func heartbeat() async throws
    func removeActor(actorID: String) async throws
    func uploadAvatar(actorID: String, imageData: Data, contentType: String) async throws -> String
    func updateCurrentActorProfile(actorID: String, displayName: String, avatarURL: String?) async throws -> ActorRecord
    func updateAgentDefaults(actorID: String, defaultWorkspaceID: String?, agentKind: String?,
                             defaultAgentType: String?) async throws -> AgentDefaults
    /// The calling member's default agent id for a team (nil if unset).
    func getMemberDefaultAgent(teamID: String) async throws -> String?
    /// Set (agentID) or clear (nil) the calling member's default agent. Returns the new value.
    func setMemberDefaultAgent(teamID: String, agentID: String?) async throws -> String?
    /// The team-level default agent id (nil if unset). Any member may read.
    func getTeamDefaultAgent(teamID: String) async throws -> String?
    /// Set (agentID) or clear (nil) the team default agent. Owner/admin only (server-enforced). Returns the new value.
    func setTeamDefaultAgent(teamID: String, agentID: String?) async throws -> String?
    /// The calling member's effective default (member default, else team default, else nil).
    func getEffectiveDefaultAgent(teamID: String) async throws -> String?
}
