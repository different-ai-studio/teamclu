import { test } from "node:test";
import assert from "node:assert/strict";
import { appPublicUrl, parseAppPublicHost } from "../src/lib/apps-public-host.js";

const CODE = "k7m2q9vx4n8p";
const ID = "18e4ecad-6189-495b-a873-7fe09179a5f5";
const env = { APPS_PUBLIC_DOMAIN: "apps.example.com" };

test("Chinese names do not affect code hosts", () => {
  assert.equal(appPublicUrl("门店大盘", "18e4ecad-6189-495b-a873-7fe09179a5f5",
    { APPS_PUBLIC_DOMAIN: "apps.example.com" }, "k7m2q9vx4n8p"),
    "https://a-k7m2q9vx4n8p.apps.example.com");
  for (const slug of ["renamed", "", "验".repeat(100), null, undefined]) {
    assert.equal(appPublicUrl(slug, ID, env, CODE), "https://a-k7m2q9vx4n8p.apps.example.com");
  }
});

test("code URLs require a configured domain and an exact valid code", () => {
  for (const code of ["", "short", "k7m2q9vx4n8p0", "k7m2q9vx4n8_", "k7m2q9vx4n8i", "k7m2q9vx4n8l", "k7m2q9vx4n8o", "k7m2q9vx4n8u", "k7m2q9vx4n8.", "K7M2Q9VX4N8P"]) {
    assert.equal(appPublicUrl("shop", ID, env, code), null, code);
  }
  for (const config of [{}, { APPS_PUBLIC_DOMAIN: "  " }]) {
    assert.equal(appPublicUrl("shop", ID, config, CODE), null);
    assert.equal(parseAppPublicHost("a-k7m2q9vx4n8p.apps.example.com", config), null);
  }
});

test("code host parsing normalizes case and port and rejects malformed hosts", () => {
  assert.deepEqual(parseAppPublicHost(" A-K7M2Q9VX4N8P.APPS.EXAMPLE.COM:443 ", env), { appCode: CODE });
  for (const host of ["a-short.apps.example.com", "a-k7m2q9vx4n8p0.apps.example.com", "a-k7m2q9vx4n8i.apps.example.com", "a-k7m2q9vx4n8_.apps.example.com", "x.a-k7m2q9vx4n8p.apps.example.com", "a-k7m2q9vx4n8p.apps.example.com.evil.org", "a-k7m2q9vx4n8p.other.example.com", "a-k7m2q9vx4n8papps.example.com"]) {
    assert.equal(parseAppPublicHost(host, env), null, host);
  }
});

test("legacy URL calls and ASCII and punycode routing remain compatible", () => {
  assert.equal(appPublicUrl("shop", ID, env), "https://shop-18e4ecad.apps.example.com");
  assert.equal(appPublicUrl("shop", ID, env, null), "https://shop-18e4ecad.apps.example.com");
  assert.deepEqual(parseAppPublicHost("SHOP-18E4ECAD.apps.example.com:443", env), { slug: "shop", idPrefix: "18e4ecad" });
  assert.deepEqual(parseAppPublicHost("xn--teamclu--18e4ecad-nx65apz36b.apps.example.com", env), { slug: "teamclu-官网", idPrefix: "18e4ecad" });
});
