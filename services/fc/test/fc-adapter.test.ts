import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { handler, normalizeFcEvent, timerEventToHttpEvent } from "../src/index.js";

function fcEvent(method: string, path: string, opts: { headers?: any; body?: any } = {}) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: opts.headers ?? {},
    body: opts.body ? JSON.stringify(opts.body) : "",
    isBase64Encoded: false,
    queryStringParameters: {},
  };
}

test("OPTIONS -> 204", async () => {
  const res: any = await handler(fcEvent("OPTIONS", "/v1/teams"), {});
  assert.equal(res.statusCode, 204);
});

test("unknown /v1 route -> 404 envelope", async () => {
  const res: any = await handler(fcEvent("GET", "/v1/nope", { headers: { authorization: "Bearer x" } }), {});
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error.code, "not_found");
});

test("Buffer event is parsed", async () => {
  const ev = Buffer.from(JSON.stringify(fcEvent("OPTIONS", "/v1/teams")));
  const res: any = await handler(ev, {});
  assert.equal(res.statusCode, 204);
});

test("string event is parsed", async () => {
  const ev = JSON.stringify(fcEvent("OPTIONS", "/v1/teams"));
  const res: any = await handler(ev, {});
  assert.equal(res.statusCode, 204);
});

// ---- normalizeFcEvent unit tests (deterministic, no env/network) ----

test("normalizeFcEvent: backfills rawQueryString from queryStringParameters when absent", () => {
  const event = {
    rawPath: "/sync/versions",
    queryStringParameters: { teamId: "t1", path: "/foo" },
  };
  normalizeFcEvent(event as any);
  const params = new URLSearchParams((event as any).rawQueryString);
  assert.equal(params.get("teamId"), "t1");
  assert.equal(params.get("path"), "/foo");
});

test("normalizeFcEvent: does NOT clobber existing rawQueryString", () => {
  const event = {
    rawPath: "/sync/versions",
    rawQueryString: "teamId=existing",
    queryStringParameters: { teamId: "other" },
  };
  normalizeFcEvent(event as any);
  assert.equal((event as any).rawQueryString, "teamId=existing");
});

test("normalizeFcEvent: leaves event unchanged when both are absent", () => {
  const event = { rawPath: "/sync/versions" };
  normalizeFcEvent(event as any);
  assert.equal((event as any).rawQueryString, undefined);
});

test("normalizeFcEvent: leaves event unchanged when queryStringParameters is empty object", () => {
  const event = { rawPath: "/sync/versions", queryStringParameters: {} };
  normalizeFcEvent(event as any);
  assert.equal((event as any).rawQueryString, undefined);
});

test("normalizeFcEvent: backfills rawQueryString from queryParameters (FC 3.0)", () => {
  const event = {
    rawPath: "/v1/sync/actor-directory",
    queryStringParameters: {},
    queryParameters: { teamId: "t1", since: "2026-05-01T00:00:00Z" },
  };
  normalizeFcEvent(event as any);
  const params = new URLSearchParams((event as any).rawQueryString);
  assert.equal(params.get("teamId"), "t1");
  assert.equal(params.get("since"), "2026-05-01T00:00:00Z");
});

test("normalizeFcEvent: prefers queryParameters when queryStringParameters is empty", () => {
  const event = {
    rawPath: "/v1/sync/actor-directory",
    queryParameters: { teamId: "fc3-team" },
  };
  normalizeFcEvent(event as any);
  assert.equal(new URLSearchParams((event as any).rawQueryString).get("teamId"), "fc3-team");
});

test("handler forwards FC 3.0 queryParameters to GET /v1/sync/actor-directory", async () => {
  const res: any = await handler(
    {
      rawPath: "/v1/sync/actor-directory",
      requestContext: { http: { method: "GET" } },
      headers: { authorization: "Bearer not-a-real-jwt" },
      queryStringParameters: {},
      queryParameters: { teamId: "fc3-handler-team" },
      body: "",
      isBase64Encoded: false,
    },
    {},
  );
  const body = JSON.parse(res.body);
  assert.notEqual(
    body?.error?.message,
    "teamId is required",
    "queryParameters were not backfilled into rawQueryString for Hono",
  );
});

