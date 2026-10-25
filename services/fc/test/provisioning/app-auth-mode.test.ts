import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlatformAuthEnv } from "../../src/lib/provisioning/app-auth-mode.js";

test("platform-auth environment uses the code address", () => {
  const previous = process.env.AUTH_BASE_URL;
  process.env.AUTH_BASE_URL = "https://api.example.com";
  try {
    assert.equal(buildPlatformAuthEnv({ appId: "18e4ecad-6189-495b-a873-7fe09179a5f5", slug: "门店大盘", appCode: "k7m2q9vx4n8p", usesAppCodeDomain: true }, { APPS_PUBLIC_DOMAIN: "apps.example.com" }).APP_PUBLIC_URL,
      "https://a-k7m2q9vx4n8p.apps.example.com");
  } finally {
    if (previous === undefined) delete process.env.AUTH_BASE_URL;
    else process.env.AUTH_BASE_URL = previous;
  }
});


test("platform-auth env requires explicit code mode and preserves other env semantics", () => {
  const previous = process.env.AUTH_BASE_URL;
  process.env.AUTH_BASE_URL = "https://api.example.com";
  try { for (const mode of [undefined, false, true]) {
    const env = buildPlatformAuthEnv({ appId: "18e4ecad-6189-495b-a873-7fe09179a5f5", slug: "shop", appCode: "k7m2q9vx4n8p", usesAppCodeDomain: mode }, { APPS_PUBLIC_DOMAIN: "apps.example.com", SUPABASE_PUBLIC_URL: "https://db.example.com/", SUPABASE_ANON_KEY: "anon" });
    assert.equal(env.APP_PUBLIC_URL, mode === true ? "https://a-k7m2q9vx4n8p.apps.example.com" : "https://shop-18e4ecad.apps.example.com");
    assert.equal(env.SUPABASE_URL, "https://db.example.com");
    assert.equal(env.SUPABASE_ANON_KEY, "anon");
  } } finally {
    if (previous === undefined) delete process.env.AUTH_BASE_URL;
    else process.env.AUTH_BASE_URL = previous;
  }
});
