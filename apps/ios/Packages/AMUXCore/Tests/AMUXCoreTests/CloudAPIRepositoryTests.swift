import Foundation
import Testing
@testable import AMUXCore

@Suite("Cloud API repositories")
struct CloudAPIRepositoryTests {
    @Test
    func sessionsAndMessagesUseCloudAPIContract() async throws {
        let recorder = RequestRecorder()
        let client = CloudAPIClient(
            configuration: configuration(),
            accessToken: { "access-token" },
            send: { request in
                await recorder.append(request)
                let path = request.url?.path ?? ""
                if path == "/v1/sessions" {
                    return try response("""
                    {
                      "items": [
                        {
                          "id": "session-1",
                          "teamId": "team-1",
                          "title": "Session",
                          "mode": "collab",
                          "ideaId": null,
                          "primaryAgentId": "agent-1",
                          "createdByActorId": "actor-1",
                          "summary": "topic",
                          "lastMessageAt": "2026-05-27T10:00:00Z",
                          "lastMessagePreview": "hello",
                          "participantCount": 3,
                          "hasUnread": true,
                          "createdAt": "2026-05-27T09:00:00Z",
                          "updatedAt": null
                        }
                      ],
                      "nextCursor": null
                    }
                    """)
                }
                if path == "/v1/sessions/session-1/messages" {
                    return try response("""
                    {
                      "items": [
                        {
                          "id": "message-1",
                          "teamId": "team-1",
                          "sessionId": "session-1",
                          "turnId": "turn-1",
                          "senderActorId": "actor-1",
                          "replyToMessageId": null,
                          "kind": "text",
                          "content": "hello",
                          "metadata": null,
                          "model": null,
                          "createdAt": "2026-05-27T10:00:00Z",
                          "updatedAt": null
                        },
                        {
                          "id": "message-2",
                          "teamId": "team-1",
                          "sessionId": "session-1",
                          "turnId": null,
                          "senderActorId": "actor-2",
                          "replyToMessageId": "message-1",
                          "kind": "user_message",
                          "content": "hi @agent",
                          "metadata": {
                            "mention_actor_ids": ["agent-1", "agent-2"],
                            "some_future_key": {"nested": true}
                          },
                          "model": "claude-opus-4-7",
                          "createdAt": "2026-05-27T10:01:00Z",
                          "updatedAt": "2026-05-27T10:02:00Z"
                        }
                      ],
                      "nextCursor": null
                    }
                    """)
                }
                return try response("{}", status: 404)
            }
        )

        let sessionsRepo = CloudAPISessionsRepository(client: client)
        let messagesRepo = CloudAPIMessagesRepository(client: client)

        let sessions = try await sessionsRepo.listSessions(teamID: "team-1")
        let messages = try await messagesRepo.listForSession(sessionID: "session-1")

        #expect(sessions.map(\.id) == ["session-1"])
        #expect(sessions.first?.lastMessagePreview == "hello")
        #expect(sessions.first?.primaryAgentID == "agent-1")
        #expect(sessions.first?.createdByActorID == "actor-1")
        #expect(sessions.first?.summary == "topic")
        #expect(sessions.first?.participantCount == 3)
        #expect(sessions.first?.hasUnread == true)
        #expect(messages.map(\.id) == ["message-1", "message-2"])
        #expect(messages.first?.turnID == "turn-1")
        // Full contract round-trip: every field of the OpenAPI Message
        // schema must survive decoding, including the typed metadata path.
        let second = try #require(messages.last)
        #expect(second.teamID == "team-1")
        #expect(second.replyToMessageID == "message-1")
        #expect(second.mentionActorIDs == ["agent-1", "agent-2"])
        #expect(second.model == "claude-opus-4-7")
        #expect(second.updatedAt == ISO8601DateFormatter().date(from: "2026-05-27T10:02:00Z"))
        // null metadata must decode to "no mentions", not a decode failure.
        #expect(messages.first?.mentionActorIDs == [])
        #expect(messages.first?.updatedAt == nil)
        let requests = await recorder.requests
        // The session list must be team-narrowed server-side and page-capped.
        // Narrowing in the client would drop rows on later pages now that
        // /v1/sessions replaced the unpaginated team endpoint.
        let listQuery = try #require(requests.first { $0.url?.path == "/v1/sessions" }?.url?.query)
        #expect(listQuery.contains("teamId=team-1"))
        #expect(listQuery.contains("limit=100"))
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer access-token" })
        #expect(requests.map { $0.value(forHTTPHeaderField: "X-Request-Id")?.isEmpty == false }.allSatisfy { $0 })
    }

