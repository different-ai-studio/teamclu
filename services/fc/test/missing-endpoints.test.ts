import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";

function makeRepo(overrides = {}) {
  const calls = [];
  const record = (method) => async (...args) => {
    calls.push({ method, args });
    const fn = overrides[method];
    return typeof fn === "function" ? fn(...args) : undefined;
  };
  return {
    calls,
    listSessionsForTeamSince: record("listSessionsForTeamSince"),
    listMessagesForSessionSince: record("listMessagesForSessionSince"),
    listSessionDisplayRows: record("listSessionDisplayRows"),
    createThread: record("createThread"),
    listThreadSummaries: record("listThreadSummaries"),
    listSessionIdsForActor: record("listSessionIdsForActor"),
    listWorkspacesByIdsSlim: record("listWorkspacesByIdsSlim"),
    listShortcutRoleBindings: record("listShortcutRoleBindings"),
    submitFeedback: record("submitFeedback"),
    listFeedback: record("listFeedback"),
    deleteFeedback: record("deleteFeedback"),
    submitSessionReport: record("submitSessionReport"),
    submitSkillUsage: record("submitSkillUsage"),
    listFeedbackSummary: record("listFeedbackSummary"),
    getTeamLeaderboard: record("getTeamLeaderboard"),
  };
}

async function request(repo: any, { method, path, body, headers = {}, query = {} }: { method: any; path: any; body?: any; headers?: any; query?: any }) {
  return handleBusinessApiRequest(
    {
      httpMethod: method,
      path,
      headers: { Authorization: "Bearer caller-token", ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      queryStringParameters: query,
    },
    {
      createRepository: () => repo,
      createAuthRepository: () => repo,
    },
  );
}

test("GET /v1/sync/sessions forwards teamId+since", async () => {
  const repo = makeRepo({
    listSessionsForTeamSince: () => [{ id: "s1", team_id: "t1" }],
  });
  const res = await request(repo, {
    method: "GET",
    path: "/v1/sync/sessions",
    query: { teamId: "t1", since: "2026-05-01T00:00:00Z" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).items[0].id, "s1");
  assert.deepEqual(repo.calls[0].args, [
    "t1",
    "2026-05-01T00:00:00Z",
    { limit: 50, cursor: null },
  ]);
});

test("GET /v1/sync/sessions paginates: nextCursor set only on a full page", async () => {
  // A short page means the walk is done — returning a cursor there would make
  // clients loop forever on an empty tail.
  const short = makeRepo({
    listSessionsForTeamSince: () => [
      { id: "s1", team_id: "t1", updated_at: "2026-05-01T00:00:00Z" },
    ],
  });
  const shortRes = await request(short, {
    method: "GET",
    path: "/v1/sync/sessions",
    query: { teamId: "t1", limit: "2" },
  });
  assert.equal(JSON.parse(shortRes.body).nextCursor, null);

  const full = makeRepo({
    listSessionsForTeamSince: () => [
      { id: "s1", team_id: "t1", updated_at: "2026-05-01T00:00:00Z" },
      { id: "s2", team_id: "t1", updated_at: "2026-05-02T00:00:00Z" },
    ],
  });
  const fullRes = await request(full, {
    method: "GET",
    path: "/v1/sync/sessions",
    query: { teamId: "t1", limit: "2" },
  });
  const cursor = JSON.parse(fullRes.body).nextCursor;
  assert.ok(cursor, "a full page must hand back a cursor");
  assert.deepEqual(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")), {
    updatedAt: "2026-05-02T00:00:00Z",
    id: "s2",
  });

  // And that cursor must round-trip back into the repository call.
  const next = makeRepo({ listSessionsForTeamSince: () => [] });
  await request(next, {
    method: "GET",
    path: "/v1/sync/sessions",
    query: { teamId: "t1", limit: "2", cursor },
  });
  assert.deepEqual(next.calls[0].args[2], {
    limit: 2,
    cursor: { updatedAt: "2026-05-02T00:00:00Z", id: "s2" },
  });
});

test("GET /v1/sync/sessions requires teamId", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "GET",
    path: "/v1/sync/sessions",
    query: {},
  });
  assert.equal(res.statusCode, 400);
});

