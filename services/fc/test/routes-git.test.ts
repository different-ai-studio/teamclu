import test from "node:test";
import assert from "node:assert/strict";
import {
  credentialFromHeader,
  readGitPublicHost,
  readGitPublicScheme,
  registerGit,
  resetGitCallerCache,
  resetGitMintLimiter,
  type GitRouteDeps,
} from "../src/lib/routes/git.js";
import { signGitToken, verifyGitToken, GIT_TOKEN_TTL_SECONDS } from "../src/lib/git-token.js";
import { giteaUserName } from "../src/lib/provisioning/gitea.js";

const SECRET = "s".repeat(40);
const ALICE = "aaaaaaaa-0000-4000-8000-00000000000a";
const AGENT = "aaaaaaaa-0000-4000-8000-00000000000b";
const STRANGER = "aaaaaaaa-0000-4000-8000-00000000000c";
const APP_ID = "bbbbbbbb-0000-4000-8000-000000000001";

function makeRouter() {
  const routes: Record<string, (ctx: any) => Promise<any>> = {};
  const router = {
    get: (p: string, _o: any, h: any) => { routes[`GET ${p}`] = h; },
    post: (p: string, _o: any, h: any) => { routes[`POST ${p}`] = h; },
  };
  return { router, routes };
}

/** GoTrue as far as these routes use it, over the shared apps fake for tables. */
function fakeAdmin(opts: { users?: Record<string, any>; sessions?: Record<string, string>; seed?: any } = {}) {
  const users: Record<string, any> = {
    [ALICE]: { id: ALICE, app_metadata: {} },
    [AGENT]: { id: AGENT, app_metadata: {} },
    [STRANGER]: { id: STRANGER, app_metadata: {} },
    ...(opts.users ?? {}),
  };
  const sessions: Record<string, string> = { "alice-session": ALICE, "agent-session": AGENT, "stranger-session": STRANGER, ...(opts.sessions ?? {}) };
  const seed = opts.seed ?? {};
  // Minimal PostgREST shape: select().eq()...maybeSingle(), filters honoured.
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: unknown) => { filters.push([col, val]); return builder; },
      maybeSingle: async () => ({
        data: (seed[table] ?? []).find((row: any) => filters.every(([c, v]) => row[c] === v)) ?? null,
        error: null,
      }),
    };
    return builder;
  };
  return {
    users,
    from,
    auth: {
      getUser: async (jwt: string) => {
        const id = sessions[jwt];
        return id ? { data: { user: users[id] }, error: null } : { data: { user: null }, error: new Error("invalid jwt") };
      },
      admin: {
        getUserById: async (id: string) => (users[id] ? { data: { user: users[id] }, error: null } : { data: { user: null }, error: new Error("not found") }),
        updateUserById: async (id: string, attrs: any) => {
          users[id] = { ...users[id], app_metadata: { ...(users[id].app_metadata ?? {}), ...(attrs.app_metadata ?? {}) } };
          return { data: { user: users[id] }, error: null };
        },
      },
    },
  };
}

function setup(adminOpts: Parameters<typeof fakeAdmin>[0] = {}, over: Partial<GitRouteDeps> = {}) {
  resetGitCallerCache();
  resetGitMintLimiter();
  const admin = fakeAdmin(adminOpts);
  let now = Date.parse("2026-11-17T08:00:00Z");
  const deps: GitRouteDeps = {
    secret: () => SECRET,
    admin: () => admin,
    now: () => now,
    gitHost: () => "gitea.example.com",
    trustedExternalJwtSecret: () => undefined,
    ...over,
  };
  const { router, routes } = makeRouter();
  registerGit(router, deps);
  const call = (route: string, headers: Record<string, string> = {}, query = "") =>
    routes[route]({
      getHeader: (n: string) => headers[n.toLowerCase()],
      query: new URLSearchParams(query),
    });
  return { admin, routes, call, advance: (ms: number) => { now += ms; } };
}

const basic = (password: string) => `Basic ${Buffer.from(`git:${password}`).toString("base64")}`;

