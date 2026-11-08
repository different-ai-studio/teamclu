import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { createSupabaseBusinessRepository } from "../src/lib/supabase-repo.js";
import { jwtSessionId, resolvePlatformOperator } from "../src/lib/platform-operators.js";

/**
 * Support mode (docs/plans/2026-11-08-platform-operator-support-access.md):
 * who is a platform operator (admin_type 4 in the platform org, or the env
 * fallback), entering a customer team as the org's support account, and
 * ending that session.
 */

const OPERATOR = "0b5b7c1e-3d0a-4c65-9d2f-6a1e0f7c2b11";
const OUTSIDER = "7f3e2a10-9c4b-4e8d-a1f6-2b7d5c0e9a33";
const SUPPORT = "5e5e5e5e-1111-4222-8333-444444444444";
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const GRANT = "44444444-4444-4444-8444-444444444444";
const SESSION = "66666666-6666-4666-8666-666666666666";

function tokenWith(claims: Record<string, unknown>) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
}

function noEnvOperators(t: any) {
  const prev = process.env.PLATFORM_OPERATOR_USER_IDS;
  delete process.env.PLATFORM_OPERATOR_USER_IDS;
  t.after(() => {
    if (prev !== undefined) process.env.PLATFORM_OPERATOR_USER_IDS = prev;
  });
}

type Rpc = { fn: string; args: any };
type RpcAnswer = { data?: any; error?: any };

/** A service-role client that answers rpc() from a table and records calls. */
function fakeAdmin(rpc: Record<string, RpcAnswer | ((args: any) => RpcAnswer)>, rows: Record<string, any[]>, calls: Rpc[]) {
  return {
    schema(schema: string) {
      return {
        rpc(fn: string, args: any) {
          calls.push({ fn, args });
          const answer = rpc[fn];
          const out = typeof answer === "function" ? answer(args) : answer;
          return Promise.resolve({ data: out?.data ?? null, error: out?.error ?? null });
        },
        from(table: string) {
          const filters: Record<string, unknown> = {};
          const builder: any = {
            select() { return builder },
            eq(col: string, val: unknown) { filters[col] = val; return builder },
            maybeSingle() {
              const hit = (rows[`${schema}.${table}`] ?? []).find((r) =>
                Object.entries(filters).every(([k, v]) => r[k] === v));
              return Promise.resolve({ data: hit ?? null, error: null });
            },
          };
          return builder;
        },
      };
    },
  };
}

function repoFor(userId: string, opts: {
  rpc?: Record<string, RpcAnswer | ((args: any) => RpcAnswer)>;
  rows?: Record<string, any[]>;
  accessToken?: string;
} = {}) {
  const calls: Rpc[] = [];
  const repo = createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: opts.accessToken ?? "caller-token",
    trustedExternalJwtSecret: "",
    createServiceRoleClient: () => fakeAdmin(opts.rpc ?? {}, opts.rows ?? {}, calls),
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
      from: () => { throw new Error("the caller's own client must not be used") },
      rpc: () => { throw new Error("the caller's own client must not be used") },
    }),
  } as any) as any;
  return { repo, calls };
}

const operatorInDb = { is_platform_operator: (a: any) => ({ data: a.p_user_id === OPERATOR }) };

// ── who is an operator ──────────────────────────────────────────────────────

test("the env list short-circuits; otherwise admin_type 4 is asked of the database", async () => {
  let asked = 0;
  const admin = async () => ({
    schema: () => ({ rpc: async (_fn: string, a: any) => { asked++; return { data: a.p_user_id === OPERATOR, error: null } } }),
  });
  assert.equal(await resolvePlatformOperator(OUTSIDER, admin, { PLATFORM_OPERATOR_USER_IDS: OUTSIDER } as any), true);
  assert.equal(asked, 0, "an env hit needs no lookup");
  assert.equal(await resolvePlatformOperator(OPERATOR, admin, {} as any), true);
  assert.equal(await resolvePlatformOperator(OUTSIDER, admin, {} as any), false);
  assert.equal(await resolvePlatformOperator(null, admin, {} as any), false);
});

