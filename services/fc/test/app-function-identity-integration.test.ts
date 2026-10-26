import { test } from "node:test";
import assert from "node:assert/strict";
import { jwtVerify } from "jose";
import { createSupabaseBusinessRepository } from "../src/lib/supabase-repo.js";
import { startDeploy, finalizeDeploy } from "../src/lib/provisioning/app-deploy.js";
import { cleanupAppDeployment } from "../src/lib/provisioning/app-undeploy.js";
import { makeSupabaseVanityLookup, proxyToApp, __resetVanityCache } from "../src/lib/apps-vanity.js";
import { originJwks } from "../src/lib/apps-origin-auth.js";
import { ORIGIN_CONFIG, installOriginEnv } from "./fixtures/apps-origin-auth/config.js";

// External DB adapter, kept stateful across creation, deployment and cleanup.
// SQL trigger/worker effects are explicit below; native pgTAP verifies those separately.
function appsAuth(userId = "user-app-1") {
  return {
    async getUser() {
      return { data: { user: { id: userId } }, error: null };
    },
  };
}

// Stateful supabase double for apps tests. `seed` provides rows keyed by table.
// `actorRow` is what the actors lookup (resolveCurrentMemberActor) returns.
// Select filters (eq / is / in) are applied so workspace upsert dedup lookups
// can find seeded rows the same way PostgREST would.
function appsSupabase({ seed = {}, actorRow = { id: "actor-app-1" }, calls = [] }: any = {}) {
  const state: any = {
    apps: [...(seed.apps ?? [])],
    actors: [...(seed.actors ?? [])],
    workspaces: [...(seed.workspaces ?? [])],
    sessions: [...(seed.sessions ?? [])],
    app_member_access: [...(seed.app_member_access ?? [])],
    app_env_vars: [...(seed.app_env_vars ?? [])],
    app_secrets: [...(seed.app_secrets ?? [])],
    app_cron_jobs: [...(seed.app_cron_jobs ?? [])],
    // resolveTeamOrgId reads this. It defaults to a team WITH an org because
    // createApp now refuses a team without one (409 team_has_no_org) — the
    // app's tenant is settled at creation so `apps.org_id` can be NOT NULL.
    // A test that wants the no-org case seeds `teams: []` explicitly.
    teams: [...(seed.teams ?? [{ id: "team-1", oid: "org-1" }])],
    agents: [...(seed.agents ?? [])],
    session_participants: [...(seed.session_participants ?? [])],
    agent_member_access: [...(seed.agent_member_access ?? [])],
  };
  return {
    auth: appsAuth(),
    from(table: string) {
      const ctx: any = { table, op: null, filters: {}, isFilters: {}, neqFilters: {}, inFilters: {}, limitCount: null };
      // `resolveCurrentMemberActor` filters `actor_type = 'member'` and the
      // agent git-credential path filters `'agent'`. A seeded `actorRow` that
      // names its own type must answer only the matching lookup; one that does
      // not (most tests) still answers both, as it always has.
      const matchActor = () => {
        if (ctx.filters.id) {
          const seeded = (state.actors ?? []).find((r: any) => r.id === ctx.filters.id);
          if (seeded) return seeded;
        }
        if (!actorRow) return null;
        const wanted = ctx.filters.actor_type;
        if (wanted && actorRow.actor_type && actorRow.actor_type !== wanted) return null;
        return actorRow;
      };
      const matchRows = () => {
        let rows = [...(state[table] ?? [])];
        for (const [col, val] of Object.entries(ctx.filters)) {
          rows = rows.filter((r) => r[col as string] === val);
        }
        for (const [col, val] of Object.entries(ctx.neqFilters)) rows = rows.filter(r => r[col] !== val);
        for (const [col, val] of Object.entries(ctx.isFilters)) {
          rows = rows.filter((r) => (val === null ? r[col as string] == null : r[col as string] === val));
        }
        for (const [col, vals] of Object.entries(ctx.inFilters)) {
          rows = rows.filter((r) => (vals as any[]).includes(r[col as string]));
        }
        if (typeof ctx.limitCount === "number") rows = rows.slice(0, ctx.limitCount);
        return rows;
      };
      const project = (row: any) => !row || !ctx.columns || ctx.columns === "*" ? row
        : Object.fromEntries(ctx.columns.split(",").map((column: string) => column.trim()).map((column: string) => [column, row[column]]));
      const builder: any = {
        not(col: string, operator: string, val: any) { assert.equal(operator, "is"); ctx.neqFilters[col] = val; return builder; },
        neq(col: string, val: any) { ctx.neqFilters[col] = val; return builder; },
        select(columns: string) {
          ctx.columns = columns;
          calls.push({ table, op: ctx.op ? `${ctx.op}.select` : "select", columns });
          return builder;
        },
        insert(row: any) {
          ctx.op = "insert";
          calls.push({ table, op: "insert", row });
          // mutate state so the inserted row is what subsequent .single() returns
          const inserted = {
            ...(table === "apps" ? { app_code: "a-p35cg2kk6bh3", provision_status: "ready" } : {}),
            ...row, id: row.id ?? (table === "apps" ? "76af539e-5341-4e96-bda7-6c8dacf2b092" : `${table}-id-1`),
          };
          state[table] = [inserted];
          ctx.inserted = inserted;
          return builder;
        },
        update(row: any) {
          ctx.op = "update";
          calls.push({ table, op: "update", row });
          ctx.update = row;
          return builder;
        },
        upsert(row: any, options?: any) {
          ctx.op = "upsert";
          calls.push({ table, op: "upsert", row, options });
          const upserted = { ...row, id: row.id ?? `${table}-id-${(state[table]?.length ?? 0) + 1}` };
          if (!upserted.created_at) upserted.created_at = new Date().toISOString();
          if (!upserted.updated_at) upserted.updated_at = new Date().toISOString();
          if (!state[table]) state[table] = [];
          let idx = -1;
          if (table === "app_member_access" && options?.onConflict === "app_id,member_id") {
            idx = state[table].findIndex(
              (r: any) => r.app_id === upserted.app_id && r.member_id === upserted.member_id,
            );
          } else {
            idx = state[table].findIndex((r: any) => r.id === upserted.id);
          }
          if (idx >= 0) state[table][idx] = { ...state[table][idx], ...upserted };
          else state[table].push(upserted);
          ctx.inserted = state[table].find(
            (r: any) => (table === "app_member_access" && options?.onConflict === "app_id,member_id")
              ? r.app_id === upserted.app_id && r.member_id === upserted.member_id
              : r.id === upserted.id,
          );
          return builder;
        },
        delete() {
          ctx.op = "delete";
          calls.push({ table, op: "delete" });
          return builder;
        },
        eq(column: string, value: any) {
          ctx.filters[column] = value;
          calls.push({ table, op: `${ctx.op ?? "select"}.eq`, column, value });
          return builder;
        },
        is(column: string, value: any) {
          ctx.isFilters[column] = value;
          calls.push({ table, op: `${ctx.op ?? "select"}.is`, column, value });
          return builder;
        },
        in(column: string, values: any[]) {
          ctx.inFilters[column] = values;
          calls.push({ table, op: `${ctx.op ?? "select"}.in`, column, values });
          return builder;
        },
        order() { return builder; },
        // Chainable like supabase-js: limit() returns the (thenable) builder so
        // a trailing .maybeSingle()/.single() still works; awaiting it yields the
        // table rows (used by listApps / workspace dedup lookups).
        limit(count: number) {
          ctx.limitCount = count;
          return builder;
        },
        single() {
          if (ctx.op === "insert" || ctx.op === "upsert") return Promise.resolve({ data: ctx.inserted, error: null });
          if (ctx.op === "update") {
            const matched = matchRows();
            const base = matched[0] ?? state[table]?.[0] ?? {};
            const merged = { ...base, ...ctx.update };
            if (base?.id) {
              const idx = state[table].findIndex((r: any) => r.id === base.id);
              if (idx >= 0) state[table][idx] = merged;
              else state[table] = [merged];
            } else {
              state[table] = [merged];
            }
            return Promise.resolve({ data: merged, error: null });
          }
          // plain select: actors lookup returns the actor row
          if (table === "actors") return Promise.resolve({ data: matchActor(), error: null });
          return Promise.resolve({ data: project(matchRows()[0] ?? null), error: null });
        },
        maybeSingle() {
          if (table === "actors") return Promise.resolve({ data: matchActor(), error: null });
          if (ctx.op === "delete") {
            const matched = matchRows();
            state[table] = (state[table] ?? []).filter((r: any) => !matched.includes(r));
            return Promise.resolve({ data: null, error: null });
          }
          if (ctx.op === "update") {
            const matched = matchRows();
            const base = matched[0];
            if (!base) return Promise.resolve({ data: null, error: null });
            const merged = { ...base, ...ctx.update };
            const idx = state[table].findIndex((r: any) => r.id === base.id);
            if (idx >= 0) state[table][idx] = merged;
            return Promise.resolve({ data: merged, error: null });
          }
          return Promise.resolve({ data: project(matchRows()[0] ?? null), error: null });
        },
        then(resolve: any, reject: any) {
          if (ctx.op === "update") {
            const matched = matchRows();
            state[table] = state[table].map((row: any) => matched.includes(row) ? { ...row, ...ctx.update } : row);
          }
          return Promise.resolve({ data: matchRows().map(project), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    async rpc(name, args) {
      state.app_lifecycle_operations ??= [];
      const active=state.app_lifecycle_operations.find(r=>r.app_id===args.p_app_id && r.status!=='succeeded');
      if (name==='begin_app_lifecycle') {
        if(active) return {data:null,error:{code:'55000'}};
        const op={id:'operation-'+(state.app_lifecycle_operations.length+1),app_id:args.p_app_id,kind:args.p_kind,token:args.p_token,status:'pending',in_flight:false,steps:{},snapshot:{}};
        state.app_lifecycle_operations.push(op);return {data:op,error:null};
      }
      if(name==='finish_app_lifecycle') {const op=state.app_lifecycle_operations.find(r=>r.id===args.p_operation_id);if(op)op.status='succeeded';return {data:null,error:null};}
      return { data: [], error: null };
    },
  };
}

function fakeGitea(over: Record<string, unknown> = {}) {
  return {
    createAppRepo: async (appId: string) => ({
      cloneUrl: `https://gitea.example/teamclaw-apps/tc-app-${appId}.git`,
      sshUrl: `git@gitea.example:teamclaw-apps/tc-app-${appId}.git`,
    }),
    createDeployKey: async () => ({ id: 1 }),
    listDeployKeys: async () => [],
    deleteDeployKey: async () => {},
    archiveAndRenameAppRepo: async (appId: string) => ({
      sshUrl: `git@gitea.example:teamclaw-apps/deleted-tc-app-${appId}.git`,
    }),
    getRepoHead: async () => ({ sha: "abc123", branch: "main" }),
    compareCommits: async () => 4,
    ...over,
  };
}

function appsRepo(supabase: any, extra: any = {}) {
  return createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => supabase,
    createServiceRoleClient: () => supabase,
    gitea: fakeGitea(),
    validateAppOrigin: () => ({}),
    ...extra,
  });
}


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