test("credentials are read from Basic (git) and Bearer headers", () => {
  assert.equal(credentialFromHeader(basic("tok")), "tok");
  assert.equal(credentialFromHeader("Bearer abc"), "abc");
  assert.equal(credentialFromHeader(`Basic ${Buffer.from("only-user:").toString("base64")}`), null);
  assert.equal(credentialFromHeader(undefined), null);
  assert.equal(readGitPublicHost({ GITEA_PUBLIC_URL: "https://gitea.example.com/" }), "gitea.example.com");
  assert.equal(readGitPublicHost({}), null);
});

test("the helper's scheme follows GITEA_PUBLIC_URL, https unless it says http", () => {
  assert.equal(readGitPublicScheme({ GITEA_PUBLIC_URL: "https://gitea.example.com/" }), "https");
  assert.equal(readGitPublicScheme({ GITEA_PUBLIC_URL: "http://gitea.localhost:8080" }), "http");
  assert.equal(readGitPublicScheme({}), "https");
  assert.equal(readGitPublicScheme({ GITEA_PUBLIC_URL: "not a url" }), "https");
});

test("with per-account git off, no git token is minted even if the secret is set", async () => {
  const off = setup({}, { accountAuth: () => false });
  await assert.rejects(
    () => off.call("POST /v1/git/token", { authorization: "Bearer alice-session" }),
    (e: any) => e.statusCode === 503 && e.code === "git_token_unavailable",
  );
});

test("git tokens are git-only, carry their epoch, and expire after 30 days", async () => {
  const now = Date.parse("2026-11-17T08:00:00Z");
  const { token } = await signGitToken({ userId: ALICE, epoch: 2 }, SECRET, now);
  assert.deepEqual(await verifyGitToken(token, SECRET, now), { userId: ALICE, epoch: 2 });
  assert.equal(await verifyGitToken(token, "x".repeat(40), now), null, "another secret");
  assert.equal(await verifyGitToken(token, SECRET, now + (GIT_TOKEN_TTL_SECONDS + 1) * 1000), null, "expired");
});

test("a person mints a git token with their session and it opens the gateway", async () => {
  const { call } = setup();
  const minted = await call("POST /v1/git/token", { authorization: "Bearer alice-session" });
  assert.equal(minted.body.userName, giteaUserName(ALICE));
  assert.equal(minted.body.gitHost, "gitea.example.com");
  assert.equal(minted.body.gitScheme, "https");

  const ok = await call("GET /v1/git/authz", { authorization: basic(minted.body.token) });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["X-WEBAUTH-USER"], giteaUserName(ALICE));
});

test("the gateway refuses no credential, a wrong one, and a bare session-shaped string", async () => {
  const { call } = setup();
  for (const headers of [{}, { authorization: basic("garbage") }, { authorization: "Bearer nope" }]) {
    const res = await call("GET /v1/git/authz", headers);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers["WWW-Authenticate"], 'Basic realm="TeamClu"', "git needs this to ask its helper");
    assert.equal(res.headers["X-WEBAUTH-USER"], undefined);
  }
});

test("an agent authenticates with its own login token", async () => {
  const { call } = setup();
  const res = await call("GET /v1/git/authz", { authorization: basic("agent-session") });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["X-WEBAUTH-USER"], giteaUserName(AGENT));
});

test("signing out revokes every git token of the account", async () => {
  const { call, advance } = setup();
  const { body } = await call("POST /v1/git/token", { authorization: "Bearer alice-session" });
  assert.equal((await call("GET /v1/git/authz", { authorization: basic(body.token) })).statusCode, 200);

  const revoked = await call("POST /v1/git/token/revoke", { authorization: "Bearer alice-session" });
  assert.deepEqual(revoked.body, { revoked: true, epoch: 1 });
  advance(1000);
  assert.equal((await call("GET /v1/git/authz", { authorization: basic(body.token) })).statusCode, 401);

  // A token minted after the revoke works.
  const fresh = await call("POST /v1/git/token", { authorization: "Bearer alice-session" });
  assert.equal((await call("GET /v1/git/authz", { authorization: basic(fresh.body.token) })).statusCode, 200);
});

