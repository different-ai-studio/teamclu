import Foundation

/// `/v1/apps` — the read side of the Apps module, plus creating a row.
///
/// In its own file rather than in `CloudAPIRepositories.swift`: that file is
/// already past 1500 lines, and nothing here is shared with the repositories
/// living in it.
public actor CloudAPITeamAppRepository: TeamAppRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func listApps(teamID: String) async throws -> [TeamAppRecord] {
        // No cursor on this endpoint — the server caps at `limit` and orders
        // newest first. 100 is its own default, restated so a later change to
        // that default does not silently change what a phone shows.
        let page: CloudTeamAppList = try await client.get(
            "/v1/apps?teamId=\(Self.enc(teamID))&limit=100"
        )
        return page.items.map(\.record)
    }

    public func getApp(appID: String) async throws -> TeamAppRecord {
        do {
            let row: CloudTeamApp = try await client.get("/v1/apps/\(Self.enc(appID))")
            return row.record
        } catch let error as CloudAPIError {
            // The server returns 404 for "not visible to you" as well as for
            // "deleted", on purpose — it will not confirm an app exists to
            // someone who may not see it. Translate it once here so callers
            // do not each re-interpret the status code.
            if case .requestFailed(let status, _, _) = error, status == 404 {
                throw TeamAppRepositoryError.notFound
            }
            throw error
        }
    }

    public func createApp(teamID: String, input: TeamAppCreateInput) async throws -> TeamAppRecord {
        let name = input.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw TeamAppRepositoryError.missingName }
        let body = CloudTeamAppCreateRequest(
            teamId: teamID,
            name: name,
            type: input.type.rawValue,
            visibility: input.visibility.rawValue
        )
        let row: CloudTeamApp = try await client.post("/v1/apps", body: body)
        return row.record
    }

    public func listAppSessions(appID: String) async throws -> [TeamAppSessionRecord] {
        let page: CloudTeamAppSessionList = try await client.get(
            "/v1/apps/\(Self.enc(appID))/sessions"
        )
        return page.items.map(\.record)
    }

    private static func enc(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}

// MARK: - Wire shapes

private struct CloudTeamAppList: Decodable, Sendable {
    let items: [CloudTeamApp]
}

private struct CloudTeamAppSessionList: Decodable, Sendable {
    let items: [CloudTeamAppSession]
}

private struct CloudTeamAppCreateRequest: Encodable, Sendable {
    let teamId: String
    let name: String
    let type: String
    let visibility: String
}

private struct CloudTeamApp: Decodable, Sendable {
    let id: String
    let teamId: String
    let createdByActorId: String?
    let name: String
    let slug: String?
    let type: String?
    let visibility: String?
    let provisionStatus: String?
    let fcStatus: String?
    let publicUrl: String?
    let fcEndpoint: String?
    let gitRemoteUrl: String?
    let gitAuthKind: String?
    let relationship: String?
    let createdAt: String?
    let updatedAt: String?

    var record: TeamAppRecord {
        TeamAppRecord(
            id: id,
            teamID: teamId,
            createdByActorID: createdByActorId,
            name: name,
            slug: slug ?? "",
            // An unrecognised type is shown as an import rather than guessed
            // at: `imported` is the one type that makes no claim about what is
            // inside, so a server that adds a type does not have this client
            // mislabelling it as a static site.
            type: TeamAppType(rawValue: type ?? "") ?? .imported,
            visibility: TeamAppVisibility(rawValue: visibility ?? "") ?? .personal,
            // Falling back to `pending` keeps an unknown status on the
            // conservative side of `needsDesktopSetup`, so the UI offers the
            // desktop hint rather than a deploy affordance that would 409.
            provisionStatus: TeamAppProvisionStatus(rawValue: provisionStatus ?? "") ?? .pending,
            // `nil` is meaningful here (never deployed) and must survive, so
            // there is no fallback: an unknown string reads as never-deployed.
            fcStatus: fcStatus.flatMap(TeamAppFcStatus.init(rawValue:)),
            publicURL: publicUrl.flatMap(URL.init(string:)),
            fcEndpoint: fcEndpoint.flatMap(URL.init(string:)),
            gitRemoteURL: gitRemoteUrl,
            gitAuthKind: gitAuthKind,
            relationship: TeamAppRelationship(rawValue: relationship ?? "") ?? .team,
            createdAt: parseCloudDate(createdAt) ?? .distantPast,
            updatedAt: parseCloudDate(updatedAt) ?? .distantPast
        )
    }
}

private struct CloudTeamAppSession: Decodable, Sendable {
    let id: String
    let teamId: String
    let title: String?
    let mode: String?
    let lastMessageAt: String?
    let createdAt: String?
    let updatedAt: String?

    var record: TeamAppSessionRecord {
        TeamAppSessionRecord(
            id: id,
            teamID: teamId,
            title: title ?? "",
            mode: mode ?? "",
            lastMessageAt: parseCloudDate(lastMessageAt),
            createdAt: parseCloudDate(createdAt) ?? .distantPast,
            updatedAt: parseCloudDate(updatedAt) ?? .distantPast
        )
    }
}
