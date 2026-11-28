import assert from "node:assert/strict";
import test from "node:test";
import { createLoopbackKongAdmin } from "../src/lib/app-api/kong-admin.js";

const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("Admin transport stays on Pod loopback and pages managed routes", async () => {
  const seen: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/routes?tags=teamclu-app-api")) return Response.json({ data: [{ name: "tc-app-api-first" }], next: "/routes?offset=next&tags=teamclu-app-api" });
    return Response.json({ data: [{ name: "tc-app-api-second" }], next: null });
  };
  const admin = createLoopbackKongAdmin(fetcher);
  assert.deepEqual(await admin.listManaged("routes"), ["tc-app-api-first", "tc-app-api-second"]);
  assert.deepEqual(seen, [
    "http://127.0.0.1:8001/routes?tags=teamclu-app-api",
    "http://127.0.0.1:8001/routes?offset=next&tags=teamclu-app-api",
  ]);
});

test("Admin transport rejects a pagination URL outside loopback", async () => {
  const admin = createLoopbackKongAdmin(async () => Response.json({ data: [], next: "http://evil.example/routes" }));
  await assert.rejects(() => admin.listManaged("routes"), /pagination/);
});

test("managed inventory refuses pagination that drops the management tag", async () => {
  let requests = 0;
  const admin = createLoopbackKongAdmin(async () => { requests++; return Response.json({ data: [], next: "/routes?offset=next" }); });
  await assert.rejects(() => admin.listManaged("routes"), /pagination/);
  assert.equal(requests, 1);
});

test("managed Consumer inventory uses Kong username rather than a nonexistent name field", async () => {
  const admin = createLoopbackKongAdmin(async () => Response.json({ data: [{ username: `tc-app-api-caller-${B}` }], next: null }));
  assert.deepEqual(await admin.listManaged("consumers"), [`tc-app-api-caller-${B}`]);
});

test("credential replacement deletes old credentials before storing the approved secret and never leaks it in errors", async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: init?.body?.toString() };
    calls.push(call);
    if (call.method === "GET") return Response.json({ data: [{ id: "old-id" }], next: null });
    if (call.method === "POST") return new Response("test-secret", { status: 400 });
    return Response.json({});
  };
  const admin = createLoopbackKongAdmin(fetcher);
  await assert.rejects(() => admin.replaceCallerCredential({ appId: B, username: `app-${B}`, password: "test-secret" }), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes("test-secret"));
    return true;
  });
  assert.deepEqual(calls.map(call => call.method), ["GET", "DELETE", "POST"]);
  assert.equal(calls[2].url, `http://127.0.0.1:8001/consumers/tc-app-api-caller-${B}/basic-auth`);
  assert.match(calls[2].body ?? "", /test-secret/);
});

test("route readback rejects a broader expression or changed upstream Service", async () => {
  const admin = createLoopbackKongAdmin(async () => Response.json({ name: "tc-app-api-route", expression: 'http.path ^= "/internal"', service: { name: "wrong" }, strip_path: false, preserve_host: false }));
  assert.equal(await admin.readRoute({ name: "tc-app-api-route", expression: 'http.path == "/internal/api/v1/orders"', service: { name: "expected" }, priority: 100, strip_path: false, preserve_host: false, protocols: ["http"], tags: ["teamclu-app-api"] }), false);
});

test("route write resolves the Service ID required by Kong 3.9 Admin API", async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const admin = createLoopbackKongAdmin(async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body?.toString() });
    return init?.method === "PUT" ? Response.json({}) : Response.json({ id: "service-id" });
  });
  await admin.putRoute({ name: "tc-app-api-route", service: { name: "tc-app-api-service" }, expression: 'http.path == "/internal/api/v1/orders"', priority: 100, strip_path: false, preserve_host: false, protocols: ["http"], tags: ["teamclu-app-api"] });
  assert.equal(calls[0].url, "http://127.0.0.1:8001/services/tc-app-api-service");
  assert.deepEqual(JSON.parse(calls[1].body ?? "{}"), {
    name: "tc-app-api-route", service: { id: "service-id" }, expression: 'http.path == "/internal/api/v1/orders"', priority: 100, strip_path: false, preserve_host: false, protocols: ["http"], tags: ["teamclu-app-api"],
  });
});
