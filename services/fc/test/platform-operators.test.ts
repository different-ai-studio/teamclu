import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { aiGateway } from "../src/lib/ai-gateway.js";
import { createSupabaseBusinessRepository } from "../src/lib/supabase-repo.js";
import { isPlatformOperator, platformOperatorIds } from "../src/lib/platform-operators.js";

const OPERATOR = "0b5b7c1e-3d0a-4c65-9d2f-6a1e0f7c2b11";
const OWNER = "7f3e2a10-9c4b-4e8d-a1f6-2b7d5c0e9a33";
const env = (ids: string) => ({ PLATFORM_OPERATOR_USER_IDS: ids }) as NodeJS.ProcessEnv;

test("the operator list is user ids, comma or whitespace separated", () => {
  assert.deepEqual([...platformOperatorIds(env(`${OPERATOR}, ${OWNER}\n`))], [OPERATOR, OWNER]);
  assert.ok(isPlatformOperator(OPERATOR.toUpperCase(), env(OPERATOR)), "uuids compare case-insensitively");
});

test("unset or blank means nobody is an operator", () => {
  assert.equal(platformOperatorIds({} as NodeJS.ProcessEnv).size, 0);
  assert.equal(isPlatformOperator(OPERATOR, env("")), false);
  assert.equal(isPlatformOperator(undefined, env(OPERATOR)), false);
  assert.equal(isPlatformOperator("", env(OPERATOR)), false);
});

test("an entry that is not a user id is ignored, not trusted", (t) => {
  // An email pasted where an id belongs. A phone-login account's email is
  // synthesized, so matching on it would be matching on something forgeable.
  const warn = t.mock.method(console, "warn", () => {});
  const ids = platformOperatorIds(env(`ops@example.com,${OPERATOR}`));
  assert.deepEqual([...ids], [OPERATOR]);
  assert.equal(isPlatformOperator("ops@example.com", env("ops@example.com")), false);
  assert.ok(warn.mock.callCount() >= 1);
});

/** The real repository over a stub client whose caller is `userId`. */
function repoFor(userId: string | null) {
  return createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    // Explicit, so a TRUSTED_EXTERNAL_JWT_SECRET in the shell cannot switch paths.
    trustedExternalJwtSecret: "",
    createClient: () => ({
      auth: {
        getUser: async () =>
          userId ? { data: { user: { id: userId } }, error: null } : { data: { user: null }, error: new Error("no") },
      },
      // A team owner check would query actors and current_team_role. The
      // operator check must not depend on either, so reaching them fails.
      from: () => { throw new Error("team membership must not be consulted"); },
      rpc: () => { throw new Error("team role must not be consulted"); },
    }),
  } as any) as any;
}

function withOperators(t: any, ids: string) {
  const prev = process.env.PLATFORM_OPERATOR_USER_IDS;
  process.env.PLATFORM_OPERATOR_USER_IDS = ids;
  t.after(() => {
    if (prev === undefined) delete process.env.PLATFORM_OPERATOR_USER_IDS;
    else process.env.PLATFORM_OPERATOR_USER_IDS = prev;
  });
}

const TOP_UP = { amountCredits: 1_000_000, idempotencyKey: "manual-grant:test", kind: "grant" };

test("a team owner who is not an operator cannot add credits", async (t) => {
  // The hole this closes: every self-registered user owns the team they
  // create, and top-up used to be owner-only — so anyone could pay themselves.
  withOperators(t, OPERATOR);
  const topUp = t.mock.method(aiGateway, "topUp", async () => ({ applied: true, balanceCredits: 1 }));

  await assert.rejects(repoFor(OWNER).topUpCredits("team-1", TOP_UP), (e: any) => {
    assert.equal(e.statusCode ?? e.status, 403);
    assert.equal(e.code, "not_platform_operator");
    return true;
  });
  assert.equal(topUp.mock.callCount(), 0, "the gateway is never asked");
});

test("with no operators configured nobody can add credits", async (t) => {
  withOperators(t, "");
  const topUp = t.mock.method(aiGateway, "topUp", async () => ({ applied: true, balanceCredits: 1 }));
  await assert.rejects(repoFor(OPERATOR).topUpCredits("team-1", TOP_UP));
  assert.equal(topUp.mock.callCount(), 0);
});

test("an operator adds credits to a team they do not belong to", async (t) => {
  withOperators(t, OPERATOR);
  t.mock.method(console, "log", () => {});
  const topUp = t.mock.method(aiGateway, "topUp", async () => ({ applied: true, balanceCredits: 42 }));

  const res = await repoFor(OPERATOR).topUpCredits("team-1", TOP_UP);
  assert.deepEqual(res, { applied: true, balanceCredits: 42 });
  assert.deepEqual(topUp.mock.calls[0].arguments, [
    "team-1",
    { amountCredits: 1_000_000, kind: "grant", idempotencyKey: "manual-grant:test", note: null },
  ]);
});

test("an unauthenticated caller is 401, not 403", async (t) => {
  withOperators(t, OPERATOR);
  await assert.rejects(repoFor(null).topUpCredits("team-1", TOP_UP), (e: any) => {
    assert.equal(e.statusCode ?? e.status, 401);
    return true;
  });
});

test("whoami answers any signed-in caller with their id and operator status", async (t) => {
  withOperators(t, OPERATOR);
  assert.deepEqual(await repoFor(OWNER).getAdminWhoami(), { userId: OWNER, operator: false });
  assert.deepEqual(await repoFor(OPERATOR).getAdminWhoami(), { userId: OPERATOR, operator: true });
});

test("GET /v1/admin/whoami reaches the repository", async () => {
  const repo = { getAdminWhoami: async () => ({ userId: OWNER, operator: false }) };
  const res = await handleBusinessApiRequest(
    { httpMethod: "GET", path: "/v1/admin/whoami", headers: { Authorization: "Bearer caller-token" } } as any,
    { createRepository: () => repo, createAuthRepository: () => repo } as any,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { userId: OWNER, operator: false });
});

test("a partner-issued session is recognised as the operator it names", async (t) => {
  // Belayo phone logins can arrive as a JWT from the partner's own Supabase,
  // which has no GoTrue session here. GoTrue would say "no such session".
  withOperators(t, OPERATOR);
  const secret = "partner-shared-secret-with-enough-entropy";
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(OPERATOR)
    .setAudience("authenticated")
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
  const repo = createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: token,
    trustedExternalJwtSecret: secret,
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: null }, error: new Error("no GoTrue session") }) },
      from: () => { throw new Error("not reached"); },
      rpc: () => { throw new Error("not reached"); },
    }),
  } as any) as any;
  assert.deepEqual(await repo.getAdminWhoami(), { userId: OPERATOR, operator: true });
});
