import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { createSupabaseAuthRepository } from "../src/lib/supabase-repo.js";

// Route layer (wiring + bearer forwarding) for the login-time identity picker;
// the authorization itself lives in amux.list_my_identities /
// amux.mint_identity_session (services/supabase/tests/048_identity_selection.sql).
function deps(repo: any) {
  return {
    createRepository: () => { throw new Error("business repo not expected"); },
    createAuthRepository: () => repo,
  };
}

test("GET /v1/auth/identities forwards the bearer and wraps items", async () => {
  const calls: any[] = [];
  const repo = {
    listMyIdentities: async (ctx: any) => {
      calls.push(ctx);
      return [{ userId: "u1", orgId: "o1", orgName: "Own", orgLogo: null, adminType: 3, isCurrent: true }];
    },
  };
  const res = await handleBusinessApiRequest(
    { httpMethod: "GET", path: "/v1/auth/identities", headers: { authorization: "Bearer jwt-1" }, body: "" },
    deps(repo),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).items[0].orgName, "Own");
  assert.deepEqual(calls[0], { accessToken: "jwt-1" });
});

test("GET /v1/auth/identities without a bearer is 401", async () => {
  const res = await handleBusinessApiRequest(
    { httpMethod: "GET", path: "/v1/auth/identities", headers: {}, body: "" },
    deps({ listMyIdentities: async () => [] }),
  );
  assert.equal(res.statusCode, 401);
});

test("POST /v1/auth/identities/:userId/session returns the refresh token", async () => {
  const calls: any[] = [];
  const repo = {
    mintIdentitySession: async (userId: string, ctx: any) => {
      calls.push({ userId, ctx });
      return { refreshToken: "rt-2" };
    },
  };
  const res = await handleBusinessApiRequest(
    { httpMethod: "POST", path: "/v1/auth/identities/u2/session", headers: { authorization: "Bearer jwt-1" }, body: "{}" },
    deps(repo),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).refreshToken, "rt-2");
  assert.deepEqual(calls[0], { userId: "u2", ctx: { accessToken: "jwt-1" } });
});

test("auth repo maps a refused identity switch to 403", async () => {
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "anon",
    createClient: () => ({
      rpc: async () => ({ data: null, error: { code: "42501", message: "not one of your identities" } }),
    }),
  });
  await assert.rejects(
    () => repo.mintIdentitySession("someone-else", { accessToken: "jwt" }),
    (e: any) => e.statusCode === 403,
  );
});

test("auth repo maps list_my_identities rows", async () => {
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "anon",
    createClient: () => ({
      rpc: async (fn: string) => ({
        data: fn === "list_my_identities"
          ? [{ user_id: "u1", org_id: "o1", org_name: "Own", org_logo: null, admin_type: 3, is_current: true }]
          : null,
        error: null,
      }),
    }),
  });
  assert.deepEqual(await repo.listMyIdentities({ accessToken: "jwt" }), [
    { userId: "u1", orgId: "o1", orgName: "Own", orgLogo: null, adminType: 3, isCurrent: true },
  ]);
});
