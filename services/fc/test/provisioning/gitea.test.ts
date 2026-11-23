import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGiteaClient, readGiteaConfig, giteaUnavailable } from "../../src/lib/provisioning/gitea.js";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("createAppRepo posts private repo named tc-app-{appId}", async () => {
  const calls: { input: unknown; init?: RequestInit }[] = [];
  const client = makeGiteaClient({
    url: "https://gitea.example",
    token: "tok",
    owner: "teamclaw-apps",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json(201, {
        clone_url: "https://gitea.example/teamclaw-apps/tc-app-uuid.git",
        ssh_url: "git@gitea.example:teamclaw-apps/tc-app-uuid.git",
      });
    },
  });
  const r = await client.createAppRepo("uuid");
  assert.equal(r.cloneUrl, "https://gitea.example/teamclaw-apps/tc-app-uuid.git");
  // The SSH URL is what gets persisted as the app remote — the deploy key we
  // issue is an SSH key and authenticates nothing over HTTPS.
  assert.equal(r.sshUrl, "git@gitea.example:teamclaw-apps/tc-app-uuid.git");
  assert.match(String(calls[0].input), /\/api\/v1\/orgs\/teamclaw-apps\/repos$/);
  assert.equal(JSON.parse(String(calls[0].init?.body)).private, true);
  assert.equal(JSON.parse(String(calls[0].init?.body)).name, "tc-app-uuid");
});

test("createDeployKey posts a write deploy key on the app repo", async () => {
  const calls: { input: unknown; init?: RequestInit }[] = [];
  const client = makeGiteaClient({
    url: "https://gitea.example",
    token: "tok",
    owner: "teamclaw-apps",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json(201, { id: 7 });
    },
  });
  const r = await client.createDeployKey("uuid", "seed-key", "ssh-rsa AAAA");
  assert.equal(r.id, 7);
  assert.match(String(calls[0].input), /\/api\/v1\/repos\/teamclaw-apps\/tc-app-uuid\/keys$/);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.title, "seed-key");
  assert.equal(body.key, "ssh-rsa AAAA");
  assert.equal(body.read_only, false);
});

test("createDeployKey can register a key that cannot push", async () => {
  const calls: { input: unknown; init?: RequestInit }[] = [];
  const client = makeGiteaClient({
    url: "https://gitea.example",
    token: "tok",
    owner: "teamclaw-apps",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json(201, { id: 8 });
    },
  });
  await client.createDeployKey("uuid", "download-key", "ssh-ed25519 AAAA", { readOnly: true });
  assert.equal(JSON.parse(String(calls[0].init?.body)).read_only, true);
});

test("deleteDeployKey deletes by id", async () => {
  const calls: { input: unknown; init?: RequestInit }[] = [];
  const client = makeGiteaClient({
    url: "https://gitea.example",
    token: "tok",
    owner: "teamclaw-apps",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return new Response(null, { status: 204 });
    },
  });
  await client.deleteDeployKey("uuid", 42);
  assert.match(String(calls[0].input), /\/api\/v1\/repos\/teamclaw-apps\/tc-app-uuid\/keys\/42$/);
  assert.equal(calls[0].init?.method, "DELETE");
});

test("readGiteaConfig names the first empty variable", () => {
  assert.deepEqual(readGiteaConfig({ GITEA_URL: "", GITEA_TOKEN: "t", GITEA_OWNER: "o" }), { error: "GITEA_URL is empty" });
  assert.deepEqual(readGiteaConfig({ GITEA_URL: "https://g", GITEA_TOKEN: "", GITEA_OWNER: "o" }), { error: "GITEA_TOKEN is empty" });
  assert.deepEqual(readGiteaConfig({ GITEA_URL: "https://g/", GITEA_TOKEN: "t", GITEA_OWNER: "team" }), {
    config: { url: "https://g", token: "t", owner: "team" },
  });
});

test("giteaUnavailable surfaces the missing variable", () => {
  const err = giteaUnavailable("GITEA_TOKEN is empty");
  assert.equal(err.statusCode, 503);
  assert.equal(err.code, "gitea_unavailable");
  assert.match(err.message, /GITEA_TOKEN/);
});

test("getRepoHead reads default branch commit sha", async () => {
  const calls: string[] = [];
  const client = makeGiteaClient({
    url: "https://gitea.example",
    token: "tok",
    owner: "teamclaw-apps",
    fetch: async (input) => {
      calls.push(String(input));
      if (String(input).endsWith("/repos/teamclaw-apps/tc-app-uuid")) {
        return json(200, { default_branch: "main" });
      }
      if (String(input).endsWith("/repos/teamclaw-apps/tc-app-uuid/branches/main")) {
        return json(200, { commit: { id: "deadbeef" } });
      }
      return json(404, {});
    },
  });
  const r = await client.getRepoHead("uuid");
  assert.equal(r.sha, "deadbeef");
  assert.equal(calls.length, 2);
});

test("createAppRepo refuses a repo Gitea reported without an ssh_url", async () => {
  const client = makeGiteaClient({
    url: "https://gitea.example",
    token: "tok",
    owner: "teamclaw-apps",
    fetch: async () =>
      json(201, { clone_url: "https://gitea.example/teamclaw-apps/tc-app-uuid.git" }),
  });
  await assert.rejects(
    () => client.createAppRepo("uuid"),
    (e: any) => e.statusCode === 502 && /ssh_url/.test(e.message),
  );
});

