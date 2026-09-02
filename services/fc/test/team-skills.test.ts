import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { skillPackageBytesMatch, SKILL_PACKAGE_HASH_CAP_BYTES } from "../src/lib/skills-storage.js";

// Route-level coverage for the team skills registry.
// Design: docs/architecture/team-skills-registry.md

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
    listTeamSkills: record("listTeamSkills", []),
    listTeamSkillInstalls: record("listTeamSkillInstalls", []),
    getTeamSkill: record("getTeamSkill", { slug: "deploy-check", versions: [] }),
    createTeamSkill: record("createTeamSkill", { slug: "deploy-check" }),
    createTeamSkillVersion: record("createTeamSkillVersion", { version: 2 }),
    getTeamSkillVersion: record("getTeamSkillVersion", { version: 1, contentHash: "abc" }),
    getTeamSkillDownload: record("getTeamSkillDownload", { ossKey: "teams/t/blobs/x", contentHash: "abc", size: 12 }),
    updateTeamSkill: record("updateTeamSkill", { slug: "deploy-check", status: "deprecated" }),
    deleteTeamSkill: record("deleteTeamSkill"),
    prepareTeamSkillBlob: record("prepareTeamSkillBlob", {
      contentHash: "a".repeat(64),
      size: 12,
      ossKey: "teams/team-1/blobs/sha256/aa/aa/" + "a".repeat(64),
    }),
    completeTeamSkillBlob: record("completeTeamSkillBlob", {
      contentHash: "a".repeat(64),
      size: 12,
      ossKey: "teams/team-1/blobs/sha256/aa/aa/" + "a".repeat(64),
    }),
    revertTeamSkillVersion: record("revertTeamSkillVersion", { version: 4 }),
    installTeamSkill: record("installTeamSkill", { installedVersion: 3 }),
    uninstallTeamSkill: record("uninstallTeamSkill"),
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

test("GET /v1/teams/:id/skills returns the full registry", async () => {
  const repo = fakeRepo({
    listTeamSkills: async () => [
      { slug: "deploy-check", installed: true, hasUpdate: true, latestVersion: 3 },
      { slug: "triage", installed: false, hasUpdate: false, latestVersion: 1 },
    ],
  });
  const res = await request(
    { httpMethod: "GET", path: "/v1/teams/team-1/skills" },
    repo,
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  // The list is the whole registry, not just what the caller installed —
  // "installed" is a decoration, not a filter.
  assert.equal(body.items.length, 2);
  assert.equal(body.items[1].installed, false);
});

test("GET skills forwards actorId so an admin can inspect a team agent", async () => {
  const repo = fakeRepo();
  await request(
    {
      httpMethod: "GET",
      path: "/v1/teams/team-1/skills",
      queryStringParameters: { actorId: "agent-actor-1", status: "published" },
    },
    repo,
  );
  assert.deepEqual(repo.calls[0], {
    method: "listTeamSkills",
    args: ["team-1", { actorId: "agent-actor-1", status: "published" }],
  });
});

test("POST /v1/teams/:id/skills publishes and returns 201", async () => {
  const repo = fakeRepo();
  const res = await request(
    {
      httpMethod: "POST",
      path: "/v1/teams/team-1/skills",
      body: JSON.stringify({
        slug: "deploy-check",
        summary: "发布前检查清单",
        category: "devops",
        whenToUse: "发布前",
        whenNotToUse: "本地开发不要用",
        changelog: "first",
        contentHash: "sha256:abc",
      }),
    },
    repo,
  );
  assert.equal(res.statusCode, 201);
  assert.equal(repo.calls[0].method, "createTeamSkill");
});

test("POST versions publishes a new version", async () => {
  const repo = fakeRepo();
  const res = await request(
    {
      httpMethod: "POST",
      path: "/v1/teams/team-1/skills/deploy-check/versions",
      body: JSON.stringify({
        contentHash: "sha256:def",
        changelog: "fix typo",
        expectedLatestVersion: 1,
      }),
    },
    repo,
  );
  assert.equal(res.statusCode, 201);
  assert.deepEqual(repo.calls[0].args, [
    "team-1",
    "deploy-check",
    { contentHash: "sha256:def", changelog: "fix typo", expectedLatestVersion: 1 },
  ]);
});

test("POST versions/:v/revert rolls forward with the old content", async () => {
  const repo = fakeRepo();
  const res = await request(
    {
      httpMethod: "POST",
      path: "/v1/teams/team-1/skills/deploy-check/versions/3/revert",
      body: JSON.stringify({
        changelog: "v5 broke the migration check",
        expectedLatestVersion: 4,
      }),
    },
    repo,
  );
  assert.equal(res.statusCode, 201);
  assert.equal(repo.calls[0].method, "revertTeamSkillVersion");
  assert.deepEqual(repo.calls[0].args, [
    "team-1",
    "deploy-check",
    3,
    { changelog: "v5 broke the migration check", expectedLatestVersion: 4 },
  ]);
  // The result is a *new* version, not the old number coming back: installs
  // auto-follow latestVersion, and that only ever moves forward.
  assert.equal(JSON.parse(res.body).version, 4);
});

test("revert rejects a non-numeric version rather than passing it down", async () => {
  const repo = fakeRepo();
  const res = await request(
    { httpMethod: "POST", path: "/v1/teams/team-1/skills/deploy-check/versions/latest/revert" },
    repo,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(repo.calls.length, 0);
});

test("GET a version rejects a non-numeric version rather than passing it down", async () => {
  const repo = fakeRepo();
  const res = await request(
    { httpMethod: "GET", path: "/v1/teams/team-1/skills/deploy-check/versions/latest" },
    repo,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(repo.calls.length, 0);
});

test("PATCH deprecates with a replacement pointer", async () => {
  const repo = fakeRepo();
  const res = await request(
    {
      httpMethod: "PATCH",
      path: "/v1/teams/team-1/skills/deploy-check",
      body: JSON.stringify({ status: "deprecated", supersededBy: "hotfix-deploy" }),
    },
    repo,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0].args[2], {
    status: "deprecated",
    supersededBy: "hotfix-deploy",
  });
});

test("PUT install passes the target actor through", async () => {
  const repo = fakeRepo();
  const res = await request(
    {
      httpMethod: "PUT",
      path: "/v1/teams/team-1/skills/deploy-check/install",
      body: JSON.stringify({ actorId: "agent-actor-1", version: 3, scope: "global" }),
    },
    repo,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0].args[2], {
    actorId: "agent-actor-1",
    version: 3,
    scope: "global",
  });
});

test("DELETE install accepts actorId as a query param", async () => {
  // DELETE bodies are legal but awkward for some HTTP clients, so the route
  // folds ?actorId= into the body shape the repository expects.
  const repo = fakeRepo();
  const res = await request(
    {
      httpMethod: "DELETE",
      path: "/v1/teams/team-1/skills/deploy-check/install",
      queryStringParameters: { actorId: "agent-actor-1" },
    },
    repo,
  );
  assert.equal(res.statusCode, 204);
  assert.deepEqual(repo.calls[0].args[2], { actorId: "agent-actor-1" });
});

test("GET skill-installs is the reconcile list a daemon pulls", async () => {
  const repo = fakeRepo({
    listTeamSkillInstalls: async () => [
      { slug: "deploy-check", installedVersion: 2, latestVersion: 3, hasUpdate: true },
    ],
  });
  const res = await request(
    {
      httpMethod: "GET",
      path: "/v1/teams/team-1/skill-installs",
      queryStringParameters: { actorId: "agent-actor-1" },
    },
    repo,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).items[0].hasUpdate, true);
});

