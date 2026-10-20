import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { ApiError } from "../src/lib/http-utils.js";
import { shouldAssignMemberRole } from "../src/lib/supabase-repo/auth.js";

function makeApp({
  previewJoinLink,
  joinTeamByLink,
}: {
  previewJoinLink?: (...args: any[]) => any;
  joinTeamByLink?: (...args: any[]) => any;
}) {
  return createApp({
    createRepository: () => ({}),
    createAuthRepository: () => ({
      previewJoinLink,
      joinTeamByLink,
    }),
  } as any);
}

test("GET /v1/join-links/:token previews without a bearer and is not cached", async () => {
  const calls: any[] = [];
  const app = makeApp({
    previewJoinLink: async (token: string) => {
      calls.push({ method: "previewJoinLink", token });
      return {
        teamName: "Alpha",
        inviterDisplayName: "Ada",
        expiresAt: null,
        status: "active",
      };
    },
  });
  const res = await app.request("/v1/join-links/tok");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls[0], { method: "previewJoinLink", token: "tok" });
  assert.equal((await res.json() as any).teamName, "Alpha");
});

test("POST /v1/join-links/:token/join forwards the caller bearer", async () => {
  const calls: any[] = [];
  const app = makeApp({
    joinTeamByLink: async (token: string, ctx: { accessToken?: string }) => {
      calls.push({ method: "joinTeamByLink", token, ctx });
      return { teamId: "team-1", actorId: "actor-1", displayName: "Ada", alreadyMember: false };
    },
  });
  const res = await app.request("/v1/join-links/tok/join", {
    method: "POST",
    headers: { Authorization: "Bearer member-jwt" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], {
    method: "joinTeamByLink",
    token: "tok",
    ctx: { accessToken: "member-jwt" },
  });
});

test("POST /v1/join-links/:token/join without a bearer is 401 and does not join", async () => {
  const calls: any[] = [];
  const app = makeApp({
    joinTeamByLink: async () => {
      calls.push({ method: "joinTeamByLink" });
      return { teamId: "team-1", actorId: "actor-1", displayName: "Ada", alreadyMember: false };
    },
  });
  const res = await app.request("/v1/join-links/tok/join", { method: "POST" });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test("POST /v1/join-links/:token/join maps link_expired to 410", async () => {
  const app = makeApp({
    joinTeamByLink: async () => {
      throw new ApiError(410, "link_expired", "link_expired");
    },
  });
  const res = await app.request("/v1/join-links/tok/join", {
    method: "POST",
    headers: { Authorization: "Bearer member-jwt" },
  });
  assert.equal(res.status, 410);
  assert.equal((await res.json() as any).error.code, "link_expired");
});

test("POST /v1/join-links/:token/join calls the auth repo once for a new member", async () => {
  const calls: any[] = [];
  const app = makeApp({
    joinTeamByLink: async () => {
      calls.push({ method: "joinTeamByLink" });
      return { teamId: "team-1", actorId: "actor-1", displayName: "Ada", alreadyMember: false };
    },
  });
  const res = await app.request("/v1/join-links/tok/join", {
    method: "POST",
    headers: { Authorization: "Bearer member-jwt" },
  });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test("shouldAssignMemberRole is true only for a first-time join", () => {
  assert.equal(shouldAssignMemberRole({ alreadyMember: false }), true);
  assert.equal(shouldAssignMemberRole({ alreadyMember: true }), false);
});
