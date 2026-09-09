import { test } from "node:test";
import assert from "node:assert/strict";
import { registerApps, stripUrlCredentials } from "../src/lib/routes/apps.js";

function makeRouter() {
  const routes = [];
  // Mirrors the real adapter's (path, options?, handler) overload: the storage
  // STS route registers with `{ auth: "app-token" }`, and a two-argument fake
  // would silently hand back the options object as the handler.
  const add = (method) => (p, optionsOrHandler, maybeHandler) => {
    const [options, handler] =
      typeof optionsOrHandler === "function"
        ? [{}, optionsOrHandler]
        : [optionsOrHandler, maybeHandler];
    routes.push([method, p, handler, options]);
  };
  const router = {
    get: add("GET"),
    post: add("POST"),
    patch: add("PATCH"),
    put: add("PUT"),
    delete: add("DELETE"),
  };
  return { router, routes };
}

/** base64url, the way the client encodes a file path into one URL segment. */
function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64url");
}

function findRoute(routes, method, path) {
  const hit = routes.find((r) => r[0] === method && r[1] === path);
  assert.ok(hit, `route not registered: ${method} ${path}`);
  return hit;
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

test("a pasted token never reaches the stored repo URL", async () => {
  // `apps.git_remote_url` is handed to every member who can see the app, and
  // nothing redacts it. One paste of the URL GitHub shows you for a private
  // repo would make a personal access token team-readable, permanently.
  const { router, routes } = makeRouter();
  registerApps(router);
  const post = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps")[2];
  let seen: any;
  const repository = { createApp: async (input: any) => { seen = input; return { id: "app-1" }; } };

  await post({
    json: {
      teamId: "t1", name: "X", type: "static_web",
      gitRemoteUrl: "https://someone:ghp_0123456789abcdef@github.com/owner/private.git",
    },
    repository,
  });
  assert.equal(seen.gitRemoteUrl, "https://github.com/owner/private.git");
  assert.ok(!seen.gitRemoteUrl.includes("ghp_"), "no token survives the write");
});

test("stripUrlCredentials keeps the parts of a URL that are the address", () => {
  // http(s): all of the userinfo is a credential.
  assert.equal(
    stripUrlCredentials("https://ghp_secret@github.com/o/r.git"),
    "https://github.com/o/r.git",
  );
  assert.equal(
    stripUrlCredentials("http://u:p@git.internal:3000/o/r?ref=main#frag"),
    "http://git.internal:3000/o/r?ref=main#frag",
  );

  // ssh / git: `git@` IS the address; only a password would be a secret.
  assert.equal(
    stripUrlCredentials("ssh://git@github.com/o/r.git"),
    "ssh://git@github.com/o/r.git",
  );
  assert.equal(
    stripUrlCredentials("ssh://git:hunter2@github.com/o/r.git"),
    "ssh://git@github.com/o/r.git",
  );

  // scp-like has no scheme to reason about, and `git@` is load-bearing there too.
  assert.equal(
    stripUrlCredentials("git@github.com:owner/repo.git"),
    "git@github.com:owner/repo.git",
  );

  // Nothing to strip is left exactly as it was.
  for (const url of [
    "https://github.com/owner/repo.git",
    "git://example.com/repo.git",
  ]) {
    assert.equal(stripUrlCredentials(url), url);
  }
});

test("a password containing an @ does not cut the host off", () => {
  // Such a password should be percent-encoded, and git tolerates it when it is
  // not; splitting on the FIRST `@` would store `p@github.com` as the host.
  assert.equal(
    stripUrlCredentials("https://u:p@ss@github.com/o/r.git"),
    "https://github.com/o/r.git",
  );
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
    () =>
      handler({
        params: { appId: "app-1" },
        query: new URLSearchParams(""),
        repository: { getAppGitHead: async () => null },
      }),
    (e) => (e as { statusCode?: number }).statusCode === 404,
  );
});

