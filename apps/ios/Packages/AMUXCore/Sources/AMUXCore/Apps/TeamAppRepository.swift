import Foundation

/// The slice of the Apps API this client speaks.
///
/// Deliberately small. Deploying, seeding, env vars, cron and the data browser
/// all need the local daemon or a desktop-sized surface; what a phone is good
/// for is seeing what the team has and opening it.
public protocol TeamAppRepository: Sendable {
    func listApps(teamID: String) async throws -> [TeamAppRecord]
    func getApp(appID: String) async throws -> TeamAppRecord
    /// Inserts the row. The app comes back at `repo_created`, not `ready` —
    /// see `TeamAppRecord.needsDesktopSetup`.
    func createApp(teamID: String, input: TeamAppCreateInput) async throws -> TeamAppRecord
    func listAppSessions(appID: String) async throws -> [TeamAppSessionRecord]
}

public struct TeamAppCreateInput: Equatable, Sendable {
    public var name: String
    public var type: TeamAppType
    public var visibility: TeamAppVisibility

    public init(name: String, type: TeamAppType = .staticWeb, visibility: TeamAppVisibility = .personal) {
        self.name = name
        self.type = type
        self.visibility = visibility
    }
}

public enum TeamAppRepositoryError: LocalizedError {
    case missingName
    case notFound

    public var errorDescription: String? {
        switch self {
        case .missingName:
            return "请先给应用起个名字。"
        case .notFound:
            // The server answers 404 both for "gone" and for "you may not see
            // it", so the message must not promise which one it was.
            return "打不开这个应用，它可能已被删除，或者你没有访问权限。"
        }
    }
}
