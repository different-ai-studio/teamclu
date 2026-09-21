import Foundation

/// One org role assignment on a member — `public.roles_users` joined to
/// `public.roles`, as the Cloud API serves it in `Actor.roles`.
///
/// This, not `teamRole`, is the source of truth for role display. Permissions
/// moved to the org in 2026-09; `teamRole` is only the transitional "highest
/// privilege" derivation, and the contract says so in as many words —
/// "Legacy callers may read this; new UI must use `roles`"
/// (`docs/openapi/teamclu-api.v1.yaml`, `Actor.teamRole`). It is also lossy: a
/// member holding `finance` or a custom org role collapses to a code the old
/// three-way label mapping rendered as "—".
public struct ActorRoleRef: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let code: String
    public let name: String

    public init(id: String, code: String, name: String) {
        self.id = id
        self.code = code
        self.name = name
    }

    /// Seeded system codes get a localized label; a custom role keeps the name
    /// the org gave it (falling back to the code if that name came back empty).
    public var label: String {
        switch code {
        case "owner":   return String(localized: "Owner")
        case "admin":   return String(localized: "Admin")
        case "member":  return String(localized: "Member")
        case "finance": return String(localized: "Finance")
        default:        return name.isEmpty ? code : name
        }
    }
}

public extension Array where Element == ActorRoleRef {
    /// Mirrors FC's `deriveHighestTeamRole`: `owner > admin > finance > member`,
    /// custom codes last. Keeping the same order means the label this renders
    /// and the `teamRole` the server derives never disagree.
    var highestPrivilege: ActorRoleRef? {
        func rank(_ code: String) -> Int {
            switch code {
            case "owner":   return 0
            case "admin":   return 1
            case "finance": return 2
            case "member":  return 3
            default:        return 99
            }
        }
        return self.min { rank($0.code) < rank($1.code) }
    }

    func contains(code: String) -> Bool {
        contains { $0.code == code }
    }
}

/// Role reads shared by `ActorRecord` (network) and `CachedActor` (SwiftData),
/// so the two can never drift on what "owner" means.
enum ActorRoleResolution {
    /// `roles` wins. `teamRole` is only consulted when the roles array is empty
    /// — a cold cache row written before this field existed, or the onboarding
    /// bootstrapper's local stand-in.
    static func hasRole(_ code: String, roles: [ActorRoleRef], teamRole: String?) -> Bool {
        if roles.contains(code: code) { return true }
        return roles.isEmpty && teamRole == code
    }

    /// Label for the member's highest-privilege role. Members with no binding
    /// at all read as "Member", matching the `current_team_role` SQL fallback
    /// that every server-side guard already relies on. Non-members have no org
    /// role by construction, so they get the em dash.
    static func roleLabel(isMember: Bool, roles: [ActorRoleRef], teamRole: String?) -> String {
        guard isMember else { return "—" }
        if let best = roles.highestPrivilege { return best.label }
        switch teamRole {
        case "owner":   return String(localized: "Owner")
        case "admin":   return String(localized: "Admin")
        case "finance": return String(localized: "Finance")
        default:        return String(localized: "Member")
        }
    }

    /// Every role to show as a chip. Falls back to a synthetic "member" chip so
    /// a member row is never chip-less — the same shape `ActorDetailContent.tsx`
    /// uses on web.
    static func displayRoles(isMember: Bool, roles: [ActorRoleRef], teamRole: String?) -> [ActorRoleRef] {
        guard isMember else { return [] }
        if !roles.isEmpty { return roles }
        let code = teamRole ?? "member"
        return [ActorRoleRef(id: "_fallback-\(code)", code: code, name: code)]
    }
}
