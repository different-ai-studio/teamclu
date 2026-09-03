import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCursor,
  encodeCursor,
  handleBusinessApiRequest,
} from "../src/lib/business-api.js";
import {
  DEFAULT_MESSAGE_LIST_LIMIT,
  MAX_MESSAGE_LIST_LIMIT,
} from "../src/lib/routing-utils.js";

test("handleBusinessApiRequest routes list sessions with bearer-scoped repository", async () => {
  const repo = fakeRepo({
    sessions: [
      session("s1", "2026-05-27T01:00:00Z"),
      session("s2", "2026-05-27T00:00:00Z"),
      session("s3", "2026-05-26T23:00:00Z"),
    ],
  });
  const createCalls = [];

  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: {
      Authorization: "Bearer caller-token",
      "X-Request-Id": "request_12345",
    },
    queryStringParameters: { limit: "2", teamId: "team-1" },
  }, {
    createRepository(args) {
      createCalls.push(args);
      return repo;
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["X-Request-Id"], "request_12345");
  assert.deepEqual(createCalls, [{ accessToken: "caller-token" }]);
  const body = JSON.parse(response.body);
  assert.equal(body.items.length, 2);
  assert.deepEqual(decodeCursor(body.nextCursor), {
    lastMessageAt: "2026-05-27T00:00:00Z",
    createdAt: "2026-05-26T00:00:00Z",
    id: "s2",
  });
  assert.deepEqual(repo.calls[0], {
    method: "listSessions",
    args: {
      limit: 3,
      cursor: null,
      teamId: "team-1",
      ideaId: null,
      kind: "all",
    },
  });
});

test("GET /v1/sessions does not return a cursor for an exactly-full terminal page", async () => {
  const repo = fakeRepo({
    sessions: [
      session("s1", "2026-05-27T01:00:00Z"),
      session("s2", "2026-05-27T00:00:00Z"),
    ],
  });
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: { Authorization: "Bearer token" },
    queryParameters: { teamId: "team-1", limit: "2", kind: "regular" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).nextCursor, null);
  assert.equal(repo.calls[0].args.limit, 3, "one sentinel row is requested");
});

test("list sessions decodes cursor before calling repository", async () => {
  const repo = fakeRepo({ sessions: [] });
  const cursor = encodeCursor({
    lastMessageAt: "2026-05-27T01:00:00Z",
    createdAt: "2026-05-26T01:00:00Z",
    id: "s1",
  });

  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: { Authorization: "Bearer token" },
    queryStringParameters: { cursor, teamId: "team-1" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.calls[0].args.cursor, {
    lastMessageAt: "2026-05-27T01:00:00Z",
    createdAt: "2026-05-26T01:00:00Z",
    id: "s1",
  });
});

// ── GET /v1/sessions/:id/messages pagination ─────────────────────────────────
// This endpoint had no limit and returned `nextCursor: null` unconditionally, so
// a long session shipped its entire history every time — 6k messages measured
// 6.1s / 3.7MB, and 40k exceeded the 8s statement_timeout as a 500.

test("GET messages defaults to the newest page and reports a cursor", async () => {
  const rows = Array.from({ length: DEFAULT_MESSAGE_LIST_LIMIT }, (_, i) => ({
    id: `m${i}`, createdAt: `2026-05-27T00:00:${String(i % 60).padStart(2, "0")}Z`,
  }));
  const repo = fakeRepo({ messages: rows });

  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-1/messages",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.calls[0], {
    method: "listMessages",
    sessionId: "session-1",
    limit: DEFAULT_MESSAGE_LIST_LIMIT,
    cursor: null,
  });
  // A full page means there may be older messages, so the cursor must point at
  // the OLDEST row on the page — items[0], since a page reads oldest-first.
  const body = JSON.parse(response.body);
  assert.ok(body.nextCursor, "a full page must carry a cursor");
  const decoded = JSON.parse(Buffer.from(body.nextCursor, "base64url").toString("utf8"));
  assert.equal(decoded.id, "m0");
});

test("GET messages omits the cursor on a short (final) page", async () => {
  const repo = fakeRepo({ messages: [{ id: "only", createdAt: "2026-05-27T00:00:00Z" }] });

  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-1/messages",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(JSON.parse(response.body).nextCursor, null);
});

test("GET messages forwards limit and cursor to the repository", async () => {
  const repo = fakeRepo({ messages: [] });
  const cursor = Buffer.from(
    JSON.stringify({ createdAt: "2026-05-27T00:00:00Z", id: "m-42" }), "utf8",
  ).toString("base64url");

  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-1/messages",
    headers: { Authorization: "Bearer token" },
    queryParameters: { limit: "10", cursor },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.calls[0], {
    method: "listMessages",
    sessionId: "session-1",
    limit: 10,
    cursor: { createdAt: "2026-05-27T00:00:00Z", id: "m-42" },
  });
});

test("GET messages rejects a limit past the maximum", async () => {
  const repo = fakeRepo({ messages: [] });

  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-1/messages",
    headers: { Authorization: "Bearer token" },
    queryParameters: { limit: String(MAX_MESSAGE_LIST_LIMIT + 1) },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
  assert.equal(repo.calls.length, 0);
});

// ── /v1/sync/* pagination ────────────────────────────────────────────────────
// These were unbounded: a first-time sync of a large team returned every
// changed row in one response (10k actors measured 3.1MB / 4.4s). They are now
// keyset-paginated on (updated_at, id), so callers must follow nextCursor.

const SYNC_ROUTES = [
  { path: "/v1/sync/actor-directory", query: { teamId: "team-1" }, method: "listActorDirectoryForSync" },
  { path: "/v1/sync/ideas", query: { teamId: "team-1" }, method: "listIdeasForSync" },
  { path: "/v1/sync/session-participants", query: { sessionId: "session-1" }, method: "listSessionParticipantsForSync" },
  { path: "/v1/sync/sessions", query: { teamId: "team-1" }, method: "listSessionsForTeamSince" },
  { path: "/v1/sync/messages", query: { sessionId: "session-1" }, method: "listMessagesForSessionSince" },
];

for (const route of SYNC_ROUTES) {
  test(`GET ${route.path} forwards limit and cursor`, async () => {
    const repo = fakeRepo({ syncRows: [] });
    const cursor = Buffer.from(
      JSON.stringify({ updatedAt: "2026-05-27T00:00:00Z", id: "row-7" }), "utf8",
    ).toString("base64url");

    const response = await handleBusinessApiRequest({
      httpMethod: "GET",
      path: route.path,
      headers: { Authorization: "Bearer token" },
      queryParameters: { ...route.query, limit: "10", cursor },
    }, { createRepository: () => repo });

    assert.equal(response.statusCode, 200);
    const call = repo.calls[0];
    assert.equal(call.method, route.method);
    assert.equal(call.limit, 10);
    assert.deepEqual(call.cursor, { updatedAt: "2026-05-27T00:00:00Z", id: "row-7" });
  });

  test(`GET ${route.path} reports a cursor on a full page and null on a short one`, async () => {
    // A page that fills `limit` may have more behind it.
    const full = fakeRepo({
      syncRows: [
        { id: "r1", updated_at: "2026-05-27T00:00:01Z" },
        { id: "r2", updated_at: "2026-05-27T00:00:02Z" },
      ],
    });
    const fullResponse = await handleBusinessApiRequest({
      httpMethod: "GET",
      path: route.path,
      headers: { Authorization: "Bearer token" },
      queryParameters: { ...route.query, limit: "2" },
    }, { createRepository: () => full });
    const fullBody = JSON.parse(fullResponse.body);
    assert.ok(fullBody.nextCursor, "a full page must carry a cursor");
    const decoded = JSON.parse(Buffer.from(fullBody.nextCursor, "base64url").toString("utf8"));
    // The cursor is the LAST row — sync walks forward through (updated_at, id).
    assert.deepEqual(decoded, { updatedAt: "2026-05-27T00:00:02Z", id: "r2" });

    const short = fakeRepo({ syncRows: [{ id: "r1", updated_at: "2026-05-27T00:00:01Z" }] });
    const shortResponse = await handleBusinessApiRequest({
      httpMethod: "GET",
      path: route.path,
      headers: { Authorization: "Bearer token" },
      queryParameters: { ...route.query, limit: "2" },
    }, { createRepository: () => short });
    assert.equal(JSON.parse(shortResponse.body).nextCursor, null);
  });
}

