/**
 * The app platform's deploy / teardown / logs wiring, driven end to end
 * against an in-memory provider. Exercises `src/lib/app-platform/deps.ts` and
 * the undeploy deps exactly as the business repository and the heartbeat get
 * them — only the cloud underneath is swapped.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { setAppPlatformForTests } from "../../src/lib/app-platform/index.js";
import {
  makeAppLogsDeps,
  makeDeployDeps,
  makeTeardownDeps,
  resetAppPlatformDepsForTests,
} from "../../src/lib/app-platform/deps.js";
import { teardownAppResources } from "../../src/lib/provisioning/app-delete.js";
import { makeAppUndeployDeps } from "../../src/lib/provisioning/app-undeploy-config.js";
import { createFakeAppPlatform, type FakeAppPlatformOptions } from "../fixtures/app-platform/fake.js";
import { installOriginEnv } from "../fixtures/apps-origin-auth/config.js";

const APP_ID = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";
const SLUG = "demo";

let restoreOrigin: () => void;
let savedOriginMode: string | undefined;

beforeEach(() => {
  restoreOrigin = installOriginEnv();
  savedOriginMode = process.env.APPS_FC_ORIGIN_MODE;
  delete process.env.APPS_FC_ORIGIN_MODE;
});

afterEach(() => {
  setAppPlatformForTests(null);
  resetAppPlatformDepsForTests();
  restoreOrigin();
  if (savedOriginMode === undefined) delete process.env.APPS_FC_ORIGIN_MODE;
  else process.env.APPS_FC_ORIGIN_MODE = savedOriginMode;
});

function useFake(options: FakeAppPlatformOptions = {}) {
  const fake = createFakeAppPlatform(options);
  setAppPlatformForTests(() => ({ platform: fake.platform }));
  resetAppPlatformDepsForTests();
  return fake;
}

function deployDeps() {
  const deps = makeDeployDeps();
  assert.ok("startDeploy" in deps, `deploy should be available, got ${JSON.stringify(deps)}`);
  return deps;
}

test("start → finalize → teardown runs through the provider", async () => {
  const { platform, state } = useFake({ region: "cn-fake-1" });
  const deps = deployDeps();

  const started = await deps.startDeploy({ appId: APP_ID, slug: SLUG, region: "ignored-region", buildKind: "node" } as any);
  // The platform region wins over whatever the caller asked for.
  assert.equal(started.fcRegion, platform.region);
  assert.equal(started.ossObjectName, `apps/${APP_ID}/code.zip`);
  assert.match(started.presignedPut!, /^https:\/\/fake-apps-bucket\.oss\.fake\/apps\/.+\?expires=1800$/);
  assert.deepEqual(state.presignedKeys, [`apps/${APP_ID}/code.zip`]);

  const { fcEndpoint } = await deps.finalizeDeploy({
    appId: APP_ID,
    slug: SLUG,
    appType: "static_web",
    fcFunctionName: started.fcFunctionName,
    ossObjectName: started.ossObjectName!,
  });

  const fn = state.functions.get(started.fcFunctionName);
  assert.ok(fn, "the function was created");
  assert.equal(fn.ossObjectName, `apps/${APP_ID}/code.zip`);
  assert.equal(fn.env.NODE_ENV, "production");
  // The function points at the log destination the provisioner ensured first.
  assert.equal(state.logStoreEnsured, true);
  assert.deepEqual(fn.options.logs?.(), { project: "fake-project", logstore: "fake-logstore" });
  assert.ok(fn.options.originAuth, "entrypoint operations carry the origin credentials");
  assert.ok(state.httpTriggers.has(started.fcFunctionName));
  const [domain] = [...state.customDomains.keys()];
  assert.equal(state.customDomains.get(domain), started.fcFunctionName);
  assert.ok(domain.endsWith(".origins.test"), `route host under the route domain, got ${domain}`);
  assert.equal(fcEndpoint, `http://${domain}`);
  assert.deepEqual(state.calls.filter(c => !c.startsWith("presignPut")), [
    `ensureFunction ${started.fcFunctionName}`,
    `waitUntilReady ${started.fcFunctionName}`,
    `ensureHttpTrigger ${started.fcFunctionName}`,
    `ensureCustomDomain ${started.fcFunctionName} ${domain}`,
    // Applied on every deploy so the declaration, not a console edit, decides.
    `setMinInstances ${started.fcFunctionName} 0`,
  ]);

  const { teardownDeps } = makeTeardownDeps();
  assert.ok(teardownDeps);
  await teardownAppResources(
    { ...teardownDeps },
    { appId: APP_ID, slug: SLUG, fcFunctionName: started.fcFunctionName, fcEndpoint },
  );
  assert.equal(state.functions.size, 0);
  assert.equal(state.httpTriggers.size, 0);
  assert.equal(state.customDomains.size, 0);
  assert.deepEqual(state.deletedObjects, [`apps/${APP_ID}/code.zip`]);
});

test("the heartbeat's undeploy deps reach the same provider", async () => {
  const { state } = useFake();
  const deps = makeAppUndeployDeps();
  assert.ok(deps.deleteFunction && deps.deleteHttpTrigger && deps.deleteArtifact);
  await deps.deleteHttpTrigger!("tc-app-x");
  await deps.deleteFunction!("tc-app-x");
  await deps.deleteArtifact!("apps/x/code.zip");
  assert.deepEqual(state.calls, [
    "deleteHttpTrigger tc-app-x",
    "deleteFunction tc-app-x",
    "DeleteObjectCommand apps/x/code.zip",
  ]);
});

test("a provider that cannot be resolved names the reason", () => {
  setAppPlatformForTests(() => ({ error: "APPS_OSS_BUCKET is not set" }));
  resetAppPlatformDepsForTests();
  assert.deepEqual(makeDeployDeps(), { deployUnavailableReason: "APPS_OSS_BUCKET is not set" });
  assert.deepEqual(makeTeardownDeps(), {});
  assert.deepEqual(makeAppUndeployDeps(), {});
  assert.deepEqual(makeAppLogsDeps(), { appLogsUnavailableReason: "APPS_OSS_BUCKET is not set" });
});

test("no compute endpoint: deploy and teardown refuse, the artifact can still be removed on undeploy", async () => {
  const { state } = useFake({ computeConfigured: false });
  assert.match(String((makeDeployDeps() as any).deployUnavailableReason), /FC endpoint is not configured/);
  assert.deepEqual(makeTeardownDeps(), {});
  const undeploy = makeAppUndeployDeps();
  assert.equal(undeploy.deleteFunction, undefined);
  await undeploy.deleteArtifact!("apps/x/code.zip");
  assert.deepEqual(state.deletedObjects, ["apps/x/code.zip"]);
});

test("logs unavailable: deploy still works, without a log destination", async () => {
  const { state } = useFake({ logsUnavailable: "APPS_SLS_PROJECT is not set" });
  assert.deepEqual(makeAppLogsDeps(), { appLogsUnavailableReason: "APPS_SLS_PROJECT is not set" });
  const deps = deployDeps();
  const started = await deps.startDeploy({ appId: APP_ID, slug: SLUG, region: "x", buildKind: "node" } as any);
  await deps.finalizeDeploy({
    appId: APP_ID,
    slug: SLUG,
    appType: "static_web",
    fcFunctionName: started.fcFunctionName,
    ossObjectName: started.ossObjectName!,
  });
  assert.equal(state.functions.get(started.fcFunctionName)?.options.logs?.(), undefined);
});

test("logs are read through the provider", async () => {
  const { state } = useFake();
  const { appLogs } = makeAppLogsDeps();
  assert.ok(appLogs);
  const result = await appLogs({ functionName: "tc-app-x", sinceMinutes: 5, limit: 10, kind: "app" } as any);
  assert.ok(Array.isArray((result as any).entries ?? []));
  assert.equal(state.logStoreEnsured, false, "reading logs never provisions the store");
});
