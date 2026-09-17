import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { createSupabaseAuthRepository } from "../src/lib/supabase-repo.js";

function stubGoTrue(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const key = `${init.method} ${new URL(url).pathname}`;
    const handler = responses[key];
    if (!handler) {
      return new Response(JSON.stringify({ error: "no stub" }), { status: 500 });
    }
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

test("POST /v1/auth/signin-anonymous answers 410 and never reaches GoTrue", async () => {
  // Anonymous sign-in was removed from the product. The route survives as an
  // explicit gone so already-installed clients get a legible answer instead of
  // a 404 that reads like a routing bug.
  const stub = stubGoTrue({
    "POST /auth/v1/signup": () => new Response("{}", { status: 200 }),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/signin-anonymous",
    headers: {},
    body: "{}",
  }, authDeps(stub));
  assert.equal(res.statusCode, 410);
  assert.equal(JSON.parse(res.body).error.code, "anonymous_signin_removed");
  assert.equal(stub.calls.length, 0);
});


test("POST /v1/auth/signin-otp forwards email to /otp", async () => {
  const stub = stubGoTrue({
    "POST /auth/v1/otp": () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/signin-otp",
    headers: {},
    body: JSON.stringify({ email: "a@example.com" }),
  }, authDeps(stub));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(stub.calls[0].init.body), { email: "a@example.com" });
});

test("POST /v1/auth/signin-otp surfaces 422 invalid email", async () => {
  const stub = stubGoTrue({
    "POST /auth/v1/otp": () => new Response(
      JSON.stringify({ msg: "Invalid email", code: 422 }),
      { status: 422 },
    ),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/signin-otp",
    headers: {},
    body: JSON.stringify({ email: "not-an-email" }),
  }, authDeps(stub));
  assert.equal(res.statusCode, 422);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, "validation_failed");
});

test("POST /v1/auth/signin-otp rejects missing email and phone", async () => {
  const stub = stubGoTrue({});
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/signin-otp",
    headers: {},
    body: "{}",
  }, authDeps(stub));
  assert.equal(res.statusCode, 400);
});

test("POST /v1/auth/signin-otp rejects phone-only (moved to /v1/auth/phone/*)", async () => {
  // Phone OTP no longer goes through GoTrue native /otp (it created phone-native
  // users divergent from the partner SaaS). Phone callers must use /v1/auth/phone/send-code
  // + /v1/auth/phone/login. The route 400s without ever calling GoTrue.
  const stub = stubGoTrue({
    "POST /auth/v1/otp": () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/signin-otp",
    headers: {},
    body: JSON.stringify({ phone: "+8613800138000" }),
  }, authDeps(stub));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error.message, /phone\/send-code/);
  assert.equal(stub.calls.length, 0);
});

test("POST /v1/auth/verify-otp proxies email+token+type", async () => {
  const stub = stubGoTrue({
    "POST /auth/v1/verify": () => new Response(JSON.stringify({
      access_token: "at",
      refresh_token: "rt",
      user: { id: "u" },
    }), { status: 200 }),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/verify-otp",
    headers: {},
    body: JSON.stringify({ email: "a@example.com", token: "123456", type: "email" }),
  }, authDeps(stub));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(stub.calls[0].init.body), {
    email: "a@example.com",
    token: "123456",
    type: "email",
  });
});

test("POST /v1/auth/verify-otp proxies phone with default sms type", async () => {
  const stub = stubGoTrue({
    "POST /auth/v1/verify": () => new Response(JSON.stringify({
      access_token: "at",
      refresh_token: "rt",
      user: { id: "u" },
    }), { status: 200 }),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/verify-otp",
    headers: {},
    body: JSON.stringify({ phone: "+8613800138000", token: "123456" }),
  }, authDeps(stub));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(stub.calls[0].init.body), {
    token: "123456",
    type: "sms",
    phone: "+8613800138000",
  });
});

test("POST /v1/auth/verify-otp rejects missing email and phone", async () => {
  const stub = stubGoTrue({});
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/verify-otp",
    headers: {},
    body: JSON.stringify({ token: "123456" }),
  }, authDeps(stub));
  assert.equal(res.statusCode, 400);
});

test("POST /v1/auth/signout requires bearer and forwards to /logout", async () => {
  const stub = stubGoTrue({
    "POST /auth/v1/logout": () => new Response(null, { status: 204 }),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/signout",
    headers: { Authorization: "Bearer caller-jwt" },
    body: "{}",
  }, authDeps(stub));
  assert.equal(res.statusCode, 200);
  assert.equal(stub.calls[0].init.headers.Authorization, "Bearer caller-jwt");
});

test("POST /v1/auth/signout ends only the caller's session, not the user's other devices", async () => {
  // GoTrue's /logout defaults to scope=global, which deletes every session the
  // user has. Signing out of the desktop app used to sign the same person out
  // of iOS as well.
  const stub = stubGoTrue({
    "POST /auth/v1/logout": () => new Response(null, { status: 204 }),
  });
  await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/signout",
    headers: { Authorization: "Bearer caller-jwt" },
    body: "{}",
  }, authDeps(stub));
  assert.equal(stub.calls.length, 1);
  assert.equal(new URL(stub.calls[0].url).searchParams.get("scope"), "local");
});

test("POST /v1/auth/signout rejects without bearer", async () => {
  const stub = stubGoTrue({});
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/signout",
    headers: {},
    body: "{}",
  }, authDeps(stub));
  assert.equal(res.statusCode, 401);
});

test("PATCH /v1/auth/user forwards body to PUT /auth/v1/user with bearer", async () => {
  const stub = stubGoTrue({
    "PUT /auth/v1/user": () => new Response(JSON.stringify({
      id: "user-1",
      email: "new@example.com",
    }), { status: 200 }),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/auth/user",
    headers: { Authorization: "Bearer caller-jwt" },
    body: JSON.stringify({ email: "new@example.com" }),
  }, authDeps(stub));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).email, "new@example.com");
  assert.equal(stub.calls[0].init.headers.Authorization, "Bearer caller-jwt");
  assert.deepEqual(JSON.parse(stub.calls[0].init.body), { email: "new@example.com" });
});

test("PATCH /v1/auth/user rejects without bearer", async () => {
  const stub = stubGoTrue({});
  const res = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/auth/user",
    headers: {},
    body: "{}",
  }, authDeps(stub));
  assert.equal(res.statusCode, 401);
});
