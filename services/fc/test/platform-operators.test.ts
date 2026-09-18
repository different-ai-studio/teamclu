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

// ── AI gateway provider pools ───────────────────────────────────────────────

const POOLS = {
  providers: [
    {
      providerId: "deepseek",
      keys: [{ id: "1a2b3c4d", hint: "…aaaa", position: 0, ok: 3, failed: 1, lastUsedAt: null, cooldowns: [] }],
    },
  ],
};

test("a team owner who is not an operator cannot see the provider keys", async (t) => {
  withOperators(t, OPERATOR);
  const pools = t.mock.method(aiGateway, "providerPools", async () => POOLS);
  await assert.rejects(repoFor(OWNER).getProviderPools(), (e: any) => e.statusCode === 403);
  assert.equal(pools.mock.callCount(), 0);
});

test("an operator gets the gateway's pool snapshot as the gateway reports it", async (t) => {
  withOperators(t, OPERATOR);
  t.mock.method(aiGateway, "providerPools", async () => POOLS);
  assert.deepEqual(await repoFor(OPERATOR).getProviderPools(), POOLS);
});

test("a non-operator cannot reset a pool", async (t) => {
  withOperators(t, OPERATOR);
  const reset = t.mock.method(aiGateway, "resetProviderPool", async () => ({ cleared: 1 }));
  await assert.rejects(repoFor(OWNER).resetProviderPool("deepseek", {}), (e: any) => e.statusCode === 403);
  assert.equal(reset.mock.callCount(), 0);
});

test("an operator resets one key or the whole provider", async (t) => {
  withOperators(t, OPERATOR);
  t.mock.method(console, "log", () => {});
  const reset = t.mock.method(aiGateway, "resetProviderPool", async () => ({ cleared: 2 }));

  assert.deepEqual(await repoFor(OPERATOR).resetProviderPool("deepseek", { keyId: "1a2b3c4d" }), { cleared: 2 });
  await repoFor(OPERATOR).resetProviderPool("deepseek", {});
  assert.deepEqual(reset.mock.calls.map((c) => c.arguments), [["deepseek", "1a2b3c4d"], ["deepseek", undefined]]);
});

test("a malformed provider or key id is refused before the gateway is asked", async (t) => {
  withOperators(t, OPERATOR);
  const reset = t.mock.method(aiGateway, "resetProviderPool", async () => ({ cleared: 0 }));
  for (const [providerId, input] of [
    ["deep%2Fseek", {}],
    ["", {}],
    ["deepseek", { keyId: "sk-live-whole-key" }],
    ["deepseek", { keyId: 42 }],
  ] as const) {
    await assert.rejects(repoFor(OPERATOR).resetProviderPool(providerId, input), (e: any) => {
      assert.equal(e.statusCode, 400, `${providerId} ${JSON.stringify(input)}`);
      return true;
    });
  }
  assert.equal(reset.mock.callCount(), 0);
});

test("the provider pool routes reach their repository methods", async () => {
  const calls: unknown[][] = [];
  const repo = {
    getProviderPools: async (...args: unknown[]) => { calls.push(["getProviderPools", ...args]); return POOLS; },
    resetProviderPool: async (...args: unknown[]) => { calls.push(["resetProviderPool", ...args]); return { cleared: 1 }; },
  };
  const deps = { createRepository: () => repo, createAuthRepository: () => repo } as any;
  const headers = { Authorization: "Bearer caller-token" };

  const list = await handleBusinessApiRequest({ httpMethod: "GET", path: "/v1/admin/ai/provider-pools", headers } as any, deps);
  assert.equal(list.statusCode, 200);
  assert.deepEqual(JSON.parse(list.body), POOLS);

  const reset = await handleBusinessApiRequest(
    {
      httpMethod: "POST",
      path: "/v1/admin/ai/provider-pools/deepseek/reset",
      headers,
      body: JSON.stringify({ keyId: "1a2b3c4d" }),
    } as any,
    deps,
  );
  assert.equal(reset.statusCode, 200);
  assert.deepEqual(calls, [["getProviderPools"], ["resetProviderPool", "deepseek", { keyId: "1a2b3c4d" }]]);
});

test("the gateway client calls the internal pool endpoints with the service token", async (t) => {
  const prev = { url: process.env.AI_GATEWAY_INTERNAL_URL, token: process.env.AI_GATEWAY_SERVICE_TOKEN };
  process.env.AI_GATEWAY_INTERNAL_URL = "http://gw:4001/";
  process.env.AI_GATEWAY_SERVICE_TOKEN = "svc";
  t.after(() => {
    for (const [k, v] of [["AI_GATEWAY_INTERNAL_URL", prev.url], ["AI_GATEWAY_SERVICE_TOKEN", prev.token]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const seen: { url: string; method: string; auth: string; body: unknown }[] = [];
  let reply = new Response(JSON.stringify(POOLS), { status: 200 });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    seen.push({
      url: String(url),
      method: init.method ?? "GET",
      auth: (init.headers as Record<string, string>).Authorization,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return reply;
  });

  assert.deepEqual(await aiGateway.providerPools(), POOLS);
  reply = new Response(JSON.stringify({ cleared: 1 }), { status: 200 });
  await aiGateway.resetProviderPool("deepseek", "1a2b3c4d");
  assert.deepEqual(seen, [
    { url: "http://gw:4001/internal/provider-pools", method: "GET", auth: "Bearer svc", body: undefined },
    { url: "http://gw:4001/internal/provider-pools/deepseek/reset", method: "POST", auth: "Bearer svc", body: { keyId: "1a2b3c4d" } },
  ]);

  // The gateway's own 404 for an unknown provider reaches the caller as a 404.
  reply = new Response(JSON.stringify({ error: { code: "not_found", message: 'unknown provider "nope"' } }), { status: 404 });
  await assert.rejects(aiGateway.resetProviderPool("nope"), (e: any) => e.statusCode === 404 && e.code === "not_found");
});
