import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import {
  assertNoLiteralSecrets,
  assertTransportShape,
  readServerFields,
  NAME_RE,
} from "../src/lib/validation/team-mcp.js";

// Route-level coverage for the team MCP catalog, plus direct repo coverage for
// the secret-literal gate (which is the security-relevant part and does not
// need a database to exercise).
// Design: docs/architecture/team-mcp-and-env-cloud.md

function fakeRepo(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string, result: unknown = null) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  return {
    calls,
    listTeamMcpServers: record("listTeamMcpServers", []),
    getTeamMcpConfig: record("getTeamMcpConfig", { mcpServers: {} }),
    createTeamMcpServer: record("createTeamMcpServer", { name: "sentry" }),
    updateTeamMcpServer: record("updateTeamMcpServer", { name: "sentry" }),
    deleteTeamMcpServer: record("deleteTeamMcpServer"),
    installTeamMcpServer: record("installTeamMcpServer", { name: "sentry" }),
    uninstallTeamMcpServer: record("uninstallTeamMcpServer"),
    ...overrides,
  };
}

function request(overrides: Record<string, unknown>, repo: unknown) {
  return handleBusinessApiRequest(
    {
      headers: { Authorization: "Bearer caller-token" },
      ...overrides,
    } as never,
    { createRepository: () => repo } as never,
  );
}

test("GET /v1/teams/:id/mcp-servers returns the full catalog", async () => {
  const repo = fakeRepo({
    listTeamMcpServers: async () => [
      { name: "sentry", transport: "local", installed: true },
      { name: "grafana", transport: "remote", installed: false },
    ],
  });
  const res = await request(
    { httpMethod: "GET", path: "/v1/teams/team-1/mcp-servers" },
    repo,
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  // The catalog is everything the team has, not just what the caller runs —
  // `installed` decorates, it does not filter.
  assert.equal(body.items.length, 2);
  assert.equal(body.items[1].installed, false);
});

test("GET mcp-servers forwards actorId so a client can inspect another agent's installs", async () => {
  const repo = fakeRepo();
  await request(
    {
      httpMethod: "GET",
      path: "/v1/teams/team-1/mcp-servers",
      queryStringParameters: { actorId: "agent-actor-1" },
    },
    repo,
  );
  assert.deepEqual(repo.calls[0], {
    method: "listTeamMcpServers",
    args: ["team-1", { actorId: "agent-actor-1" }],
  });
});

test("GET mcp-servers without actorId leaves the subject to the repo (the caller)", async () => {
  const repo = fakeRepo();
  await request({ httpMethod: "GET", path: "/v1/teams/team-1/mcp-servers" }, repo);
  assert.deepEqual(repo.calls[0], {
    method: "listTeamMcpServers",
    args: ["team-1", {}],
  });
});

// Reading someone else's install state is allowed; writing it is not. The two
// are deliberately asymmetric — there is no "install on behalf of".
test("PUT install still rejects actorId", async () => {
  const repo = fakeRepo();
  const res = await request(
    {
      httpMethod: "PUT",
      path: "/v1/teams/team-1/mcp-servers/sentry/install",
      body: JSON.stringify({ actorId: "agent-actor-1" }),
    },
    repo,
  );
  assert.equal(res.statusCode, 400);
});

test("GET mcp-servers/config is routed to the config resolver, not treated as a server name", async () => {
  const seen: unknown[] = [];
  const repo = fakeRepo({
    getTeamMcpConfig: async (...args: unknown[]) => {
      seen.push(args);
      return { mcpServers: { sentry: { command: "npx", args: ["sentry-mcp"] } } };
    },
  });
  const res = await request(
    { httpMethod: "GET", path: "/v1/teams/team-1/mcp-servers/config" },
    repo,
  );
  assert.equal(res.statusCode, 200);
  // "config" must not be swallowed by the /:name route — that would silently
  // 404 the daemon's only read path.
  assert.deepEqual(seen, [["team-1"]]);
  // Shape must stay byte-compatible with the on-disk .mcp/*.json the daemon
  // already knows how to parse.
  assert.deepEqual(JSON.parse(res.body), {
    mcpServers: { sentry: { command: "npx", args: ["sentry-mcp"] } },
  });
});

test("POST /v1/teams/:id/mcp-servers creates and returns 201", async () => {
  const repo = fakeRepo();
  const res = await request(
    {
      httpMethod: "POST",
      path: "/v1/teams/team-1/mcp-servers",
      body: JSON.stringify({ name: "sentry", transport: "local", command: "npx" }),
    },
    repo,
  );
  assert.equal(res.statusCode, 201);
  assert.deepEqual(repo.calls[0], {
    method: "createTeamMcpServer",
    args: ["team-1", { name: "sentry", transport: "local", command: "npx" }],
  });
});

test("PUT install passes no actor — installs are self-only", async () => {
  const repo = fakeRepo();
  const res = await request(
    { httpMethod: "PUT", path: "/v1/teams/team-1/mcp-servers/sentry/install" },
    repo,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0], {
    method: "installTeamMcpServer",
    args: ["team-1", "sentry"],
  });
});

