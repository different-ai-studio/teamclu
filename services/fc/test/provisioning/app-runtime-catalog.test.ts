import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeCatalogReader, type CatalogClient } from "../../src/lib/provisioning/app-runtime-catalog.js";
import { resolveFcEndpoint } from "../../src/lib/provisioning/fc-client.js";
import { readRuntimeObservations } from "../../src/lib/provisioning/app-runtime-observations.js";
const layer = (name: string, version: number) => ({ layerName: name, version,
  layerVersionArn: `acs:fc:cn-shenzhen:official:layers/${name}/versions/${version}`,
  compatibleRuntime: ["custom.debian10"] });
function fixture(fail = false): CatalogClient {
  return {
    async listLayers(req) { return { body: req.nextToken ? { layers: [{ layerName: "Java21" }] } :
      { layers: [{ layerName: "Java17" }, { layerName: "Python310" }], nextToken: "page2" } }; },
    async listLayerVersions(name, req) {
      if (req.startVersion && fail) throw Object.assign(new Error("provider detail"), { code: "AccessDenied" });
      return { body: req.startVersion ? { layers: [layer(name, 1)] } : { layers: [layer(name, 2)], nextVersion: 1 } };
    },
  };
}
test("Java catalog includes all paginated versions and separates documented builtins", async () => {
  const read = createRuntimeCatalogReader(() => fixture());
  const result = await read("cn-shenzhen", "java");
  assert.deepEqual(result.candidates.filter(c => c.source === "officialLayers").map(c => `${c.name}:${c.version}`),
    ["Java17:2", "Java17:1", "Java21:2", "Java21:1"]);
  assert.deepEqual(result.candidates.filter(c => c.source === "documentation").map(c => c.name), ["java8", "java11"]);
  assert.ok(result.candidates.filter(c => c.source === "documentation").every(c => c.teamcluDeployable === "providerAvailableButUnsupported"));
  assert.ok(result.candidates.filter(c => c.source === "officialLayers").every(c => c.teamcluDeployable === "unknown" && !('path' in c)));
  assert.equal(result.sourceStatus.officialLayers.complete, true);
  assert.equal(result.sourceStatus.documentation.observedAt, "2026-09-28");
});
test("failed later version pages preserve partial candidates and visible source errors", async () => {
  const result = await createRuntimeCatalogReader(() => fixture(true))("cn-shenzhen", "java");
  assert.equal(result.sourceStatus.officialLayers.complete, false);
  assert.ok(result.sourceStatus.officialLayers.errors.some(e => e.includes("AccessDenied")));
  assert.ok(result.candidates.some(c => c.name === "Java21"));
});
test("cache expires, is bounded by region, and marks stale results on refresh failure", async () => {
  let now = 0; let calls = 0; let failed = false;
  const read = createRuntimeCatalogReader(() => { calls++; if (failed) throw new Error("unavailable"); return fixture(); },
    { now: () => now, ttlMs: 100, maxRegions: 1 });
  await read("cn-shenzhen", "java"); await read("cn-shenzhen", "python"); assert.equal(calls, 1);
  now = 101; failed = true;
  const stale = await read("cn-shenzhen"); assert.equal(stale.sourceStatus.officialLayers.stale, true);
  assert.equal(stale.sourceStatus.officialLayers.complete, false);
  failed = false; await read("cn-beijing"); await read("cn-shenzhen"); assert.equal(calls, 4);
});
test("observations distinguish record date from unknown probe date and do not invent Java paths", () => {
  const python = readRuntimeObservations("python");
  assert.ok(python.some(o => o.path === "/var/fc/lang/python3.10/bin/python3"));
  assert.ok(python.every(o => o.recordedAt === "2026-09-23" && o.probeDate === null && o.provenance && o.verificationStatus === "historicalProbe"));
  assert.ok(!readRuntimeObservations("java").some(o => o.path));
});

test("endpoint region mismatch returns incomplete catalog without mislabeled layers", async () => {
  const previous = { endpoint: process.env.APPS_FC_ENDPOINT, region: process.env.APPS_REGION };
  process.env.APPS_FC_ENDPOINT = "https://123.cn-shenzhen.fc.aliyuncs.com";
  process.env.APPS_REGION = "cn-beijing";
  try {
    assert.equal(resolveFcEndpoint("cn-shenzhen"), process.env.APPS_FC_ENDPOINT);
    assert.throws(() => resolveFcEndpoint("cn-beijing"), { code: "FcEndpointRegionMismatch" });
    const read = createRuntimeCatalogReader(region => { resolveFcEndpoint(region); return fixture(); });
    const result = await read("cn-beijing", "java");
    assert.equal(result.sourceStatus.officialLayers.complete, false);
    assert.deepEqual(result.sourceStatus.officialLayers.errors, ["ListLayers: FcEndpointRegionMismatch"]);
    assert.equal(result.candidates.filter(c => c.source === "officialLayers").length, 0);
    process.env.APPS_FC_ENDPOINT = "https://fc-proxy.example";
    assert.equal(resolveFcEndpoint("cn-beijing"), process.env.APPS_FC_ENDPOINT);
    assert.throws(() => resolveFcEndpoint("cn-shenzhen"), { code: "FcEndpointRegionMismatch" });
  } finally {
    for (const [key, value] of [["APPS_FC_ENDPOINT", previous.endpoint], ["APPS_REGION", previous.region]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