    @Test
    func messageInsertSendsIdempotencyKey() async throws {
        let recorder = RequestRecorder()
        let client = CloudAPIClient(
            configuration: configuration(),
            accessToken: { "access-token" },
            send: { request in
                await recorder.append(request)
                return try response("""
                {
                  "id": "message-1",
                  "teamId": "team-1",
                  "sessionId": "session-1",
                  "turnId": null,
                  "senderActorId": "actor-1",
                  "replyToMessageId": null,
                  "kind": "text",
                  "content": "hello",
                  "metadata": null,
                  "model": null,
                  "createdAt": "2026-05-27T10:00:00Z",
                  "updatedAt": null
                }
                """)
            }
        )
        let repo = CloudAPIMessagesRepository(client: client)

        try await repo.insert(MessageInsertInput(
            id: "message-1",
            teamID: "team-1",
            sessionID: "session-1",
            senderActorID: "actor-1",
            content: "hello",
            mentionActorIDs: ["agent-1"]
        ))

        let request = try #require(await recorder.requests.first)
        #expect(request.url?.path == "/v1/sessions/session-1/messages")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "message-1")
        let body = try #require(request.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["id"] as? String == "message-1")
        #expect(json["teamId"] as? String == "team-1")
        #expect((json["metadata"] as? [String: [String]])?["mention_actor_ids"] == ["agent-1"])
    }

    @Test
    func sessionIDsRepositoryProjectsIDs() async throws {
        let client = CloudAPIClient(
            configuration: configuration(),
            accessToken: { "access-token" },
            send: { _ in
                try response("""
                {
                  "items": [
                    { "id": "session-a", "teamId": "team-1", "title": "A", "mode": "solo",
                      "ideaId": null, "primaryAgentId": null, "createdByActorId": null,
                      "summary": null, "lastMessageAt": null, "lastMessagePreview": null,
                      "participantCount": 1, "hasUnread": false, "createdAt": null, "updatedAt": null },
                    { "id": "session-b", "teamId": "team-1", "title": "B", "mode": "solo",
                      "ideaId": null, "primaryAgentId": null, "createdByActorId": null,
                      "summary": null, "lastMessageAt": null, "lastMessagePreview": null,
                      "participantCount": 0, "hasUnread": false, "createdAt": null, "updatedAt": null }
                  ],
                  "nextCursor": null
                }
                """)
            }
        )
        let repo = CloudAPISessionIDsRepository(client: client)
        let ids = try await repo.listSessionIDs(teamID: "team-1")
        #expect(ids == Set(["session-a", "session-b"]))
    }


    @Test
    func markSessionViewedPostsLastReadMessageId() async throws {
        let recorder = RequestRecorder()
        let client = CloudAPIClient(
            configuration: configuration(),
            accessToken: { "access-token" },
            send: { request in
                await recorder.append(request)
                let url = URL(string: "https://fc.example.com")!
                let http = try #require(HTTPURLResponse(url: url, statusCode: 204, httpVersion: nil, headerFields: nil))
                return (Data(), http)
            }
        )
        let repo = CloudAPISessionsRepository(client: client)
        try await repo.markSessionViewed(sessionId: "session-1", lastReadMessageId: "msg-42")

        let request = try #require(await recorder.requests.first)
        #expect(request.url?.path == "/v1/sessions/session-1/mark-viewed")
        #expect(request.httpMethod == "POST")
        let body = try #require(request.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["lastReadMessageId"] as? String == "msg-42")
    }

