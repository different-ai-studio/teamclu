import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

function makeDeps() {
  return {
    createRepository: () => ({}),
    createAuthRepository: () => ({}),
  };
}

// The per-IP limiter allows 10 req/min. /v1/sync/* is the JWT-authenticated
// OSS-sync data plane where one tick issues several requests and team members
// often share a NAT IP — it must NOT be rate limited (a 429 here failed whole
// sync ticks in the field). Unauthenticated admin paths stay covered.

test("/v1/sync/* is exempt from the per-IP rate limit", async () => {
  const app = createApp(makeDeps());
  for (let i = 0; i < 25; i++) {
    const res = await app.request("/v1/sync/manifest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.10",
      },
      body: "{}",
    });
    // Missing teamId → 400 from the sync handler; the point is it reaches the
    // handler instead of being cut off with 429.
    assert.equal(res.status, 400, `request ${i + 1} should not be rate limited`);
  }
});

test("non-exempt paths still rate limit after 10 req/min per IP", async () => {
  const app = createApp(makeDeps());
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) {
    const res = await app.request("/no-such-admin-path", {
      headers: { "x-forwarded-for": "203.0.113.11" },
    });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404));
  assert.deepEqual(statuses.slice(10), [429, 429]);
  const body = await (await app.request("/no-such-admin-path", {
    headers: { "x-forwarded-for": "203.0.113.11" },
  })).json();
  assert.deepEqual(body, { error: "Too many requests" });
});