test("a failed operator lookup fails closed", async (t) => {
  t.mock.method(console, "warn", () => {});
  const rpcError = async () => ({ schema: () => ({ rpc: async () => ({ data: null, error: { message: "function missing" } }) }) });
  const noKey = async () => { throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured") };
  assert.equal(await resolvePlatformOperator(OPERATOR, rpcError, {} as any), false);
  assert.equal(await resolvePlatformOperator(OPERATOR, noKey, {} as any), false);
});

test("the session id is read from a token's claims, and only if it is a uuid", () => {
  assert.equal(jwtSessionId(tokenWith({ session_id: SESSION.toUpperCase() })), SESSION);
  assert.equal(jwtSessionId(tokenWith({ session_id: "nope" })), null);
  assert.equal(jwtSessionId(tokenWith({})), null);
  assert.equal(jwtSessionId("not-a-jwt"), null);
  assert.equal(jwtSessionId(undefined), null);
});

test("whoami reports an admin_type 4 operator, and a live support session", async (t) => {
  noEnvOperators(t);
  const op = repoFor(OPERATOR, { rpc: operatorInDb });
  assert.deepEqual(await op.repo.getAdminWhoami(), { userId: OPERATOR, operator: true, support: null });

  const support = repoFor(SUPPORT, {
    accessToken: tokenWith({ sub: SUPPORT, session_id: SESSION }),
    rpc: {
      ...operatorInDb,
      support_session_info: (a: any) => ({
        data: a.p_session_id === SESSION && a.p_user_id === SUPPORT
          ? [{ grant_id: GRANT, operator_user_id: OPERATOR, org_id: ORG, team_id: TEAM, expires_at: "2026-11-08T12:00:00Z" }]
          : [],
      }),
    },
  });
  assert.deepEqual(await support.repo.getAdminWhoami(), {
    userId: SUPPORT,
    operator: false,
    support: { orgId: ORG, teamId: TEAM, expiresAt: "2026-11-08T12:00:00Z" },
  });
});

// ── entering ────────────────────────────────────────────────────────────────

const startedRow = {
  grant_id: GRANT, session_id: SESSION, refresh_token: "rt-123", org_id: ORG, team_id: TEAM,
  actor_id: ACTOR, support_user_id: SUPPORT, expires_at: "2026-11-08T12:00:00Z",
};
const teams = { "amux.teams": [{ id: TEAM, oid: ORG }] };

test("only an operator may start a support session", async (t) => {
  noEnvOperators(t);
  const { repo, calls } = repoFor(OUTSIDER, { rpc: operatorInDb, rows: teams });
  await assert.rejects(repo.startSupportSession(ORG, { teamId: TEAM, reason: "help" }),
    (e: any) => e.statusCode === 403);
  assert.ok(!calls.some((c) => c.fn === "start_support_session"));
});

test("a support session needs a team of that org and a reason", async (t) => {
  noEnvOperators(t);
  const { repo, calls } = repoFor(OPERATOR, { rpc: operatorInDb, rows: teams });
  await assert.rejects(repo.startSupportSession(ORG, { reason: "help" }), (e: any) => e.statusCode === 400);
  await assert.rejects(repo.startSupportSession(ORG, { teamId: TEAM, reason: "  " }), (e: any) => e.statusCode === 400);
  await assert.rejects(repo.startSupportSession(ORG, { teamId: TEAM, reason: "help", ttlMinutes: 2 }),
    (e: any) => e.statusCode === 400);
  await assert.rejects(repo.startSupportSession(OTHER_ORG, { teamId: TEAM, reason: "help" }),
    (e: any) => e.statusCode === 404, "a team of another org");
  assert.ok(!calls.some((c) => c.fn === "start_support_session"));
});

test("an operator enters a team and gets a refresh token for the support account", async (t) => {
  noEnvOperators(t);
  t.mock.method(console, "log", () => {});
  const { repo, calls } = repoFor(OPERATOR, {
    rpc: { ...operatorInDb, start_support_session: { data: [startedRow] } },
    rows: teams,
  });
  const out = await repo.startSupportSession(ORG, { teamId: TEAM, reason: " ticket 42 " });
  assert.deepEqual(out, {
    grantId: GRANT, refreshToken: "rt-123", orgId: ORG, teamId: TEAM, actorId: ACTOR,
    supportUserId: SUPPORT, expiresAt: "2026-11-08T12:00:00Z",
  });
  const call = calls.find((c) => c.fn === "start_support_session")!;
  assert.deepEqual(call.args, {
    p_operator_user_id: OPERATOR, p_team_id: TEAM, p_reason: "ticket 42", p_ttl: "240 minutes",
  });
});

test("database refusals map to HTTP errors", async (t) => {
  noEnvOperators(t);
  for (const [code, status] of [["22023", 400], ["42501", 403], ["P0002", 404]] as const) {
    const { repo } = repoFor(OPERATOR, {
      rpc: { ...operatorInDb, start_support_session: { error: { code, message: "refused" } } },
      rows: teams,
    });
    await assert.rejects(repo.startSupportSession(ORG, { teamId: TEAM, reason: "help" }),
      (e: any) => e.statusCode === status, `${code} → ${status}`);
  }
});

test("POST /v1/admin/orgs/:orgId/support-sessions answers 201", async (t) => {
  noEnvOperators(t);
  t.mock.method(console, "log", () => {});
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: `/v1/admin/orgs/${ORG}/support-sessions`,
    headers: { Authorization: "Bearer caller-token", "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: TEAM, reason: "help" }),
  }, {
    createRepository: () => repoFor(OPERATOR, {
      rpc: { ...operatorInDb, start_support_session: { data: [startedRow] } },
      rows: teams,
    }).repo,
  });
  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.body).refreshToken, "rt-123");
});

// ── leaving ─────────────────────────────────────────────────────────────────

test("ending a support session revokes the caller's own session", async () => {
  const { repo, calls } = repoFor(SUPPORT, {
    accessToken: tokenWith({ sub: SUPPORT, session_id: SESSION }),
    rpc: { end_support_session: { data: true } },
  });
  assert.deepEqual(await repo.endCurrentSupportSession(), { ended: true });
  assert.deepEqual(calls.find((c) => c.fn === "end_support_session")!.args,
    { p_user_id: SUPPORT, p_session_id: SESSION });
});

test("a caller without a session id has nothing to end", async () => {
  const { repo, calls } = repoFor(SUPPORT, { rpc: { end_support_session: { data: true } } });
  assert.deepEqual(await repo.endCurrentSupportSession(), { ended: false });
  assert.equal(calls.length, 0);
});

test("DELETE /v1/admin/support-sessions/current", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "DELETE",
    path: "/v1/admin/support-sessions/current",
    headers: { Authorization: `Bearer ${tokenWith({ sub: SUPPORT, session_id: SESSION })}` },
  }, {
    createRepository: () => repoFor(SUPPORT, {
      accessToken: tokenWith({ sub: SUPPORT, session_id: SESSION }),
      rpc: { end_support_session: { data: false } },
    }).repo,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ended: false });
});