test("insert message enforces narrow idempotency contract", async () => {
  const repo = fakeRepo();

  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/messages",
    headers: {
      Authorization: "Bearer token",
      "Idempotency-Key": "different-id",
    },
    body: JSON.stringify({
      id: "message-1",
      teamId: "team-1",
      senderActorId: "actor-1",
      content: "hello",
    }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
  assert.equal(repo.calls.length, 0);
});

test("insert message calls repository when idempotency key matches message id", async () => {
  const repo = fakeRepo();

  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/messages",
    headers: {
      Authorization: "Bearer token",
      "Idempotency-Key": "message-1",
    },
    body: JSON.stringify({
      id: "message-1",
      teamId: "team-1",
      senderActorId: "actor-1",
      content: "hello",
    }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.calls[0], {
    method: "insertMessage",
    sessionId: "session-1",
    input: {
      id: "message-1",
      teamId: "team-1",
      senderActorId: "actor-1",
      content: "hello",
    },
  });
});

test("PATCH /v1/messages/:messageId updates message", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/messages/message-1",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ content: "updated content" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.content, "updated content");
  assert.deepEqual(repo.calls[0], {
    method: "patchMessage",
    messageId: "message-1",
    patch: { content: "updated content" },
  });
});

test("DELETE /v1/messages/:messageId removes message", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "DELETE",
    path: "/v1/messages/message-1",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "deleteMessage",
    messageId: "message-1",
  });
});

test("POST /v1/sessions/:sessionId/mark-unread clears the caller's read marker", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/mark-unread",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "markSessionUnread",
    sessionId: "session-1",
  });
});

test("claim invite is anonymous and routes to auth repository", async () => {
  // No Authorization header — daemon's bootstrap `amuxd init` has no token
  // yet. The route must dispatch to createAuthRepository(), not require auth.
  const authCalls = [];
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/invites/claim",
    headers: {},
    body: JSON.stringify({ token: "invite-token" }),
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository: () => ({
      async claimInvite(token) {
        authCalls.push({ method: "claimInvite", token });
        return {
          actorId: "agent-1",
          teamId: "team-1",
          actorType: "agent",
          displayName: "Agent",
          refreshToken: "rt-1",
        };
      },
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(authCalls[0], { method: "claimInvite", token: "invite-token" });
  assert.equal(JSON.parse(response.body).actorId, "agent-1");
});

// The three routes below are the contact path (invited by email/phone, no token
// ever reached the invitee). Unlike /v1/invites/claim they REQUIRE a bearer:
// matching keys off the caller's own verified identity, so there is no
// anonymous variant.
test("pending invites route requires a bearer and routes to auth repository", async () => {
  const authCalls = [];
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/invites/pending",
    headers: { Authorization: "Bearer member-jwt" },
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository: () => ({
      async listPendingInvites(ctx) {
        authCalls.push({ method: "listPendingInvites", accessToken: ctx?.accessToken });
        return { items: [{ inviteId: "invite-1", teamId: "team-1", matchedVia: "email" }] };
      },
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(authCalls[0], { method: "listPendingInvites", accessToken: "member-jwt" });
  assert.equal(JSON.parse(response.body).items[0].inviteId, "invite-1");
});

test("pending invites route returns 401 without a bearer", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/invites/pending",
    headers: {},
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository: () => ({
      async listPendingInvites() {
        assert.fail("must not reach the repository without a bearer");
      },
    }),
  });

  assert.equal(response.statusCode, 401);
});

test("accept pending invite forwards inviteId and bearer", async () => {
  const authCalls = [];
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/invites/invite-1/accept",
    headers: { Authorization: "Bearer member-jwt" },
    body: "{}",
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository: () => ({
      async acceptPendingInvite(inviteId, ctx) {
        authCalls.push({ method: "acceptPendingInvite", inviteId, accessToken: ctx?.accessToken });
        return { actorId: "actor-9", teamId: "team-1", actorType: "member", displayName: "New User", refreshToken: null };
      },
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(authCalls[0], { method: "acceptPendingInvite", inviteId: "invite-1", accessToken: "member-jwt" });
  assert.equal(JSON.parse(response.body).teamId, "team-1");
});

test("decline pending invite returns 204", async () => {
  const authCalls = [];
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/invites/invite-1/decline",
    headers: { Authorization: "Bearer member-jwt" },
    body: "{}",
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository: () => ({
      async declinePendingInvite(inviteId, ctx) {
        authCalls.push({ method: "declinePendingInvite", inviteId, accessToken: ctx?.accessToken });
      },
    }),
  });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(authCalls[0], { method: "declinePendingInvite", inviteId: "invite-1", accessToken: "member-jwt" });
});

test("claim invite forwards the caller bearer for member claims", async () => {
  // A member joining via someone's link IS authenticated (anonymous or real).
  // The route must forward their bearer as accessToken so the SECURITY DEFINER
  // RPC resolves auth.uid() — otherwise member claims fail with 42501.
  const ctxSeen = [];
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/invites/claim",
    headers: { Authorization: "Bearer member-jwt" },
    body: JSON.stringify({ token: "invite-token" }),
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository: () => ({
      async claimInvite(token, ctx) {
        ctxSeen.push({ token, ctx });
        return {
          actorId: "member-1",
          teamId: "team-1",
          actorType: "member",
          displayName: "Member",
          refreshToken: null,
        };
      },
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(ctxSeen[0].token, "invite-token");
  assert.equal(ctxSeen[0].ctx.accessToken, "member-jwt");
  assert.equal(JSON.parse(response.body).actorId, "member-1");
});

test("missing bearer returns OpenAPI error envelope", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: {},
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 401);
  const body = JSON.parse(response.body);
  assert.equal(body.error.code, "missing_auth");
  assert.match(body.error.requestId, /^[A-Za-z0-9_-]+$/);
});

test("POST /v1/auth/refresh proxies to repository without auth", async () => {
  const authCalls = [];
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/refresh",
    headers: {},
    body: JSON.stringify({ refreshToken: "test-rt" }),
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository() {
      return {
        async refreshAccessToken({ refreshToken }) {
          authCalls.push({ refreshToken });
          return { accessToken: "at-2", refreshToken: "rt-2", expiresAt: 123 };
        },
      };
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(authCalls, [{ refreshToken: "test-rt" }]);
  assert.deepEqual(JSON.parse(response.body), { accessToken: "at-2", refreshToken: "rt-2", expiresAt: 123 });
});

test("POST /v1/auth/refresh rejects missing refreshToken", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/refresh",
    headers: {},
    body: JSON.stringify({}),
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository: () => ({
      async refreshAccessToken() { throw new Error("should not be called"); },
    }),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("POST /v1/auth/signin-idtoken proxies provider + idToken to auth repo", async () => {
  const authCalls = [];
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/signin-idtoken",
    headers: {},
    body: JSON.stringify({ provider: "apple", idToken: "id-token-123", nonce: "n-1" }),
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository: () => ({
      async signInWithIdToken(input) {
        authCalls.push(input);
        return { access_token: "at-apple", refresh_token: "rt-apple" };
      },
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(authCalls[0], { provider: "apple", idToken: "id-token-123", nonce: "n-1", accessToken: null });
  assert.equal(JSON.parse(response.body).access_token, "at-apple");
});

test("POST /v1/auth/signin-idtoken forwards bearer for identity linking", async () => {
  const authCalls = [];
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/signin-idtoken",
    headers: { Authorization: "Bearer anon-token" },
    body: JSON.stringify({ provider: "apple", idToken: "id-token-123" }),
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository: () => ({
      async signInWithIdToken(input) {
        authCalls.push(input);
        return { access_token: "at-linked", refresh_token: "rt-linked" };
      },
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(authCalls[0].accessToken, "anon-token");
  assert.equal(authCalls[0].nonce, null);
});

test("POST /v1/auth/signin-idtoken rejects missing idToken", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/signin-idtoken",
    headers: {},
    body: JSON.stringify({ provider: "apple" }),
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository: () => ({ async signInWithIdToken() { throw new Error("should not be called"); } }),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("repository Supabase errors are normalized", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: { Authorization: "Bearer token" },
    queryParameters: { teamId: "team-1" },
  }, {
    createRepository: () => fakeRepo({ error: { code: "23505", message: "duplicate key" } }),
  });

  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).error.code, "conflict");
});

test("GET /v1/teams/:teamId/workspace-defaults returns 404 when not set", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/workspace-defaults",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "not_found");
  assert.deepEqual(repo.calls[0], { method: "getTeamWorkspaceConfig", teamId: "team-1" });
});

test("GET /v1/teams/:teamId/workspace-defaults returns config when set", async () => {
  const repo = fakeRepo({
    teamWorkspaceConfigs: {
      "team-1": {
        teamId: "team-1",
        defaultWorkspaceId: "workspace-1",
        pinnedWorkspaceIds: [],
        updatedAt: "2026-05-27T01:00:00Z",
      },
    },
  });
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/workspace-defaults",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(body.defaultWorkspaceId, "workspace-1");
});

test("PUT /v1/teams/:teamId/workspace-config upserts config", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/workspace-config",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({
      defaultWorkspaceId: "workspace-2",
      pinnedWorkspaceIds: ["workspace-3"],
    }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(body.defaultWorkspaceId, "workspace-2");
  assert.deepEqual(body.pinnedWorkspaceIds, ["workspace-3"]);
  assert.deepEqual(repo.calls[0], {
    method: "putTeamWorkspaceConfig",
    teamId: "team-1",
    input: {
      defaultWorkspaceId: "workspace-2",
      pinnedWorkspaceIds: ["workspace-3"],
    },
  });
});

