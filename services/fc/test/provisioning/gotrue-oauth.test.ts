import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeGotrueOAuthClient,
  readGotrueOAuthConfig,
  oauthUnavailable,
} from "../../src/lib/provisioning/gotrue-oauth.js";

test("readGotrueOAuthConfig names missing SUPABASE_URL", () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.GOTRUE_URL;
  delete process.env.FC_SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  try {
    assert.deepEqual(readGotrueOAuthConfig(), { error: "SUPABASE_URL is empty" });
  } finally {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test("createOAuthClient posts to GoTrue admin API", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = makeGotrueOAuthClient({
    authUrl: "https://auth.example/auth/v1",
    serviceRoleKey: "service-key",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          client_id: "cid-abc",
          client_secret: "sec-xyz",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  const out = await client.createOAuthClient({
    name: "My App",
    redirectUris: ["https://demo-abc12345.apps.example/auth/callback"],
  });
  assert.equal(out.clientId, "cid-abc");
  assert.equal(out.clientSecret, "sec-xyz");
  assert.equal(out.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://auth.example/auth/v1/admin/oauth/clients");
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.client_name, "My App");
  assert.equal(body.client_type, "confidential");
  assert.deepEqual(body.redirect_uris, ["https://demo-abc12345.apps.example/auth/callback"]);
});

test("updateOAuthClient PUTs redirect_uris", async () => {
  const calls: string[] = [];
  const client = makeGotrueOAuthClient({
    authUrl: "https://auth.example/auth/v1",
    serviceRoleKey: "service-key",
    fetch: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return new Response("{}", { status: 200 });
    },
  });
  await client.updateOAuthClient("cid-abc", {
    redirectUris: ["https://demo-abc12345.apps.example/auth/callback"],
  });
  assert.deepEqual(calls, [
    "PUT https://auth.example/auth/v1/admin/oauth/clients/cid-abc",
  ]);
});

test("disableOAuthClient DELETEs registration", async () => {
  const calls: string[] = [];
  const client = makeGotrueOAuthClient({
    authUrl: "https://auth.example/auth/v1",
    serviceRoleKey: "service-key",
    fetch: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return new Response(null, { status: 204 });
    },
  });
  await client.disableOAuthClient("cid-abc");
  assert.deepEqual(calls, [
    "DELETE https://auth.example/auth/v1/admin/oauth/clients/cid-abc",
  ]);
});

test("oauthUnavailable includes the missing config name", () => {
  const err = oauthUnavailable("SUPABASE_SERVICE_ROLE_KEY is empty");
  assert.equal(err.code, "oauth_unavailable");
  assert.match(err.message, /SUPABASE_SERVICE_ROLE_KEY/);
});