test("listDeployKeys reports id + title for the sweep", async () => {
  const calls: string[] = [];
  const client = makeGiteaClient({
    url: "https://gitea.example",
    token: "tok",
    owner: "teamclaw-apps",
    fetch: async (input) => {
      calls.push(String(input));
      return json(200, [
        { id: 1, title: "jit-1700000000000-aaaa" },
        { id: 2 },
        { title: "no id" },
      ]);
    },
  });
  const keys = await client.listDeployKeys("uuid");
  assert.match(calls[0], /\/api\/v1\/repos\/teamclaw-apps\/tc-app-uuid\/keys$/);
  assert.deepEqual(keys, [
    { id: 1, title: "jit-1700000000000-aaaa" },
    { id: 2, title: "" },
  ]);
});

test("users FC creates get a noreply address under the public git host, not FC's internal route", async () => {
  const { giteaNoreplyHost, makeGiteaClient } = await import("../../src/lib/provisioning/gitea.js");
  assert.equal(giteaNoreplyHost("http://caddy:8081", { GITEA_PUBLIC_URL: "https://git.example.com" }), "git.example.com");
  assert.equal(giteaNoreplyHost("http://caddy:8081", {}), "caddy");
  assert.equal(giteaNoreplyHost("not a url", { GITEA_PUBLIC_URL: "" }), "gitea.local");

  const bodies: any[] = [];
  const client = makeGiteaClient({
    url: "http://caddy:8081",
    token: "t",
    owner: "o",
    noreplyHost: "git.example.com",
    fetch: (async (url: string, init?: any) => {
      if (init?.method === "POST") bodies.push(JSON.parse(init.body));
      return new Response(init?.method === "POST" ? "{}" : "", { status: init?.method === "POST" ? 201 : 404 });
    }) as any,
  } as any);
  await client.ensureUser("uabc", "Alice");
  assert.equal(bodies[0].email, "uabc@users.noreply.git.example.com");
});

/** A Gitea that pages: `limit` is clamped to 50, as the real one does. */
function pagedGitea(lists: Record<string, unknown[]>, calls: string[] = []) {
  return makeGiteaClient({
    url: "https://gitea.example",
    token: "tok",
    owner: "o1",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}${url.search}`);
      if (method !== "GET") return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/permission")) return json(200, { permission: "write" });
      const list = lists[url.pathname];
      if (!list) return json(404, { message: "not found" });
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 30), 50);
      const page = Number(url.searchParams.get("page") ?? 1);
      return json(200, list.slice((page - 1) * limit, page * limit));
    },
  });
}

test("lists the sync treats as complete are read past Gitea's 50-item page", async () => {
  const members = Array.from({ length: 120 }, (_, i) => ({ login: `u${i}` }));
  const teams = Array.from({ length: 51 }, (_, i) => ({ id: i + 1, name: `t${i}` }));
  const collaborators = Array.from({ length: 53 }, (_, i) => ({ login: `c${i}` }));
  const client = pagedGitea({
    "/api/v1/teams/7/members": members,
    "/api/v1/orgs/o1/teams": teams,
    "/api/v1/repos/o1/tc-app-a1/collaborators": collaborators,
  });
  // The 51st member is exactly who a one-page read would never remove again.
  assert.equal((await client.listTeamMembers(7)).length, 120);
  assert.equal(await client.findTeamId("o1", "t50"), 51);
  assert.equal(await client.findTeamId("o1", "nope"), null);
  assert.equal(await client.findTeamId("missing-org", "t1"), null);
  assert.equal((await client.listCollaborators("a1")).length, 53);
});

test("removeAllAppAccess takes every collaborator and team off the repo, but not Owners", async () => {
  const calls: string[] = [];
  const client = pagedGitea(
    {
      "/api/v1/repos/o1/tc-app-a1/collaborators": Array.from({ length: 51 }, (_, i) => ({ login: `c${i}` })),
      "/api/v1/repos/o1/tc-app-a1/teams": [{ name: "Owners" }, { name: "t1" }],
    },
    calls,
  );
  assert.deepEqual(await client.removeAllAppAccess("a1"), { collaborators: 51, teams: 1 });
  const deletes = calls.filter((c) => c.startsWith("DELETE "));
  assert.equal(deletes.length, 52);
  assert.ok(deletes.includes("DELETE /api/v1/repos/o1/tc-app-a1/collaborators/c50"));
  assert.ok(deletes.includes("DELETE /api/v1/repos/o1/tc-app-a1/teams/t1"));
  assert.ok(!deletes.some((c) => c.endsWith("/teams/Owners")));
});

test("background expiration inventories deploy keys after the first Gitea page", async () => {
  const seen: number[] = [];
  const signal = AbortSignal.timeout(5000);
  const client = makeGiteaClient({
    url: "https://gitea.example",
    token: "test-token",
    owner: "teamclaw-apps",
    fetch: async (input, init) => {
      assert.equal(init?.signal, signal);
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/v1/repos/teamclaw-apps/tc-app-uuid/keys");
      const page = Number(url.searchParams.get("page"));
      seen.push(page);
      const count = page === 1 ? 50 : 1;
      return json(200, Array.from({ length: count }, (_, index) => ({
        id: (page - 1) * 50 + index + 1,
        title: "key",
      })));
    },
  });
  const keys = await client.listAllDeployKeys("uuid", signal);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(keys.at(-1)?.id, 51);
});
