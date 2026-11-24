import Foundation

/// `public.users.admin_type` — an identity tier, not a permission (ADR-0016).
/// Mirrors services/fc/src/lib/admin-type.ts. Clients only label with it; what
/// someone may do comes from org roles.
public enum AdminType: Int, Sendable {
    case guest = 1
    case member = 2
    case creator = 3
    case platformOperator = 4

    /// The label an identity carries, or nil for an ordinary member (the norm)
    /// and unknown values. A client cannot tell whether a 4 sits in the
    /// platform org, so the label is a hint, not a grant.
    public static func label(for rawValue: Int) -> String? {
        switch AdminType(rawValue: rawValue) {
        case .guest: return String(localized: "Guest")
        case .creator: return String(localized: "Creator")
        case .platformOperator: return String(localized: "Platform operator")
        case .member, .none: return nil
        }
    }
}