test("hono/aws-lambda base64-encodes binary (png) round-trip", async () => {
  const app = new Hono();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  app.get("/f", () => new Response(png, { headers: { "Content-Type": "image/png" } }));
  const res: any = await handle(app)(
    {
      rawPath: "/f",
      requestContext: { http: { method: "GET" } },
      headers: {},
      isBase64Encoded: false,
      queryStringParameters: {},
    } as any,
    {} as any,
  );
  assert.equal(res.isBase64Encoded, true);
  assert.deepEqual(Buffer.from(res.body, "base64"), png);
});


// ---- timer triggers ---------------------------------------------------------
//
// A timer trigger invokes the function with an event, not an HTTP request. On
// belayo that difference was invisible: hono/aws-lambda routed the timer event
// to a 404 without throwing, so FC recorded a successful invocation every
// minute while the cron tick never ran once.

const timerEvent = (payload: unknown) => ({
  triggerTime: "2026-09-10T02:03:00Z",
  triggerName: "app-cron",
  payload: typeof payload === "string" ? payload : JSON.stringify(payload),
});

test("a timer payload becomes the request it names", () => {
  const ev = timerEventToHttpEvent(
    timerEvent({ path: "/v1/internal/app-cron/tick", method: "POST", body: { secret: "s" } }),
  );
  assert.equal(ev.rawPath, "/v1/internal/app-cron/tick");
  assert.equal(ev.requestContext.http.method, "POST");
  assert.equal(ev.body, JSON.stringify({ secret: "s" }));
  // v2 is the processor that reads rawPath; without requestContext.http the
  // adapter silently falls back to v1 and reads `path`, which is not set.
  assert.ok(Object.hasOwn(ev, "rawPath") && Object.hasOwn(ev.requestContext, "http"));
});

test("a query string in the payload path is split out, not left in the path", () => {
  // The v2 processor reads the two separately; a path carrying "?" would be
  // matched literally and never hit the route.
  const ev = timerEventToHttpEvent(timerEvent({ path: "/v1/x?a=1&b=2" }));
  assert.equal(ev.rawPath, "/v1/x");
  assert.equal(ev.rawQueryString, "a=1&b=2");
  assert.equal(ev.requestContext.http.method, "POST", "POST is the default for a timer");
});

test("the synthesized host matches no app, so app routing cannot swallow the tick", () => {
  const ev = timerEventToHttpEvent(timerEvent({ path: "/v1/internal/app-cron/tick" }));
  assert.equal(ev.headers.host, "localhost");
  assert.equal(ev.body, undefined, "no body means no body, not an empty JSON object");
});

test("anything that is not a timer payload is left alone", () => {
  // An HTTP event must pass through untouched...
  assert.equal(timerEventToHttpEvent(fcEvent("GET", "/v1/teams")), null);
  // ...and so must a timer whose payload names nothing routable, rather than
  // being turned into a request to "/undefined".
  assert.equal(timerEventToHttpEvent(timerEvent({ task: "oss-gc-blobs" })), null);
  assert.equal(timerEventToHttpEvent(timerEvent("not json at all")), null);
  assert.equal(timerEventToHttpEvent(timerEvent({ path: "no-leading-slash" })), null);
  assert.equal(timerEventToHttpEvent(null), null);
  assert.equal(timerEventToHttpEvent({ payload: '{"path":"/v1/x"}' }), null);
});

test("the timer reaches the tick route's auth check instead of a 404", async () => {
  // The discriminator: a 404 here means the translation did not happen, and is
  // precisely the failure that hid for a day. 401 means the request arrived at
  // the route with a body the auth kind could read.
  const before = process.env.APP_CRON_SECRET;
  process.env.APP_CRON_SECRET = "the-real-secret";
  try {
    const res: any = await handler(
      timerEvent({
        path: "/v1/internal/app-cron/tick",
        method: "POST",
        body: { secret: "not-the-real-secret" },
      }),
      {},
    );
    assert.equal(res.statusCode, 401, `expected 401, got ${res.statusCode}: ${res.body}`);
  } finally {
    if (before === undefined) delete process.env.APP_CRON_SECRET;
    else process.env.APP_CRON_SECRET = before;
  }
});