test("POST /v1/heartbeat calls repository.heartbeat", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/heartbeat",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "heartbeat" });
});

test("POST /v1/presence/foreground upserts client_presence", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/presence/foreground",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "device-1", foregroundUntil: "2026-05-28T01:00:00Z" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "writeForegroundPresence",
    input: { deviceId: "device-1", foregroundUntil: "2026-05-28T01:00:00Z" },
  });
});

test("POST /v1/presence/foreground rejects missing deviceId with 400", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/presence/foreground",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ foregroundUntil: "2026-05-28T01:00:00Z" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.error.code, "invalid_request");
  assert.equal(repo.calls.length, 0);
});

test("POST /v1/presence/foreground rejects non-ISO foregroundUntil with 400", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/presence/foreground",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "d", foregroundUntil: "not-a-date" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.error.code, "invalid_request");
});

test("GET /v1/workspaces returns 400 without teamId", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/workspaces",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("GET /v1/workspaces returns workspace page", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/workspaces",
    headers: { Authorization: "Bearer token" },
    queryStringParameters: { teamId: "team-1" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].name, "Alpha");
  assert.deepEqual(repo.calls[0], {
    method: "listWorkspaces",
    args: { teamId: "team-1", limit: 50, cursor: null, agentId: null },
  });
});

test("POST /v1/workspaces upserts workspace", async () => {
  const repo = fakeRepo({ workspaces: [] });
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/workspaces",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({
      id: "workspace-2",
      teamId: "team-1",
      name: "Beta",
    }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.id, "workspace-2");
  assert.equal(body.name, "Beta");
  assert.deepEqual(repo.calls[0], {
    method: "upsertWorkspace",
    input: {
      id: "workspace-2",
      teamId: "team-1",
      name: "Beta",
      path: null,
      agentId: null,
      createdByMemberId: null,
      slug: null,
      archived: false,
    },
  });
});

test("GET /v1/workspaces/:workspaceId returns 404 for missing workspace", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/workspaces/workspace-missing",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => fakeRepo({ workspaces: [] }) });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "not_found");
});

test("GET /v1/workspaces/:workspaceId returns workspace", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/workspaces/workspace-1",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.name, "Alpha");
  assert.deepEqual(repo.calls[0], { method: "getWorkspace", workspaceId: "workspace-1" });
});

test("PATCH /v1/workspaces/:workspaceId updates workspace", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/workspaces/workspace-1",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ archived: true }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.archived, true);
  assert.deepEqual(repo.calls[0], {
    method: "patchWorkspace",
    workspaceId: "workspace-1",
    patch: { archived: true },
  });
});

test("GET /v1/teams/:teamId/directory returns actors and members", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/directory",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(Array.isArray(body.actors));
  assert.ok(Array.isArray(body.members));
  assert.equal(body.actors.length, 1);
  assert.equal(body.actors[0].displayName, "Alice");
  assert.equal(body.members.length, 1);
  assert.equal(body.members[0].role, "member");
  assert.deepEqual(repo.calls[0], { method: "getTeamDirectory", teamId: "team-1" });
});

test("GET /v1/sessions/:sessionId returns session with participants", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-1",
    headers: { Authorization: "Bearer token" },
    queryParameters: { teamId: "team-1" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.id, "session-1");
  assert.ok(Array.isArray(body.participants));
  assert.deepEqual(repo.calls[0], { method: "getSession", sessionId: "session-1", teamId: "team-1" });
});

test("GET /v1/sessions/:sessionId requires teamId", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-1",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
  assert.equal(repo.calls.length, 0, "must not reach the repository without a team");
});

test("GET /v1/sessions/:sessionId returns 404 for missing session", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-missing",
    headers: { Authorization: "Bearer token" },
    queryParameters: { teamId: "team-1" },
  }, { createRepository: () => fakeRepo({ sessions: [] }) });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "not_found");
});

test("PATCH /v1/sessions/:sessionId updates session", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/sessions/session-1",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ title: "New title" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.title, "New title");
  assert.deepEqual(repo.calls[0], { method: "patchSession", sessionId: "session-1", patch: { title: "New title" } });
});

test("POST /v1/sessions creates session", async () => {
  const repo = fakeRepo({ sessions: [] });
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1", title: "New", mode: "solo" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(repo.calls[0], { method: "createSession", input: { teamId: "team-1", title: "New", mode: "solo" } });
});

test("POST /v1/sessions returns 400 without required fields", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1" }),
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("POST /v1/sessions/:sessionId/mark-viewed returns 204 with no body", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/mark-viewed",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "markSessionViewed", sessionId: "session-1", lastReadMessageId: null });
});

test("POST /v1/sessions/:sessionId/mark-viewed forwards lastReadMessageId", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/mark-viewed",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ lastReadMessageId: "msg-42" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "markSessionViewed", sessionId: "session-1", lastReadMessageId: "msg-42" });
});

test("GET /v1/teams/:teamId/sessions is gone (replaced by /v1/sessions?teamId=)", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/sessions",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 404);
});

test("GET /v1/sessions narrows by teamId and ideaId server-side", async () => {
  // Narrowing must reach the repository rather than being post-filtered: once
  // the list is paginated, filtering the returned page silently drops matches
  // that live on later pages.
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    queryParameters: { teamId: "team-1", ideaId: "idea-1", kind: "regular", limit: "25" },
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.calls[0], {
    method: "listSessions",
    args: { limit: 26, cursor: null, teamId: "team-1", ideaId: "idea-1", kind: "regular" },
  });
});

// teamId identifies WHICH actor the caller is (one actor row per user per
// team). It stays optional on the wire so already-released builds keep working:
// FC redeploys on merge, clients ship on tags. The repository routes a
// team-less call to the deprecated un-scoped RPC — see
// 20260804020000_per_team_actor_scope.sql.
// Was "still serves a client that sends no teamId". The un-scoped fallback it
// covered is gone: without a team the query cannot use
// sessions_team_active_last_message_idx, so it degraded linearly with the
// caller's history (4.5s at 6k sessions, statement_timeout 500 past ~13k).
// A caller that omits teamId now gets a 400 instead of a list that silently
// rots as it grows.
test("GET /v1/sessions rejects a client that sends no teamId", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
  assert.equal(repo.calls.length, 0, "must not reach the repository without a team");
});

