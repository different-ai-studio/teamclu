import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

// GET /v1/teams?scope=all is a bearer route, so it resolves the BUSINESS
// repository (createRepository). POST /v1/teams/:id/activate is registered with
// { auth: "none" }, so it resolves the AUTH repository (createAuthRepository) —
// which owns switchActiveTeam (it forwards the bearer itself).
function makeApp({
  listAllMyTeams,
  getHomeOrgId,
  listDiscoverableTeams,
  bootstrapTeam,
  switchActiveTeam,
}: {
  listAllMyTeams?: (...args: any[]) => any;
  getHomeOrgId?: (...args: any[]) => any;
  listDiscoverableTeams?: (...args: any[]) => any;
  bootstrapTeam?: (...args: any[]) => any;
  switchActiveTeam?: (...args: any[]) => any;
}) {
  return createApp({
    createRepository: ({ accessToken }: { accessToken: string }) => ({
      listTeams: async () => [{ id: "active-only", name: "Active", accessToken }],
      listAllMyTeams,
      getHomeOrgId,
      listDiscoverableTeams,
      bootstrapTeam,
    }),
    createAuthRepository: () => ({
      switchActiveTeam,
    }),
  } as any);
}

test("GET /v1/teams?scope=all returns orgName and takes no listing options", async () => {
  let received: any;
  const app = makeApp({
    listAllMyTeams: async (args: any) => {
      received = args;
      return [
        { id: "t1", name: "Alpha", slug: "alpha", orgId: "o1", orgName: "Org One" },
        { id: "t2", name: "Beta", slug: "beta", orgId: "o2", orgName: "Org Two" },
      ];
    },
  });
  // `includeEmptyOrgs` is gone: an org with no team now gets one on its first
  // member's login, so there is no empty-org picker row to opt into. A stray
  // query param must simply be ignored, not forwarded.
  const res = await app.request("/v1/teams?scope=all&includeEmptyOrgs=true", {
    headers: { authorization: "Bearer x" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.deepEqual(received, undefined);
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].orgName, "Org One");
  assert.equal(body.nextCursor, null);
});

test("GET /v1/teams?scope=all carries the caller's home org alongside the full list", async () => {
  const app = makeApp({
    listAllMyTeams: async () => [
      { id: "t1", name: "Alpha", orgId: "o1", orgName: "Org One" },
      { id: "t2", name: "Beta", orgId: "o2", orgName: "Org Two" },
    ],
    getHomeOrgId: async () => "o2",
  });
  const res = await app.request("/v1/teams?scope=all", { headers: { authorization: "Bearer x" } });
  const body = (await res.json()) as any;
  assert.equal(body.homeOrgId, "o2");
  // Narrowing is the client's call (login chooser only); the list stays whole.
  assert.equal(body.items.length, 2);
});

test("GET /v1/teams?scope=all reports homeOrgId null when the repo cannot say", async () => {
  const app = makeApp({ listAllMyTeams: async () => [] });
  const res = await app.request("/v1/teams?scope=all", { headers: { authorization: "Bearer x" } });
  const body = (await res.json()) as any;
  assert.equal(body.homeOrgId, null);
});

test("GET /v1/teams?scope=discoverable is gone — it falls through to the member listing", async () => {
  // Anonymous public-team browsing was removed with anonymous sign-in. An old
  // client still sending the scope must get the ordinary listing rather than a
  // route error.
  let discoverableCalled = false;
  const app = makeApp({
    listDiscoverableTeams: async () => { discoverableCalled = true; return []; },
  });
  const res = await app.request("/v1/teams?scope=discoverable", {
    headers: { authorization: "Bearer x" },
  });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(discoverableCalled, false);
  assert.equal(body.items[0].id, "active-only");
});

test("POST /v1/teams/bootstrap delegates atomic first-team creation", async () => {
  let input: any;
  const app = makeApp({
    bootstrapTeam: async (received: any) => {
      input = received;
      return { id: "org-team", name: "Org One", slug: "org-one" };
    },
  });
  const res = await app.request("/v1/teams/bootstrap", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Boss" }),
  });
  assert.equal(res.status, 200);
  // `orgId` went with the empty-org picker row and `deviceId` with the
  // guest-team reuse the anonymous path needed. `teamName` is what the
  // first-run screen collects — null here because this body omits it, which is
  // the older-client shape and must keep working.
  assert.deepEqual(input, { displayName: "Boss", teamName: null });
  assert.equal((await res.json() as any).name, "Org One");
});



test("GET /v1/teams (no scope) keeps the active-org listing", async () => {
  let allCalled = false;
  const app = makeApp({
    listAllMyTeams: async () => {
      allCalled = true;
      return [];
    },
  });
  const res = await app.request("/v1/teams", {
    headers: { authorization: "Bearer x" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(allCalled, false);
  assert.equal(body.items[0].id, "active-only");
});

test("POST /v1/teams/:id/activate forwards bearer and returns refreshToken", async () => {
  let seenTeamId: string | undefined;
  let seenToken: string | undefined;
  const app = makeApp({
    switchActiveTeam: async (id: string, ctx: any) => {
      seenTeamId = id;
      seenToken = ctx?.accessToken;
      return { actorId: "a1", teamId: id, refreshToken: "rt-123" };
    },
  });
  const res = await app.request("/v1/teams/t9/activate", {
    method: "POST",
    headers: { authorization: "Bearer tok" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(seenTeamId, "t9");
  assert.equal(seenToken, "tok");
  assert.equal(body.refreshToken, "rt-123");
  assert.equal(body.teamId, "t9");
  assert.equal(body.actorId, "a1");
});