test("GET /v1/sync/messages forwards sessionId+since", async () => {
  const repo = makeRepo({
    listMessagesForSessionSince: () => [{ id: "m1" }],
  });
  const res = await request(repo, {
    method: "GET",
    path: "/v1/sync/messages",
    query: { sessionId: "s1" },
  });
  assert.equal(res.statusCode, 200);
  // Third arg is the page options the route now always supplies; the endpoint
  // is keyset-paginated rather than returning a session's whole history.
  const [sessionId, since, page] = repo.calls[0].args;
  assert.equal(sessionId, "s1");
  assert.equal(since, null);
  assert.equal(typeof page.limit, "number");
  assert.equal(page.cursor, null);
});

test("GET /v1/sync/messages requires sessionId", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "GET",
    path: "/v1/sync/messages",
    query: {},
  });
  assert.equal(res.statusCode, 400);
});

test("POST /v1/sessions/display-rows forwards teamId+ids", async () => {
  const repo = makeRepo({
    listSessionDisplayRows: () => [{ id: "s1", title: "Hi" }],
  });
  const res = await request(repo, {
    method: "POST",
    path: "/v1/sessions/display-rows",
    body: { teamId: "t1", sessionIds: ["s1", "s2"] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0].args, ["t1", ["s1", "s2"]]);
});

test("POST /v1/sessions/display-rows rejects non-array sessionIds", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "POST",
    path: "/v1/sessions/display-rows",
    body: { teamId: "t1", sessionIds: "nope" },
  });
  assert.equal(res.statusCode, 400);
});

test("GET /v1/actors/:actorId/sessions returns ids", async () => {
  const repo = makeRepo({
    listSessionIdsForActor: () => ["s1", "s2"],
  });
  const res = await request(repo, {
    method: "GET",
    path: "/v1/actors/actor-1/sessions",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { items: ["s1", "s2"] });
  assert.deepEqual(repo.calls[0].args, ["actor-1"]);
});

test("POST /v1/workspaces/by-ids forwards teamId+ids", async () => {
  const repo = makeRepo({
    listWorkspacesByIdsSlim: () => [{ id: "w1", name: "Alpha", path: "/x" }],
  });
  const res = await request(repo, {
    method: "POST",
    path: "/v1/workspaces/by-ids",
    body: { teamId: "t1", ids: ["w1"] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0].args, ["t1", ["w1"]]);
});

test("POST /v1/workspaces/by-ids rejects non-array ids", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "POST",
    path: "/v1/workspaces/by-ids",
    body: { teamId: "t1", ids: "no" },
  });
  assert.equal(res.statusCode, 400);
});

test("GET /v1/teams/:teamId/shortcut-role-bindings returns items", async () => {
  const repo = makeRepo({
    listShortcutRoleBindings: () => [
      { resource_id: "sc1", permission_roles: [{ role_id: "r1" }] },
    ],
  });
  const res = await request(repo, {
    method: "GET",
    path: "/v1/teams/team-1/shortcut-role-bindings",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0].args, ["team-1"]);
  assert.equal(JSON.parse(res.body).items[0].resource_id, "sc1");
});

// Telemetry route tests

