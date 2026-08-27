import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startDeploy,
  finalizeDeploy,
  needsDatabase,
  checkDeployInProgress,
  isStaleDeploy,
  parseOptionalGitCommitSha,
  STALE_DEPLOY_MS,
} from "../../src/lib/provisioning/app-deploy.js";

test("startDeploy mints the upload handle and names the function + object", async () => {
  const out = await startDeploy(
    { mintUploadUrl: async (k: string) => `https://oss.example/put/${k}?sig=x` },
    { appId: "3f1c9a2e-0000-4000-8000-000000000abc", region: "cn-hangzhou" },
  );
  assert.equal(out.fcFunctionName, "tc-app-3f1c9a2e-0000-4000-8000-000000000abc");
  assert.equal(out.fcRegion, "cn-hangzhou");
  assert.equal(out.ossObjectName, "apps/3f1c9a2e-0000-4000-8000-000000000abc/code.zip");
  assert.match(out.presignedPut, /code\.zip\?sig=x/);
});

test("startDeploy does NOT touch FC — the code object does not exist yet", async () => {
  // Regression: creating the function here made CreateFunction reference an OSS
  // object the daemon had not uploaded. Function creation belongs in finalize.
  let mintCalls = 0;
  await startDeploy(
    { mintUploadUrl: async () => { mintCalls += 1; return "https://oss.example/put"; } },
    { appId: "app-1", region: "cn-hangzhou" },
  );
  assert.equal(mintCalls, 1);
});

test("finalizeDeploy provisions the org DB + schema, then sets code + env together", async () => {
  const calls: any[] = [];
  const orgId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const out = await finalizeDeploy(
    {
      appsAdminUrl: "postgres://host:5432/postgres",
      provisionDb: async (adminUrl, params) => {
        calls.push(["provisionDb", adminUrl, params]);
        return {
          schema: "app_demo",
          role: "app_role",
          database: "tc_org_aaaaaaaabbbb4ccc8dddeeeeeeeeeeee",
          connectionString: `postgres://app_role:pw-fixed@host:5432/tc_org_aaaaaaaabbbb4ccc8dddeeeeeeeeeeee?options=-c%20search_path%3Dapp_demo`,
        };
      },
      fcOps: {
        ensureFunction: async (n: string, a: any) => { calls.push(["ensureFunction", n, a]); },
        ensureHttpTrigger: async (n: string) => { calls.push(["trigger", n]); return "https://fn.example.fcapp.run"; },
      },
      genPassword: () => "pw-fixed",
    },
    {
      appId: "3f1c9a2e-0000-4000-8000-000000000abc",
      slug: "Demo App",
      orgId,
      appType: "data_app",
      fcFunctionName: "tc-app-3f1c9a2e-0000-4000-8000-000000000abc",
      ossObjectName: "apps/3f1c9a2e-0000-4000-8000-000000000abc/code.zip",
    },
  );
  assert.deepEqual(out, { fcEndpoint: "https://fn.example.fcapp.run" });

  assert.equal(calls[0][0], "provisionDb");
  assert.equal(calls[0][1], "postgres://host:5432/postgres");
  assert.equal(calls[0][2].orgId, orgId);
  const ensure = calls.find((c) => c[0] === "ensureFunction");
  assert.ok(ensure, "ensureFunction was called");
  const [, name, args] = ensure;
  assert.equal(name, "tc-app-3f1c9a2e-0000-4000-8000-000000000abc");
  assert.equal(args.ossObjectName, "apps/3f1c9a2e-0000-4000-8000-000000000abc/code.zip");
  assert.equal(args.env.PORT, "9000");
  assert.match(args.env.DATABASE_URL, /tc_org_/);
  assert.match(args.env.DATABASE_URL, /pw-fixed/);
  assert.equal(calls.at(-1)[0], "trigger");
});

test("a data app without orgId fails before provisioning", async () => {
  await assert.rejects(
    () => finalizeDeploy(
      {
        appsAdminUrl: "postgres://host:5432/postgres",
        provisionDb: async () => { throw new Error("must not be called"); },
        fcOps: {
          ensureFunction: async () => { throw new Error("must not be called"); },
          ensureHttpTrigger: async () => "unused",
        },
      },
      { appId: "app-1", slug: "demo", appType: "data_app", fcFunctionName: "tc-app-1", ossObjectName: "k" },
    ),
    /org/,
  );
});

