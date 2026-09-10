import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createHonoRouterAdapter } from "../src/lib/hono-adapter.js";

function makeDeps() {
  return {
    createRepository: ({ accessToken }: { accessToken: string }) => ({ kind: "biz", accessToken }),
    createAuthRepository: () => ({ kind: "auth" }),
  };
}

test("bearer route: injects repository from token and returns json body", async () => {
  const app = new Hono();
  const router = createHonoRouterAdapter(app, makeDeps());
  router.get("/v1/ping/:id", async (ctx: any) => ({
    body: { id: ctx.params.id, repo: ctx.repository.kind, token: ctx.repository.accessToken, q: ctx.query.get("x") },
  }));
  const res = await app.request("/v1/ping/42?x=9", { headers: { authorization: "Bearer tok123" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "42", repo: "biz", token: "tok123", q: "9" });
});

test("bearer route without token -> 401 via errorResponse", async () => {
  const app = new Hono();
  const router = createHonoRouterAdapter(app, makeDeps());
  router.get("/v1/secure", async () => ({ body: { ok: true } }));
  const res = await app.request("/v1/secure");
  assert.equal(res.status, 401);
  const j = await res.json() as any;
  assert.equal(j.error.code, "missing_auth");
});

test('auth:"none" route uses auth repository, no token needed', async () => {
  const app = new Hono();
  const router = createHonoRouterAdapter(app, makeDeps());
  router.post("/v1/auth/x", { auth: "none" }, async (ctx: any) => ({
    body: { repo: ctx.repository.kind, sent: ctx.json.hello },
  }));
  const res = await app.request("/v1/auth/x", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "world" }),
  });
  assert.deepEqual(await res.json(), { repo: "auth", sent: "world" });
});

test("redirect result -> 302 Location", async () => {
  const app = new Hono();
  const router = createHonoRouterAdapter(app, makeDeps());
  router.get("/v1/go", { auth: "none" }, async () => ({ redirect: "https://example.com/cb" }));
  const res = await app.request("/v1/go");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://example.com/cb");
});

test("binary result -> bytes returned with mime", async () => {
  const app = new Hono();
  const router = createHonoRouterAdapter(app, makeDeps());
  router.get("/v1/file", { auth: "none" }, async () => ({ binary: { mime: "text/plain", bytes: Buffer.from("hi") } }));
  const res = await app.request("/v1/file");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain");
  assert.equal(await res.text(), "hi");
});

test("postRaw route: ctx.rawBody is a Buffer of the raw body", async () => {
  const app = new Hono();
  const router = createHonoRouterAdapter(app, makeDeps());
  router.postRaw("/v1/up", { auth: "none" }, async (ctx: any) => ({ body: { len: ctx.rawBody.length } }));
  const res = await app.request("/v1/up", { method: "POST", body: Buffer.from([1, 2, 3]) });
  assert.deepEqual(await res.json(), { len: 3 });
});

// --- the app-cron heartbeat -------------------------------------------------

/** The tick route takes no repository; only the secret decides admission. */
function cronApp(secret: string | undefined) {
  const prev = process.env.APP_CRON_SECRET;
  if (secret === undefined) delete process.env.APP_CRON_SECRET;
  else process.env.APP_CRON_SECRET = secret;
  const app = new Hono();
  const router = createHonoRouterAdapter(app, makeDeps() as any);
  router.post("/v1/internal/tick", { auth: "cron-tick" }, async () => ({ body: { ran: true } }));
  return { app, restore: () => { if (prev === undefined) delete process.env.APP_CRON_SECRET; else process.env.APP_CRON_SECRET = prev; } };
}

test("the heartbeat is admitted by a bearer — what the compose sidecar sends", async () => {
  const { app, restore } = cronApp("s3cret");
  try {
    const res = await app.request("/v1/internal/tick", {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ran: true });
  } finally { restore(); }
});

test("the heartbeat is admitted by a body secret — what an FC timer sends", async () => {
  // A timer payload carries only path/method/body, so there is no header to put
  // the secret in. The body is the only place left that stays out of URLs and
  // access logs.
  const { app, restore } = cronApp("s3cret");
  try {
    const res = await app.request("/v1/internal/tick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "s3cret" }),
    });
    assert.equal(res.status, 200);
  } finally { restore(); }
});

test("a wrong or missing secret is refused, in either position", async () => {
  const { app, restore } = cronApp("s3cret");
  try {
    for (const init of [
      { method: "POST" },
      { method: "POST", headers: { authorization: "Bearer nope" } },
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "nope" }) },
      { method: "POST", headers: { "content-type": "application/json" }, body: "not json" },
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: 42 }) },
    ]) {
      const res = await app.request("/v1/internal/tick", init as any);
      assert.equal(res.status, 401, `should have refused ${JSON.stringify(init)}`);
    }
  } finally { restore(); }
});

test("an UNSET secret refuses everything, including an empty one", async () => {
  // Fail-closed: a deployment that never configured a secret has no scheduler,
  // rather than a tick endpoint anyone who finds it can fire.
  const { app, restore } = cronApp(undefined);
  try {
    for (const init of [
      { method: "POST", headers: { authorization: "Bearer " } },
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "" }) },
      { method: "POST" },
    ]) {
      const res = await app.request("/v1/internal/tick", init as any);
      assert.equal(res.status, 401);
    }
  } finally { restore(); }
});

