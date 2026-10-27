import { createSupabaseBusinessRepository } from "../../src/lib/supabase-repo.js";

// Shared external DB/provider fixtures. Defaults preserve existing repository-test
// semantics; app insertion and selected-column projection are explicit overrides.
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
//
// `creatorOnlyAppUpdates` mimics RLS `apps_update_if_creator` on a caller-scoped
// client: an `apps` UPDATE matches no row unless the caller (`actorRow`) created
// it. `serviceRole()` is a second double over the same rows with no RLS, for
// writes the repository escalates.
export function appsSupabase({ seed = {}, actorRow = { id: "actor-app-1" }, calls = [],
  projectSelects = false, appInsertDefaults = { app_code: "a-k7m2q9vx4n8p" }, appInsertId,
  creatorOnlyAppUpdates = false, sharedState,
}: any = {}): any {
  const state: any = sharedState ?? {
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
    serviceRole: () => appsSupabase({ actorRow, calls, projectSelects, appInsertDefaults, appInsertId, sharedState: state }),
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
        if (creatorOnlyAppUpdates && table === "apps" && ctx.op === "update") {
          rows = rows.filter((r) => r.created_by_actor_id === actorRow?.id);
        }
        if (typeof ctx.limitCount === "number") rows = rows.slice(0, ctx.limitCount);
        return rows;
      };
      // Older repository tests intentionally read complete rows. Integration opts in
      // to projection so an omitted identity column cannot silently survive a select.
      const project = (row: any) => !projectSelects || !row || !ctx.columns || ctx.columns === "*" ? row
        : Object.fromEntries(ctx.columns.split(",").map((column: string) => column.trim()).map((column: string) => [column, row[column]]));
      const builder: any = {
        not(col: string, operator: string, val: any) {
          if (operator !== "is") throw new Error("unsupported test filter");
          ctx.neqFilters[col] = val;
          return builder;
        },
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
            ...(table === "apps" ? appInsertDefaults : {}),
            ...row, id: row.id ?? (table === "apps" && appInsertId ? appInsertId : `${table}-id-1`),
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
    // Shared lifecycle fence simulation. Callers may wrap RPC to capture their
    // scenario's snapshot; trigger/worker persistence is verified separately in SQL.
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

export function fakeGitea(over: Record<string, unknown> = {}) {
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

export function appsRepo(supabase: any, extra: any = {}) {
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