test("a banned account's git token stops working", async () => {
  const { call, admin, advance } = setup();
  const { body } = await call("POST /v1/git/token", { authorization: "Bearer alice-session" });
  admin.users[ALICE].banned_until = "2099-01-01T00:00:00Z";
  advance(61_000); // past the cache
  assert.equal((await call("GET /v1/git/authz", { authorization: basic(body.token) })).statusCode, 401);
});

test("minting needs a session, a secret, and stays under the hourly limit", async () => {
  const noSecret = setup({}, { secret: () => null });
  await assert.rejects(() => noSecret.call("POST /v1/git/token", { authorization: "Bearer alice-session" }), (e: any) => e.statusCode === 503);

  const { call } = setup();
  await assert.rejects(() => call("POST /v1/git/token", {}), (e: any) => e.statusCode === 401);
  // A git token is not a session: it cannot mint another one.
  const { body } = await call("POST /v1/git/token", { authorization: "Bearer alice-session" });
  await assert.rejects(() => call("POST /v1/git/token", { authorization: `Bearer ${body.token}` }), (e: any) => e.statusCode === 401);
  for (let i = 1; i < 10; i++) await call("POST /v1/git/token", { authorization: "Bearer alice-session" });
  await assert.rejects(() => call("POST /v1/git/token", { authorization: "Bearer alice-session" }), (e: any) => e.statusCode === 429);
});

// ── /v1/git/access ────────────────────────────────────────────────────────

const accessSeed = {
  apps: [{ id: APP_ID, name: "订单看板", team_id: "team-1", visibility: "personal", created_by_actor_id: "actor-alice" }],
  actors: [
    { id: "actor-alice", team_id: "team-1", actor_type: "member", user_id: ALICE, display_name: "Alice" },
    { id: "actor-agent", team_id: "team-1", actor_type: "agent", user_id: AGENT, display_name: "小助手" },
  ],
  app_member_access: [] as any[],
};

test("access tells an ungranted agent which app it lacks", async () => {
  const { call } = setup({ seed: accessSeed });
  const res = await call("GET /v1/git/access", { authorization: basic("agent-session") }, `repo=o123/tc-app-${APP_ID}.git`);
  assert.deepEqual(res.body, { appId: APP_ID, appName: "订单看板", permission: null, actorName: "小助手", actorType: "agent" });
});

test("access reports the creator as admin and a granted agent at its level", async () => {
  const granted = { ...accessSeed, app_member_access: [{ app_id: APP_ID, member_id: "actor-agent", permission_level: "write" }] };
  const { call } = setup({ seed: granted });
  assert.equal((await call("GET /v1/git/access", { authorization: basic("alice-session") }, `repo=o1/tc-app-${APP_ID}`)).body.permission, "admin");
  assert.equal((await call("GET /v1/git/access", { authorization: basic("agent-session") }, `repo=o1/tc-app-${APP_ID}`)).body.permission, "write");
});

test("access says read for a teammate on a team-visible app", async () => {
  const team = { ...accessSeed, apps: [{ ...accessSeed.apps[0], visibility: "team" }] };
  const { call } = setup({ seed: team });
  assert.equal((await call("GET /v1/git/access", { authorization: basic("agent-session") }, `repo=o1/tc-app-${APP_ID}`)).body.permission, "read");
});

test("access reveals nothing to someone outside the team", async () => {
  const { call } = setup({ seed: accessSeed });
  await assert.rejects(
    () => call("GET /v1/git/access", { authorization: basic("stranger-session") }, `repo=o1/tc-app-${APP_ID}`),
    (e: any) => e.statusCode === 404,
  );
  await assert.rejects(
    () => call("GET /v1/git/access", { authorization: basic("alice-session") }, "repo=o1/not-an-app"),
    (e: any) => e.statusCode === 404,
  );
  await assert.rejects(() => call("GET /v1/git/access", {}, `repo=o1/tc-app-${APP_ID}`), (e: any) => e.statusCode === 401);
});
