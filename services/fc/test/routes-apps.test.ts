import { test } from "node:test";
import assert from "node:assert/strict";
import { registerApps } from "../src/lib/routes/apps.js";

function makeRouter() {
  const routes = [];
  const router = {
    get: (p, h) => routes.push(["GET", p, h]),
    post: (p, h) => routes.push(["POST", p, h]),
    patch: (p, h) => routes.push(["PATCH", p, h]),
  };
  return { router, routes };
}

test("POST /v1/apps creates and returns 201", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const post = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps")[2];
  const created = { id: "app-1", name: "X" };
  const res = await post({ json: { teamId: "t1", name: "X", type: "fullstack_tanstack_postgres" }, repository: { createApp: async () => created } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, created);
});

test("POST /v1/apps passes an optional gitRemoteUrl through", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const post = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps")[2];
  let seen;
  const repository = { createApp: async (input) => { seen = input; return { id: "app-1" }; } };

  await post({ json: { teamId: "t1", name: "X", type: "static_web", gitRemoteUrl: "  git@github.com:owner/repo.git " }, repository });
  assert.equal(seen.gitRemoteUrl, "git@github.com:owner/repo.git", "trimmed and forwarded");

  await post({ json: { teamId: "t1", name: "X", type: "static_web" }, repository });
  assert.equal(seen.gitRemoteUrl, null, "absent means no import, not undefined");

  await post({ json: { teamId: "t1", name: "X", type: "static_web", gitRemoteUrl: "   " }, repository });
  assert.equal(seen.gitRemoteUrl, null, "an empty field is the same as none");
});

test("POST /v1/apps rejects a gitRemoteUrl git would not treat as an address", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const post = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps")[2];
  const repository = { createApp: async () => ({ id: "app-1" }) };
  // `ext::` is a git transport helper that runs a command; a leading dash is
  // read by git as an option. Neither may reach the daemon's clone.
  for (const gitRemoteUrl of ["ext::sh -c whoami", "--upload-pack=x", "/etc/passwd", "file:///etc/passwd", 42]) {
    await assert.rejects(
      () => post({ json: { teamId: "t1", name: "X", type: "static_web", gitRemoteUrl }, repository }),
      (e) => (e as { statusCode?: number }).statusCode === 400,
      `accepted ${String(gitRemoteUrl)}`,
    );
  }
});

test("GET /v1/apps requires teamId", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const get = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps")[2];
  await assert.rejects(() => get({ query: new URLSearchParams(""), repository: {} }));
});

test("POST /v1/apps/:id/deploy returns 202 with deploy result", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps/:appId/deploy")[2];
  const result = { id: "app-1", fcStatus: "awaiting_build", ossObjectName: "apps/app-1/code.zip", deployToken: "tok", gitCommitSha: "abc1234" };
  let seenBody: unknown;
  const res = await handler({
    params: { appId: "app-1" },
    json: { gitCommitSha: "abc1234" },
    repository: { deployApp: async (_id, body) => { seenBody = body; return result; } },
  });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, result);
  assert.deepEqual(seenBody, { gitCommitSha: "abc1234" });
});

test("POST /v1/apps/:id/deploy 404s when repo returns null", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps/:appId/deploy")[2];
  await assert.rejects(() => handler({
    params: { appId: "x" },
    json: { gitCommitSha: "abc1234" },
    repository: { deployApp: async () => null },
  }));
});

test("POST /v1/apps/:id/deploy/finalize returns 200 with the app", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps/:appId/deploy/finalize")[2];
  const result = { id: "app-1", fcStatus: "live", fcEndpoint: "https://x.fcapp.run", gitCommitSha: "deadbeef" };
  let seenBody: unknown;
  const res = await handler({
    params: { appId: "app-1" },
    json: { gitCommitSha: "deadbeef", deployToken: "tok" },
    repository: { finalizeDeploy: async (_id, body) => { seenBody = body; return result; } },
  });
  assert.deepEqual(res.body, result);
  assert.deepEqual(seenBody, { gitCommitSha: "deadbeef", deployToken: "tok" });
});

test("POST /v1/apps/:id/deploy/finalize 404s when repo returns null", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps/:appId/deploy/finalize")[2];
  await assert.rejects(() => handler({
    params: { appId: "x" },
    json: { gitCommitSha: "abc1234", deployToken: "tok" },
    repository: { finalizeDeploy: async () => null },
  }));
});

test("GET /v1/apps/:id/git-credential 404s when repo returns null (non-creator)", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps/:appId/git-credential")[2];
  await assert.rejects(
    () => handler({ params: { appId: "app-1" }, repository: { getAppGitCredential: async () => null } }),
    (e) => (e as { statusCode?: number }).statusCode === 404,
  );
});

test("GET /v1/apps/:id/git-credential returns deploy key for creator", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps/:appId/git-credential")[2];
  const cred = {
    remoteUrl: "https://gitea.example/tc-app-1.git",
    authKind: "deploy_key",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    deployKeyId: 9,
    expiresAt: "2026-08-27T02:30:00.000Z",
  };
  const res = await handler({
    params: { appId: "app-1" },
    repository: { getAppGitCredential: async () => cred },
  });
  assert.deepEqual(res.body, cred);
});

test("GET /v1/apps/:id/git-head 404s when repo returns null", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps/:appId/git-head")[2];
  await assert.rejects(
    () => handler({ params: { appId: "app-1" }, repository: { getAppGitHead: async () => null } }),
    (e) => (e as { statusCode?: number }).statusCode === 404,
  );
});

test("GET /v1/apps/:id/git-head returns default branch sha", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps/:appId/git-head")[2];
  const res = await handler({
    params: { appId: "app-1" },
    repository: { getAppGitHead: async () => ({ sha: "abc123def456" }) },
  });
  assert.deepEqual(res.body, { sha: "abc123def456" });
});

test("GET /v1/apps/:id/membership returns member verdict", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps/:appId/membership")[2];
  const res = await handler({
    params: { appId: "app-1" },
    repository: { getAppMembership: async () => ({ member: true }) },
  });
  assert.deepEqual(res.body, { member: true });
});

test("GET /v1/apps/:id/membership 404s when repo returns null", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps/:appId/membership")[2];
  await assert.rejects(
    () => handler({ params: { appId: "missing" }, repository: { getAppMembership: async () => null } }),
    (e) => (e as { statusCode?: number }).statusCode === 404,
  );
});