test("GET /v1/sessions leaves ideaId null when not supplied", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: { Authorization: "Bearer token" },
    queryParameters: { teamId: "team-1" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.calls[0], {
    method: "listSessions",
    args: { limit: 51, cursor: null, teamId: "team-1", ideaId: null, kind: "all" },
  });
});

test("GET /v1/sessions rejects an unknown session kind", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: { Authorization: "Bearer token" },
    queryParameters: { teamId: "team-1", kind: "scheduled-ish" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 400);
  assert.equal(repo.calls.length, 0);
});


test("GET /v1/sessions/:sessionId/participants returns participant list", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-1/participants",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(Array.isArray(body.items));
  assert.deepEqual(repo.calls[0], { method: "listSessionParticipants", sessionId: "session-1" });
});

test("GET /v1/sessions/:sessionId/roster returns participant display names", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-1/roster",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.sessionId, "session-1");
  assert.ok(Array.isArray(body.items));
  assert.deepEqual(repo.calls[0], { method: "listSessionRoster", sessionId: "session-1" });
});

test("POST /v1/sessions/:sessionId/participants upserts participant", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/participants",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ actorId: "actor-2", role: "member" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.calls[0], { method: "upsertSessionParticipant", sessionId: "session-1", input: { actorId: "actor-2", role: "member" } });
});

test("POST /v1/sessions/:sessionId/participants returns 400 without actorId", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/participants",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ role: "member" }),
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("PATCH /v1/sessions/:sessionId/participants/:actorId/model updates the model", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/sessions/session-1/participants/actor-1/model",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ model: "anthropic/claude-sonnet-4-6" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "updateParticipantModel",
    sessionId: "session-1",
    actorId: "actor-1",
    input: { model: "anthropic/claude-sonnet-4-6" },
  });
});

test("PATCH /v1/sessions/:sessionId/participants/:actorId/model returns 400 without model", async () => {
  // Not nullable on purpose: every entry point pins a model at creation time,
  // so an empty body is a caller bug, not a request to clear (ADR-0007).
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/sessions/session-1/participants/actor-1/model",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({}),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 400);
  assert.equal(repo.calls.length, 0);
});

test("DELETE /v1/sessions/:sessionId/participants/:actorId removes participant", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "DELETE",
    path: "/v1/sessions/session-1/participants/actor-1",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "removeSessionParticipant", sessionId: "session-1", actorId: "actor-1" });
});

test("GET /v1/sessions/by-acp/:acpSessionId returns 404 when not found", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/by-acp/acp-missing",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "not_found");
});

test("POST /v1/sessions/gateway/ensure creates gateway session", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/gateway/ensure",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1", binding: "wecom:room#1", title: "Stand-up", primaryAgentActorId: "actor-1", ownerMemberActorIds: [], participantActorIds: [] }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(body.sessionId);
  assert.equal(body.created, true);
  assert.deepEqual(repo.calls[0], { method: "ensureGatewaySession", input: { teamId: "team-1", binding: "wecom:room#1", title: "Stand-up", primaryAgentActorId: "actor-1", ownerMemberActorIds: [], participantActorIds: [] } });
});

test("POST /v1/sessions/gateway/ensure returns 400 without required fields", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/gateway/ensure",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1" }),
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("POST /v1/sessions/cron creates cron session", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/cron",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1", primaryAgentActorId: "actor-1", title: "Daily" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(body.sessionId);
  assert.deepEqual(repo.calls[0], { method: "createCronSession", input: { teamId: "team-1", primaryAgentActorId: "actor-1", title: "Daily" } });
});

test("POST /v1/sessions/cron returns 400 without required fields", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/cron",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1" }),
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("GET /v1/notifications/prefs returns defaults", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/notifications/prefs",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(typeof body.pushEnabled, "boolean");
  assert.deepEqual(repo.calls[0], { method: "getNotificationPrefs" });
});

test("PUT /v1/notifications/prefs upserts prefs", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/notifications/prefs",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({
      userId: "user-1",
      pushEnabled: false,
      emailEnabled: true,
      digestFrequency: "daily",
    }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.pushEnabled, false);
  assert.equal(body.emailEnabled, true);
  assert.equal(body.digestFrequency, "daily");
  assert.deepEqual(repo.calls[0], {
    method: "putNotificationPrefs",
    input: {
      userId: "user-1",
      pushEnabled: false,
      emailEnabled: true,
      digestFrequency: "daily",
    },
  });
});

test("POST /v1/sessions/:sessionId/mute mutes session", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/mute",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ until: null }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "muteSession",
    sessionId: "session-1",
    input: { until: null },
  });
});

test("DELETE /v1/sessions/:sessionId/mute unmutes session", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "DELETE",
    path: "/v1/sessions/session-1/mute",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "unmuteSession",
    sessionId: "session-1",
  });
});

test("POST /v1/teams writes only the teams row", async () => {
  // The route provisions no gateway: it forwards name/slug/displayName and
  // nothing else, and the response is the plain team shape.
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ name: "Acme" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.id, "team-1");
  assert.equal(body.name, "Acme");
  assert.deepEqual(repo.calls[0], {
    method: "createTeam",
    input: { name: "Acme", slug: null, displayName: null },
  });
});

test("PATCH /v1/teams/:teamId renames team", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/teams/team-1",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ name: "Updated Team Name" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.id, "team-1");
  assert.equal(body.name, "Updated Team Name");
  assert.deepEqual(repo.calls[0], { method: "renameTeam", teamId: "team-1", input: { name: "Updated Team Name" } });
});

test("PATCH /v1/teams/:teamId returns 400 without name", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/teams/team-1",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({}),
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("POST /v1/teams/:teamId/invites creates invite", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/invites",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ kind: "member", displayName: "New User", teamRole: "member" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body);
  assert.equal(body.token, "invite-token");
  assert.deepEqual(repo.calls[0], { method: "createTeamInvite", teamId: "team-1", input: { kind: "member", displayName: "New User", teamRole: "member", agentKind: null, ttlSeconds: null, targetActorId: null, inviteEmail: null, invitePhone: null } });
});

test("POST /v1/teams/:teamId/invites forwards invitee contact", async () => {
  const repo = fakeRepo();
  await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/invites",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({
      kind: "member",
      displayName: "New User",
      teamRole: "member",
      inviteEmail: "new@example.com",
      invitePhone: "13800138000",
    }),
  }, { createRepository: () => repo });

  assert.equal(repo.calls[0].input.inviteEmail, "new@example.com");
  assert.equal(repo.calls[0].input.invitePhone, "13800138000");
});

test("POST /v1/teams/:teamId/invites returns 400 without required fields", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/invites",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ displayName: "New User" }),
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("DELETE /v1/teams/:teamId/members/:actorId removes team actor", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "DELETE",
    path: "/v1/teams/team-1/members/actor-1",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "removeTeamActor", teamId: "team-1", actorId: "actor-1" });
});

test("DELETE /v1/teams/:teamId/actors/:actorId removes team actor (scoped path)", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "DELETE",
    path: "/v1/teams/team-1/actors/actor-1",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "removeTeamActor", teamId: "team-1", actorId: "actor-1" });
});

test("GET /v1/sessions/muted returns muted session IDs", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/muted",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(Array.isArray(body.items));
  assert.deepEqual(repo.calls[0], { method: "listMutedSessions" });
});

test("GET /v1/teams/:teamId/shortcuts calls repo.listShortcuts", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/shortcuts",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(Array.isArray(body.items));
  assert.deepEqual(repo.calls[0], { method: "listShortcuts", teamId: "team-1", args: {} });
});

test("POST /v1/shortcuts calls repo.createShortcut", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/shortcuts",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: "team-1", kind: "link", label: "New Shortcut", position: 100 }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body);
  assert.ok(body.id);
  assert.equal(body.teamId, "team-1");
  assert.deepEqual(repo.calls[0], { method: "createShortcut", input: { teamId: "team-1", kind: "link", label: "New Shortcut", position: 100, scope: "team", nodeType: "link" } });
});

