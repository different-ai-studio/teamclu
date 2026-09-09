import Foundation

public actor CloudAPITeamRepository: TeamRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func loadDetails(teamID: String) async throws -> TeamDetails {
        let row: CloudTeam = try await client.get("/v1/teams/\(teamID)")
        return TeamDetails(
            id: row.id,
            name: row.name,
            slug: row.slug ?? "",
            createdAt: parseCloudDate(row.createdAt) ?? .distantPast,
            ownerDisplayName: nil,
            orgName: row.orgName
        )
    }
}

public actor CloudAPISessionsRepository: SessionsRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func listSessions(teamID: String) async throws -> [SessionRecord] {
        try await CloudSessionPager.allPages(client: client, teamID: teamID).map { row in
            SessionRecord(
                id: row.id,
                teamID: row.teamId,
                ideaID: row.ideaId,
                createdByActorID: row.createdByActorId ?? "",
                primaryAgentID: row.primaryAgentId,
                mode: row.mode,
                title: row.title,
                summary: row.summary ?? "",
                participantCount: row.participantCount,
                lastMessagePreview: row.lastMessagePreview ?? "",
                lastMessageAt: parseCloudDate(row.lastMessageAt),
                createdAt: parseCloudDate(row.createdAt) ?? .distantPast,
                source: row.source
            )
        }
    }

    public func fetchUnreadFlags(teamID: String, limit: Int) async throws -> [String: Bool] {
        let page: CloudPage<CloudSession> = try await client.get(
            "/v1/sessions?teamId=\(urlEncoded(teamID))&limit=\(limit)"
        )
        return page.items.reduce(into: [String: Bool]()) { acc, row in
            acc[row.id] = row.hasUnread
        }
    }

    public func markSessionViewed(sessionId: String, lastReadMessageId: String?) async throws {
        let body = CloudMarkViewedRequest(lastReadMessageId: lastReadMessageId)
        try await client.postVoid("/v1/sessions/\(sessionId)/mark-viewed", body: body)
    }

    public func markSessionUnread(sessionId: String) async throws {
        // FC resolves the actor from the bearer token; the empty JSON body
        // just keeps the shared postVoid encoder path.
        try await client.postVoid("/v1/sessions/\(sessionId)/mark-unread", body: CloudEmptyBody())
    }

    public func renameSession(sessionId: String, title: String) async throws {
        let encoded = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
        try await client.patchVoid(
            "/v1/sessions/\(encoded)",
            body: CloudSessionRenameRequest(title: title)
        )
    }

    public func setSessionArchived(sessionId: String, archivedAt: Date?) async throws {
        let encoded = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
        try await client.patchVoid(
            "/v1/sessions/\(encoded)",
            body: CloudSessionArchiveRequest(archivedAt: archivedAt)
        )
    }
}

private struct CloudSessionRenameRequest: Encodable, Sendable {
    let title: String
}

/// `archivedAt` always encodes — an explicit JSON null clears the flag, which
/// a plain optional would silently omit (and the server would then treat the
/// patch as a no-op).
private struct CloudSessionArchiveRequest: Encodable, Sendable {
    let archivedAt: Date?

    private enum CodingKeys: String, CodingKey { case archivedAt }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let archivedAt {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            try container.encode(formatter.string(from: archivedAt), forKey: .archivedAt)
        } else {
            try container.encodeNil(forKey: .archivedAt)
        }
    }
}

public actor CloudAPISessionIDsRepository: SessionIDsRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func listSessionIDs(teamID: String) async throws -> Set<String> {
        Set(try await CloudSessionPager.allPages(client: client, teamID: teamID).map(\.id))
    }
}

/// Walks `GET /v1/sessions?teamId=…` to exhaustion.
///
/// This replaced `GET /v1/teams/:teamID/sessions`, which returned a team's
/// entire session list in one unpaginated response — and blew up once a team
/// grew past a couple hundred sessions, because the server built its
/// participant-count query by putting every session id in a URL. The
/// replacement is capped at 100 rows per page, so callers that genuinely want
/// the whole list have to page for it.
private enum CloudSessionPager {
    /// Matches the server-side cap in `parseLimit` (MAX_LIST_LIMIT); asking for
    /// more is a 400, not a bigger page.
    private static let pageSize = 100

    /// Stops after this many pages so a server that keeps handing back a cursor
    /// cannot spin the client forever. 100 pages x 100 rows is far beyond any
    /// real team, so hitting it means something is wrong, not that the team is
    /// large.
    private static let maxPages = 100

    static func allPages(client: CloudAPIClient, teamID: String) async throws -> [CloudSessionFull] {
        var all: [CloudSessionFull] = []
        var cursor: String?
        var pages = 0

        repeat {
            var path = "/v1/sessions?teamId=\(urlEncoded(teamID))&limit=\(pageSize)"
            if let cursor { path += "&cursor=\(urlEncoded(cursor))" }

            let page: CloudPage<CloudSessionFull> = try await client.get(path)
            all.append(contentsOf: page.items)
            cursor = page.nextCursor
            pages += 1
        } while cursor != nil && pages < maxPages

        return all
    }

}

/// RFC 3986 unreserved set. Deliberately not `.alphanumerics` (which would
/// escape the hyphens in a uuid) nor `.urlQueryAllowed` (which passes `&`
/// and `=` through and would let a value forge extra query parameters).
private let cloudQueryUnreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
)

private func urlEncoded(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: cloudQueryUnreserved) ?? value
}

