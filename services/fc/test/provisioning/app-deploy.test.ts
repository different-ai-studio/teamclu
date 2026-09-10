import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startDeploy,
  finalizeDeploy,
  needsDatabase,
  checkDeployInProgress,
  isStaleDeploy,
  parseOptionalGitCommitSha,
  parseAppDeployDeclaration,
  parseDeployedImage,
  assertDeployAllowed,
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
  const declaration = {
    build: { kind: "python" as const, output: "." },
    start: { fcRuntime: "custom.debian12", command: ["python3"], args: ["app.py"], port: 9000 },
  };
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
      declaration,
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
  assert.deepEqual(args.declaration, declaration);
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

test("data_app finalize rewrites DATABASE_URL host via APPS_DB_APP_URL", async () => {
  const calls: any[] = [];
  const orgId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const prev = {
    vpc: process.env.APPS_FC_VPC_ID,
    vsw: process.env.APPS_FC_VSWITCH_ID,
    sg: process.env.APPS_FC_SECURITY_GROUP_ID,
  };
  process.env.APPS_FC_VPC_ID = "vpc-apps";
  process.env.APPS_FC_VSWITCH_ID = "vsw-apps";
  process.env.APPS_FC_SECURITY_GROUP_ID = "sg-apps";
  try {
    await finalizeDeploy(
      {
        appsAdminUrl: "postgres://postgres:pw@db:5432/postgres",
        appsAppUrl: "postgres://postgres:pw@192.168.0.23:5432/postgres",
        provisionDb: async () => ({
          schema: "app_demo",
          role: "app_role",
          database: "tc_org_aaaaaaaabbbb4ccc8dddeeeeeeeeeeee",
          connectionString:
            "postgres://app_role:pw-fixed@db:5432/tc_org_aaaaaaaabbbb4ccc8dddeeeeeeeeeeee?options=-c%20search_path%3Dapp_demo",
        }),
        fcOps: {
          ensureFunction: async (_n: string, a: any) => { calls.push(a); },
          ensureHttpTrigger: async () => "https://fn.example.fcapp.run",
        },
        genPassword: () => "pw-fixed",
      },
      {
        appId: "app-1",
        slug: "demo",
        orgId,
        appType: "data_app",
        fcFunctionName: "tc-app-1",
        ossObjectName: "apps/app-1/code.zip",
      },
    );
    assert.match(calls[0].env.DATABASE_URL, /@192\.168\.0\.23:5432\/tc_org_/);
    assert.doesNotMatch(calls[0].env.DATABASE_URL, /@db/);
  } finally {
    for (const [k, v] of [
      ["APPS_FC_VPC_ID", prev.vpc],
      ["APPS_FC_VSWITCH_ID", prev.vsw],
      ["APPS_FC_SECURITY_GROUP_ID", prev.sg],
    ] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("data_app finalize fails when APPS_DB_APP_URL is set but VPC env is missing", async () => {
  const prev = {
    vpc: process.env.APPS_FC_VPC_ID,
    vsw: process.env.APPS_FC_VSWITCH_ID,
    sg: process.env.APPS_FC_SECURITY_GROUP_ID,
  };
  delete process.env.APPS_FC_VPC_ID;
  delete process.env.APPS_FC_VSWITCH_ID;
  delete process.env.APPS_FC_SECURITY_GROUP_ID;
  try {
    await assert.rejects(
      () => finalizeDeploy(
        {
          appsAdminUrl: "postgres://postgres:pw@public.example:5432/postgres",
          appsAppUrl: "postgres://postgres:pw@internal.example:5432/postgres",
          provisionDb: async () => ({
            schema: "app_demo",
            role: "app_role",
            database: "tc_org_x",
            connectionString: "postgres://app_role:pw@public.example:5432/tc_org_x",
          }),
          fcOps: {
            ensureFunction: async () => { throw new Error("must not be called"); },
            ensureHttpTrigger: async () => "unused",
          },
        },
        {
          appId: "app-1",
          slug: "demo",
          orgId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          appType: "data_app",
          fcFunctionName: "tc-app-1",
          ossObjectName: "k",
        },
      ),
      /APPS_FC_VPC_ID/,
    );
  } finally {
    for (const [k, v] of [
      ["APPS_FC_VPC_ID", prev.vpc],
      ["APPS_FC_VSWITCH_ID", prev.vsw],
      ["APPS_FC_SECURITY_GROUP_ID", prev.sg],
    ] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("data_app finalize fails when admin URL is compose-internal and APPS_DB_APP_URL is missing", async () => {
  await assert.rejects(
    () => finalizeDeploy(
      {
        appsAdminUrl: "postgres://postgres:pw@db:5432/postgres",
        provisionDb: async () => ({
          schema: "app_demo",
          role: "app_role",
          database: "tc_org_x",
          connectionString: "postgres://app_role:pw@db:5432/tc_org_x",
        }),
        fcOps: {
          ensureFunction: async () => { throw new Error("must not be called"); },
          ensureHttpTrigger: async () => "unused",
        },
      },
      {
        appId: "app-1",
        slug: "demo",
        orgId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        appType: "data_app",
        fcFunctionName: "tc-app-1",
        ossObjectName: "k",
      },
    ),
    /APPS_DB_APP_URL is required/,
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
      platformAuthEnv: {
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

// ── custom domain ─────────────────────────────────────────────────────────
//
// `*.fcapp.run` refuses to forward any 3xx with `ExternalRedirectForbidden`
// (Alibaba product change, 2025-04-01), so an app that merely normalises a
// trailing slash is broken on it. Every deploy binds a custom domain instead.

test("finalizeDeploy binds a custom domain and serves the app on it", async () => {
  const prev = process.env.APPS_FC_ROUTE_DOMAIN;
  process.env.APPS_FC_ROUTE_DOMAIN = "fc-apps.example.com";
  try {
    const bound: string[][] = [];
    const out = await finalizeDeploy(
      {
        fcOps: {
          ensureFunction: async () => {},
          ensureHttpTrigger: async () => "https://fn.example.fcapp.run",
          ensureCustomDomain: async (fn: string, domain: string) => {
            bound.push([fn, domain]);
            return `http://${domain}`;
          },
        },
      },
      {
        appId: "3f1c9a2e-0000-4000-8000-000000000abc",
        slug: "demo",
        appType: "static_web",
        fcFunctionName: "tc-app-3f1c9a2e-0000-4000-8000-000000000abc",
        ossObjectName: "apps/x/code.zip",
      },
    );
    // Same label as the public host, so the two correlate in logs on both sides.
    assert.deepEqual(bound, [[
      "tc-app-3f1c9a2e-0000-4000-8000-000000000abc",
      "demo-3f1c9a2e.fc-apps.example.com",
    ]]);
    assert.deepEqual(out, { fcEndpoint: "http://demo-3f1c9a2e.fc-apps.example.com" });
  } finally {
    if (prev === undefined) delete process.env.APPS_FC_ROUTE_DOMAIN;
    else process.env.APPS_FC_ROUTE_DOMAIN = prev;
  }
});

test("finalizeDeploy falls back to the trigger URL with no route domain", async () => {
  const prev = process.env.APPS_FC_ROUTE_DOMAIN;
  delete process.env.APPS_FC_ROUTE_DOMAIN;
  try {
    const out = await finalizeDeploy(
      {
        fcOps: {
          ensureFunction: async () => {},
          ensureHttpTrigger: async () => "https://fn.example.fcapp.run",
          ensureCustomDomain: async () => { throw new Error("must not be called"); },
        },
      },
      {
        appId: "3f1c9a2e-0000-4000-8000-000000000abc",
        slug: "demo",
        appType: "static_web",
        fcFunctionName: "tc-app-x",
        ossObjectName: "apps/x/code.zip",
      },
    );
    assert.deepEqual(out, { fcEndpoint: "https://fn.example.fcapp.run" });
  } finally {
    if (prev !== undefined) process.env.APPS_FC_ROUTE_DOMAIN = prev;
  }
});

test("deleting an app drops its custom domain too", async () => {
  // The domain outlives the function and the quota is account-wide, so leaking
  // one per deleted app is how a later create starts failing for a different
  // app entirely.
  const prev = process.env.APPS_FC_ROUTE_DOMAIN;
  process.env.APPS_FC_ROUTE_DOMAIN = "fc-apps.example.com";
  try {
    const dropped: string[] = [];
    const { teardownAppResources } = await import("../../src/lib/provisioning/app-delete.js");
    await teardownAppResources(
      {
        fcOps: {
          deleteFunction: async () => {},
          deleteCustomDomain: async (d: string) => { dropped.push(d); },
        },
      },
      { appId: "3f1c9a2e-0000-4000-8000-000000000abc", slug: "demo" },
    );
    assert.deepEqual(dropped, ["demo-3f1c9a2e.fc-apps.example.com"]);
  } finally {
    if (prev === undefined) delete process.env.APPS_FC_ROUTE_DOMAIN;
    else process.env.APPS_FC_ROUTE_DOMAIN = prev;
  }
});

test("a failing custom-domain delete never blocks the rest of teardown", async () => {
  const prev = process.env.APPS_FC_ROUTE_DOMAIN;
  process.env.APPS_FC_ROUTE_DOMAIN = "fc-apps.example.com";
  try {
    let deletedFn = false;
    const { teardownAppResources } = await import("../../src/lib/provisioning/app-delete.js");
    const out = await teardownAppResources(
      {
        fcOps: {
          deleteFunction: async () => { deletedFn = true; },
          deleteCustomDomain: async () => { throw new Error("gone"); },
        },
      },
      { appId: "3f1c9a2e-0000-4000-8000-000000000abc", slug: "demo" },
    );
    assert.ok(deletedFn);
    assert.deepEqual(out, { archivedRepoUrl: null });
  } finally {
    if (prev === undefined) delete process.env.APPS_FC_ROUTE_DOMAIN;
    else process.env.APPS_FC_ROUTE_DOMAIN = prev;
  }
});

// --- Container apps: a deploy that ships an image instead of a code archive.

test("a container app is minted a registry to push to, not an upload URL", async () => {
  let minted: { appId: string; sha: string | null | undefined } | null = null;
  const out = await startDeploy(
    {
      mintUploadUrl: async () => {
        throw new Error("a container deploy must not mint an OSS upload");
      },
      mintImagePush: async (appId, gitCommitSha) => {
        minted = { appId, sha: gitCommitSha };
        return {
          reference: `registry.cn-shenzhen.aliyuncs.com/ns/tc-app-${appId}:abc1234`,
          registry: "registry.cn-shenzhen.aliyuncs.com",
          username: "temp-user",
          password: "temp-token",
        };
      },
    },
    { appId: "app-1", region: "cn-shenzhen", buildKind: "container", gitCommitSha: "abc1234" },
  );
  assert.deepEqual(minted, { appId: "app-1", sha: "abc1234" });
  assert.equal(out.presignedPut, undefined);
  assert.equal(out.ossObjectName, undefined);
  assert.equal(out.image?.username, "temp-user");
  assert.match(out.image?.reference ?? "", /tc-app-app-1:abc1234$/);
});

test("a container deploy on a deployment with no registry names the variable", async () => {
  // The 503 a node app never sees: everything else about this deployment works,
  // and "not configured" with nothing named costs an SSH session to diagnose.
  await assert.rejects(
    () =>
      startDeploy(
        {
          mintUploadUrl: async () => "https://oss.example/put",
          imagePushUnavailable: "APPS_REGISTRY_HOST is not set",
        },
        { appId: "app-1", region: "cn-shenzhen", buildKind: "container" },
      ),
    (e: any) => {
      assert.equal(e.statusCode ?? e.status, 503);
      assert.match(String(e.message), /APPS_REGISTRY_HOST/);
      return true;
    },
  );
});

test("an app that declares nothing still gets the upload handle", async () => {
  // Every client older than container support sends no runtime at all.
  const out = await startDeploy(
    { mintUploadUrl: async (k: string) => `https://oss.example/${k}` },
    { appId: "app-1", region: "cn-shenzhen" },
  );
  assert.ok(out.presignedPut);
  assert.equal(out.image, undefined);
});

test("a container declaration has no entry, and a code app may not send an image", () => {
  const spec = parseAppDeployDeclaration({
    build: { kind: "container" },
    start: { port: 5000, healthCheckPath: "/api/health" },
  });
  assert.equal(spec.build.kind, "container");
  assert.equal(spec.start.healthCheckPath, "/api/health");

  // The image belongs to the runtime that has one. Accepting it for an archive
  // deploy would let a client point the function at an unrelated build.
  assert.equal(parseDeployedImage("registry/ns/app:sha", spec), "registry/ns/app:sha");
  assert.throws(() => parseDeployedImage("", spec), /must finalize with its image/);
  const node = parseAppDeployDeclaration({
    build: { kind: "node", output: ".output" },
    start: {
      fcRuntime: "custom.debian10",
      command: ["/opt/nodejs20/bin/node"],
      args: ["server/index.mjs"],
      port: 9000,
    },
  });
  assert.equal(parseDeployedImage(undefined, node), undefined);
  assert.throws(() => parseDeployedImage("registry/ns/app:sha", node), /only accepted for a container/);
});

test("a health check path that is not a path is refused", () => {
  assert.throws(
    () => parseAppDeployDeclaration({
      build: { kind: "container" },
      start: { port: 5000, healthCheckPath: "api/health" },
    }),
    /healthCheckPath must start with/,
  );
});

test("the deploy gate accepts every declared build kind", () => {
  assertDeployAllowed({ id: "app-1", slug: "notes", runtime: "container", authMode: "none" });
  assertDeployAllowed({ id: "app-1", slug: "notes", runtime: "python", authMode: "none" });
  assert.throws(() => assertDeployAllowed({ id: "app-1", slug: "notes", runtime: "ruby", authMode: "none" }), /not available/);
});

test("finalizeDeploy refuses an image outside the app's own repository", async () => {
  // Unchecked, this is how one app's deploy points its function at another
  // app's image: the deploy token proves who started *this* deploy, not what
  // the image is. And the refusal has to land before anything is provisioned.
  const calls: string[] = [];
  const deps = {
    appsAdminUrl: "postgres://host:5432/postgres",
    provisionDb: async () => {
      calls.push("provisionDb");
      throw new Error("must not be reached");
    },
    ensureLogStore: async () => { calls.push("ensureLogStore"); },
    fcOps: {
      ensureFunction: async () => { calls.push("ensureFunction"); },
      ensureHttpTrigger: async () => { calls.push("trigger"); return "https://fn.example.fcapp.run"; },
    },
    ownsImage: (appId: string, image: string) =>
      image.startsWith(`registry.example.com/apps/tc-app-${appId}:`),
  };
  const input = {
    appId: "app-1",
    slug: "demo",
    orgId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    appType: "data_app",
    fcFunctionName: "tc-app-app-1",
    ossObjectName: "apps/app-1/code.zip",
  };

  await assert.rejects(
    () => finalizeDeploy(deps as never, { ...input, image: "registry.example.com/apps/tc-app-app-2:sha" }),
    /this app's own repository/,
  );
  assert.deepEqual(calls, [], "nothing was provisioned for a rejected image");

  // The app's own image still finalizes.
  const out = await finalizeDeploy(
    { ...deps, provisionDb: async () => ({
        schema: "app_demo",
        role: "app_role",
        database: "tc_org_x",
        connectionString: "postgres://app_role:pw@host:5432/tc_org_x?options=-c%20search_path%3Dapp_demo",
      }) } as never,
    { ...input, image: "registry.example.com/apps/tc-app-app-1:sha" },
  );
  assert.deepEqual(out, { fcEndpoint: "https://fn.example.fcapp.run" });
});

test("finalizeDeploy leaves the image unchecked where no registry is configured", async () => {
  // A deployment with no registry has no container app to finalize —
  // startDeploy refuses one before a build runs — so an absent `ownsImage`
  // must not turn into a refusal for the archive apps that do deploy there.
  let ensured: any;
  const out = await finalizeDeploy(
    {
      fcOps: {
        ensureFunction: async (_n: string, a: any) => { ensured = a; },
        ensureHttpTrigger: async () => "https://fn.example.fcapp.run",
      },
    } as never,
    {
      appId: "app-1",
      slug: "demo",
      appType: "static_web",
      fcFunctionName: "tc-app-app-1",
      ossObjectName: "apps/app-1/code.zip",
      image: "anything.example.com/whatever:1",
    },
  );
  assert.deepEqual(out, { fcEndpoint: "https://fn.example.fcapp.run" });
  assert.equal(ensured.image, "anything.example.com/whatever:1");
});
