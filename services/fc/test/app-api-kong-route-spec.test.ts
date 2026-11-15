import assert from "node:assert/strict";
import test from "node:test";
import { compileKongRoute, type ApprovedRoute } from "../src/lib/app-api/kong-route-spec.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function approved(overrides: Partial<ApprovedRoute> = {}): ApprovedRoute {
  return {
    targetAppId: A,
    gatewayHost: `app-${A}.apps-internal.teamclu.example`,
    upstreamOrigin: "http://app-a.fc-internal.example:80",
    method: "GET",
    path: "/internal/api/v1/orders",
    callerAppIds: [B],
    keyId: "app-a-v1",
    privateKeyPath: "/run/secrets/app-jwt/app-a-v1.pem",
    ...overrides,
  };
}

test("compiled Route matches only the approved target Host, method and literal path", () => {
  const spec = compileKongRoute(approved());
  assert.equal(spec.route.expression, `http.host == "app-${A}.apps-internal.teamclu.example" && http.method == "GET" && http.path == "/internal/api/v1/orders"`);
  assert.equal(spec.route.strip_path, false);
  assert.equal(spec.route.preserve_host, false);
  assert.deepEqual(spec.route.protocols, ["http"]);
  assert.equal(spec.service.url, "http://app-a.fc-internal.example");
  assert.deepEqual(spec.plugins.map(plugin => plugin.name), ["basic-auth", "acl", "kong-upstream-jwt", "request-transformer"]);
  assert.deepEqual(spec.plugins[0].config, { hide_credentials: true });
  assert.deepEqual(spec.plugins[1].config, { allow: [`app-${B}`], hide_groups_header: true });
  assert.equal(spec.plugins[2].config.target_app_id, A);
  assert.equal(spec.plugins[2].config.private_key_location, "/run/secrets/app-jwt/app-a-v1.pem");
  assert.ok(!JSON.stringify(spec).includes("password"));
});

test("same endpoint has a stable name; a different method or target has a different name", () => {
  const first = compileKongRoute(approved());
  assert.equal(compileKongRoute(approved({ callerAppIds: [B, C] })).route.name, first.route.name);
  assert.notEqual(compileKongRoute(approved({ method: "POST" })).route.name, first.route.name);
  assert.notEqual(compileKongRoute(approved({ targetAppId: C })).route.name, first.route.name);
});

test("rejects route broadening, arbitrary upstreams and an empty allow list", () => {
  for (const path of ["/internal/api/v1/orders/{id}", "/internal/api/v1/orders*", "/internal/api/v1/orders?x=1", "/internal/api/v1/../admin", "/internal/api/v1//orders", "/public"]) {
    assert.throws(() => compileKongRoute(approved({ path })), /path/);
  }
  assert.throws(() => compileKongRoute(approved({ callerAppIds: [] })), /caller/);
  assert.throws(() => compileKongRoute(approved({ upstreamOrigin: "http://app-a.fc-internal.example/public" })), /upstream/);
  assert.throws(() => compileKongRoute(approved({ upstreamOrigin: "http://user:password@app-a.fc-internal.example" })), /upstream/);
  assert.throws(() => compileKongRoute(approved({ gatewayHost: "*" })), /Host/);
});