test("GET /v1/apps/:id/git-head returns the head, and compares only when asked", async () => {
  // The compare costs a round trip to the forge, and the deploy path hits this
  // endpoint on every deploy while reading only `sha`.
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps/:appId/git-head")[2];
  const seen: unknown[] = [];
  const head = {
    sha: "abc123def456",
    branch: "main",
    deployedSha: "999888777666",
    undeployedCommits: 2,
  };
  const repository = {
    getAppGitHead: async (_id: string, opts: unknown) => {
      seen.push(opts);
      return head;
    },
  };

  const res = await handler({
    params: { appId: "app-1" },
    query: new URLSearchParams("compare=1"),
    repository,
  });
  assert.deepEqual(res.body, head);

  await handler({ params: { appId: "app-1" }, query: new URLSearchParams(""), repository });
  await handler({
    params: { appId: "app-1" },
    query: new URLSearchParams("compare=yes"),
    repository,
  });
  assert.deepEqual(seen, [{ compare: true }, { compare: false }, { compare: false }]);
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

test("PUT /v1/apps/:id/access/:memberId 404s when repo returns null (non-admin)", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "PUT" && r[1] === "/v1/apps/:appId/access/:memberId")[2];
  await assert.rejects(
    () => handler({
      params: { appId: "app-1", memberId: "member-2" },
      json: { permissionLevel: "prompt" },
      repository: { setAppAccess: async () => null },
    }),
    (e) => (e as { statusCode?: number }).statusCode === 404,
  );
});

test("GET /v1/apps/:id/access returns access rows", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps/:appId/access")[2];
  const items = [{
    memberId: "member-2",
    permissionLevel: "prompt",
    grantedByMemberId: "actor-app-1",
    createdAt: "2026-08-27T00:00:00.000Z",
  }];
  const res = await handler({
    params: { appId: "app-1" },
    repository: { listAppAccess: async () => items },
  });
  assert.deepEqual(res.body, { items });
});

test("DELETE /v1/apps/:id/access/:memberId returns ok", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "DELETE" && r[1] === "/v1/apps/:appId/access/:memberId")[2];
  const res = await handler({
    params: { appId: "app-1", memberId: "member-2" },
    repository: { removeAppAccess: async () => true },
  });
  assert.deepEqual(res.body, { ok: true });
});

test("DELETE /v1/apps/:id returns ok when repo deletes", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "DELETE" && r[1] === "/v1/apps/:appId")[2];
  let seenId: string | undefined;
  const res = await handler({
    params: { appId: "app-1" },
    repository: { deleteApp: async (id) => { seenId = id; return true; } },
  });
  assert.deepEqual(res.body, { ok: true });
  assert.equal(seenId, "app-1");
});

test("DELETE /v1/apps/:id 404s when repo returns false", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "DELETE" && r[1] === "/v1/apps/:appId")[2];
  await assert.rejects(
    () => handler({ params: { appId: "missing" }, repository: { deleteApp: async () => false } }),
    (e) => (e as { statusCode?: number }).statusCode === 404,
  );
});

// --- App logs route ---------------------------------------------------------

test("GET /v1/apps/:id/logs forwards the query and 404s on null", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps/:appId/logs")[2];
  let seen: any;
  const res = await handler({
    params: { appId: "app-1" },
    query: new URLSearchParams(
      "sinceMinutes=120&limit=50&kind=all&contains=user_sessions&requestId=req-A",
    ),
    repository: {
      getAppLogs: async (appId: string, query: any) => {
        seen = { appId, query };
        return { items: [], truncated: false };
      },
    },
  });
  assert.deepEqual(res.body, { items: [], truncated: false });
  assert.equal(seen.appId, "app-1");
  assert.deepEqual(seen.query, {
    sinceMinutes: "120",
    limit: "50",
    kind: "all",
    contains: "user_sessions",
    requestId: "req-A",
  });

  // Null is "you cannot see this app", which must be indistinguishable from it
  // not existing — the same contract the data browser routes hold to.
  await assert.rejects(
    () => handler({
      params: { appId: "x" },
      query: new URLSearchParams(""),
      repository: { getAppLogs: async () => null },
    }),
    (e: any) => e?.statusCode === 404,
  );
});

// --- App data browser routes ------------------------------------------------

test("GET /v1/apps/:id/data/tables forwards the app id and 404s on null", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps/:appId/data/tables")[2];
  const res = await handler({
    params: { appId: "app-1" },
    query: new URLSearchParams(""),
    repository: { listAppDataTables: async (id: string) => ({ items: [{ name: `t-${id}` }] }) },
  });
  assert.deepEqual(res.body, { items: [{ name: "t-app-1" }] });

  await assert.rejects(
    () => handler({
      params: { appId: "x" },
      query: new URLSearchParams(""),
      repository: { listAppDataTables: async () => null },
    }),
    (e: any) => e?.statusCode === 404,
  );
});