test("POST skill-blobs/prepare is routed to the repository", async () => {
  const { ApiError } = await import("../src/lib/http-utils.js");
  const seen: unknown[] = [];
  const repo = fakeRepo({
    prepareTeamSkillBlob: async (...args: unknown[]) => {
      seen.push(args);
      // Fail before the route reaches Supabase Storage so the test stays offline-safe.
      throw new ApiError(400, "validation_failed", "skip-storage-for-test");
    },
  });
  const res = await request(
    {
      httpMethod: "POST",
      path: "/v1/teams/team-1/skill-blobs/prepare",
      body: JSON.stringify({ contentHash: "a".repeat(64), size: 12 }),
    },
    repo,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ["team-1", { contentHash: "a".repeat(64), size: 12 }]);
});

test("POST skill-blobs/prepare skips the upload URL when the blob is already verified", async () => {
  const repo = fakeRepo({
    prepareTeamSkillBlob: async () => ({
      contentHash: "a".repeat(64),
      size: 12,
      ossKey: "teams/team-1/blobs/sha256/aa/aa/" + "a".repeat(64),
      verified: true,
    }),
  });
  const res = await request(
    {
      httpMethod: "POST",
      path: "/v1/teams/team-1/skill-blobs/prepare",
      body: JSON.stringify({ contentHash: "a".repeat(64), size: 12 }),
    },
    repo,
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.requiresUpload, false);
  assert.equal(body.presignedPut, null);
});

test("GET versions/:v/download is routed to the repository before storage", async () => {
  const { ApiError } = await import("../src/lib/http-utils.js");
  const seen: unknown[] = [];
  const repo = fakeRepo({
    getTeamSkillDownload: async (...args: unknown[]) => {
      seen.push(args);
      throw new ApiError(409, "blob_missing", "skip-storage-for-test");
    },
  });
  const res = await request(
    { httpMethod: "GET", path: "/v1/teams/team-1/skills/deploy-check/versions/1/download" },
    repo,
  );
  assert.equal(res.statusCode, 409);
  assert.deepEqual(seen[0], ["team-1", "deploy-check", 1]);
});

test("GET versions/:v/download rejects a non-numeric version", async () => {
  const repo = fakeRepo();
  const res = await request(
    { httpMethod: "GET", path: "/v1/teams/team-1/skills/deploy-check/versions/latest/download" },
    repo,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(repo.calls.length, 0);
});

test("skillPackageBytesMatch requires size then hash", () => {
  const hash = "a".repeat(64);
  assert.equal(skillPackageBytesMatch(null, hash, { contentHash: hash, size: 12 }).ok, false);
  assert.equal(
    skillPackageBytesMatch({ size: 11 }, hash, { contentHash: hash, size: 12 }).ok,
    false,
  );
  const sizeMismatch = skillPackageBytesMatch({ size: 11 }, hash, { contentHash: hash, size: 12 });
  if (sizeMismatch.ok !== false) throw new Error("expected fail");
  assert.equal(sizeMismatch.code, "blob_missing");

  const hashMismatch = skillPackageBytesMatch({ size: 12 }, "b".repeat(64), {
    contentHash: hash,
    size: 12,
  });
  if (hashMismatch.ok !== false) throw new Error("expected fail");
  assert.equal(hashMismatch.code, "blob_hash_mismatch");

  assert.equal(skillPackageBytesMatch({ size: 12 }, hash, { contentHash: hash, size: 12 }).ok, true);

  // Oversized packages skip the hash (size-only fallback).
  const big = SKILL_PACKAGE_HASH_CAP_BYTES + 1;
  assert.equal(
    skillPackageBytesMatch({ size: big }, null, { contentHash: hash, size: big }).ok,
    true,
  );
});