test("POST /v1/feedback accepts kind=positive and returns 201", async () => {
  const repo = makeRepo({
    submitFeedback: () => ({ id: "fb1", kind: "positive" }),
  });
  const res = await request(repo, {
    method: "POST",
    path: "/v1/feedback",
    body: { messageId: "m1", actorId: "a1", teamId: "t1", kind: "positive" },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(repo.calls[0].method, "submitFeedback");
});

test("POST /v1/feedback accepts kind=negative and returns 201", async () => {
  const repo = makeRepo({
    submitFeedback: () => ({ id: "fb2", kind: "negative" }),
  });
  const res = await request(repo, {
    method: "POST",
    path: "/v1/feedback",
    body: { messageId: "m2", actorId: "a1", teamId: "t1", kind: "negative" },
  });
  assert.equal(res.statusCode, 201);
});

test("POST /v1/feedback rejects kind=up with 400", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "POST",
    path: "/v1/feedback",
    body: { messageId: "m3", actorId: "a1", teamId: "t1", kind: "up" },
  });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, "validation_failed");
});

test("POST /v1/feedback rejects kind=star with 400", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "POST",
    path: "/v1/feedback",
    body: { messageId: "m4", actorId: "a1", teamId: "t1", kind: "star" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /v1/session-report routes to submitSessionReport and returns 201", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "POST",
    path: "/v1/session-report",
    body: { actorId: "a1", teamId: "t1", sessionId: "s1", duration: 120 },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(repo.calls[0].method, "submitSessionReport");
  assert.equal(repo.calls[0].args[0].sessionId, "s1");
});

test("POST /v1/session-report requires sessionId", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "POST",
    path: "/v1/session-report",
    body: { actorId: "a1", teamId: "t1" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /v1/skill-usage routes to submitSkillUsage and returns 201", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "POST",
    path: "/v1/skill-usage",
    body: { actorId: "a1", teamId: "t1", skill: "my-skill" },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(repo.calls[0].method, "submitSkillUsage");
  assert.equal(repo.calls[0].args[0].skill, "my-skill");
});

test("POST /v1/skill-usage requires skill", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "POST",
    path: "/v1/skill-usage",
    body: { actorId: "a1", teamId: "t1" },
  });
  assert.equal(res.statusCode, 400);
});

test("GET /v1/feedback-summary returns items from listFeedbackSummary", async () => {
  // Stub mirrors the real repo, which returns { items: [...] } (NOT a bare
  // array) — so this guards against the route double-wrapping the result.
  const repo = makeRepo({
    listFeedbackSummary: () => ({ items: [{ actorId: "a1", displayName: null, positive: 3, negative: 1, total: 4 }] }),
  });
  const res = await request(repo, {
    method: "GET",
    path: "/v1/feedback-summary",
    query: { teamId: "t1" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(repo.calls[0].method, "listFeedbackSummary");
  assert.deepEqual(repo.calls[0].args, ["t1"]);
  const body = JSON.parse(res.body);
  assert.equal(body.items[0].actorId, "a1");
  assert.equal(body.items[0].total, 4);
  assert.ok(!Array.isArray(body.items[0]), "items[0] must be an object, not a nested array (no double-wrap)");
});

test("GET /v1/feedback-summary requires teamId", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "GET",
    path: "/v1/feedback-summary",
    query: {},
  });
  assert.equal(res.statusCode, 400);
});

test("POST /v1/sessions/:id/threads forwards rootMessageId", async () => {
  const repo = makeRepo({
    createThread: () => ({ id: "thread-1", title: "T" }),
  });
  const res = await request(repo, {
    method: "POST",
    path: "/v1/sessions/parent-1/threads",
    body: { rootMessageId: "msg-1" },
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(repo.calls[0].args, ["parent-1", { rootMessageId: "msg-1" }]);
});

test("GET /v1/sessions/:id/thread-summaries returns items", async () => {
  const repo = makeRepo({
    listThreadSummaries: () => [
      {
        threadSessionId: "t1",
        rootMessageId: "m1",
        messageCount: 2,
        lastMessageAt: null,
        participantCount: 3,
      },
    ],
  });
  const res = await request(repo, {
    method: "GET",
    path: "/v1/sessions/parent-1/thread-summaries",
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.items.length, 1);
});
