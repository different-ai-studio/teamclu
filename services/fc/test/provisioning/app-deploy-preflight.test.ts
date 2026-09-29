import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightAppDeploy, verifyAppDeployPreflight, isAppDeployPreflightExpired } from "../../src/lib/provisioning/app-deploy-preflight.js";

const declaration = { build: { kind: "node", output: ".output" }, start: { fcRuntime: "custom.debian12", command: ["node"], args: ["server.js"], port: 9000, layers: [] } };
const live = { runtime: "node", startSpec: declaration.start, provider: { runtime: "custom.debian12", command: ["node"], args: ["server.js"], port: 9000, layers: [] }, drift: false };
const revision = "a".repeat(40);

test("first deployment produces a revision-bound preview", () => {
  const result = preflightAppDeploy("app-1", revision, declaration, null, { region: "cn-hangzhou", capabilities: [], catalogComplete: true });
  assert.deepEqual(result.preview.changes, []);
  assert.equal(result.preview.firstDeploy, true);
  assert.doesNotThrow(() => verifyAppDeployPreflight(result.token, "app-1", revision, declaration, null));
  assert.throws(() => verifyAppDeployPreflight(result.token, "app-1", "b".repeat(40), declaration, null), /revision/i);
});

test("an abandoned preflight token expires so another proposal can replace it", () => {
  const result = preflightAppDeploy("app-1", revision, declaration, null, { region: "cn-hangzhou", capabilities: [], catalogComplete: true });
  assert.equal(isAppDeployPreflightExpired(result.token), false);
  const old = JSON.parse(Buffer.from(result.token, "base64url").toString("utf8"));
  old.issuedAt = Date.now() - 11 * 60_000;
  assert.equal(isAppDeployPreflightExpired(Buffer.from(JSON.stringify(old)).toString("base64url")), true);
});

test("unchanged live runtime can redeploy", () => {
  const result = preflightAppDeploy("app-1", revision, declaration, live, { region: "cn-hangzhou", capabilities: [] });
  assert.deepEqual(result.preview.changes, []);
});

test("interpreter version and layers require explicit migration intent", () => {
  const changed = { ...declaration, start: { ...declaration.start, command: ["/opt/node22/bin/node"], layers: ["Nodejs22:1"] } };
  assert.throws(() => preflightAppDeploy("app-1", revision, changed, live, { region: "cn-hangzhou", capabilities: [] }), (e: any) => e.code === "runtime_migration_required" && /command.*layers/.test(e.message));
});

test("migration intent yields an exact preview and binds approval context", () => {
  const changed = { ...declaration, start: { ...declaration.start, fcRuntime: "custom.debian11" } };
  const result = preflightAppDeploy("app-1", revision, changed, live, { region: "cn-hangzhou", capabilities: [], catalogComplete: true, migrationIntent: true });
  assert.deepEqual(result.preview.changes.map((c: any) => c.field), ["fcRuntime"]);
  assert.equal(result.preview.requiresMigrationApproval, true);
  assert.doesNotThrow(() => verifyAppDeployPreflight(result.token, "app-1", revision, changed, live));
  assert.throws(() => verifyAppDeployPreflight(result.token, "app-1", revision, declaration, live), /declaration/i);
});

test("port changes are previewed without migration intent", () => {
  const changed = { ...declaration, start: { ...declaration.start, port: 8080 } };
  const result = preflightAppDeploy("app-1", revision, changed, live, { region: "cn-hangzhou", capabilities: [] });
  assert.deepEqual(result.preview.changes.map((c: any) => c.field), ["port"]);
  assert.equal(result.preview.requiresMigrationApproval, false);
});

test("changed launch args require migration intent because a shell arg can select the interpreter", () => {
  const changed = { ...declaration, start: { ...declaration.start, command: ["sh", "-c"], args: ["exec node22 server.js"] } };
  const baseline = { ...live, startSpec: { ...live.startSpec, command: ["sh", "-c"], args: ["exec node20 server.js"] }, provider: { ...live.provider, command: ["sh", "-c"], args: ["exec node20 server.js"] } };
  assert.throws(() => preflightAppDeploy("app-1", revision, changed, baseline, { region: "cn-hangzhou", capabilities: [] }),
    (e: any) => e.code === "runtime_migration_required" && e.message.includes("args"));
  const result = preflightAppDeploy("app-1", revision, changed, baseline,
    { region: "cn-hangzhou", capabilities: [], migrationIntent: true });
  assert.deepEqual(result.preview.changes.map((c: any) => c.field), ["args"]);
  assert.equal(result.preview.requiresMigrationApproval, true);
});

