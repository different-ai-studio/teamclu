import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { createSupabaseAuthRepository } from "../src/lib/supabase-repo.js";
import { buildWebHandoffUrl, resolveWebHandoffTarget, webHandoffHosts } from "../src/lib/web-handoff.js";

const HOSTS = new Set(["admin.climban.com", "admin.mx5.cn"]);

test("webHandoffHosts parses a trimmed, lower-cased list; unset is empty", () => {
  assert.deepEqual([...webHandoffHosts({ WEB_HANDOFF_HOSTS: " Admin.Climban.com, admin.mx5.cn ,," })], [
    "admin.climban.com",
    "admin.mx5.cn",
  ]);
  assert.equal(webHandoffHosts({}).size, 0);
});

test("resolveWebHandoffTarget keeps path + query for allowlisted https hosts", () => {
  assert.deepEqual(resolveWebHandoffTarget("https://admin.mx5.cn/services/abc?tab=1#frag", HOSTS), {
    origin: "https://admin.mx5.cn",
    redirect: "/services/abc?tab=1",
  });
  assert.deepEqual(resolveWebHandoffTarget("https://ADMIN.climban.com", HOSTS), {
    origin: "https://admin.climban.com",
    redirect: "/",
  });
});

test("resolveWebHandoffTarget refuses everything else", () => {
  for (const url of [
    "http://admin.mx5.cn/x", // plaintext
    "https://evil.example.com/x",
    "https://admin.mx5.cn.evil.com/x",
    "https://user:pw@admin.mx5.cn/x",
    "not a url",
    42,
  ]) {
    assert.equal(resolveWebHandoffTarget(url, HOSTS), null, String(url));
  }
  assert.equal(resolveWebHandoffTarget("https://admin.mx5.cn/x", new Set()), null);
});

test("resolveWebHandoffTarget never yields a protocol-relative redirect", () => {
  const t = resolveWebHandoffTarget("https://admin.mx5.cn//evil.com/x", HOSTS);
  assert.equal(t?.redirect, "/evil.com/x");
});

test("buildWebHandoffUrl targets the console's /session page with the hash in the fragment", () => {
  assert.equal(
    buildWebHandoffUrl({ origin: "https://admin.mx5.cn", redirect: "/a?b=1" }, "h/1"),
    "https://admin.mx5.cn/session?redirect=%2Fa%3Fb%3D1#token_hash=h%2F1",
  );
});

function deps(repo: any) {
  return {
    createRepository: () => {
      throw new Error("business repo not expected");
    },
    createAuthRepository: () => repo,
  };
}

async function post(body: unknown, repo: any, headers: Record<string, string> = { authorization: "Bearer jwt-1" }) {
  return handleBusinessApiRequest(
    { httpMethod: "POST", path: "/v1/auth/web-handoff", headers, body: JSON.stringify(body) },
    deps(repo),
  );
}

test("POST /v1/auth/web-handoff mints a link for an allowlisted host", async (t) => {
  const prev = process.env.WEB_HANDOFF_HOSTS;
  process.env.WEB_HANDOFF_HOSTS = "admin.mx5.cn";
  t.after(() => {
    if (prev === undefined) delete process.env.WEB_HANDOFF_HOSTS;
    else process.env.WEB_HANDOFF_HOSTS = prev;
  });
  const calls: any[] = [];
  const repo = {
    createWebHandoffToken: async (ctx: any) => {
      calls.push(ctx);
      return { tokenHash: "hash-1" };
    },
  };
  const res = await post({ url: "https://admin.mx5.cn/orders" }, repo);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).url, "https://admin.mx5.cn/session?redirect=%2Forders#token_hash=hash-1");
  assert.deepEqual(calls, [{ accessToken: "jwt-1" }]);
});

test("POST /v1/auth/web-handoff answers url:null without minting for other hosts", async (t) => {
  const prev = process.env.WEB_HANDOFF_HOSTS;
  process.env.WEB_HANDOFF_HOSTS = "admin.mx5.cn";
  t.after(() => {
    if (prev === undefined) delete process.env.WEB_HANDOFF_HOSTS;
    else process.env.WEB_HANDOFF_HOSTS = prev;
  });
  const repo = {
    createWebHandoffToken: async () => {
      throw new Error("must not mint");
    },
  };
  const res = await post({ url: "https://example.com/" }, repo);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).url, null);
});

test("POST /v1/auth/web-handoff requires a bearer and a url", async () => {
  const repo = { createWebHandoffToken: async () => ({ tokenHash: "x" }) };
  assert.equal((await post({ url: "https://admin.mx5.cn/" }, repo, {})).statusCode, 401);
  assert.equal((await post({}, repo)).statusCode, 400);
});

function authRepo(user: any, generateLink: (args: any) => any) {
  return createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "anon",
    createClient: () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }),
    createServiceRoleClient: () => ({ auth: { admin: { generateLink } } }),
  });
}

test("auth repo mints a magic link for the bearer's own email", async () => {
  const seen: any[] = [];
  const repo = authRepo({ id: "u1", email: "a@b.c" }, async (args: any) => {
    seen.push(args);
    return { data: { properties: { hashed_token: "hh" } }, error: null };
  });
  assert.deepEqual(await repo.createWebHandoffToken({ accessToken: "jwt" }), { tokenHash: "hh" });
  assert.deepEqual(seen, [{ type: "magiclink", email: "a@b.c" }]);
});

test("auth repo refuses an account with no email (409)", async () => {
  const repo = authRepo({ id: "u1", email: null }, async () => {
    throw new Error("must not mint");
  });
  await assert.rejects(() => repo.createWebHandoffToken({ accessToken: "jwt" }), (e: any) => e.statusCode === 409);
});
