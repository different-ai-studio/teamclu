import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

// The container's liveness/readiness probe. Deliberately touches no database:
// compose gates `caddy` and the deploy's health wait on this, so making it
// depend on Postgres would turn a slow database into a failed deploy.
test("GET /healthz returns 200 ok:true", async () => {
  const app = createApp({
    createRepository: () => ({}),
    createAuthRepository: () => ({}),
  } as any);
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