test("GET .../rows forwards paging and filter params", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps/:appId/data/tables/:table/rows")[2];
  let seen: any;
  await handler({
    params: { appId: "app-1", table: "items" },
    query: new URLSearchParams(
      "after=CURSOR&direction=desc&limit=25&filterColumn=note&filterOp=eq&filterValue=keep",
    ),
    repository: {
      readAppDataRows: async (appId: string, table: string, query: any) => {
        seen = { appId, table, query };
        return { rows: [] };
      },
    },
  });
  assert.equal(seen.appId, "app-1");
  assert.equal(seen.table, "items");
  assert.deepEqual(seen.query, {
    after: "CURSOR",
    direction: "desc",
    limit: "25",
    filterColumn: "note",
    filterOp: "eq",
    filterValue: "keep",
  });
});

test("GET .../rows decodes a table name that needed escaping", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps/:appId/data/tables/:table/rows")[2];
  let seenTable = "";
  await handler({
    params: { appId: "app-1", table: "my%20table" },
    query: new URLSearchParams(""),
    repository: { readAppDataRows: async (_a: string, table: string) => { seenTable = table; return { rows: [] }; } },
  });
  assert.equal(seenTable, "my table");
});

test("PATCH .../rows/:rowKey forwards the opaque key and body", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find(
    (r) => r[0] === "PATCH" && r[1] === "/v1/apps/:appId/data/tables/:table/rows/:rowKey",
  )[2];
  let seen: any;
  const res = await handler({
    params: { appId: "app-1", table: "items", rowKey: "WzJd" },
    json: { patch: { title: "x" } },
    repository: {
      updateAppDataRow: async (appId: string, table: string, rowKey: string, body: any) => {
        seen = { appId, table, rowKey, body };
        return { row: { id: 2 } };
      },
    },
  });
  assert.deepEqual(seen, {
    appId: "app-1", table: "items", rowKey: "WzJd", body: { patch: { title: "x" } },
  });
  assert.deepEqual(res.body, { row: { id: 2 } });
});

test("DELETE .../rows/:rowKey 404s when the repo says the app is invisible", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find(
    (r) => r[0] === "DELETE" && r[1] === "/v1/apps/:appId/data/tables/:table/rows/:rowKey",
  )[2];
  const ok = await handler({
    params: { appId: "app-1", table: "items", rowKey: "WzJd" },
    repository: { deleteAppDataRow: async () => ({ ok: true }) },
  });
  assert.deepEqual(ok.body, { ok: true });

  await assert.rejects(
    () => handler({
      params: { appId: "app-1", table: "items", rowKey: "WzJd" },
      repository: { deleteAppDataRow: async () => null },
    }),
    (e: any) => e?.statusCode === 404,
  );
});

// --- File storage routes (design 2026-09-09-app-storage-design) ---

test("storage routes answer 404 when the repository declines", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const repository = {
    listAppFiles: async () => null,
    getAppStorageUsage: async () => null,
    purgeAppFiles: async () => null,
  };
  for (const [method, path] of [
    ["GET", "/v1/apps/:appId/storage/objects"],
    ["GET", "/v1/apps/:appId/storage/usage"],
    ["POST", "/v1/apps/:appId/storage/purge"],
  ]) {
    const handler = findRoute(routes, method, path)[2];
    await assert.rejects(
      handler({ params: { appId: "a1" }, query: new URLSearchParams(), json: {}, repository }),
      /not found/,
      `${method} ${path} must 404, not leak a tier`,
    );
  }
});

test("a file path is decoded from base64url before it reaches the repository", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  let seen;
  const repository = {
    deleteAppFile: async (_appId, path) => {
      seen = path;
      return { ok: true };
    },
  };
  const del = findRoute(routes, "DELETE", "/v1/apps/:appId/storage/objects/:key")[2];
  // A path with a slash and a non-ASCII name: the two things a raw segment
  // cannot carry.
  const path = "reports/2026/季度.csv";
  await del({ params: { appId: "a1", key: b64url(path) }, repository });
  assert.equal(seen, path);
});

test("sign-upload requires a path", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const post = findRoute(routes, "POST", "/v1/apps/:appId/storage/sign-upload")[2];
  await assert.rejects(
    post({ params: { appId: "a1" }, json: {}, repository: {} }),
    /path/,
  );
});