test("PATCH /v1/shortcuts/:shortcutId calls repo.updateShortcut", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/shortcuts/shortcut-1",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Updated Label" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.label, "Updated Label");
  assert.deepEqual(repo.calls[0], { method: "updateShortcut", shortcutId: "shortcut-1", patch: { label: "Updated Label" } });
});

test("DELETE /v1/shortcuts/:shortcutId calls repo.deleteShortcut", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "DELETE",
    path: "/v1/shortcuts/shortcut-1",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "deleteShortcut", shortcutId: "shortcut-1" });
});

test("POST /v1/shortcuts/batch-move calls repo.batchMoveShortcuts", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/shortcuts/batch-move",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ moves: [{ shortcutId: "shortcut-1", parentId: null, position: 0 }] }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "batchMoveShortcuts", input: { moves: [{ shortcutId: "shortcut-1", parentId: null, position: 0 }] } });
});

test("PUT /v1/shortcuts/:shortcutId/visible-roles calls repo.setShortcutVisibleRoles", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/shortcuts/shortcut-1/visible-roles",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ roleIds: ["role-1"] }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "setShortcutVisibleRoles", shortcutId: "shortcut-1", input: { roleIds: ["role-1"] } });
});

test("GET /v1/teams/:teamId/roles calls repo.listTeamRoles", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/roles",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(Array.isArray(body.items));
  assert.deepEqual(repo.calls[0], { method: "listTeamRoles", teamId: "team-1" });
});

test("GET /v1/teams/:teamId/permissions calls repo.listTeamPermissions", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/permissions",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(Array.isArray(body.items));
  assert.deepEqual(repo.calls[0], { method: "listTeamPermissions", teamId: "team-1" });
});

// ── Ideas ─────────────────────────────────────────────────────────────────────

test("GET /v1/ideas returns 400 without teamId", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/ideas",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("GET /v1/ideas returns 401 without bearer", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/ideas",
    headers: {},
    queryStringParameters: { teamId: "team-1" },
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).error.code, "missing_auth");
});

test("GET /v1/ideas returns idea page", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/ideas",
    headers: { Authorization: "Bearer token" },
    queryStringParameters: { teamId: "team-1" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(Array.isArray(body.items));
  assert.deepEqual(repo.calls[0], { method: "listIdeas", args: { teamId: "team-1", archived: false, limit: 50, cursor: null } });
});

test("GET /v1/ideas/:ideaId returns 404 for missing idea", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/ideas/idea-missing",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => fakeRepo({ ideas: [] }) });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "not_found");
});

test("GET /v1/ideas/:ideaId returns idea", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/ideas/idea-1",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.id, "idea-1");
  assert.deepEqual(repo.calls[0], { method: "getIdea", ideaId: "idea-1" });
});

test("POST /v1/ideas creates idea", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/ideas",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1", title: "New Idea", authorActorId: "actor-1" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body);
  assert.equal(body.title, "New Idea");
  assert.deepEqual(repo.calls[0], { method: "createIdea", input: { teamId: "team-1", title: "New Idea", authorActorId: "actor-1" } });
});

test("POST /v1/ideas returns 400 without required fields", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/ideas",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1" }),
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("PATCH /v1/ideas/:ideaId updates idea", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/ideas/idea-1",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ title: "Updated Title" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.title, "Updated Title");
  assert.deepEqual(repo.calls[0], { method: "updateIdea", ideaId: "idea-1", patch: { title: "Updated Title" } });
});

test("POST /v1/ideas/:ideaId/archive returns 204", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/ideas/idea-1/archive",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "archiveIdea", ideaId: "idea-1" });
});

test("POST /v1/ideas/:ideaId/activities creates activity", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/ideas/idea-1/activities",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ kind: "comment", actorId: "actor-1", content: "looks good" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body);
  assert.ok(body.id);
  assert.deepEqual(repo.calls[0], { method: "createIdeaActivity", ideaId: "idea-1", input: { kind: "comment", actorId: "actor-1", content: "looks good" } });
});

test("POST /v1/ideas/:ideaId/activities returns 400 without kind", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/ideas/idea-1/activities",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ actorId: "actor-1" }),
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

function session(id, lastMessageAt) {
  return {
    id,
    teamId: "team-1",
    title: id,
    mode: "collab",
    ideaId: null,
    lastMessageAt,
    lastMessagePreview: null,
    hasUnread: false,
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: lastMessageAt,
  };
}

// ─── /v1/agents/runtimes ───────────────────────────────────────────────────



test("GET /v1/agents/runtimes returns 404 for missing runtime", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/agents/runtimes",
    queryStringParameters: { sessionId: "session-missing", runtimeId: "runtime-abc" },
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 404);
});


test("GET /v1/agents/runtimes/latest returns 404 for missing", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/agents/runtimes/latest",
    queryStringParameters: { agentId: "actor-missing", sessionId: "session-1" },
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 404);
});



test("POST /v1/agents/types/ensure dispatches to repo.ensureAgentTypes", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/agents/types/ensure",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ supportedTypes: ["openai", "claude"], defaultAgentType: "claude" }),
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "ensureAgentTypes", input: { supportedTypes: ["openai", "claude"], defaultAgentType: "claude" } });
});

test("POST /v1/agents/types/ensure records an empty advertise as a clear", async () => {
  // A daemon whose team points at an uninstalled runtime supports nothing. That
  // has to land: refusing it left the previous answer on the row, and every
  // client went on badging a runtime the machine could no longer start.
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/agents/types/ensure",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ supportedTypes: [], defaultAgentType: null }),
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "ensureAgentTypes",
    input: { supportedTypes: [], defaultAgentType: null },
  });
});

test("POST /v1/agents/types/ensure still requires a default when types are given", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/agents/types/ensure",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ supportedTypes: ["pi"] }),
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 400);
});

test("PATCH /v1/agents/:agentActorId forwards display name and visibility", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/agents/actor-1",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "b003-agent", visibility: "personal" }),
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "updateOwnedAgentProfile",
    agentActorId: "actor-1",
    patch: { displayName: "b003-agent", avatarUrl: null, description: null, visibility: "personal" },
  });
});

test("PATCH /v1/agents/:agentActorId/defaults forwards default workspace + agent type", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/agents/actor-1/defaults",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ defaultAgentType: "claude", defaultWorkspaceId: "workspace-1" }),
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "updateAgentDefaults",
    agentActorId: "actor-1",
    patch: { defaultAgentType: "claude", supportedAgentTypes: null, defaultWorkspaceId: "workspace-1", agentKind: null },
  });
});

test("POST /v1/attachments uploads binary body and returns path + url", async () => {
  const repo = fakeRepo();
  const body = Buffer.from("png-bytes");
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/attachments",
    headers: { Authorization: "Bearer token", "Content-Type": "image/png" },
    queryStringParameters: { path: "foo/bar.png" },
    body: body.toString("base64"),
    isBase64Encoded: true,
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.path, "foo/bar.png");
  assert.ok(typeof parsed.url === "string");
  assert.deepEqual(repo.calls[0], {
    method: "uploadAttachment",
    input: { path: "foo/bar.png", mime: "image/png", bytes: body, bucket: "attachments" },
  });
});

test("POST /v1/attachments?bucket=avatars routes to avatars bucket and returns avatars url", async () => {
  const repo = fakeRepo();
  const body = Buffer.from("avatar-bytes");
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/attachments",
    headers: { Authorization: "Bearer token", "Content-Type": "image/jpeg" },
    queryStringParameters: { path: "actor-1/avatar-1.jpg", bucket: "avatars" },
    body: body.toString("base64"),
    isBase64Encoded: true,
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.path, "actor-1/avatar-1.jpg");
  assert.ok(parsed.url.includes("/avatars/"));
  assert.deepEqual(repo.calls[0], {
    method: "uploadAttachment",
    input: { path: "actor-1/avatar-1.jpg", mime: "image/jpeg", bytes: body, bucket: "avatars" },
  });
});