    /// Ids spliced into a path are escaped as one segment, so a stray `/` or
    /// `?` cannot redirect the request to another route.
    @Test
    func sessionIDsAreEscapedAsOnePathSegment() async throws {
        let recorder = RequestRecorder()
        let client = CloudAPIClient(
            configuration: configuration(),
            accessToken: { "access-token" },
            send: { request in
                await recorder.append(request)
                let url = URL(string: "https://fc.example.com")!
                let http = try #require(HTTPURLResponse(url: url, statusCode: 204, httpVersion: nil, headerFields: nil))
                return (Data(), http)
            }
        )
        let repo = CloudAPISessionsRepository(client: client)
        try await repo.markSessionViewed(sessionId: "a/b?c", lastReadMessageId: nil)
        try await repo.markSessionUnread(sessionId: "a/b?c")

        let urls = await recorder.requests.compactMap { $0.url?.absoluteString }
        #expect(urls == [
            "https://fc.example.com/v1/sessions/a%2Fb%3Fc/mark-viewed",
            "https://fc.example.com/v1/sessions/a%2Fb%3Fc/mark-unread",
        ])
    }

    @Test
    func actorsAndWorkspacesDecodeContractShapes() async throws {
        let client = CloudAPIClient(
            configuration: configuration(),
            accessToken: { "access-token" },
            send: { request in
                let path = request.url?.path ?? ""
                if path == "/v1/teams/team-1/actors" {
                    return try response("""
                    {
                      "items": [
                        {
                          "id": "actor-1", "teamId": "team-1", "kind": "member",
                          "displayName": "Yan", "avatarUrl": "https://cdn/a.png",
                          "userId": "user-1", "invitedByActorId": null,
                          "teamRole": "owner", "memberStatus": "active",
                          "agentStatus": null, "agentTypes": null, "agentKind": null,
                          "defaultAgentType": null, "defaultWorkspaceId": null,
                          "email": "yan@example.com", "phone": null,
                          "lastActiveAt": "2026-05-27T10:00:00Z",
                          "createdAt": "2026-05-27T09:00:00Z", "updatedAt": null
                        },
                        {
                          "id": "actor-2", "teamId": "team-1", "kind": "agent",
                          "displayName": "Coder", "avatarUrl": null,
                          "userId": null, "invitedByActorId": "actor-1",
                          "teamRole": null, "memberStatus": null,
                          "agentStatus": "online", "agentTypes": ["claude_code"],
                          "agentKind": "claude_code", "defaultAgentType": "claude_code",
                          "defaultWorkspaceId": "ws-1", "email": null, "phone": null,
                          "lastActiveAt": null, "createdAt": null, "updatedAt": null
                        }
                      ],
                      "nextCursor": null
                    }
                    """)
                }
                if path == "/v1/workspaces" {
                    return try response("""
                    {
                      "items": [
                        { "id": "ws-1", "teamId": "team-1", "name": "Main",
                          "path": "~/code/app", "agentId": "actor-2" },
                        { "id": "ws-2", "teamId": "team-1", "name": "Scratch",
                          "path": null, "agentId": null },
                        { "id": "ws-3", "teamId": "team-1", "name": "SlugOnly",
                          "slug": "~/code/slug-only", "agentId": "actor-2" }
                      ],
                      "nextCursor": null
                    }
                    """)
                }
                return try response("{}", status: 404)
            }
        )

        let actors = try await CloudAPIActorRepository(client: client).listActors(teamID: "team-1")
        #expect(actors.map(\.id) == ["actor-1", "actor-2"])

        let workspaces = try await CloudAPIWorkspaceRepository(client: client)
            .listWorkspaces(teamID: "team-1", agentID: nil)
        #expect(workspaces.map(\.id) == ["ws-1", "ws-2", "ws-3"])
        #expect(workspaces.first?.path == "~/code/app")
        // null path must decode to empty string, not a decode failure.
        #expect(workspaces[1].path == "")
        // A backend that only fills `slug` must still yield a usable path.
        #expect(workspaces.last?.path == "~/code/slug-only")
    }

    @Test
    func markSessionUnreadPostsToMarkUnread() async throws {
        let recorder = RequestRecorder()
        let client = CloudAPIClient(
            configuration: configuration(),
            accessToken: { "access-token" },
            send: { request in
                await recorder.append(request)
                let url = URL(string: "https://fc.example.com")!
                let http = try #require(HTTPURLResponse(url: url, statusCode: 204, httpVersion: nil, headerFields: nil))
                return (Data(), http)
            }
        )
        let repo = CloudAPISessionsRepository(client: client)
        try await repo.markSessionUnread(sessionId: "session-1")

        let request = try #require(await recorder.requests.first)
        #expect(request.url?.path == "/v1/sessions/session-1/mark-unread")
        #expect(request.httpMethod == "POST")
    }

    @Test
    func patchMessageSendsContentAndDecodesResponse() async throws {
        let recorder = RequestRecorder()
        let client = CloudAPIClient(
            configuration: configuration(),
            accessToken: { "access-token" },
            send: { request in
                await recorder.append(request)
                return try response("""
                {
                  "id": "message-1",
                  "teamId": "team-1",
                  "sessionId": "session-1",
                  "turnId": null,
                  "senderActorId": "actor-1",
                  "replyToMessageId": null,
                  "kind": "user_message",
                  "content": "edited",
                  "metadata": null,
                  "model": null,
                  "createdAt": "2026-05-27T10:00:00Z",
                  "updatedAt": "2026-06-11T10:00:00Z"
                }
                """)
            }
        )
        let repo = CloudAPIMessagesRepository(client: client)
        try await repo.patch(messageID: "message-1", content: "edited")

        let request = try #require(await recorder.requests.first)
        #expect(request.url?.path == "/v1/messages/message-1")
        #expect(request.httpMethod == "PATCH")
        let body = try #require(request.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["content"] as? String == "edited")
        #expect(json.count == 1, "PATCH body must carry only the rewritten content")
    }

    @Test
    func deleteMessageUsesDeleteVerb() async throws {
        let recorder = RequestRecorder()
        let client = CloudAPIClient(
            configuration: configuration(),
            accessToken: { "access-token" },
            send: { request in
                await recorder.append(request)
                let url = URL(string: "https://fc.example.com")!
                let http = try #require(HTTPURLResponse(url: url, statusCode: 204, httpVersion: nil, headerFields: nil))
                return (Data(), http)
            }
        )
        let repo = CloudAPIMessagesRepository(client: client)
        try await repo.delete(messageID: "message-1")

        let request = try #require(await recorder.requests.first)
        #expect(request.url?.path == "/v1/messages/message-1")
        #expect(request.httpMethod == "DELETE")
        #expect(request.httpBody == nil)
    }

    @Test
    func renameSessionLocksTheTitle() async throws {
        let recorder = RequestRecorder()
        let client = CloudAPIClient(
            configuration: configuration(),
            accessToken: { "access-token" },
            send: { request in
                await recorder.append(request)
                let url = URL(string: "https://fc.example.com")!
                let http = try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil))
                return (Data("{}".utf8), http)
            }
        )
        let repo = CloudAPISessionsRepository(client: client)
        try await repo.renameSession(sessionId: "session-1", title: "Standup (09:30)")

        let request = try #require(await recorder.requests.first)
        #expect(request.httpMethod == "PATCH")
        #expect(request.url?.path == "/v1/sessions/session-1")
        let body = try #require(request.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["title"] as? String == "Standup (09:30)")
        #expect(json["titleLocked"] as? Bool == true)
    }

    private func configuration() -> CloudAPIConfiguration {
        CloudAPIConfiguration(
            baseURL: URL(string: "https://fc.example.com")!
        )
    }

    private func response(_ json: String, status: Int = 200) throws -> (Data, HTTPURLResponse) {
        let url = URL(string: "https://fc.example.com")!
        let http = try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil))
        return (Data(json.utf8), http)
    }
}

private actor RequestRecorder {
    private var stored: [URLRequest] = []

    var requests: [URLRequest] {
        stored
    }

    func append(_ request: URLRequest) {
        stored.append(request)
    }
}