public actor CloudAPISessionRepository: SessionRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func createSession(_ input: SessionCreateInput) async throws {
        let title = input.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw SessionRepositoryError.missingTitle }
        guard !input.participants.isEmpty else { throw SessionRepositoryError.missingParticipants }

        let body = CloudSessionCreateRequest(
            id: input.id,
            teamId: input.teamID,
            title: title,
            mode: input.mode,
            ideaId: Self.normalized(input.ideaID),
            primaryAgentActorId: Self.normalized(input.primaryAgentID),
            participantActorIds: input.participants.map(\.actorID)
        )
        // FC derives created_by from the bearer actor; per-participant roles
        // are not expressed by SessionCreate (participantActorIds is a flat
        // uuid[]) and are intentionally dropped.
        try await client.postVoid("/v1/sessions", body: body, idempotencyKey: input.id)
        AnalyticsSink.track("session_created", [
            "mode": input.mode,
            "participantCount": String(input.participants.count),
        ])
    }

    public func addParticipants(sessionID: String, actorIDs: [String]) async throws {
        let encodedSession = Self.encodePath(sessionID)
        for actorID in actorIDs {
            let trimmed = actorID.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            // FC's participants POST is single-actor + idempotent (upsert on
            // session_id,actor_id), so we loop one call per actor.
            try await client.postVoid(
                "/v1/sessions/\(encodedSession)/participants",
                body: CloudUpsertParticipantRequest(actorId: trimmed)
            )
        }
    }

    public func listSessionParticipants(sessionID: String) async throws -> [SessionParticipantRecord] {
        let encodedSession = Self.encodePath(sessionID)
        let page: CloudPage<CloudSessionParticipant> = try await client.get("/v1/sessions/\(encodedSession)/participants")
        return page.items.map { row in
            SessionParticipantRecord(
                id: "\(row.sessionId):\(row.actorId)",
                sessionID: row.sessionId,
                actorID: row.actorId,
                role: row.role,
                displayName: row.displayName ?? "",
                actorType: row.actorType ?? "",
                workspaceID: row.workspaceId,
                model: row.model
            )
        }
    }

    public func removeParticipant(sessionID: String, actorID: String) async throws {
        let encodedSession = Self.encodePath(sessionID)
        let encodedActor = Self.encodePath(actorID)
        try await client.deleteVoid("/v1/sessions/\(encodedSession)/participants/\(encodedActor)")
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func encodePath(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}

public actor CloudAPIWorkspaceRepository: WorkspaceRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func listWorkspaces(teamID: String, agentID: String?) async throws -> [WorkspaceRecord] {
        var query = "teamId=\(Self.encode(teamID))&limit=200"
        if let agentID, !agentID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            query += "&agentId=\(Self.encode(agentID))"
        }
        let page: CloudPage<CloudWorkspace> = try await client.get("/v1/workspaces?\(query)")
        return page.items.map { row in
            WorkspaceRecord(
                id: row.id,
                teamID: row.teamId,
                agentID: row.agentId,
                path: row.resolvedPath,
                displayName: row.name
            )
        }
    }

    public func createWorkspace(teamID: String, agentID: String, path: String) async throws -> WorkspaceRecord {
        let trimmedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = trimmedPath.split(separator: "/").last.map(String.init) ?? trimmedPath
        let body = CloudWorkspaceCreateRequest(
            teamId: teamID,
            agentId: agentID,
            name: name,
            path: trimmedPath,
            archived: false
        )
        let row: CloudWorkspace = try await client.post("/v1/workspaces", body: body)
        return WorkspaceRecord(
            id: row.id,
            teamID: row.teamId,
            agentID: row.agentId,
            path: row.resolvedPath,
            displayName: row.name
        )
    }

    private static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }
}

private struct CloudWorkspaceCreateRequest: Encodable, Sendable {
    let teamId: String
    let agentId: String
    let name: String
    let path: String
    let archived: Bool
}

