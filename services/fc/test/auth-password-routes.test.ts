import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { createSupabaseAuthRepository } from "../src/lib/supabase-repo.js";

function stubGoTrue(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const key = `${init.method} ${new URL(url).pathname}${new URL(url).search}`;
    const handler = responses[key] ?? responses[`${init.method} ${new URL(url).pathname}`];
    if (!handler) return new Response(JSON.stringify({ error: "no stub" }), { status: 500 });
    return handler(init);
  };
  return { fetchImpl, calls };
}

function authDeps(stub) {
  const auth = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "anon-key",
    fetchImpl: stub.fetchImpl,
    createClient: () => ({ rpc: async () => ({ data: null, error: null }) }),
  });
  return {
    createRepository: () => { throw new Error("business repo not expected"); },
    createAuthRepository: () => auth,
  };
}

test("POST /v1/auth/signin-password proxies to GoTrue password grant", async () => {
  const stub = stubGoTrue({
    "POST /auth/v1/token?grant_type=password": () => new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", expires_in: 3600,
      token_type: "bearer", user: { id: "u1", email: "a@b.com", is_anonymous: false },
    }), { status: 200 }),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/auth/signin-password", headers: {},
    body: JSON.stringify({ email: "a@b.com", password: "pw" }),
  }, authDeps(stub));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.access_token, "at");
  assert.equal(body.user.email, "a@b.com");
  assert.deepEqual(JSON.parse(stub.calls[0].init.body), { email: "a@b.com", password: "pw" });
});

test("POST /v1/auth/signup proxies to GoTrue /signup", async () => {
  const stub = stubGoTrue({
    "POST /auth/v1/signup": () => new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", expires_in: 3600,
      user: { id: "u1", email: "a@b.com", is_anonymous: false, identities: [{ id: "i1" }] },
    }), { status: 200 }),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/auth/signup", headers: {},
    body: JSON.stringify({ email: "a@b.com", password: "pw" }),
  }, authDeps(stub));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(stub.calls[0].init.body), { email: "a@b.com", password: "pw" });
});

test("POST /v1/auth/signin-password maps wrong credentials to invalid_credentials, not upstream_unavailable", async () => {
  const stub = stubGoTrue({
    "POST /auth/v1/token?grant_type=password": () => new Response(JSON.stringify({
      code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials",
    }), { status: 400 }),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/auth/signin-password", headers: {},
    body: JSON.stringify({ email: "a@b.com", password: "wrong" }),
  }, authDeps(stub));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, "invalid_credentials");
});

test("GoTrue 5xx still maps to upstream_unavailable", async () => {
  const stub = stubGoTrue({
    "POST /auth/v1/token?grant_type=password": () => new Response("bad gateway", { status: 502 }),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/auth/signin-password", headers: {},
    body: JSON.stringify({ email: "a@b.com", password: "pw" }),
  }, authDeps(stub));
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error.code, "upstream_unavailable");
});