test("PUT install rejects an explicit actorId rather than silently ignoring it", async () => {
  const repo = fakeRepo();
  const res = await request(
    {
      httpMethod: "PUT",
      path: "/v1/teams/team-1/mcp-servers/sentry/install",
      body: JSON.stringify({ actorId: "someone-else" }),
    },
    repo,
  );
  // Silently dropping it would let a caller believe they installed for another
  // member; MCP servers execute locally, so that misunderstanding matters.
  assert.equal(res.statusCode, 400);
  assert.equal(repo.calls.length, 0);
});

test("DELETE install uninstalls for the caller", async () => {
  const repo = fakeRepo();
  const res = await request(
    { httpMethod: "DELETE", path: "/v1/teams/team-1/mcp-servers/sentry/install" },
    repo,
  );
  assert.equal(res.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "uninstallTeamMcpServer",
    args: ["team-1", "sentry"],
  });
});

test("DELETE a catalog entry is routed to the repository", async () => {
  const repo = fakeRepo();
  const res = await request(
    { httpMethod: "DELETE", path: "/v1/teams/team-1/mcp-servers/sentry" },
    repo,
  );
  assert.equal(res.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "deleteTeamMcpServer",
    args: ["team-1", "sentry"],
  });
});

// ---------------------------------------------------------------------------
// Validation rules, tested directly.
//
// The repo authorises (a database round-trip) before it validates, which is the
// right order — an unauthorised caller should not get to probe input handling.
// That makes the validators awkward to reach through the repo without a live
// db, so they are exported and exercised here on their own. The secret gate in
// particular is the security-relevant rule in this module and deserves coverage
// that cannot rot behind a mock.
// ---------------------------------------------------------------------------

function expectApiError(fn: () => unknown, status: number, code?: string) {
  try {
    fn();
  } catch (e: any) {
    assert.equal(e.statusCode ?? e.status, status, `expected ${status}: ${e.message}`);
    if (code) assert.equal(e.code, code);
    return e;
  }
  throw new Error("expected the call to throw");
}

test("literal secrets in env are rejected with 422", () => {
  const err = expectApiError(
    () =>
      readServerFields({
        transport: "local",
        command: "npx",
        env: { SENTRY_AUTH_TOKEN: "sntrys_actual_token_value" },
      }),
    422,
    "literal_secret_rejected",
  );
  // The message has to name the offending field or the author cannot act on it.
  assert.match(err.message, /SENTRY_AUTH_TOKEN/);
});

test("literal secrets in headers are rejected too", () => {
  expectApiError(
    () =>
      readServerFields({
        transport: "remote",
        url: "https://example.invalid/mcp",
        headers: { "X-Api-Key": "abcdef123456" },
      }),
    422,
    "literal_secret_rejected",
  );
});

test("${KEY} and $KEY placeholders are accepted for secret-looking keys", () => {
  for (const value of ["${TEAM_SENTRY_TOKEN}", "$TEAM_SENTRY_TOKEN", "  ${PADDED}  "]) {
    assert.doesNotThrow(
      () => assertNoLiteralSecrets({ SENTRY_AUTH_TOKEN: value }, "env"),
      `expected ${value} to pass the secret gate`,
    );
  }
});

test("non-secret-looking keys may hold literals", () => {
  assert.doesNotThrow(() =>
    assertNoLiteralSecrets({ SENTRY_ORG: "acme", LOG_LEVEL: "debug" }, "env"),
  );
});

test("every secret-ish key name is covered, not just TOKEN", () => {
  for (const key of ["API_KEY", "ACCESS_TOKEN", "CLIENT_SECRET", "DB_PASSWORD", "MY_CREDENTIAL"]) {
    expectApiError(
      () => assertNoLiteralSecrets({ [key]: "literal-value" }, "env"),
      422,
      "literal_secret_rejected",
    );
  }
});

test("transport invariants are 400s, not raw constraint violations", () => {
  // local without a command, and remote carrying one — both are contradictions
  // the DB would reject as a 23514; surfacing them as a readable 400 is the point.
  expectApiError(() => assertTransportShape({ transport: "local" }), 400);
  expectApiError(
    () => assertTransportShape({ transport: "remote", command: "npx", url: "https://x.invalid" }),
    400,
  );
  expectApiError(() => assertTransportShape({ transport: "remote" }), 400);
  expectApiError(
    () => assertTransportShape({ transport: "local", command: "npx", url: "https://x.invalid" }),
    400,
  );
  assert.doesNotThrow(() => assertTransportShape({ transport: "local", command: "npx" }));
  assert.doesNotThrow(() =>
    assertTransportShape({ transport: "remote", url: "https://x.invalid" }),
  );
});

test("server names are constrained to the same shape as the DB check", () => {
  for (const bad of ["../escape", "has space", "-leading-dash", ""]) {
    assert.equal(NAME_RE.test(bad), false, `${bad} should be rejected`);
  }
  for (const good of ["sentry", "team.mcp-1", "A_b.c-9"]) {
    assert.equal(NAME_RE.test(good), true, `${good} should be accepted`);
  }
});

test("args must be an array of strings", () => {
  expectApiError(() => readServerFields({ transport: "local", command: "npx", args: "npx" }), 400);
  expectApiError(() => readServerFields({ transport: "local", command: "npx", args: [1, 2] }), 400);
  assert.doesNotThrow(() =>
    readServerFields({ transport: "local", command: "npx", args: ["a", "b"] }),
  );
});