public actor CloudAPIMessagesRepository: MessagesRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    private static func enc(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }

    /// The newest page of the session. Omitting a cursor no longer means "the
    /// whole history" — the server caps the page and reports `nextCursor` for
    /// older ones. Use `listPage` to walk back through them.
    public func listForSession(sessionID: String) async throws -> [MessageRecord] {
        try await listPage(sessionID: sessionID, limit: nil, cursor: nil).messages
    }

    public func listPage(sessionID: String, limit: Int?, cursor: String?) async throws -> MessagePage {
        var query: [String] = []
        if let limit { query.append("limit=\(limit)") }
        if let cursor, !cursor.isEmpty { query.append("cursor=\(Self.enc(cursor))") }
        let suffix = query.isEmpty ? "" : "?\(query.joined(separator: "&"))"
        let page: CloudPage<CloudMessage> = try await client.get(
            "/v1/sessions/\(sessionID)/messages\(suffix)"
        )
        let messages = page.items.map { row in
            MessageRecord(
                id: row.id,
                teamID: row.teamId,
                sessionID: row.sessionId,
                senderActorID: row.senderActorId ?? "",
                kind: row.kind,
                content: row.content,
                createdAt: parseCloudDate(row.createdAt) ?? .distantPast,
                updatedAt: parseCloudDate(row.updatedAt),
                model: row.model,
                turnID: row.turnId,
                replyToMessageID: row.replyToMessageId,
                mentionActorIDs: row.metadata?.mentionActorIds ?? [],
                sequence: 0
            )
        }
        return MessagePage(messages: messages, nextCursor: page.nextCursor)
    }

    public func insert(_ input: MessageInsertInput) async throws {
        let metadata: [String: [String]]? = input.mentionActorIDs.isEmpty
            ? nil
            : ["mention_actor_ids": input.mentionActorIDs]
        let body = CloudInsertMessageRequest(
            id: input.id,
            teamId: input.teamID,
            senderActorId: input.senderActorID,
            content: input.content,
            kind: input.kind,
            metadata: metadata,
            turnId: nil,
            replyToMessageId: nil,
            model: nil,
            createdAt: nil
        )
        let _: CloudMessage = try await client.post(
            "/v1/sessions/\(input.sessionID)/messages",
            body: body,
            idempotencyKey: input.id
        )
    }

    public func patch(messageID: String, content: String) async throws {
        let encoded = messageID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? messageID
        // FC echoes the updated row; decode it for contract validation but
        // discard — the caller mutates its local copy from the input.
        let _: CloudMessage = try await client.patch(
            "/v1/messages/\(encoded)",
            body: CloudPatchMessageRequest(content: content)
        )
    }

    public func delete(messageID: String) async throws {
        let encoded = messageID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? messageID
        try await client.deleteVoid("/v1/messages/\(encoded)")
    }

    public func submitFeedback(_ input: FeedbackInput) async throws {
        let body = CloudFeedbackRequest(
            messageId: input.messageID,
            actorId: input.actorID,
            teamId: input.teamID,
            sessionId: input.sessionID,
            kind: input.kind,
            starRating: input.starRating
        )
        try await client.postVoid("/v1/feedback", body: body)
    }

    public func deleteFeedback(messageID: String, actorID: String) async throws {
        let encoded = messageID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? messageID
        try await client.deleteVoid("/v1/feedback/\(encoded)?actorId=\(Self.enc(actorID))")
    }

    public func listFeedback(sessionID: String) async throws -> [FeedbackRecord] {
        let out: CloudFeedbackList = try await client.get("/v1/feedback?sessionId=\(Self.enc(sessionID))")
        return out.items.map { FeedbackRecord(messageID: $0.messageId, actorID: $0.actorId, kind: $0.kind) }
    }
}

private struct CloudFeedbackRequest: Encodable, Sendable {
    let messageId: String
    let actorId: String
    let teamId: String
    let sessionId: String?
    let kind: String
    let starRating: Int?
}

private struct CloudFeedbackList: Decodable, Sendable {
    struct Row: Decodable, Sendable {
        let messageId: String
        let actorId: String
        let kind: String
    }
    let items: [Row]
}

public actor CloudAPIShortcutsRepository: ShortcutsRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func listPersonal() async throws -> [ShortcutRecord] {
        let page: CloudPage<CloudShortcut> = try await client.get("/v1/shortcuts?scope=personal")
        return page.items.map(\.record)
    }

    public func listTeam(teamID: String) async throws -> [ShortcutRecord] {
        let encoded = teamID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? teamID
        let page: CloudPage<CloudShortcut> = try await client.get("/v1/teams/\(encoded)/shortcuts")
        return page.items.map(\.record)
    }
}

