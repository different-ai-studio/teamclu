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