test("quota accepts a number or null, and nothing else", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const put = findRoute(routes, "PUT", "/v1/apps/:appId/storage/quota")[2];
  const seen = [];
  const repository = {
    setAppStorageQuota: async (_id, q) => {
      seen.push(q);
      return { quotaBytes: q };
    },
  };
  await put({ params: { appId: "a1" }, json: { quotaBytes: 1024 }, repository });
  await put({ params: { appId: "a1" }, json: { quotaBytes: null }, repository });
  assert.deepEqual(seen, [1024, null]);
  await assert.rejects(
    put({ params: { appId: "a1" }, json: { quotaBytes: "1024" }, repository }),
    /quotaBytes/,
    "a string would silently become NaN downstream",
  );
});

test("only the two machine routes are registered outside the user JWT", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const nonBearer = routes
    .filter((r) => r[3] && r[3].auth && r[3].auth !== "bearer")
    .map((r) => [r[1], r[3].auth])
    .sort();
  // An exhaustive list, not a count: every entry here is a route a person's
  // token does not guard, so adding one has to be a deliberate edit of this
  // test rather than a number quietly going up.
  assert.deepEqual(nonBearer, [
    // The heartbeat that fires scheduled tasks. Shared secret, no user.
    ["/v1/internal/app-cron/tick", "cron-tick"],
    // The deployed app fetching its own storage credentials.
    ["/v1/apps/:appId/storage/sts", "app-token"],
  ].sort());
});

test("STS refuses a request with no bearer, and cannot tell a bad token from an unknown app", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const sts = findRoute(routes, "POST", "/v1/apps/:appId/storage/sts")[2];
  const repository = { mintAppStorageCredentials: async () => null };

  await assert.rejects(
    sts({ params: { appId: "a1" }, getHeader: () => undefined, repository }),
    /token required/,
  );
  await assert.rejects(
    sts({ params: { appId: "a1" }, getHeader: () => "Bearer wrong", repository }),
    /not valid/,
    "a wrong token and an unknown app must produce the same answer",
  );
});

test("STS returns the credentials and nothing about the token", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const sts = findRoute(routes, "POST", "/v1/apps/:appId/storage/sts")[2];
  let seenToken;
  const credentials = {
    accessKeyId: "STS.ak",
    accessKeySecret: "STS.sk",
    securityToken: "tok",
    expiration: "2026-09-09T01:00:00Z",
    bucket: "teamclu-app",
    prefix: "app-files/a1/",
    region: "cn-shenzhen",
    endpoint: "https://oss-cn-shenzhen.aliyuncs.com",
  };
  const repository = {
    mintAppStorageCredentials: async (_id, token) => {
      seenToken = token;
      return { credentials };
    },
  };
  const res = await sts({
    params: { appId: "a1" },
    getHeader: (h) => (h === "authorization" ? "Bearer  s3cret " : undefined),
    repository,
  });
  assert.equal(seenToken, "s3cret", "the bearer is trimmed before comparison");
  assert.deepEqual(res.body, credentials);
});

// --- scheduled tasks --------------------------------------------------------

test("cron routes 404 when the repository declines", async () => {
  // Null from the repo means "not visible, or not yours" and must be
  // indistinguishable from "no such app", like every other app route.
  const { router, routes } = makeRouter();
  registerApps(router);
  const repository = {
    listAppCronJobs: async () => null,
    createAppCronJob: async () => null,
    updateAppCronJob: async () => null,
    deleteAppCronJob: async () => false,
    runAppCronJobNow: async () => null,
    listAppCronRuns: async () => null,
  };
  const params = { appId: "a1", jobId: "j1" };
  const calls: Array<Promise<unknown>> = [
    findRoute(routes, "GET", "/v1/apps/:appId/cron-jobs")[2]({ params, repository }),
    findRoute(routes, "POST", "/v1/apps/:appId/cron-jobs")[2]({
      params, json: { name: "n", schedule: "0 9 * * *" }, repository,
    }),
    findRoute(routes, "PATCH", "/v1/apps/:appId/cron-jobs/:jobId")[2]({ params, json: {}, repository }),
    findRoute(routes, "DELETE", "/v1/apps/:appId/cron-jobs/:jobId")[2]({ params, repository }),
    findRoute(routes, "POST", "/v1/apps/:appId/cron-jobs/:jobId/run")[2]({ params, repository }),
    findRoute(routes, "GET", "/v1/apps/:appId/cron-jobs/:jobId/runs")[2]({
      params, query: new URLSearchParams(""), repository,
    }),
  ];
  for (const call of calls) {
    await assert.rejects(call, (e: any) => e.statusCode === 404);
  }
});