test("POST /v1/attachments rejects unknown bucket with 400", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/attachments",
    headers: { Authorization: "Bearer token", "Content-Type": "image/png" },
    queryStringParameters: { path: "x.png", bucket: "secrets" },
    body: Buffer.from("x").toString("base64"),
    isBase64Encoded: true,
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.error.code, "invalid_request");
  assert.equal(repo.calls.length, 0);
});

test("POST /v1/attachments returns 400 when path query param is missing", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/attachments",
    headers: { Authorization: "Bearer token", "Content-Type": "image/png" },
    queryStringParameters: {},
    body: Buffer.from("bytes").toString("base64"),
    isBase64Encoded: true,
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.error.code, "invalid_request");
});

test("GET /v1/attachments/:path returns binary response", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/attachments/foo%2Fbar.png",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 200);
  assert.equal((response as any).isBase64Encoded, true);
  assert.equal(response.headers["Content-Type"], "image/png");
  const decoded = Buffer.from(response.body, "base64");
  assert.deepEqual(decoded, Buffer.from("fake-image-bytes"));
  assert.deepEqual(repo.calls[0], { method: "downloadAttachment", path: "foo%2Fbar.png", options: { bucket: "attachments" } });
});

test("GET /v1/attachments/:path returns 404 when attachment missing", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/attachments/missing%2Ffile.bin",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 404);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.error.code, "not_found");
});

// Telemetry routes

test("POST /v1/feedback requires bearer token", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/feedback",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId: "00000000-0000-0000-0000-000000000001", actorId: "00000000-0000-0000-0000-000000000002", kind: "up" }),
  }, { createRepository: () => fakeRepo() });
  assert.equal(response.statusCode, 401);
});

test("POST /v1/feedback returns 400 when messageId is missing", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/feedback",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ actorId: "00000000-0000-0000-0000-000000000002", kind: "up" }),
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.error.code, "validation_failed");
});

test("POST /v1/feedback happy path returns 201", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/feedback",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ messageId: "00000000-0000-0000-0000-000000000001", actorId: "00000000-0000-0000-0000-000000000002", teamId: "00000000-0000-0000-0000-000000000003", kind: "positive", starRating: 5, note: "great" }),
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 201);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.kind, "positive");
  assert.deepEqual(repo.calls[0], { method: "submitFeedback", body: { messageId: "00000000-0000-0000-0000-000000000001", actorId: "00000000-0000-0000-0000-000000000002", teamId: "00000000-0000-0000-0000-000000000003", kind: "positive", starRating: 5, note: "great" } });
});

test("GET /v1/feedback returns 400 when sessionId is missing", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/feedback",
    headers: { Authorization: "Bearer token" },
    queryStringParameters: {},
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.error.code, "validation_failed");
});

test("GET /v1/feedback returns items list", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/feedback",
    headers: { Authorization: "Bearer token" },
    queryStringParameters: { sessionId: "00000000-0000-0000-0000-000000000003" },
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.body);
  assert.ok(Array.isArray(parsed.items), "items must be an array");
  assert.deepEqual(repo.calls[0], { method: "listFeedback", args: { sessionId: "00000000-0000-0000-0000-000000000003" } });
});

test("DELETE /v1/feedback/:messageId returns 204", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "DELETE",
    path: "/v1/feedback/00000000-0000-0000-0000-000000000001",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "deleteFeedback", messageId: "00000000-0000-0000-0000-000000000001", actorId: null });
});

test("GET /v1/teams/:teamId/leaderboard defaults to week period", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/leaderboard",
    headers: { Authorization: "Bearer token" },
    queryStringParameters: {},
  }, { createRepository: () => repo });
  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.body);
  assert.ok(Array.isArray(parsed.items));
  assert.deepEqual(repo.calls[0], { method: "getTeamLeaderboard", teamId: "team-1", args: { period: "week" } });
});




type SyncPageOpts = { limit?: number | null; cursor?: string | null };

