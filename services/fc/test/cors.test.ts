import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { isAllowedCorsOrigin, parseCorsOrigins, resolveCorsAllowOrigin } from "../src/lib/cors-origin.js";

// The origin callback used to return the request origin on both branches, so
// the allowlist never refused anything. These tests pin the policy: known
// client origins are echoed, everything else gets no
// Access-Control-Allow-Origin at all, and requests without Origin still work.

describe("isAllowedCorsOrigin", () => {
  const allowed = [
    "tauri://localhost",
    "https://tauri.localhost",
    "http://tauri.localhost",
    "http://localhost",
    "http://localhost:1420",
    "http://127.0.0.1:5173",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  ];
  for (const o of allowed) {
    test(`allows ${o}`, () => assert.equal(isAllowedCorsOrigin(o), true));
  }

  const refused = [
    "",
    "null",
    "https://evil.example",
    "https://tauri.localhost.evil.example",
    "http://localhost.evil.example",
    "https://localhost", // only plain-http dev servers are implied
    "tauri://evil",
    "http://127.0.0.1.nip.io",
    "http://localhost/path",
    "not a url",
  ];
  for (const o of refused) {
    test(`refuses ${JSON.stringify(o)}`, () => assert.equal(isAllowedCorsOrigin(o), false));
  }

  test("CORS_ORIGINS entries match exactly", () => {
    const extra = parseCorsOrigins(" https://app.example.com, https://staging.example.com ,, ");
    assert.deepEqual(extra, ["https://app.example.com", "https://staging.example.com"]);
    assert.equal(isAllowedCorsOrigin("https://app.example.com", extra), true);
    assert.equal(isAllowedCorsOrigin("https://app.example.com.evil", extra), false);
    assert.equal(isAllowedCorsOrigin("https://other.example.com", extra), false);
  });

  test("resolveCorsAllowOrigin echoes or returns null", () => {
    assert.equal(resolveCorsAllowOrigin("tauri://localhost"), "tauri://localhost");
    assert.equal(resolveCorsAllowOrigin("https://evil.example"), null);
    assert.equal(resolveCorsAllowOrigin(""), null);
  });
});

describe("app CORS headers", () => {
  const app = createApp({
    createRepository: () => ({}),
    createAuthRepository: () => ({}),
  } as any);
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    if (saved === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = saved;
  });

  test("allowed origin is echoed", async () => {
    const res = await app.request("/healthz", { headers: { origin: "tauri://localhost" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "tauri://localhost");
  });

  test("unknown origin gets no allow-origin header", async () => {
    const res = await app.request("/healthz", { headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  test("no Origin header still succeeds without CORS headers", async () => {
    const res = await app.request("/healthz");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  test("preflight from an unknown origin is 204 without allow-origin", async () => {
    const res = await app.request("/v1/teams", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  test("preflight from the extension carries the allow headers", async () => {
    const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const res = await app.request("/v1/teams", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /Authorization/);
  });

  test("CORS_ORIGINS adds a browser-hosted origin at request time", async () => {
    process.env.CORS_ORIGINS = "https://web.example.com";
    const res = await app.request("/healthz", { headers: { origin: "https://web.example.com" } });
    assert.equal(res.headers.get("access-control-allow-origin"), "https://web.example.com");
  });
});
