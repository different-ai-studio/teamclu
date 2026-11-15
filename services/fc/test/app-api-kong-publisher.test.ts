import assert from "node:assert/strict";
import test from "node:test";
import { publishApprovedKongSnapshot, type ApprovedKongSnapshot, type KongPublicationAdmin } from "../src/lib/app-api/kong-publisher.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function snapshot(routes = 1): ApprovedKongSnapshot {
  return {
    generation: 7,
    callers: routes ? [{ appId: B, username: `app-${B}`, password: "test-secret" }] : [],
    routes: routes ? [{
      targetAppId: A,
      gatewayHost: `app-${A}.apps-internal.example`,
      upstreamOrigin: "https://fc-a.internal.example",
      method: "GET",
      path: "/internal/api/v1/orders",
      callerAppIds: [B],
      keyId: "a-v1",
      privateKeyPath: "/run/secrets/app-jwt/a-v1.pem",
    }] : [],
  };
}

function admin(events: string[], existingRoutes = ["tc-app-api-old"], existingServices: string[] = [], existingConsumers: string[] = []): KongPublicationAdmin {
  return {
    listManaged: async kind => kind === "routes" ? existingRoutes : kind === "services" ? existingServices : existingConsumers,
    deleteRoute: async name => { events.push(`delete-route:${name}`); },
    putService: async spec => { events.push(`put-service:${spec.name}`); },
    replaceServicePlugins: async (name, plugins) => { events.push(`plugins:${name}:${plugins.length}`); },
    putConsumer: async consumer => { events.push(`consumer:${consumer.appId}`); },
    replaceCallerCredential: async caller => { events.push(`credential:${caller.appId}`); },
    replaceCallerGroups: async (appId, groups) => { events.push(`groups:${appId}:${groups.join(",")}`); },
    putRoute: async spec => { events.push(`put-route:${spec.name}`); },
    deleteService: async name => { events.push(`delete-service:${name}`); },
    deleteConsumer: async name => { events.push(`delete-consumer:${name}`); },
    readRoute: async spec => { events.push(`read-route:${spec.name}`); return true; },
  };
}

test("publication removes old routes before any credential or plugin update, and creates routes last", async () => {
  const events: string[] = [];
  const result = await publishApprovedKongSnapshot(snapshot(), admin(events), {
    withExclusivePublication: async (_generation, run) => run(async () => { events.push("fence"); }),
  });
  assert.equal(result.generation, 7);
  assert.equal(result.routeNames.length, 1);
  assert.equal(events[0], "fence");
  assert.ok(events.indexOf("delete-route:tc-app-api-old") < events.findIndex(x => x.startsWith("put-service:")));
  assert.ok(events.findIndex(x => x.startsWith("put-route:")) > events.findIndex(x => x.startsWith("plugins:")));
  assert.ok(events.findIndex(x => x.startsWith("put-route:")) > events.findIndex(x => x.startsWith("credential:")));
  assert.ok(events.at(-1)?.startsWith("read-route:"));
});

test("revocation removes persisted managed routes and leaves no desired route", async () => {
  const events: string[] = [];
  const result = await publishApprovedKongSnapshot(snapshot(0), admin(events, ["tc-app-api-old"], ["tc-app-api-old"], [`tc-app-api-caller-${B}`]), {
    withExclusivePublication: async (_generation, run) => run(async () => {}),
  });
  assert.deepEqual(result.routeNames, []);
  assert.deepEqual(events, ["delete-route:tc-app-api-old", "delete-service:tc-app-api-old", `delete-consumer:tc-app-api-caller-${B}`]);
});

test("a failed plugin write leaves the route absent", async () => {
  const events: string[] = [];
  const gateway = admin(events);
  gateway.replaceServicePlugins = async () => { throw new Error("plugin failed"); };
  await assert.rejects(() => publishApprovedKongSnapshot(snapshot(), gateway, {
    withExclusivePublication: async (_generation, run) => run(async () => {}),
  }), /plugin failed/);
  assert.deepEqual(events.filter(x => x.startsWith("put-route:")), []);
  assert.ok(events.includes("delete-route:tc-app-api-old"));
});

test("stale generation aborts before creating a route", async () => {
  const events: string[] = [];
  let checks = 0;
  await assert.rejects(() => publishApprovedKongSnapshot(snapshot(), admin(events), {
    withExclusivePublication: async (_generation, run) => run(async () => {
      checks++;
      if (checks >= 3) throw new Error("stale generation");
    }),
  }), /stale generation/);
  assert.ok(!events.some(x => x.startsWith("put-route:")));
});

test("route references without provisioned caller credentials fail before any Kong mutation", async () => {
  const events: string[] = [];
  const input = snapshot();
  input.callers = [];
  await assert.rejects(() => publishApprovedKongSnapshot(input, admin(events), {
    withExclusivePublication: async (_generation, run) => run(async () => {}),
  }), /caller/);
  assert.deepEqual(events, []);
});

test("a provisioned but ungranted caller can authenticate and receive ACL denial", async () => {
  const events: string[] = [];
  const input = snapshot();
  input.callers.push({ appId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", username: "app-c", password: "other-secret" });
  await publishApprovedKongSnapshot(input, admin(events), {
    withExclusivePublication: async (_generation, run) => run(async () => {}),
  });
  assert.ok(events.includes("consumer:cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
  assert.ok(events.includes("groups:cccccccc-cccc-4ccc-8ccc-cccccccccccc:app-cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
});
