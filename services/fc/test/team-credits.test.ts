import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { createSupabaseBusinessRepository } from "../src/lib/supabase-repo.js";

/**
 * Every credits and quota endpoint answered `ctx.repository.<method> is not a
 * function` in production: `routes/team-credits.ts` called eight repository
 * methods that no repository implemented. They had been written next to the
 * LiteLLM block and were deleted along with it, and nothing noticed — this
 * directory had no test that touched credits at all.
 *
 * The first test here is the general guard, not a list of the eight: it reads
 * the route file and requires the repository to implement whatever that file
 * calls. A method deleted out from under a route fails here rather than in
 * someone's billing screen.
 */

const ROUTE_SRC = new URL("../src/lib/routes/team-credits.ts", import.meta.url);

function repositoryMethodsCalledByRoutes(): string[] {
  const src = readFileSync(ROUTE_SRC, "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/ctx\.repository\.([A-Za-z0-9_]+)\s*\(/g)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

/** The real repository, wired to a client that is never actually reached —
 *  method identity is the contract under test, not query behaviour. */
function realRepository() {
  return createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
      from: () => { throw new Error("not reached"); },
      rpc: () => { throw new Error("not reached"); },
    }),
  } as any);
}

test("every repository method the credits routes call actually exists", () => {
  const called = repositoryMethodsCalledByRoutes();
  const repo = realRepository() as Record<string, unknown>;

  assert.ok(called.length >= 8, `expected the route file to call methods, found ${called.length}`);

  const missing = called.filter((name) => typeof repo[name] !== "function");
  assert.deepEqual(
    missing,
    [],
    `routes/team-credits.ts calls ${missing.join(", ")}, which the repository does not implement`,
  );
});

test("the eight credits and quota methods are on the repository by name", () => {
  const repo = realRepository() as Record<string, unknown>;
  for (const name of [
    "getTeamCredits",
    "getCreditUsage",
    "getCreditLedger",
    "topUpCredits",
    "listCreditPackages",
    "createCreditCheckoutSession",
    "getMemberQuotas",
    "setMemberQuotas",
  ]) {
    assert.equal(typeof repo[name], "function", `${name} must be implemented`);
  }
});

// ── route wiring ────────────────────────────────────────────────────────────

function makeRepo(overrides: Record<string, any> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    const fn = overrides[method];
    return typeof fn === "function" ? fn(...args) : {};
  };
  return {
    calls,
    getTeamCredits: record("getTeamCredits"),
    getCreditUsage: record("getCreditUsage"),
    getCreditLedger: record("getCreditLedger"),
    topUpCredits: record("topUpCredits"),
    listCreditPackages: record("listCreditPackages"),
    createCreditCheckoutSession: record("createCreditCheckoutSession"),
    getMemberQuotas: record("getMemberQuotas"),
    setMemberQuotas: record("setMemberQuotas"),
  };
}

async function request(
  repo: any,
  { method, path, body, query = {} }: { method: string; path: string; body?: any; query?: any },
) {
  return handleBusinessApiRequest(
    {
      httpMethod: method,
      path,
      headers: { Authorization: "Bearer caller-token" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      queryStringParameters: query,
    } as any,
    { createRepository: () => repo, createAuthRepository: () => repo } as any,
  );
}

test("GET /v1/teams/:id/credits/usage forwards range and date", async () => {
  const repo = makeRepo({ getCreditUsage: () => ({ range: "month", byActor: [] }) });
  const res = await request(repo, {
    method: "GET",
    path: "/v1/teams/team-1/credits/usage",
    query: { range: "week", date: "2026-09-01" },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).range, "month");
  assert.deepEqual(repo.calls[0], {
    method: "getCreditUsage",
    args: ["team-1", { range: "week", date: "2026-09-01" }],
  });
});

test("GET /v1/teams/:id/credits/usage defaults to the month, with no date", async () => {
  const repo = makeRepo();
  await request(repo, { method: "GET", path: "/v1/teams/team-1/credits/usage" });

  assert.deepEqual(repo.calls[0].args, ["team-1", { range: "month", date: undefined }]);
});

test("the remaining credits and quota routes reach their repository method", async () => {
  const cases: Array<{ method: string; path: string; body?: any; expect: string }> = [
    { method: "GET", path: "/v1/teams/team-1/credits", expect: "getTeamCredits" },
    { method: "GET", path: "/v1/teams/team-1/credits/ledger", expect: "getCreditLedger" },
    { method: "GET", path: "/v1/teams/team-1/credits/packages", expect: "listCreditPackages" },
    {
      method: "POST",
      path: "/v1/teams/team-1/credits/top-up",
      body: { amountCredits: 10, idempotencyKey: "k1" },
      expect: "topUpCredits",
    },
    {
      method: "POST",
      path: "/v1/teams/team-1/credits/checkout-session",
      body: { priceId: "price_1" },
      expect: "createCreditCheckoutSession",
    },
    { method: "GET", path: "/v1/teams/team-1/quotas", expect: "getMemberQuotas" },
    { method: "PUT", path: "/v1/teams/team-1/quotas", body: {}, expect: "setMemberQuotas" },
  ];

  for (const c of cases) {
    const repo = makeRepo();
    const res = await request(repo, c);
    assert.equal(res.statusCode, 200, `${c.method} ${c.path} -> ${res.statusCode}: ${res.body}`);
    assert.equal(repo.calls[0]?.method, c.expect, `${c.method} ${c.path}`);
    assert.equal(repo.calls[0]?.args[0], "team-1");
  }
});

test("GET /v1/teams/:id/credits/ledger forwards an explicit limit", async () => {
  const repo = makeRepo();
  await request(repo, {
    method: "GET",
    path: "/v1/teams/team-1/credits/ledger",
    query: { limit: "5" },
  });

  assert.deepEqual(repo.calls[0].args, ["team-1", { limit: 5 }]);
});
