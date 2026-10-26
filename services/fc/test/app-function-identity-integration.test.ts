import { test } from "node:test";
import assert from "node:assert/strict";
import { jwtVerify } from "jose";
import { appsSupabase as sharedAppsSupabase, appsRepo } from "./fixtures/apps-repository.js";
import { startDeploy, finalizeDeploy } from "../src/lib/provisioning/app-deploy.js";
import { cleanupAppDeployment } from "../src/lib/provisioning/app-undeploy.js";
import { makeSupabaseVanityLookup, proxyToApp, __resetVanityCache } from "../src/lib/apps-vanity.js";
import { originJwks } from "../src/lib/apps-origin-auth.js";
import { ORIGIN_CONFIG, installOriginEnv } from "./fixtures/apps-origin-auth/config.js";

// Use the same stateful persistence/filter/lifecycle adapter as repository tests,
// with projection enabled and this scenario's database-generated App identity.
const appsSupabase = (options: any = {}) => sharedAppsSupabase({
  ...options,
  projectSelects: true,
  appInsertDefaults: { app_code: "a-p35cg2kk6bh3", provision_status: "ready" },
  appInsertId: "76af539e-5341-4e96-bda7-6c8dacf2b092",
});

const declaration = { build: { kind: "node", output: ".output" }, start: {
  fcRuntime: "custom.debian10", command: ["/opt/nodejs20/bin/node"], args: ["server/index.mjs"],
  port: 9000, layers: ["Nodejs20:3"],
} };
const revision = `sha256:${"a".repeat(64)}`;

