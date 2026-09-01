import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import {
  isTeamScopedSkillObjectPath,
  marketplaceObjectPath,
} from "../src/lib/validation/marketplace-paths.js";

// Route-level coverage for the skills marketplace.
// Design: docs/architecture/skills-marketplace.md

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
    listMarketplaceSkills: record("listMarketplaceSkills", []),
    getMarketplaceSkill: record("getMarketplaceSkill", { slug: "deploy-check", versions: [] }),
    adoptMarketplaceSkill: record("adoptMarketplaceSkill", { slug: "deploy-check", origin: "marketplace" }),
    detachMarketplaceSkill: record("detachMarketplaceSkill", {
      slug: "deploy-check",
      upstreamSubscribed: false,
    }),
    prepareMarketplaceSkillBlob: record("prepareMarketplaceSkillBlob", {
      contentHash: "a".repeat(64),
      size: 12,
      objectPath: marketplaceObjectPath("a".repeat(64)),
      requiresUpload: true,
    }),
    completeMarketplaceSkillBlob: record("completeMarketplaceSkillBlob", {
      contentHash: "a".repeat(64),
      size: 12,
      objectPath: marketplaceObjectPath("a".repeat(64)),
      verified: true,
    }),
    createMarketplaceSkill: record("createMarketplaceSkill", { slug: "deploy-check" }),
    createMarketplaceSkillVersion: record("createMarketplaceSkillVersion", { version: 1 }),
    promoteMarketplaceSkillVersion: record("promoteMarketplaceSkillVersion", { version: 1 }),
    revertMarketplaceSkillVersion: record("revertMarketplaceSkillVersion", { version: 2 }),
    updateMarketplaceSkill: record("updateMarketplaceSkill", { status: "delisted" }),
    alignAllMarketplaceSubscriptions: record("alignAllMarketplaceSubscriptions", { aligned: 3 }),
    ...overrides,
  };
}

function request(overrides: Record<string, unknown>, repo: unknown) {
  return handleBusinessApiRequest(
    {
      headers: { Authorization: "Bearer caller-token" },
      ...overrides,
    } as never,
    {
      createRepository: () => repo,
      createSystemRepository: () => repo,
      createAuthRepository: () => repo,
    } as never,
  );
}

test("GET /v1/marketplace/skills lists the catalog", async () => {
  const repo = fakeRepo({
    listMarketplaceSkills: async () => [{ slug: "deploy-check", adoptedByTeam: null }],
  });
  const res = await request({ httpMethod: "GET", path: "/v1/marketplace/skills" }, repo);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.items.length, 1);
});

test("POST /v1/teams/:id/skills/adopt creates a subscribed team skill", async () => {
  const repo = fakeRepo();
  const res = await request(
    {
      httpMethod: "POST",
      path: "/v1/teams/team-1/skills/adopt",
      body: JSON.stringify({ marketplaceSlug: "deploy-check" }),
    },
    repo,
  );
  assert.equal(res.statusCode, 201);
  assert.equal(repo.calls[0].method, "adoptMarketplaceSkill");
});

test("POST /v1/teams/:id/skills/:slug/detach stops following", async () => {
  const repo = fakeRepo();
  const res = await request(
    {
      httpMethod: "POST",
      path: "/v1/teams/team-1/skills/deploy-check/detach",
      body: "{}",
    },
    repo,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0].args, ["team-1", "deploy-check"]);
});

test("admin prepare rejects when MARKETPLACE_ADMIN_SECRET is unset", async () => {
  const prev = process.env.MARKETPLACE_ADMIN_SECRET;
  delete process.env.MARKETPLACE_ADMIN_SECRET;
  try {
    const repo = fakeRepo();
    const res = await request(
      {
        httpMethod: "POST",
        path: "/v1/admin/marketplace/skill-blobs/prepare",
        headers: { "x-webhook-secret": "anything" },
        body: JSON.stringify({ contentHash: "a".repeat(64), size: 1 }),
      },
      repo,
    );
    assert.equal(res.statusCode, 401);
  } finally {
    if (prev === undefined) delete process.env.MARKETPLACE_ADMIN_SECRET;
    else process.env.MARKETPLACE_ADMIN_SECRET = prev;
  }
});

test("admin promote accepts matching shared secret", async () => {
  const prev = process.env.MARKETPLACE_ADMIN_SECRET;
  process.env.MARKETPLACE_ADMIN_SECRET = "marketplace-test-secret";
  try {
    const repo = fakeRepo();
    const res = await request(
      {
        httpMethod: "POST",
        path: "/v1/admin/marketplace/skills/deploy-check/versions/1/promote",
        headers: {
          Authorization: "Bearer ignored",
          "x-webhook-secret": "marketplace-test-secret",
        },
        body: "{}",
      },
      repo,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(repo.calls[0].method, "promoteMarketplaceSkillVersion");
  } finally {
    if (prev === undefined) delete process.env.MARKETPLACE_ADMIN_SECRET;
    else process.env.MARKETPLACE_ADMIN_SECRET = prev;
  }
});

test("marketplace object paths never look team-scoped (GC assertion)", () => {
  const path = marketplaceObjectPath("ab".repeat(32));
  assert.ok(path.startsWith("marketplace/blobs/sha256/"));
  assert.equal(isTeamScopedSkillObjectPath(path), false);
  assert.equal(
    isTeamScopedSkillObjectPath("teams/team-1/blobs/sha256/aa/bb/" + "c".repeat(64)),
    true,
  );
});
