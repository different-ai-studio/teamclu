import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceSnapshot, assertAcceptanceInventory } from "../scripts/app-api-kong-acceptance.js";

const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const credentials = { bId: B, bPassword: "b-test", cId: C, cPassword: "c-test" };

test("temporary acceptance snapshot pins the real FC target and grants only B", () => {
  const input = acceptanceSnapshot("publish", credentials);
  assert.equal(input.routes.length, 1);
  assert.equal(input.routes[0].targetAppId, "4fddbe81-a0e4-41c2-b74a-feccd0d9f959");
  assert.equal(input.routes[0].gatewayHost, "app-4fddbe81-a0e4-41c2-b74a-feccd0d9f959.apps-internal.teamclu.cn");
  assert.equal(input.routes[0].upstreamOrigin, "https://teamclug-target-mwsjjxhwgp.cn-hangzhou-vpc.fcapp.run");
  assert.deepEqual(input.routes[0].callerAppIds, [B]);
  assert.deepEqual(input.callers.map(caller => caller.appId), [B, C]);
  assert.ok(!JSON.stringify(input.routes).includes("b-test"));
});

test("temporary revocation removes route and both test Consumers", () => {
  const input = acceptanceSnapshot("revoke", credentials);
  assert.deepEqual(input.routes, []);
  assert.deepEqual(input.callers, []);
});

test("acceptance guard refuses unrelated managed Kong entities", () => {
  const input = acceptanceSnapshot("publish", credentials);
  assert.doesNotThrow(() => assertAcceptanceInventory({ routes: [], services: [], consumers: [] }, input, credentials));
  assert.throws(() => assertAcceptanceInventory({ routes: ["tc-app-api-other"], services: [], consumers: [] }, input, credentials), /unrelated/);
  assert.throws(() => assertAcceptanceInventory({ routes: [], services: [], consumers: ["tc-app-api-caller-another"] }, input, credentials), /unrelated/);
});