function fakeRepo({ sessions = [], error = null, teamWorkspaceConfigs = {}, workspaces = [], ideas = null, messages = [], syncRows = [] } = {}) {
  const calls = [];
  const messageStore = messages.slice();
  const syncStore = syncRows.slice();
  const configs = { ...teamWorkspaceConfigs };
  const workspaceStore = workspaces.length > 0 ? workspaces.slice() : [
    { id: "workspace-1", teamId: "team-1", name: "Alpha", slug: null, archived: false, metadata: null, createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" },
  ];
  const ideaStore = ideas !== null ? ideas.slice() : [
    { id: "idea-1", teamId: "team-1", title: "Idea One", description: null, archived: false, authorActorId: "actor-1", actorIds: [], createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" },
  ];
  const sessionStore = sessions.length > 0 ? sessions.slice() : [
    { id: "session-1", teamId: "team-1", title: "Architecture plan", mode: "collab", ideaId: "idea-1", lastMessageAt: "2026-05-27T00:30:00Z", lastMessagePreview: "Start with OpenAPI.", hasUnread: false, createdAt: "2026-05-26T23:00:00Z", updatedAt: "2026-05-27T00:30:00Z", participants: [{ sessionId: "session-1", actorId: "actor-1", role: "owner", joinedAt: "2026-05-26T23:00:00Z" }] },
    { id: "session-2", teamId: "team-1", title: "Migration review", mode: "collab", ideaId: null, lastMessageAt: "2026-05-27T02:00:00Z", lastMessagePreview: "FC facade is the next boundary.", hasUnread: true, createdAt: "2026-05-27T01:00:00Z", updatedAt: "2026-05-27T02:00:00Z", participants: [] },
  ];
  const gatewayBindings = {};
  return {
    calls,
    async listTeams(args) { calls.push({ method: "listTeams", args }); if (error) throw error; return []; },
    async createTeam(input) { calls.push({ method: "createTeam", input }); if (error) throw error; return { id: "team-1", name: input.name, slug: input.slug ?? null, createdAt: null }; },
    async getTeam(teamId) { calls.push({ method: "getTeam", teamId }); if (error) throw error; return { id: teamId, name: "Team", slug: null, createdAt: null }; },
    async listSessions(args) { calls.push({ method: "listSessions", args }); if (error) throw error; return sessions.length > 0 ? sessions : sessionStore; },
    async getSession(sessionId, opts: { teamId?: string | null } = {}) { calls.push({ method: "getSession", sessionId, teamId: opts?.teamId ?? null }); if (error) throw error; const store = sessions.length > 0 ? sessions : sessionStore; return store.find(s => s.id === sessionId) ?? null; },
    async patchSession(sessionId, patch) { calls.push({ method: "patchSession", sessionId, patch }); if (error) throw error; const store = sessions.length > 0 ? sessions : sessionStore; const s = store.find(s => s.id === sessionId); if (!s) return null; if (patch.title !== undefined) s.title = patch.title; return s; },
    async createSession(input) { calls.push({ method: "createSession", input }); if (error) throw error; const id = input.id ?? "session-new"; const newS = { id, teamId: input.teamId, title: input.title, mode: input.mode, ideaId: null, lastMessageAt: null, lastMessagePreview: null, hasUnread: false, createdAt: "2026-05-27T03:00:00Z", updatedAt: "2026-05-27T03:00:00Z", participants: (input.participantActorIds ?? []).map(a => ({ sessionId: id, actorId: a, role: "member", joinedAt: null })) }; sessionStore.push(newS); return newS; },
    async markSessionViewed(sessionId, lastReadMessageId) { calls.push({ method: "markSessionViewed", sessionId, lastReadMessageId }); if (error) throw error; },
    async markSessionUnread(sessionId) { calls.push({ method: "markSessionUnread", sessionId }); if (error) throw error; },
    async listAgentRuntimesForTeam(teamId) { calls.push({ method: "listAgentRuntimesForTeam", teamId }); if (error) throw error; return [{ id: "rt-1", teamId, agentId: "agent-1", sessionId: "session-1", workspaceId: null, backendType: "claude_code", status: "ready", backendSessionId: "bs-1", runtimeId: "rt12abcd", currentModel: "claude-opus-4-7", lastSeenAt: "2026-05-27T01:00:00Z", createdAt: "2026-05-27T00:00:00Z", updatedAt: "2026-05-27T01:00:00Z" }]; },
    async listSessionParticipants(sessionId) { calls.push({ method: "listSessionParticipants", sessionId }); if (error) throw error; const store = sessions.length > 0 ? sessions : sessionStore; const s = store.find(s => s.id === sessionId); return { items: s?.participants ?? [] }; },
    async listSessionRoster(sessionId) { calls.push({ method: "listSessionRoster", sessionId }); if (error) throw error; const store = sessions.length > 0 ? sessions : sessionStore; const s = store.find(s => s.id === sessionId); const participants = s?.participants ?? []; return { sessionId, callerActorId: participants[0]?.actorId ?? "actor-1", title: s?.title ?? null, selfAgent: null, items: participants.map(p => ({ actorId: p.actorId, displayName: "Alice", kind: "member", isSelf: p.actorId === (participants[0]?.actorId ?? "actor-1") })) }; },
    async upsertSessionParticipant(sessionId, input) { calls.push({ method: "upsertSessionParticipant", sessionId, input }); if (error) throw error; const store = sessions.length > 0 ? sessions : sessionStore; const s = store.find(s => s.id === sessionId); const existing = s?.participants?.find(p => p.actorId === input.actorId); if (existing) { existing.role = input.role ?? existing.role; return existing; } const newP = { sessionId, actorId: input.actorId, role: input.role ?? "member", joinedAt: null }; if (s) s.participants.push(newP); return newP; },
    async updateParticipantModel(sessionId, actorId, input) { calls.push({ method: "updateParticipantModel", sessionId, actorId, input }); if (error) throw error; const store = sessions.length > 0 ? sessions : sessionStore; const s = store.find(s => s.id === sessionId); const p = s?.participants?.find(p => p.actorId === actorId); if (p) p.model = input.model; },
    async removeSessionParticipant(sessionId, actorId) { calls.push({ method: "removeSessionParticipant", sessionId, actorId }); if (error) throw error; const store = sessions.length > 0 ? sessions : sessionStore; const s = store.find(s => s.id === sessionId); if (s?.participants) s.participants = s.participants.filter(p => p.actorId !== actorId); },
    async getSessionByAcp(acpSessionId) { calls.push({ method: "getSessionByAcp", acpSessionId }); if (error) throw error; return gatewayBindings[acpSessionId] ?? null; },
    async ensureGatewaySession(input) { calls.push({ method: "ensureGatewaySession", input }); if (error) throw error; const b = input.binding; if (gatewayBindings[b]) return { ...gatewayBindings[b], created: false }; const r = { sessionId: "gw-" + b, gatewaySessionId: b, created: true }; gatewayBindings[b] = r; return r; },
    async createCronSession(input) { calls.push({ method: "createCronSession", input }); if (error) throw error; return { sessionId: "cron-" + input.title }; },
    async listActorDirectoryForSync(teamId, since, opts: SyncPageOpts = {}) { calls.push({ method: "listActorDirectoryForSync", teamId, since, limit: opts?.limit ?? null, cursor: opts?.cursor ?? null }); return syncStore.slice(0, opts?.limit ?? syncStore.length); },
    async listIdeasForSync(teamId, since, opts: SyncPageOpts = {}) { calls.push({ method: "listIdeasForSync", teamId, since, limit: opts?.limit ?? null, cursor: opts?.cursor ?? null }); return syncStore.slice(0, opts?.limit ?? syncStore.length); },
    async listSessionParticipantsForSync(sessionId, since, opts: SyncPageOpts = {}) { calls.push({ method: "listSessionParticipantsForSync", sessionId, since, limit: opts?.limit ?? null, cursor: opts?.cursor ?? null }); return syncStore.slice(0, opts?.limit ?? syncStore.length); },
    async listSessionsForTeamSince(teamId, since, opts: SyncPageOpts = {}) { calls.push({ method: "listSessionsForTeamSince", teamId, since, limit: opts?.limit ?? null, cursor: opts?.cursor ?? null }); return syncStore.slice(0, opts?.limit ?? syncStore.length); },
    async listMessagesForSessionSince(sessionId, since, opts: SyncPageOpts = {}) { calls.push({ method: "listMessagesForSessionSince", sessionId, since, limit: opts?.limit ?? null, cursor: opts?.cursor ?? null }); return syncStore.slice(0, opts?.limit ?? syncStore.length); },
    async listMessages(sessionId, opts: SyncPageOpts = {}) { calls.push({ method: "listMessages", sessionId, limit: opts?.limit ?? null, cursor: opts?.cursor ?? null }); if (error) throw error; return messageStore.slice(0, opts?.limit ?? messageStore.length); },
    async insertMessage(sessionId, input) { calls.push({ method: "insertMessage", sessionId, input }); if (error) throw error; return { id: input.id, teamId: input.teamId, sessionId, turnId: null, senderActorId: input.senderActorId, replyToMessageId: null, kind: input.kind ?? "text", content: input.content, metadata: input.metadata ?? null, model: null, createdAt: "2026-05-27T01:00:00Z", updatedAt: null }; },
    async patchMessage(messageId, patch) { calls.push({ method: "patchMessage", messageId, patch }); if (error) throw error; return { id: messageId, teamId: "team-1", sessionId: "session-1", turnId: null, senderActorId: "actor-1", replyToMessageId: null, kind: "text", content: patch.content ?? "hello", metadata: patch.metadata ?? null, model: null, createdAt: "2026-05-27T01:00:00Z", updatedAt: "2026-05-27T02:00:00Z" }; },
    async deleteMessage(messageId) { calls.push({ method: "deleteMessage", messageId }); if (error) throw error; },
    async claimInvite(token) { calls.push({ method: "claimInvite", token }); if (error) throw error; return { actorId: "actor-1", teamId: "team-1", actorType: "member", displayName: "Alice", refreshToken: null }; },
    async getTeamWorkspaceConfig(teamId) { calls.push({ method: "getTeamWorkspaceConfig", teamId }); if (error) throw error; return configs[teamId] ?? null; },
    async putTeamWorkspaceConfig(teamId, input) { calls.push({ method: "putTeamWorkspaceConfig", teamId, input }); if (error) throw error; configs[teamId] = { teamId, defaultWorkspaceId: input.defaultWorkspaceId ?? null, pinnedWorkspaceIds: input.pinnedWorkspaceIds ?? [], updatedAt: "2026-05-27T01:00:00Z" }; return configs[teamId]; },
    async heartbeat() { calls.push({ method: "heartbeat" }); if (error) throw error; },
    async writeForegroundPresence(input) { calls.push({ method: "writeForegroundPresence", input }); if (error) throw error; },
    async listWorkspaces(args) { calls.push({ method: "listWorkspaces", args }); if (error) throw error; return { items: workspaceStore }; },
    async upsertWorkspace(input) { calls.push({ method: "upsertWorkspace", input }); if (error) throw error; const existing = workspaceStore.find(w => w.id === input.id); if (existing) { Object.assign(existing, input); return existing; } const newW = { id: input.id ?? "workspace-new", teamId: input.teamId, name: input.name, slug: input.slug ?? null, archived: input.archived ?? false, metadata: input.metadata ?? null, createdAt: "2026-05-27T01:00:00Z", updatedAt: "2026-05-27T01:00:00Z" }; workspaceStore.push(newW); return newW; },
    async getWorkspace(workspaceId) { calls.push({ method: "getWorkspace", workspaceId }); if (error) throw error; return workspaceStore.find(w => w.id === workspaceId) ?? null; },
    async patchWorkspace(workspaceId, patch) { calls.push({ method: "patchWorkspace", workspaceId, patch }); if (error) throw error; const w = workspaceStore.find(w => w.id === workspaceId); if (!w) return null; if (patch.name !== undefined) w.name = patch.name; if (patch.archived !== undefined) w.archived = patch.archived; return w; },
    async getTeamDirectory(teamId) { calls.push({ method: "getTeamDirectory", teamId }); if (error) throw error; return { actors: [{ id: "actor-1", teamId: "team-1", kind: "user", displayName: "Alice", avatarUrl: null, metadata: null }], members: [{ actorId: "actor-1", teamId: "team-1", role: "member", joinedAt: "2026-05-27T01:00:00Z" }] }; },
    async renameTeam(teamId, input) { calls.push({ method: "renameTeam", teamId, input }); if (error) throw error; return { id: teamId, name: input.name, slug: null, createdAt: null }; },
    async createTeamInvite(teamId, input) { calls.push({ method: "createTeamInvite", teamId, input }); if (error) throw error; return { token: "invite-token", inviteId: "invite-1", expiresAt: input.expiresAt ?? null }; },
    async removeTeamActor(teamId, actorId) { calls.push({ method: "removeTeamActor", teamId, actorId }); if (error) throw error; },
    async getNotificationPrefs() { calls.push({ method: "getNotificationPrefs" }); if (error) throw error; return { userId: null, pushEnabled: true, emailEnabled: false, digestFrequency: "off" }; },
    async putNotificationPrefs(input) { calls.push({ method: "putNotificationPrefs", input }); if (error) throw error; return { userId: input.userId ?? "user-1", pushEnabled: input.pushEnabled ?? true, emailEnabled: input.emailEnabled ?? false, digestFrequency: input.digestFrequency ?? "off" }; },
    async muteSession(sessionId, input) { calls.push({ method: "muteSession", sessionId, input }); if (error) throw error; },
    async unmuteSession(sessionId) { calls.push({ method: "unmuteSession", sessionId }); if (error) throw error; },
    async listMutedSessions() { calls.push({ method: "listMutedSessions" }); if (error) throw error; return { items: [] }; },
    async listIdeas(args) { calls.push({ method: "listIdeas", args }); if (error) throw error; return { items: ideaStore }; },
    async getIdea(ideaId) { calls.push({ method: "getIdea", ideaId }); if (error) throw error; return ideaStore.find(i => i.id === ideaId) ?? null; },
    async createIdea(input) { calls.push({ method: "createIdea", input }); if (error) throw error; const idea = { id: input.id ?? "idea-new", teamId: input.teamId, title: input.title, description: input.description ?? null, archived: false, authorActorId: input.authorActorId, actorIds: input.actorIds ?? [], createdAt: "2026-05-27T01:00:00Z", updatedAt: "2026-05-27T01:00:00Z" }; ideaStore.push(idea); return idea; },
    async updateIdea(ideaId, patch) { calls.push({ method: "updateIdea", ideaId, patch }); if (error) throw error; const i = ideaStore.find(i => i.id === ideaId); if (!i) return null; if (patch.title !== undefined) i.title = patch.title; if (patch.description !== undefined) i.description = patch.description; return i; },
    async archiveIdea(ideaId) { calls.push({ method: "archiveIdea", ideaId }); if (error) throw error; const i = ideaStore.find(i => i.id === ideaId); if (i) i.archived = true; },
    async createIdeaActivity(ideaId, input) { calls.push({ method: "createIdeaActivity", ideaId, input }); if (error) throw error; return { id: "activity-1", ideaId, kind: input.kind, content: input.content ?? null, actorId: input.actorId, metadata: input.metadata ?? null, createdAt: "2026-05-27T01:00:00Z" }; },
    async listShortcuts(teamId, args) { calls.push({ method: "listShortcuts", teamId, args }); if (error) throw error; return [{ id: "shortcut-1", teamId, parentId: null, kind: "link", label: "Home", payload: null, position: 0, visibleRoleIds: [], createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" }]; },
    async createShortcut(input) { calls.push({ method: "createShortcut", input }); if (error) throw error; return { id: input.id ?? "shortcut-new", teamId: input.teamId, parentId: input.parentId ?? null, kind: input.kind, label: input.label, payload: input.payload ?? null, position: input.position ?? 0, visibleRoleIds: input.visibleRoleIds ?? [], createdAt: "2026-05-27T01:00:00Z", updatedAt: "2026-05-27T01:00:00Z" }; },
    async updateShortcut(shortcutId, patch) { calls.push({ method: "updateShortcut", shortcutId, patch }); if (error) throw error; return { id: shortcutId, teamId: "team-1", parentId: null, kind: "link", label: patch.label ?? "Home", payload: null, position: 0, visibleRoleIds: [], createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-27T02:00:00Z" }; },
    async deleteShortcut(shortcutId) { calls.push({ method: "deleteShortcut", shortcutId }); if (error) throw error; },
    async batchMoveShortcuts(input) { calls.push({ method: "batchMoveShortcuts", input }); if (error) throw error; },
    async setShortcutVisibleRoles(shortcutId, input) { calls.push({ method: "setShortcutVisibleRoles", shortcutId, input }); if (error) throw error; },
    async listTeamRoles(teamId) { calls.push({ method: "listTeamRoles", teamId }); if (error) throw error; return [{ id: "role-1", teamId, code: "admin", name: "Admin" }]; },
    async listTeamPermissions(teamId) { calls.push({ method: "listTeamPermissions", teamId }); if (error) throw error; return [{ resourceId: "resource-1", roleIds: ["role-1"] }]; },
    async upsertAgentRuntime(body) { calls.push({ method: "upsertAgentRuntime", body }); if (error) throw error; return { id: body.id ?? "runtime-row-1" }; },
    async getAgentRuntime(args) { calls.push({ method: "getAgentRuntime", args }); if (error) throw error; if (args.sessionId === "session-missing") return null; return { id: "runtime-row-1", agentActorId: "actor-1", sessionId: args.sessionId, runtimeId: args.runtimeId ?? "runtime-abc", backendSessionId: args.backendSessionId ?? "backend-1", lastProcessedMessageId: null, metadata: null, createdAt: null, updatedAt: null }; },
    async getLatestAgentRuntime(args) { calls.push({ method: "getLatestAgentRuntime", args }); if (error) throw error; if (args.agentId === "actor-missing") return null; return { id: "runtime-row-1", agentActorId: args.agentId, sessionId: args.sessionId, runtimeId: "runtime-abc", backendSessionId: "backend-1", lastProcessedMessageId: null, metadata: null, createdAt: null, updatedAt: null }; },
    async updateRuntimeCursor(runtimeRowId, input) { calls.push({ method: "updateRuntimeCursor", runtimeRowId, input }); if (error) throw error; },
    async ensureAgentTypes(input) { calls.push({ method: "ensureAgentTypes", input }); if (error) throw error; },
    async updateOwnedAgentProfile(agentActorId, patch) { calls.push({ method: "updateOwnedAgentProfile", agentActorId, patch }); if (error) throw error; },
    async updateAgentDefaults(agentActorId, patch) { calls.push({ method: "updateAgentDefaults", agentActorId, patch }); if (error) throw error; },
    async uploadAttachment(input) { calls.push({ method: "uploadAttachment", input }); if (error) throw error; const bucket = input.bucket ?? "attachments"; return { path: input.path, url: `https://supabase.example.com/storage/v1/object/public/${bucket}/${input.path}` }; },
    async downloadAttachment(path, options) { calls.push({ method: "downloadAttachment", path, options }); if (error) throw error; if (path === "missing/file.bin" || path === "missing%2Ffile.bin") return null; return { mime: "image/png", bytes: Buffer.from("fake-image-bytes") }; },
    async submitFeedback(body) { calls.push({ method: "submitFeedback", body }); if (error) throw error; return { messageId: body.messageId, actorId: body.actorId, kind: body.kind, starRating: body.starRating ?? null, note: body.note ?? null, createdAt: "2026-05-28T00:00:00Z", updatedAt: null }; },
    async listFeedback(args) { calls.push({ method: "listFeedback", args }); if (error) throw error; return { items: [] }; },
    async deleteFeedback(messageId, actorId) { calls.push({ method: "deleteFeedback", messageId, actorId }); if (error) throw error; },
    async getTeamLeaderboard(teamId, args) { calls.push({ method: "getTeamLeaderboard", teamId, args }); if (error) throw error; return { items: [] }; },
    async reportClientVersion(teamId, body) { calls.push({ method: "reportClientVersion", teamId, body }); if (error) throw error; },
  };
}