test("a static app deploys with no database at all", async () => {
  // Static types have no Postgres schema and no DATABASE_URL — and must deploy
  // even when the apps database is entirely unconfigured.
  const calls: any[] = [];
  for (const appType of ["static_web", "slides"]) {
    const out = await finalizeDeploy(
      {
        fcOps: {
          ensureFunction: async (n: string, a: any) => { calls.push([appType, n, a]); },
          ensureHttpTrigger: async () => "https://fn.example.fcapp.run",
        },
      } as any,
      { appId: "app-1", slug: "demo", appType, fcFunctionName: "tc-app-1", ossObjectName: "apps/app-1/code.zip" },
    );
    assert.deepEqual(out, { fcEndpoint: "https://fn.example.fcapp.run" });
  }
  assert.equal(calls.length, 2);
  for (const [type, , args] of calls) {
    assert.ok(!("DATABASE_URL" in args.env), `${type}: no DATABASE_URL`);
    assert.equal(args.env.PORT, "9000");
  }
});

test("a data app without a configured database fails loudly", async () => {
  await assert.rejects(
    () => finalizeDeploy(
      {
        fcOps: {
          ensureFunction: async () => { throw new Error("must not be called"); },
          ensureHttpTrigger: async () => "unused",
        },
      } as any,
      { appId: "app-1", slug: "demo", appType: "data_app", fcFunctionName: "tc-app-1", ossObjectName: "k" },
    ),
    /APPS_DB_ADMIN_URL/,
  );
});

test("an unknown or legacy type is treated as a data app", async () => {
  assert.equal(needsDatabase("fullstack_tanstack_postgres"), true);
  assert.equal(needsDatabase(""), true);
  assert.equal(needsDatabase("data_app"), true);
  assert.equal(needsDatabase("static_web"), false);
  assert.equal(needsDatabase(" slides "), false);
});

test("finalizeDeploy merges platform OAuth env into the function env", async () => {
  const calls: any[] = [];
  await finalizeDeploy(
    {
      fcOps: {
        ensureFunction: async (_n: string, a: any) => { calls.push(a); },
        ensureHttpTrigger: async () => "https://fn.example.fcapp.run",
      },
    },
    {
      appId: "app-1",
      slug: "demo",
      appType: "static_web",
      fcFunctionName: "tc-app-1",
      ossObjectName: "apps/app-1/code.zip",
      platformOAuthEnv: {
        OAUTH_CLIENT_ID: "cid",
        OAUTH_CLIENT_SECRET: "sec",
        APP_PUBLIC_URL: "https://demo-app1.apps.example",
        API_BASE: "https://api.example",
      },
    },
  );
  assert.equal(calls[0].env.OAUTH_CLIENT_ID, "cid");
  assert.equal(calls[0].env.OAUTH_CLIENT_SECRET, "sec");
  assert.equal(calls[0].env.APP_PUBLIC_URL, "https://demo-app1.apps.example");
  assert.equal(calls[0].env.API_BASE, "https://api.example");
  assert.ok(!("SUPABASE_SERVICE_ROLE_KEY" in calls[0].env));
});

test("a deploy stuck mid-flight goes stale, whatever status it is stuck in", () => {
  // finalizeDeploy writes `deploying` before calling the FC provisioner, so a
  // process killed at that point used to block every future deploy forever:
  // the staleness escape only covered `awaiting_build`.
  const started = new Date(Date.now() - STALE_DEPLOY_MS - 1000);
  for (const fc_status of ["awaiting_build", "building", "deploying"]) {
    assert.equal(
      checkDeployInProgress({ fc_status, deploy_started_at: started }),
      "stale",
      `${fc_status} must be reclaimable`,
    );
  }
});

test("a deploy that is merely in flight still blocks a second one", () => {
  const justStarted = new Date(Date.now() - 1000);
  for (const fc_status of ["awaiting_build", "building", "deploying"]) {
    assert.equal(checkDeployInProgress({ fc_status, deploy_started_at: justStarted }), "blocked");
  }
  assert.equal(checkDeployInProgress({ fc_status: "live", deploy_started_at: null }), "ok");
  assert.equal(checkDeployInProgress({ fc_status: null, deploy_started_at: null }), "ok");
  // No timestamp at all is not evidence of staleness.
  assert.equal(checkDeployInProgress({ fc_status: "deploying", deploy_started_at: null }), "blocked");
  assert.equal(isStaleDeploy("live", new Date(0)), false);
});

test("checkDeployInProgress needs only the deploy columns", () => {
  // It used to demand the whole app row (id + slug), which the supabase backend
  // does not select here — and that mismatch failed the production typecheck.
  assert.equal(checkDeployInProgress({ fcStatus: "live" }), "ok");
});

test("gitCommitSha is optional for an app with no forge repo", () => {
  assert.equal(parseOptionalGitCommitSha(undefined), null);
  assert.equal(parseOptionalGitCommitSha(null), null);
  assert.equal(parseOptionalGitCommitSha("  "), null);
  assert.equal(parseOptionalGitCommitSha("ABC1234"), "abc1234");
  assert.throws(() => parseOptionalGitCommitSha("nope"), /gitCommitSha/);
});