test("provider drift and unsupported layers reject without changing a live function", () => {
  const drifted = { ...live, drift: true };
  assert.throws(() => preflightAppDeploy("app-1", revision, declaration, drifted, { region: "cn-hangzhou", capabilities: [] }), (e: any) => e.code === "live_state_drift");
  const changed = { ...declaration, start: { ...declaration.start, layers: ["Unknown:1"] } };
  assert.throws(() => preflightAppDeploy("app-1", revision, changed, null, { region: "cn-hangzhou", capabilities: [], catalogComplete: true }), (e: any) => e.code === "unsupported_layer");
});

test("a changed live baseline invalidates the token before finalize", () => {
  const result = preflightAppDeploy("app-1", revision, declaration, live, { region: "cn-hangzhou", capabilities: [] });
  const altered = { ...live, startSpec: { ...live.startSpec, port: 8080 } };
  assert.throws(() => verifyAppDeployPreflight(result.token, "app-1", revision, declaration, altered), /baseline/i);
});

test("provider activity status does not invalidate identical runtime configuration", () => {
  const before = { ...live, provider: { ...live.provider, status: "Idle" } };
  const result = preflightAppDeploy("app-1", revision, declaration, before, { region: "cn-hangzhou", capabilities: [] });
  const after = { ...live, provider: { ...live.provider, status: "Active" } };
  assert.doesNotThrow(() => verifyAppDeployPreflight(result.token, "app-1", revision, declaration, after));
});

test("new layer choice fails closed when discovery is incomplete", () => {
  const changed = { ...declaration, start: { ...declaration.start, layers: ["Nodejs22:1"] } };
  assert.throws(() => preflightAppDeploy("app-1", revision, changed, live, { region: "cn-hangzhou", capabilities: [], catalogComplete: false, migrationIntent: true }), (e: any) => e.code === "discovery_unavailable");
});

test("new layers require a regionally deployable candidate compatible with the FC runtime", () => {
  const layer = "acs:fc:cn-hangzhou:123456:layers/private/versions/1";
  const changed = { ...declaration, start: { ...declaration.start, layers: [layer] } };
  for (const candidate of [
    undefined,
    { arn: layer, region: "cn-hangzhou", compatibleRuntime: ["custom.debian12"], teamcluDeployable: "unknown" },
    { arn: layer, region: "cn-hangzhou", compatibleRuntime: ["custom.debian10"], teamcluDeployable: "teamcluDeployable" },
  ]) {
    assert.throws(() => preflightAppDeploy("app-1", revision, changed, null,
      { region: "cn-hangzhou", capabilities: candidate ? [candidate as any] : [], catalogComplete: true }),
    (e: any) => e.code === "unsupported_layer");
  }
  assert.doesNotThrow(() => preflightAppDeploy("app-1", revision, changed, null,
    { region: "cn-hangzhou", capabilities: [{ arn: layer, region: "cn-hangzhou", compatibleRuntime: ["custom.debian12"], teamcluDeployable: "teamcluDeployable" } as any], catalogComplete: true }));
});

test("new runtime choice fails closed when discovery is incomplete", () => {
  const changed = { ...declaration, start: { ...declaration.start, fcRuntime: "custom.debian11" } };
  assert.throws(() => preflightAppDeploy("app-1", revision, changed, live,
    { region: "cn-hangzhou", capabilities: [], catalogComplete: false, migrationIntent: true }),
    (e: any) => e.code === "discovery_unavailable");
  assert.doesNotThrow(() => preflightAppDeploy("app-1", revision, declaration, live,
    { region: "cn-hangzhou", capabilities: [], catalogComplete: false }));
});

test("container first deploy does not require official layer discovery", () => {
  const container = { build: { kind: "container", output: ".", dockerfile: "Dockerfile", context: "." }, start: { port: 5000 } };
  assert.doesNotThrow(() => preflightAppDeploy("app-1", revision, container, null,
    { region: "cn-hangzhou", capabilities: [], catalogComplete: false }));
});

test("missing legacy deployment snapshot cannot be treated as an unchanged runtime", () => {
  assert.throws(() => preflightAppDeploy("app-1", revision, declaration, { ...live, startSpec: null }, { region: "cn-hangzhou", capabilities: [] }), (e: any) => e.code === "live_state_drift");
});