public actor CloudAPIActorRepository: ActorRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func listActors(teamID: String) async throws -> [ActorRecord] {
        let page: CloudPage<CloudActor> = try await client.get("/v1/teams/\(Self.enc(teamID))/actors?limit=500")
        return page.items.map { $0.record }
    }

    public func createInvite(teamID: String, input: InviteCreateInput) async throws -> InviteCreated {
        let displayName = input.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !displayName.isEmpty else { throw ActorRepositoryError.missingDisplayName }
        if input.kind == .member, input.teamRole == nil { throw ActorRepositoryError.missingTeamRole }
        if input.kind == .agent, (input.agentKind ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw ActorRepositoryError.missingAgentKind
        }
        let body = CloudCreateInviteRequest(
            kind: input.kind.rawValue,
            displayName: displayName,
            teamRole: input.teamRole?.rawValue,
            agentKind: input.agentKind,
            ttlSeconds: input.ttlSeconds,
            targetActorId: input.targetActorID
        )
        let row: CloudInviteCreated = try await client.post("/v1/teams/\(Self.enc(teamID))/invites", body: body)
        guard let expiresAt = parseCloudDate(row.expiresAt) else {
            throw ActorRepositoryError.emptyResponse("create_team_invite")
        }
        return InviteCreated(token: row.token, expiresAt: expiresAt, deeplink: row.deeplink ?? "",
                             cloudAPIURL: client.baseURL)
    }

    public func upgradeAccount(teamID: String, orgName: String, contact: String?) async throws -> OrgUpgradeResult {
        let body = CloudUpgradeAccountRequest(teamId: teamID, orgName: orgName, contact: contact)
        let row: CloudUpgradeAccountResult = try await client.post("/v1/account/upgrade", body: body)
        return OrgUpgradeResult(orgID: row.orgId, teamID: row.teamId, teamName: row.teamName)
    }

    public func claimInvite(token: String) async throws -> ClaimResult {
        let row: CloudClaimInviteResult = try await client.post("/v1/invites/claim", body: CloudClaimInviteRequest(token: token))
        return ClaimResult(
            actorID: row.actorId, teamID: row.teamId, actorType: row.actorType,
            displayName: row.displayName, refreshToken: row.refreshToken
        )
    }

    public func heartbeat() async throws {
        try await client.postVoid("/v1/heartbeat", body: CloudEmptyBody())
    }

    public func removeActor(actorID: String) async throws {
        try await client.deleteVoid("/v1/actors/\(Self.enc(actorID))")
    }

    public func uploadAvatar(actorID: String, imageData: Data, contentType: String) async throws -> String {
        let ext: String
        switch contentType.lowercased() {
        case "image/jpeg", "image/jpg": ext = "jpg"
        case "image/png": ext = "png"
        case "image/webp": ext = "webp"
        default: throw ActorRepositoryError.unsupportedAvatarContentType(contentType)
        }
        let stamp = Int(Date().timeIntervalSince1970)
        let path = "\(actorID)/avatar-\(stamp).\(ext)"
        let result: CloudAttachmentUpload = try await client.postRaw(
            "/v1/attachments?path=\(Self.encQuery(path))&bucket=avatars",
            bytes: imageData,
            contentType: contentType
        )
        return result.url
    }

    public func updateCurrentActorProfile(actorID: String, displayName: String, avatarURL: String?) async throws -> ActorRecord {
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw ActorRepositoryError.missingDisplayName }
        let body = CloudUpdateProfileRequest(displayName: name, avatarUrl: avatarURL)
        let row: CloudActor = try await client.patch("/v1/actors/\(Self.enc(actorID))/profile", body: body)
        return row.record
    }

    public func updateAgentDefaults(actorID: String, defaultWorkspaceID: String?, agentKind: String?,
                                    defaultAgentType: String?) async throws -> AgentDefaults {
        let body = CloudUpdateAgentDefaultsRequest(
            defaultWorkspaceId: defaultWorkspaceID,
            agentKind: agentKind?.trimmingCharacters(in: .whitespacesAndNewlines),
            defaultAgentType: defaultAgentType?.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        // FC returns 204; rebuild the record from the inputs we just persisted.
        try await client.patchVoid("/v1/agents/\(Self.enc(actorID))/defaults", body: body)
        return AgentDefaults(
            agentID: actorID,
            defaultWorkspaceID: defaultWorkspaceID,
            agentKind: agentKind,
            defaultAgentType: defaultAgentType
        )
    }

    public func getMemberDefaultAgent(teamID: String) async throws -> String? {
        let row: CloudMemberDefaultAgent = try await client.get(
            "/v1/teams/\(Self.enc(teamID))/members/me/default-agent"
        )
        return row.defaultAgentId
    }

    public func setMemberDefaultAgent(teamID: String, agentID: String?) async throws -> String? {
        let body = CloudSetMemberDefaultAgentRequest(agentId: agentID)
        // FC echoes the new value; mirror updateAgentDefaults and return what we sent.
        try await client.putVoid("/v1/teams/\(Self.enc(teamID))/members/me/default-agent", body: body)
        return agentID
    }

    public func getTeamDefaultAgent(teamID: String) async throws -> String? {
        let row: CloudMemberDefaultAgent = try await client.get(
            "/v1/teams/\(Self.enc(teamID))/default-agent"
        )
        return row.defaultAgentId
    }

    public func setTeamDefaultAgent(teamID: String, agentID: String?) async throws -> String? {
        let body = CloudSetMemberDefaultAgentRequest(agentId: agentID)
        try await client.putVoid("/v1/teams/\(Self.enc(teamID))/default-agent", body: body)
        return agentID
    }

    public func getEffectiveDefaultAgent(teamID: String) async throws -> String? {
        let row: CloudMemberDefaultAgent = try await client.get(
            "/v1/teams/\(Self.enc(teamID))/members/me/effective-default-agent"
        )
        return row.defaultAgentId
    }

    private static func enc(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private static func encQuery(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }
}

public actor CloudAPIAgentAccessRepository: AgentAccessRepository {
    private let client: CloudAPIClient
    private let memberActorID: String

    public init(client: CloudAPIClient, memberActorID: String) {
        self.client = client
        self.memberActorID = memberActorID
    }

    public func listConnectedAgents(teamID: String) async throws -> [ConnectedAgent] {
        let page: CloudPage<CloudConnectedAgent> = try await client.get("/v1/teams/\(Self.enc(teamID))/agents/connected")
        return page.items.map { $0.connectedAgent }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    public func listAuthorizedHumans(agentID: String) async throws -> [AgentAuthorizedHuman] {
        let page: CloudPage<CloudAgentAccess> = try await client.get("/v1/agents/\(Self.enc(agentID))/access")
        return page.items
            .filter { ($0.actorType ?? "member") == "member" }
            .map { $0.authorizedHuman }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    public func canManageAuthorizedHumans(agentID: String) async throws -> Bool {
        // Owner-only, matching the prior owner_member_id == me semantics. The
        // permission endpoint reports the caller-scoped permission_level.
        let result: CloudAgentPermission = try await client.get(
            "/v1/agents/\(Self.enc(agentID))/permission?actorId=\(Self.enc(memberActorID))"
        )
        return result.role == "owner"
    }

    public func grantAuthorizedHuman(agentID: String, memberID: String, permissionLevel: String) async throws {
        try await client.postVoid(
            "/v1/agents/\(Self.enc(agentID))/access",
            body: CloudGrantAccessRequest(actorId: memberID, role: permissionLevel)
        )
    }

    public func shareAgentToTeam(agentID: String) async throws {
        try await client.postVoid("/v1/agents/\(Self.enc(agentID))/share-to-team", body: CloudEmptyBody())
    }

    public func makeAgentPersonal(agentID: String) async throws {
        try await client.postVoid("/v1/agents/\(Self.enc(agentID))/make-personal", body: CloudEmptyBody())
    }

    public func teamAgentCount(teamID: String) async throws -> Int {
        let page: CloudPage<CloudActorRef> = try await client.get("/v1/teams/\(Self.enc(teamID))/actors?kind=agent&limit=500")
        return page.items.count
    }

    private static func enc(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}

public actor CloudAPIIdeaRepository: IdeaRepository {
    private let client: CloudAPIClient
    private let memberActorID: String

    public init(client: CloudAPIClient, memberActorID: String) {
        self.client = client
        self.memberActorID = memberActorID
    }

    public func listIdeas(teamID: String) async throws -> [IdeaRecord] {
        var all: [CloudIdea] = []
        // FC paginates and returns one archived bucket per call; iOS wants the
        // full team list (IdeaStore splits archived locally), so follow the
        // cursor to exhaustion for both archived states.
        for archived in [false, true] {
            var cursor: String? = nil
            repeat {
                var query = "teamId=\(Self.enc(teamID))&archived=\(archived)&limit=200"
                if let cursor, !cursor.isEmpty { query += "&cursor=\(Self.enc(cursor))" }
                let page: CloudPage<CloudIdea> = try await client.get("/v1/ideas?\(query)")
                all.append(contentsOf: page.items)
                cursor = page.nextCursor
            } while cursor != nil
        }
        return all.map { $0.record }
    }

    public func createIdea(teamID: String, input: IdeaCreateInput) async throws -> IdeaRecord {
        let title = input.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw IdeaRepositoryError.missingTitle }
        let body = CloudIdeaCreateRequest(
            teamId: teamID,
            title: title,
            description: input.description,
            workspaceId: Self.normalized(input.workspaceID),
            authorActorId: memberActorID
        )
        let row: CloudIdea = try await client.post("/v1/ideas", body: body)
        return row.record
    }

    public func updateIdea(ideaID: String, input: IdeaUpdateInput) async throws -> IdeaRecord {
        let title = input.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw IdeaRepositoryError.missingTitle }
        let body = CloudIdeaUpdateRequest(
            title: title,
            description: input.description,
            status: input.status,
            workspaceId: Self.normalized(input.workspaceID)
        )
        let row: CloudIdea = try await client.patch("/v1/ideas/\(Self.enc(ideaID))", body: body)
        return row.record
    }

    public func setArchived(ideaID: String, archived: Bool) async throws -> IdeaRecord {
        try await client.postVoid("/v1/ideas/\(Self.enc(ideaID))/archive", body: CloudArchiveRequest(archived: archived))
        // Archive returns 204; re-fetch the updated idea for the protocol's record.
        let row: CloudIdea = try await client.get("/v1/ideas/\(Self.enc(ideaID))")
        return row.record
    }

    public func reorderIdeas(teamID: String, ideaIDs: [String]) async throws {
        try await client.postVoid("/v1/ideas/reorder", body: CloudReorderIdeasRequest(teamId: teamID, ideaIds: ideaIDs))
    }

    public func listIdeaActivities(ideaID: String) async throws -> [IdeaActivityRecord] {
        let page: CloudPage<CloudIdeaActivity> = try await client.get("/v1/ideas/\(Self.enc(ideaID))/activities")
        return page.items.map { $0.record }
    }

    public func createIdeaActivity(ideaID: String, input: IdeaActivityCreateInput) async throws -> IdeaActivityRecord {
        let body = CloudIdeaActivityCreateRequest(
            kind: input.activityType,
            content: input.content,
            metadata: input.metadata,
            attachmentUrls: input.attachmentURLs.map(\.absoluteString),
            actorId: memberActorID
        )
        let row: CloudIdeaActivity = try await client.post("/v1/ideas/\(Self.enc(ideaID))/activities", body: body)
        return row.record
    }

    private static func normalized(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func enc(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}

public actor CloudAPINotificationsRepository: NotificationsRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func getPrefs() async throws -> NotificationPrefsRecord? {
        // FC returns the raw snake_case prefs row, or JSON `null` when the
        // user has no row yet. Tolerate an empty body the same way — both
        // map to nil and the store falls back to defaults (enabled = true).
        do {
            let row: CloudNotificationPrefsRow? = try await client.get("/v1/notifications/prefs")
            return row?.record
        } catch is DecodingError {
            return nil
        }
    }

    public func putPrefs(_ prefs: NotificationPrefsRecord) async throws -> NotificationPrefsRecord {
        let body = CloudNotificationPrefsWrite(
            enabled: prefs.enabled,
            dndStartMin: prefs.dndStartMin,
            dndEndMin: prefs.dndEndMin,
            dndTZ: prefs.dndTZ
        )
        // FC echoes the upserted row (snake_case, server-normalized).
        let row: CloudNotificationPrefsRow = try await client.put("/v1/notifications/prefs", body: body)
        return row.record
    }

    public func listMutedSessionIDs() async throws -> Set<String> {
        let list: CloudMutedSessionsList = try await client.get("/v1/notifications/muted-sessions")
        return Set(list.items)
    }

    public func mute(sessionID: String, until: Date?) async throws {
        // `until == nil` is omitted from the body (JSONEncoder drops nil
        // keys), which FC reads as a permanent mute.
        let body = CloudMuteSessionRequest(
            until: until.map { ISO8601DateFormatter.cloudWithFractionalSeconds.string(from: $0) }
        )
        try await client.postVoid("/v1/sessions/\(Self.enc(sessionID))/mute", body: body)
    }

    public func unmute(sessionID: String) async throws {
        try await client.deleteVoid("/v1/sessions/\(Self.enc(sessionID))/mute")
    }

    private static func enc(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}


public struct ClientVersionReport: Encodable, Sendable {
    public let clientType: String
    public let version: String
    public let deviceId: String
    public let build: String?
    public init(clientType: String, version: String, deviceId: String, build: String?) {
        self.clientType = clientType
        self.version = version
        self.deviceId = deviceId
        self.build = build
    }
}

private struct OkAck: Decodable, Sendable { let ok: Bool? }

public struct CloudAPIClientVersionRepository: Sendable {
    private let client: CloudAPIClient
    public init(client: CloudAPIClient) { self.client = client }

    public func report(teamID: String, version: String, build: String?, deviceID: String) async {
        let body = ClientVersionReport(clientType: "ios", version: version, deviceId: deviceID, build: build)
        // ops telemetry only — swallow all errors so it never disrupts the app
        _ = try? await client.post("/v1/teams/\(teamID)/client-version", body: body, as: OkAck.self)
    }
}

public enum CloudAPIRepositoryFactory {
    public static func client(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> CloudAPIClient {
        CloudAPIClient(configuration: configuration, accessToken: accessToken)
    }

    public static func sessionsRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any SessionsRepository {
        CloudAPISessionsRepository(client: client(configuration: configuration, accessToken: accessToken))
    }

    public static func messagesRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any MessagesRepository {
        CloudAPIMessagesRepository(client: client(configuration: configuration, accessToken: accessToken))
    }

    public static func teamRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any TeamRepository {
        CloudAPITeamRepository(client: client(configuration: configuration, accessToken: accessToken))
    }

    public static func sessionIDsRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any SessionIDsRepository {
        CloudAPISessionIDsRepository(client: client(configuration: configuration, accessToken: accessToken))
    }


    public static func workspacesRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any WorkspaceRepository {
        CloudAPIWorkspaceRepository(client: client(configuration: configuration, accessToken: accessToken))
    }

    public static func shortcutsRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any ShortcutsRepository {
        CloudAPIShortcutsRepository(client: client(configuration: configuration, accessToken: accessToken))
    }

    public static func sessionRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any SessionRepository {
        CloudAPISessionRepository(client: client(configuration: configuration, accessToken: accessToken))
    }

    public static func ideasRepository(
        configuration: CloudAPIConfiguration,
        memberActorID: String,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any IdeaRepository {
        CloudAPIIdeaRepository(
            client: client(configuration: configuration, accessToken: accessToken),
            memberActorID: memberActorID
        )
    }

    public static func agentAccessRepository(
        configuration: CloudAPIConfiguration,
        memberActorID: String,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any AgentAccessRepository {
        CloudAPIAgentAccessRepository(
            client: client(configuration: configuration, accessToken: accessToken),
            memberActorID: memberActorID
        )
    }

    public static func teamResourceRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any TeamResourceRepository {
        CloudAPITeamResourceRepository(
            client: client(configuration: configuration, accessToken: accessToken)
        )
    }

    public static func actorRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any ActorRepository {
        CloudAPIActorRepository(client: client(configuration: configuration, accessToken: accessToken))
    }

    public static func notificationsRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any NotificationsRepository {
        CloudAPINotificationsRepository(client: client(configuration: configuration, accessToken: accessToken))
    }

    public static func clientVersion(client: CloudAPIClient) -> CloudAPIClientVersionRepository {
        CloudAPIClientVersionRepository(client: client)
    }
}

private struct CloudPage<Item: Decodable & Sendable>: Decodable, Sendable {
    let items: [Item]
    let nextCursor: String?
}

private struct CloudTeam: Decodable, Sendable {
    let id: String
    let name: String
    let slug: String?
    let createdAt: String?
    let orgName: String?
}

private struct CloudSession: Decodable, Sendable {
    let id: String
    let teamId: String
    let title: String
    let mode: String
    let ideaId: String?
    let lastMessageAt: String?
    let lastMessagePreview: String?
    let hasUnread: Bool
    let createdAt: String?
}

/// Typed view of the freeform `messages.metadata` JSON column. Only the
/// keys iOS consumes are decoded; unknown keys are ignored by `Decodable`.
private struct CloudMessageMetadata: Decodable, Sendable {
    let mentionActorIds: [String]?

    private enum CodingKeys: String, CodingKey {
        case mentionActorIds = "mention_actor_ids"
    }
}

private struct CloudMessage: Decodable, Sendable {
    let id: String
    let teamId: String
    let sessionId: String
    let turnId: String?
    let senderActorId: String?
    let replyToMessageId: String?
    let kind: String
    let content: String
    let metadata: CloudMessageMetadata?
    let model: String?
    let createdAt: String
    let updatedAt: String?
}

private struct CloudSessionFull: Decodable, Sendable {
    let id: String
    let teamId: String
    let title: String
    let mode: String
    let ideaId: String?
    let primaryAgentId: String?
    let createdByActorId: String?
    let summary: String?
    let lastMessageAt: String?
    let lastMessagePreview: String?
    let participantCount: Int
    let hasUnread: Bool
    let createdAt: String?
    let updatedAt: String?
    /// `user` | `cron` | `gateway`; absent on older servers.
    let source: String?
}

private struct CloudSessionCreateRequest: Encodable, Sendable {
    let id: String
    let teamId: String
    let title: String
    let mode: String
    let ideaId: String?
    let primaryAgentActorId: String?
    let participantActorIds: [String]
}

private struct CloudUpsertParticipantRequest: Encodable, Sendable {
    let actorId: String
}

private struct CloudSessionParticipant: Decodable, Sendable {
    let sessionId: String
    let actorId: String
    let role: String?
    let displayName: String?
    let actorType: String?
    /// The agent's working state for this session, owned by the participant row
    /// (ADR-0005). Null on member rows — not applicable rather than missing.
    let workspaceId: String?
    let model: String?
}

private struct CloudActor: Decodable, Sendable {
    let id: String
    let teamId: String?
    let kind: String?
    let displayName: String?
    let avatarUrl: String?
    let userId: String?
    let invitedByActorId: String?
    let teamRole: String?
    let memberStatus: String?
    let agentStatus: String?
    let agentTypes: [String]?
    let agentKind: String?
    let defaultAgentType: String?
    let defaultWorkspaceId: String?
    let email: String?
    let phone: String?
    let lastActiveAt: String?
    let createdAt: String?
    let updatedAt: String?

    var record: ActorRecord {
        ActorRecord(
            id: id,
            teamID: teamId ?? "",
            actorType: kind ?? "",
            userID: userId,
            invitedByActorID: invitedByActorId,
            displayName: displayName ?? "",
            avatarURL: avatarUrl,
            lastActiveAt: parseCloudDate(lastActiveAt),
            createdAt: parseCloudDate(createdAt) ?? .distantPast,
            updatedAt: parseCloudDate(updatedAt) ?? .distantPast,
            memberStatus: memberStatus,
            teamRole: teamRole,
            agentTypes: agentTypes ?? [],
            agentKind: agentKind,
            defaultAgentType: defaultAgentType,
            agentStatus: agentStatus,
            defaultWorkspaceID: defaultWorkspaceId,
            email: email,
            phone: phone
        )
    }
}

private struct CloudInviteCreated: Decodable, Sendable {
    let token: String
    let expiresAt: String?
    let deeplink: String?
}

private struct CloudAttachmentUpload: Decodable, Sendable {
    let path: String
    let url: String
}

private struct CloudCreateInviteRequest: Encodable, Sendable {
    let kind: String
    let displayName: String
    let teamRole: String?
    let agentKind: String?
    let ttlSeconds: Int
    let targetActorId: String?
}

private struct CloudUpdateProfileRequest: Encodable, Sendable {
    let displayName: String
    let avatarUrl: String?
}

private struct CloudUpgradeAccountRequest: Encodable, Sendable {
    let teamId: String
    let orgName: String
    let contact: String?
}

private struct CloudUpgradeAccountResult: Decodable, Sendable {
    let orgId: String
    let teamId: String
    let teamName: String
}

private struct CloudUpdateAgentDefaultsRequest: Encodable, Sendable {
    let defaultWorkspaceId: String?
    let agentKind: String?
    let defaultAgentType: String?
}

private struct CloudMemberDefaultAgent: Decodable, Sendable {
    let defaultAgentId: String?
}

private struct CloudSetMemberDefaultAgentRequest: Encodable, Sendable {
    let agentId: String?
}

private struct CloudConnectedAgent: Decodable, Sendable {
    let id: String
    let displayName: String?
    let agentTypes: [String]?
    let agentKind: String?
    let defaultAgentType: String?
    let permissionLevel: String?
    let visibility: String?
    let isOwner: Bool?
    let lastActiveAt: String?

    var connectedAgent: ConnectedAgent {
        ConnectedAgent(
            id: id,
            displayName: displayName ?? "",
            agentTypes: agentTypes ?? [],
            agentKind: agentKind ?? "",
            defaultAgentType: defaultAgentType,
            permissionLevel: permissionLevel ?? "",
            lastActiveAt: parseCloudDate(lastActiveAt),
            visibility: visibility ?? "team",
            isOwner: isOwner ?? false
        )
    }
}

private struct CloudAgentAccess: Decodable, Sendable {
    let actorId: String
    let memberName: String?
    let role: String?
    let permissionLevel: String?
    let grantedByMemberId: String?
    let lastActiveAt: String?
    let actorType: String?

    var authorizedHuman: AgentAuthorizedHuman {
        AgentAuthorizedHuman(
            id: actorId,
            displayName: memberName ?? actorId,
            permissionLevel: role ?? permissionLevel ?? "",
            grantedByActorID: grantedByMemberId,
            lastActiveAt: parseCloudDate(lastActiveAt)
        )
    }
}

private struct CloudAgentPermission: Decodable, Sendable {
    let allowed: Bool
    let role: String?
}

private struct CloudActorRef: Decodable, Sendable {
    let id: String
}

private struct CloudGrantAccessRequest: Encodable, Sendable {
    let actorId: String
    let role: String
}

private struct CloudEmptyBody: Encodable, Sendable {}

private struct CloudIdea: Decodable, Sendable {
    let id: String
    let teamId: String
    let workspaceId: String?
    let createdByActorId: String?
    let title: String
    let description: String?
    let status: String?
    let archived: Bool
    let sortOrder: Int?
    let createdAt: String?
    let updatedAt: String?

    var record: IdeaRecord {
        IdeaRecord(
            id: id,
            teamID: teamId,
            workspaceID: workspaceId ?? "",
            createdByActorID: createdByActorId ?? "",
            title: title,
            description: description ?? "",
            status: status ?? "open",
            archived: archived,
            sortOrder: sortOrder ?? 0,
            createdAt: parseCloudDate(createdAt) ?? .distantPast,
            updatedAt: parseCloudDate(updatedAt) ?? .distantPast
        )
    }
}

private struct CloudIdeaActivity: Decodable, Sendable {
    let id: String
    let teamId: String?
    let ideaId: String
    let actorId: String
    let activityType: String?
    let kind: String?
    let content: String?
    let metadata: [String: String]?
    let attachmentUrls: [String]?
    let createdAt: String?
    let updatedAt: String?

    var record: IdeaActivityRecord {
        IdeaActivityRecord(
            id: id,
            teamID: teamId ?? "",
            ideaID: ideaId,
            actorID: actorId,
            activityType: activityType ?? kind ?? "",
            content: content ?? "",
            metadata: metadata ?? [:],
            attachmentURLs: (attachmentUrls ?? []).compactMap(URL.init(string:)),
            createdAt: parseCloudDate(createdAt) ?? .distantPast,
            updatedAt: parseCloudDate(updatedAt) ?? .distantPast
        )
    }
}

private struct CloudIdeaCreateRequest: Encodable, Sendable {
    let teamId: String
    let title: String
    let description: String
    let workspaceId: String?
    let authorActorId: String
}

private struct CloudIdeaUpdateRequest: Encodable, Sendable {
    let title: String
    let description: String
    let status: String
    let workspaceId: String?
}

private struct CloudArchiveRequest: Encodable, Sendable {
    let archived: Bool
}

private struct CloudReorderIdeasRequest: Encodable, Sendable {
    let teamId: String
    let ideaIds: [String]
}

private struct CloudIdeaActivityCreateRequest: Encodable, Sendable {
    let kind: String
    let content: String
    let metadata: [String: String]
    let attachmentUrls: [String]
    let actorId: String
}

private struct CloudShortcut: Decodable, Sendable {
    let id: String
    let scope: String
    let ownerMemberId: String?
    let teamId: String?
    let parentId: String?
    let label: String
    let icon: String?
    let order: Int
    let nodeType: String
    let target: String
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, scope, label, icon, order, target
        case ownerMemberId = "owner_member_id"
        case teamId = "team_id"
        case parentId = "parent_id"
        case nodeType = "node_type"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    var record: ShortcutRecord {
        ShortcutRecord(
            id: id,
            scope: ShortcutScope(rawValue: scope) ?? .personal,
            ownerMemberID: ownerMemberId,
            teamID: teamId,
            parentID: parentId,
            label: label,
            icon: icon,
            order: order,
            type: ShortcutNodeType(rawValue: nodeType) ?? .native,
            target: target,
            createdAt: parseCloudDate(createdAt) ?? .distantPast,
            updatedAt: parseCloudDate(updatedAt) ?? .distantPast
        )
    }
}

private struct CloudWorkspace: Decodable, Sendable {
    let id: String
    let teamId: String
    let name: String
    let path: String?
    /// The Cloud API sends the local directory as both `path` and `slug`; some
    /// backends only fill `slug`. Desktop and the daemon already fall back to
    /// it, so `resolvedPath` keeps iOS from rendering pathless workspaces.
    let slug: String?
    let agentId: String?

    var resolvedPath: String { path ?? slug ?? "" }
}

private struct CloudMarkViewedRequest: Encodable, Sendable {
    let lastReadMessageId: String?
}

private struct CloudPatchMessageRequest: Encodable, Sendable {
    let content: String
}

private struct CloudInsertMessageRequest<Metadata: Encodable & Sendable>: Encodable, Sendable {
    let id: String
    let teamId: String
    let senderActorId: String
    let content: String
    let kind: String
    let metadata: Metadata?
    let turnId: String?
    let replyToMessageId: String?
    let model: String?
    let createdAt: String?
}

// The notifications endpoints are the one Cloud API surface that speaks raw
// snake_case on the wire (FC returns the DB row unmapped, matching the
// desktop client); every other DTO in this file is camelCase. Keep explicit
// CodingKeys here instead of flipping the decoder's key strategy.
private struct CloudNotificationPrefsRow: Decodable, Sendable {
    let enabled: Bool?
    let dndStartMin: Int?
    let dndEndMin: Int?
    let dndTZ: String?

    enum CodingKeys: String, CodingKey {
        case enabled
        case dndStartMin = "dnd_start_min"
        case dndEndMin = "dnd_end_min"
        case dndTZ = "dnd_tz"
    }

    var record: NotificationPrefsRecord {
        NotificationPrefsRecord(
            enabled: enabled ?? true,
            dndStartMin: dndStartMin,
            dndEndMin: dndEndMin,
            dndTZ: dndTZ
        )
    }
}

private struct CloudNotificationPrefsWrite: Encodable, Sendable {
    let enabled: Bool
    let dndStartMin: Int?
    let dndEndMin: Int?
    let dndTZ: String?

    enum CodingKeys: String, CodingKey {
        case enabled
        case dndStartMin = "dnd_start_min"
        case dndEndMin = "dnd_end_min"
        case dndTZ = "dnd_tz"
    }
}

private struct CloudMutedSessionsList: Decodable, Sendable {
    let items: [String]
}

private struct CloudMuteSessionRequest: Encodable, Sendable {
    let until: String?
}

private struct CloudClaimInviteRequest: Encodable, Sendable {
    let token: String
}

private struct CloudClaimInviteResult: Decodable, Sendable {
    let actorId: String
    let teamId: String
    let actorType: String
    let displayName: String
    let refreshToken: String?
}

/// Shared with `CloudAPITeamResources.swift` — hence internal rather than
/// file-private.
func parseCloudDate(_ value: String?) -> Date? {
    guard let value else { return nil }
    if let date = ISO8601DateFormatter.cloudWithFractionalSeconds.date(from: value) {
        return date
    }
    return ISO8601DateFormatter.cloud.date(from: value)
}

private extension ISO8601DateFormatter {
    // `nonisolated(unsafe)`: ISO8601DateFormatter is a Foundation class (can't
    // add a Sendable conformance) but is configured once and used read-only via
    // `date(from:)`, which Foundation documents as safe for concurrent use.
    nonisolated(unsafe) static let cloudWithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) static let cloud: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