test("an empty task list is a 200, not a 404", async () => {
  // `[]` and `null` mean different things here — no tasks vs. no access — and
  // collapsing them would make an app with nothing scheduled look missing.
  const { router, routes } = makeRouter();
  registerApps(router);
  const get = findRoute(routes, "GET", "/v1/apps/:appId/cron-jobs")[2];
  const res = await get({ params: { appId: "a1" }, repository: { listAppCronJobs: async () => [] } });
  assert.deepEqual(res.body, { items: [] });
});

test("creating a task needs a name and a schedule, and answers 201", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const post = findRoute(routes, "POST", "/v1/apps/:appId/cron-jobs")[2];
  const repository = { createAppCronJob: async (_id: string, body: any) => ({ id: "j1", ...body }) };

  const res = await post({
    params: { appId: "a1" },
    json: { name: "daily", schedule: "0 9 * * *" },
    repository,
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.id, "j1");

  for (const json of [{ schedule: "0 9 * * *" }, { name: "daily" }, {}]) {
    await assert.rejects(
      post({ params: { appId: "a1" }, json, repository }),
      (e: any) => e.statusCode === 400,
    );
  }
});

test("the run-history limit is passed through, and defaults without one", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const get = findRoute(routes, "GET", "/v1/apps/:appId/cron-jobs/:jobId/runs")[2];
  const seen: unknown[] = [];
  const repository = {
    listAppCronRuns: async (_a: string, _j: string, limit: number) => {
      seen.push(limit);
      return [];
    },
  };
  await get({ params: { appId: "a1", jobId: "j1" }, query: new URLSearchParams("limit=5"), repository });
  await get({ params: { appId: "a1", jobId: "j1" }, query: new URLSearchParams(""), repository });
  assert.deepEqual(seen, [5, 20]);
});

// --- environment ------------------------------------------------------------

test("env routes 404 when the repository declines", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const repository = {
    listAppEnv: async () => null,
    putAppEnv: async () => null,
    deleteAppEnv: async () => false,
  };
  const params = { appId: "a1", key: "STRIPE_KEY" };
  await assert.rejects(
    findRoute(routes, "GET", "/v1/apps/:appId/env")[2]({ params, repository }),
    (e: any) => e.statusCode === 404,
  );
  await assert.rejects(
    findRoute(routes, "PUT", "/v1/apps/:appId/env/:key")[2]({ params, json: { value: "x" }, repository }),
    (e: any) => e.statusCode === 404,
  );
  await assert.rejects(
    findRoute(routes, "DELETE", "/v1/apps/:appId/env/:key")[2]({ params, repository }),
    (e: any) => e.statusCode === 404,
  );
});

test("an env value may be empty, but not missing", async () => {
  // "" is a variable someone deliberately set to nothing; undefined is a
  // malformed request. A truthiness check would conflate them and reject the
  // first, which is a legitimate thing to want.
  const { router, routes } = makeRouter();
  registerApps(router);
  const seen: unknown[] = [];
  const repository = {
    putAppEnv: async (_a: string, _k: string, body: any) => {
      seen.push(body.value);
      return { key: "K", isSecret: false, value: body.value, updatedAt: "x" };
    },
  };
  const params = { appId: "a1", key: "K" };

  await findRoute(routes, "PUT", "/v1/apps/:appId/env/:key")[2]({ params, json: { value: "" }, repository });
  assert.deepEqual(seen, [""]);

  for (const json of [{}, { value: null }, { value: 1 }, { isSecret: true }]) {
    await assert.rejects(
      findRoute(routes, "PUT", "/v1/apps/:appId/env/:key")[2]({ params, json, repository }),
      (e: any) => e.statusCode === 400,
      `accepted ${JSON.stringify(json)}`,
    );
  }
});

test("the env list is passed through with its canWrite flag", async () => {
  // The client learns what it may do from the same response that tells it what
  // exists — no second request, and no way for the two to disagree.
  const { router, routes } = makeRouter();
  registerApps(router);
  const out = { items: [{ key: "K", isSecret: true, value: null, updatedAt: "x" }], canWrite: false };
  const res = await findRoute(routes, "GET", "/v1/apps/:appId/env")[2]({
    params: { appId: "a1" },
    repository: { listAppEnv: async () => out },
  });
  assert.deepEqual(res.body, out);
});

test("an empty env is a 200, not a 404", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const res = await findRoute(routes, "GET", "/v1/apps/:appId/env")[2]({
    params: { appId: "a1" },
    repository: { listAppEnv: async () => ({ items: [], canWrite: true }) },
  });
  assert.deepEqual(res.body, { items: [], canWrite: true });
});