// Detect dropped naming metadata at repository → provisioner → gateway → cleanup boundaries.
test("created App keeps literal code function and origin across rename redeploy proxy uninstall and reinstall", async () => {
  const restore = installOriginEnv();
  const publicDomain = process.env.APPS_PUBLIC_DOMAIN;
  process.env.APPS_PUBLIC_DOMAIN = "apps.example";
  __resetVanityCache();
  try {
    const db = appsSupabase();
    const resources = new Map<string, string>();
    let failFinalize = false;
    let snapshot: any;
    const rpc = db.rpc.bind(db);
    db.rpc = async (name, args) => {
      const result = await rpc(name, args);
      if (name === "begin_app_lifecycle" && args.p_kind === "undeploy") {
        const { data: row } = await db.from("apps").select("*").eq("id", args.p_app_id).single();
        snapshot = { appId: row.id, slug: row.slug, functionName: row.fc_function_name,
          originDomain: args.p_origin_domain, oauthClientId: row.oauth_client_id };
        snapshot.operationId = result.data.id;
        result.data.snapshot = snapshot;
      }
      return result;
    };
    const repo = appsRepo(db, {
      validateAppOrigin: undefined,
      readAppOriginSecurity: async () => ({ status: "protected", internetUrlDisabled: true, customDomainAuth: "jwt", httpsOnly: false, driftFields: [] }),
      readAppFunction: async (name: string) => {
        if (!resources.has(name)) throw Object.assign(new Error("absent"), { code: "FunctionNotFound" });
        return { runtime: "custom.debian10", customRuntimeConfig: {
          command: declaration.start.command, args: declaration.start.args, port: 9000 },
          layers: ["acs:fc:cn-hangzhou:official:layers/Nodejs20/versions/3"] };
      },
      readRuntimeCatalog: async () => ({ candidates: [{ arn: "acs:fc:cn-hangzhou:official:layers/Nodejs20/versions/3", region: "cn-hangzhou", compatibleRuntime: ["custom.debian10"], teamcluDeployable: "teamcluDeployable" }], sourceStatus: { officialLayers: { complete: true } } }),
      startDeploy: (input: any) => startDeploy({ mintUploadUrl: async () => "https://oss.test/put" }, input),
      finalizeDeploy: (input: any) => finalizeDeploy({ fcOps: {
        ensureFunction: async name => { if (!resources.has(name)) resources.set(name, "allocated"); },
        ensureHttpTrigger: async () => ({ internetUrlDisabled: true }),
        ensureCustomDomain: async (name, host) => {
          if (failFinalize) throw Error("provider unavailable");
          resources.set(name, host);
          return `http://${host}`;
        },
      } }, input),
    });
    const created = await repo.createApp({ teamId: "team-1", name: "Original", type: "static_web", localOnly: true });
    const id = created.id;
    assert.equal(id, "76af539e-5341-4e96-bda7-6c8dacf2b092");
    assert.equal(created.appCode, "a-p35cg2kk6bh3");
    await db.from("apps").update({ provision_status: "ready" }).eq("id", id);
    const deploy = async () => {
      const preflight = await repo.preflightAppDeploy(id, { revision, declaration });
      const started = await repo.deployApp(id, { revision, declaration, gitCommitSha: "abc1234", preflightToken: preflight.token });
      assert.equal(started.fcFunctionName, "a-p35cg2kk6bh3");
      return repo.finalizeDeploy(id, { revision, declaration, gitCommitSha: "abc1234", deployToken: preflight.token });
    };
    await deploy();
    await repo.updateApp(id, { name: "Renamed" });
    await deploy();
    let live = await repo.getApp(id);
    assert.equal(live.fcEndpoint, "http://a-p35cg2kk6bh3.origins.test");
    assert.equal(live.fcFunctionName, "a-p35cg2kk6bh3");
    assert.deepEqual([...resources.keys()], ["a-p35cg2kk6bh3"]);

    // Real lookup maps the persisted row into the real proxy's origin target.
    await db.from("apps").update({ uses_app_code_domain: true, custom_domain: "custom.example", custom_domain_verified_at: "2026-10-26T00:00:00Z" }).eq("id", id);
    for (const host of ["a-p35cg2kk6bh3.apps.example", "custom.example"]) {
      const app = await makeSupabaseVanityLookup(() => db)(host);
      assert.ok(app);
      const response = await proxyToApp(new Request("https://public.example/healthz?check=1"), app.fcEndpoint!, async (url, init) => {
        assert.equal(String(url), "http://a-p35cg2kk6bh3.origins.test/healthz?check=1");
        const bearer = new Headers(init?.headers).get("x-teamclu-origin-authorization")!;
        const { payload } = await jwtVerify(bearer.slice(7), Buffer.from(originJwks(ORIGIN_CONFIG, id).keys[0].k, "base64url"));
        assert.equal(payload.appId, "76af539e-5341-4e96-bda7-6c8dacf2b092");
        assert.equal(payload.originHost, "a-p35cg2kk6bh3.origins.test");
        return new Response("healthy");
      }, null, { target: { appId: app.id, slug: app.slug, appCode: app.appCode, functionNamingMode: app.functionNamingMode }, config: ORIGIN_CONFIG });
      assert.equal(await response.text(), "healthy");
    }
    failFinalize = true;
    await assert.rejects(deploy(), /origin security unavailable/);
    live = await repo.getApp(id);
    assert.equal(live.fcEndpoint, "http://a-p35cg2kk6bh3.origins.test");
    assert.equal(live.fcFunctionName, "a-p35cg2kk6bh3");
    assert.equal(live.fcStatus, "deploy_error");
    assert.equal(resources.size, 1);
    // DB failure trigger owns reservation release, represented explicitly by the adapter.
    await db.from("apps").update({ deploy_token: null, deploy_started_at: null }).eq("id", id);
    failFinalize = false;
    await deploy();
    await repo.undeployApp(id);
    assert.equal(snapshot.functionName, "a-p35cg2kk6bh3");
    assert.equal(snapshot.originDomain, "a-p35cg2kk6bh3.origins.test");
    await assert.rejects(deploy(), /lifecycle|progress|conflict/);
    const removed: string[] = [];
    const steps = await cleanupAppDeployment({
      deleteHttpTrigger: async name => { removed.push(name); },
      deleteCustomDomain: async host => { removed.push(host); },
      deleteFunction: async name => { resources.delete(name); },
      deleteArtifact: async () => {},
    }, { ...snapshot, slug: "changed-after-queue" }, {}, async () => {});
    assert.equal(steps.function.status, "succeeded");
    assert.deepEqual(removed, ["a-p35cg2kk6bh3", "a-p35cg2kk6bh3.origins.test"]);
    assert.equal(resources.size, 0);
    // Worker completion persists these fields in production; only its DB effect is adapted.
    await db.rpc("finish_app_lifecycle", { p_operation_id: snapshot.operationId });
    await db.from("apps").update({ fc_status: "uninstalled", fc_endpoint: null, deploy_token: null, undeploy_operation: { id: "uninstall-complete", status: "succeeded", updatedAt: new Date(Date.now() + 1000).toISOString() } }).eq("id", id);
    await deploy();
    assert.equal((await repo.getApp(id)).fcFunctionName, "a-p35cg2kk6bh3");
    assert.equal(resources.get("a-p35cg2kk6bh3"), "a-p35cg2kk6bh3.origins.test");
  } finally { restore(); if (publicDomain === undefined) delete process.env.APPS_PUBLIC_DOMAIN; else process.env.APPS_PUBLIC_DOMAIN = publicDomain; __resetVanityCache(); }
});

