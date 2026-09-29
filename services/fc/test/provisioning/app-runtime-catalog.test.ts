import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeCatalogReader, type CatalogClient } from "../../src/lib/provisioning/app-runtime-catalog.js";
import { resolveFcEndpoint } from "../../src/lib/provisioning/fc-client.js";
import { readRuntimeObservations } from "../../src/lib/provisioning/app-runtime-observations.js";
import { preflightAppDeploy } from "../../src/lib/provisioning/app-deploy-preflight.js";
const layer = (name: string, version: number) => ({ layerName: name, version,
  layerVersionArn: `acs:fc:cn-shenzhen:official:layers/${name}/versions/${version}`,
  compatibleRuntime: ["custom.debian10"] });
function fixture(fail = false): CatalogClient {
  return {
    async listLayers(req) {
      if (req.nextToken) {
        if (fail) throw Object.assign(new Error("provider page unavailable"), { code: "AccessDenied" });
        return { body: { layers: [layer("Java21", 2)] } };
      }
      return { body: { layers: [layer("Java17", 2), layer("Python310", 3)], nextToken: "page2" } };
    },
  };
}
test("official current layer records remain usable when version listing rejects public layers", async () => {
  const read = createRuntimeCatalogReader(() => ({
    async listLayers() { return { body: { layers: [layer("Nodejs20", 3), layer("Java21", 2)] } }; },
    async listLayerVersions() { throw Object.assign(new Error("official versions unavailable"), { code: "LayerNotFound" }); },
  }));
  const result = await read("cn-shenzhen");
  assert.equal(result.sourceStatus.officialLayers.complete, true);
  assert.deepEqual(result.candidates.filter(c => c.source === "officialLayers").map(c => `${c.name}:${c.version}`),
    ["Nodejs20:3", "Java21:2"]);
  const declaration = { build: { kind: "node", output: ".output" }, start: { fcRuntime: "custom.debian10",
    command: ["/var/fc/lang/nodejs20/bin/node"], args: ["server/index.mjs"], layers: [], port: 9000 } };
  assert.doesNotThrow(() => preflightAppDeploy("app-1", "a".repeat(40), declaration, null,
    { region: "cn-shenzhen", capabilities: result.candidates, catalogComplete: result.sourceStatus.officialLayers.complete }));
});
test("malformed regional layer metadata cannot unlock a first deployment", async () => {
  const read = createRuntimeCatalogReader(() => ({
    async listLayers() { return { body: { layers: [{ ...layer("Nodejs20", 3), layerVersionArn:
      "acs:fc:cn-hangzhou:official:layers/Nodejs20/versions/3" }] } }; },
  }));
  const result = await read("cn-shenzhen");
  assert.equal(result.sourceStatus.officialLayers.complete, false);
  assert.deepEqual(result.candidates.filter(c => c.source === "officialLayers"), []);
  const declaration = { build: { kind: "node", output: ".output" }, start: { fcRuntime: "custom.debian10",
    command: ["/var/fc/lang/nodejs20/bin/node"], args: ["server/index.mjs"], layers: [], port: 9000 } };
  assert.throws(() => preflightAppDeploy("app-1", "a".repeat(40), declaration, null,
    { region: "cn-shenzhen", capabilities: result.candidates, catalogComplete: result.sourceStatus.officialLayers.complete }),
    (e: any) => e.code === "discovery_unavailable");
});
test("Java catalog includes current versions from all listing pages and separates documented builtins", async () => {
  const read = createRuntimeCatalogReader(() => fixture());
  const result = await read("cn-shenzhen", "java");
  assert.deepEqual(result.candidates.filter(c => c.source === "officialLayers").map(c => `${c.name}:${c.version}`),
    ["Java17:2", "Java21:2"]);
  assert.deepEqual(result.candidates.filter(c => c.source === "documentation").map(c => c.name), ["java8", "java11"]);
  assert.ok(result.candidates.filter(c => c.source === "documentation").every(c => c.teamcluDeployable === "providerAvailableButUnsupported"));
  assert.ok(result.candidates.filter(c => c.source === "officialLayers").every(c => c.teamcluDeployable === "unknown" && !('path' in c)));
  assert.equal(result.sourceStatus.officialLayers.complete, true);
  assert.match(result.sourceStatus.officialLayers.provenance, /current published official versions only/);
  assert.equal(result.sourceStatus.documentation.observedAt, "2026-09-28");
});

test("production catalog only verifies historically deployed Nodejs20 layers on the observed runtime", async () => {
  const client: CatalogClient = {
    async listLayers() { return { body: { layers: [
      { ...layer("Nodejs20", 3), compatibleRuntime: ["custom.debian10", "custom.debian12"] },
      layer("Java17", 4),
    ] } }; },
  };
  const catalog = await createRuntimeCatalogReader(() => client)("cn-shenzhen");
  const known = catalog.candidates.find(c => c.name === "Nodejs20" && c.version === 3)!;
  assert.equal(known.teamcluDeployable, "teamcluDeployable");
  assert.deepEqual(known.teamcluVerifiedRuntime, ["custom.debian10"]);
  assert.ok(catalog.candidates.filter(c => c.source === "officialLayers" && c !== known).every(c => c.teamcluDeployable === "unknown"));
  const base = { build: { kind: "node", output: ".output" }, start: { fcRuntime: "custom.debian10", command: ["/opt/nodejs20/bin/node"], args: ["server.js"], port: 9000, layers: ["Nodejs20:3"] } };
  const options = { region: "cn-shenzhen", capabilities: catalog.candidates, catalogComplete: true };
  assert.doesNotThrow(() => preflightAppDeploy("app-1", "a".repeat(40), base, null, options));
  assert.throws(() => preflightAppDeploy("app-1", "a".repeat(40), { ...base, start: { ...base.start, layers: ["Nodejs20:4"] } }, null, options),
    (e: any) => e.code === "unsupported_layer");
  assert.throws(() => preflightAppDeploy("app-1", "a".repeat(40), { ...base, start: { ...base.start, fcRuntime: "custom.debian12" } }, null, options),
    (e: any) => e.code === "unsupported_layer");
  assert.doesNotThrow(() => preflightAppDeploy("app-1", "a".repeat(40), { ...base, start: { ...base.start, command: ["/var/fc/lang/nodejs20/bin/node"], layers: [] } }, null, options));
});
test("failed later listing pages preserve partial candidates and visible source errors", async () => {
  const result = await createRuntimeCatalogReader(() => fixture(true))("cn-shenzhen", "java");
  assert.equal(result.sourceStatus.officialLayers.complete, false);
  assert.ok(result.sourceStatus.officialLayers.errors.some(e => e.includes("AccessDenied")));
  assert.ok(result.candidates.some(c => c.name === "Java17"));
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