for (const fixture of [
  { status: null, stored: null, endpoint: null, want: "historical-76af539e" },
  { status: "live", stored: "keep-old-function", endpoint: "https://older.fcapp.run", want: "keep-old-function" },
  { status: "uninstalled", stored: "keep-uninstalled-function", endpoint: null, want: "keep-uninstalled-function" },
]) test(`historical ${fixture.status ?? "never-deployed"} App remains legacy even with a public code`, async () => {
  const restore = installOriginEnv();
  try {
    const id = "76af539e-5341-4e96-bda7-6c8dacf2b092";
    const db = appsSupabase({ seed: { apps: [{ id, team_id: "team-1", created_by_actor_id: "actor-app-1",
      org_id: "org-1", name: "Historical", slug: "historical", type: "static_web", runtime: "node", auth_mode: "none",
      provision_status: "ready", function_naming_mode: "legacy", app_code: "a-p35cg2kk6bh3", uses_app_code_domain: true,
      fc_status: fixture.status, fc_function_name: fixture.stored, fc_endpoint: fixture.endpoint,
      start_spec: fixture.status ? declaration.start : null,
      undeploy_operation: fixture.status === "uninstalled" ? { id: "old-cleanup", status: "succeeded", updatedAt: "2026-10-26T00:00:00Z" } : null,
    }] } });
    const actual: string[][] = [];
    let allocated = fixture.status === "live";
    const repo = appsRepo(db, {
      validateAppOrigin: undefined,
      readAppOriginSecurity: async () => ({ status: "legacy_unverified", driftFields: [] }),
      readAppFunction: async () => {
        if (!allocated) throw Object.assign(new Error("absent"), { code: "FunctionNotFound" });
        return { runtime: "custom.debian10", customRuntimeConfig: { command: declaration.start.command, args: declaration.start.args, port: 9000 }, layers: ["acs:fc:cn-hangzhou:official:layers/Nodejs20/versions/3"] };
      },
      readRuntimeCatalog: async () => ({ candidates: [{ arn: "acs:fc:cn-hangzhou:official:layers/Nodejs20/versions/3", region: "cn-hangzhou", compatibleRuntime: ["custom.debian10"], teamcluDeployable: "teamcluDeployable" }], sourceStatus: { officialLayers: { complete: true } } }),
      startDeploy: (input: any) => startDeploy({ mintUploadUrl: async () => "https://oss.test/put" }, input),
      finalizeDeploy: (input: any) => finalizeDeploy({ fcOps: {
        ensureFunction: async name => { actual.push(["function", name]); allocated = true; },
        ensureHttpTrigger: async () => ({ internetUrlDisabled: true }),
        ensureCustomDomain: async (name, host) => { actual.push(["origin", name, host]); return `http://${host}`; },
      } }, input),
    });
    const preflight = await repo.preflightAppDeploy(id, { revision, declaration });
    const started = await repo.deployApp(id, { revision, declaration, preflightToken: preflight.token });
    assert.equal(started.fcFunctionName, fixture.want);
    await repo.finalizeDeploy(id, { revision, declaration, deployToken: preflight.token });
    assert.deepEqual(actual, [["function", fixture.want], ["origin", fixture.want, "historical-76af539e.origins.test"]]);
    assert.equal((await repo.getApp(id)).fcFunctionName, fixture.want);
    const { data: row } = await db.from("apps").select("*").eq("id", id).single();
    assert.equal(row.function_naming_mode, "legacy");
  } finally { restore(); }
});
