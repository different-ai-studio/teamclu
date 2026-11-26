import { makeGiteaForge } from "../../src/lib/forge/index.js";
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
/** `amux.app_inherited_agents` over the in-memory tables. */
function inheritedAgents(state: any, appId: string) {
  const app = (state.apps ?? []).find((a: any) => a.id === appId);
  if (!app) return [];
  const rank: Record<string, number> = { admin: 0, write: 1, read: 2 };
  const owners = new Map<string, string>();
  const offer = (actorId: string | null | undefined, level: string) => {
    if (!actorId) return;
    const prev = owners.get(actorId);
    if (!prev || rank[level] < rank[prev]) owners.set(actorId, level);
  };
  offer(app.created_by_actor_id, "admin");
  for (const g of state.app_member_access ?? []) if (g.app_id === appId) offer(g.member_id, g.permission_level);
  const actor = (id: string) => (state.actors ?? []).find((a: any) => a.id === id);
  const rows: any[] = [];
  for (const [ownerId, level] of owners) {
    const owner = actor(ownerId);
    if (!owner || owner.actor_type !== "member" || owner.team_id !== app.team_id) continue;
    for (const g of state.agents ?? []) {
      if (g.owner_member_id !== ownerId || g.status !== "active") continue;
      const ag = actor(g.id);
      if (!ag || ag.actor_type !== "agent" || ag.team_id !== app.team_id) continue;
      rows.push({ agent_id: g.id, owner_actor_id: ownerId, permission_level: level });
    }
  }
  return rows;
}

/**
 * The platform tables P2.1's triggers keep in step with the legacy ones
 * (20261125200000), derived on every read the same way: app_links from the app
 * row, user grants from app_member_access, org grants from `visibility: team`,
 * delegations from active agents. Derived here, as the projection is in the
 * real database until P3.4. Writes to them are recorded in `calls` and
 * otherwise ignored: P3.2's direct writes only settle what the projection
 * already holds. An actor's account is its `user_id`; the caller's actor
 * (`actorRow`) without one is the signed-in test user.
 */
const PROJECTED_TABLES = new Set(["app_links", "app_grants", "app_delegations"]);
/** An actor's account: its `user_id`, the caller's actor's the signed-in user, else a stand-in. */
function accountOf(state: any, actorRow: any, callerUserId: string, id: string | null | undefined): string | null {
  if (!id) return null;
  const a = (state.actors ?? []).find((x: any) => x.id === id) ?? (actorRow?.id === id ? actorRow : null);
  if (a?.user_id) return a.user_id;
  return actorRow?.id === id ? callerUserId : `user:${id}`;
}
function projectedTables(state: any, actorRow: any, callerUserId: string) {
  const userOf = (id: string | null | undefined) => accountOf(state, actorRow, callerUserId, id);
  const level = (l: string) => ({ view: "read", prompt: "write" } as Record<string, string>)[l] ?? l;
  const apps = state.apps ?? [];
  return {
    app_links: apps.map((a: any) => ({
      app_id: a.id, team_id: a.team_id ?? null, workspace_id: a.workspace_id ?? null,
      created_by_actor_id: a.created_by_actor_id ?? null,
    })),
    app_grants: [
      ...(state.app_member_access ?? []).map((g: any) => ({
        app_id: g.app_id, principal_user_id: userOf(g.member_id), principal_org_id: null,
        level: level(g.permission_level), granted_by_user_id: userOf(g.granted_by_member_id),
        source: "legacy", legacy_member_id: g.member_id, created_at: g.created_at ?? null,
      })),
      ...apps.filter((a: any) => a.visibility === "team").map((a: any) => ({
        // apps.org_id is NOT NULL in the database; a test row without one is in its team's org.
        app_id: a.id, principal_user_id: null,
        principal_org_id: a.org_id ?? (state.teams ?? []).find((t: any) => t.id === a.team_id)?.oid ?? "org-1", level: "read",
        granted_by_user_id: null, source: "legacy", legacy_member_id: null, created_at: a.created_at ?? null,
      })),
    ],
    app_delegations: (state.agents ?? [])
      .filter((g: any) => g.status === "active" && g.owner_member_id)
      .map((g: any) => ({ delegate_user_id: userOf(g.id), principal_user_id: userOf(g.owner_member_id), source_agent_id: g.id }))
      .filter((d: any) => d.delegate_user_id && d.principal_user_id && d.delegate_user_id !== d.principal_user_id),
  };
}

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
    session_read_markers: [...(seed.session_read_markers ?? [])],
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
        let rows = PROJECTED_TABLES.has(table)
          ? [...(projectedTables(state, actorRow, "user-app-1") as any)[table]]
          : [...(state[table] ?? [])];
        // `app_links!inner(team_id)` embedded in an apps select, filtered on
        // `app_links.team_id`, as PostgREST does.
        const embedded = Object.entries(ctx.filters).filter(([col]) => col.startsWith("app_links."));
        if (table === "apps" && embedded.length) {
          const links = projectedTables(state, actorRow, "user-app-1").app_links;
          for (const [col, val] of embedded) {
            const key = col.slice("app_links.".length);
            rows = rows.filter((r) => links.some((l: any) => l.app_id === r.id && l[key] === val));
          }
        }
        for (const [col, val] of Object.entries(ctx.filters)) {
          if (col.startsWith("app_links.")) continue;
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
      // apps.created_by_user_id is P2.1's BEFORE trigger's, from the creating actor.
      const derive = (row: any) => table === "apps" && row && row.created_by_user_id === undefined
        ? { ...row, created_by_user_id: accountOf(state, actorRow, "user-app-1", row.created_by_actor_id) }
        : row;
      const project = (raw: any) => {
        const row = derive(raw);
        return !projectSelects || !row || !ctx.columns || ctx.columns === "*" ? row
          : Object.fromEntries(ctx.columns.split(",").map((column: string) => column.trim()).map((column: string) => [column, row[column]]));
      };
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
          if (PROJECTED_TABLES.has(table)) ctx.projectedWrite = true;
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
          if (PROJECTED_TABLES.has(table)) ctx.projectedWrite = true;
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
          if (PROJECTED_TABLES.has(table)) ctx.projectedWrite = true;
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
          if (ctx.projectedWrite) return Promise.resolve({ data: null, error: null });
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
          if (ctx.projectedWrite) return Promise.resolve({ data: null, error: null });
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
          if (ctx.projectedWrite || (PROJECTED_TABLES.has(table) && ctx.op === "update")) {
            return Promise.resolve({ data: [], error: null }).then(resolve, reject);
          }
          if (ctx.op === "update") {
            const matched = matchRows();
            state[table] = state[table].map((row: any) => matched.includes(row) ? { ...row, ...ctx.update } : row);
          }
          if (ctx.op === "delete") {
            // Removed from state (so a later read sees the delete) and returned,
            // as PostgREST does for a delete followed by .select().
            const matched = matchRows();
            state[table] = (state[table] ?? []).filter((row: any) => !matched.includes(row));
            return Promise.resolve({ data: matched.map(project), error: null }).then(resolve, reject);
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
      // The agent-inheritance rule of 20261120120000, mirrored in memory
      // (the SQL itself is covered by agent_inherits_owner_app_access.test.sql).
      if (name === 'app_inherited_agents' || name === 'agent_inherited_app_level') {
        const rows = inheritedAgents(state, args.p_app_id);
        if (name === 'app_inherited_agents') return { data: rows, error: null };
        return { data: rows.find((r) => r.agent_id === args.p_actor_id)?.permission_level ?? null, error: null };
      }
      // amux.caller_app_access (20261126100000) over the in-memory legacy
      // tables, which P2.1's triggers project 1:1 in the real database. The
      // caller is `actorRow`. The SQL itself is app_platform_p2_switch.test.sql.
      if (name === 'caller_app_access') {
        const app = (state.apps ?? []).find((a: any) => a.id === args.p_app_id);
        const me = actorRow;
        if (!app || !me?.id) return { data: [], error: null };
        // Legacy words map as P2.1's amux.app_grant_level does.
        const rank: Record<string, number> = { read: 1, write: 2, admin: 3, view: 1, prompt: 2 };
        const name_ = ['', 'read', 'write', 'admin'];
        const isCreator = app.created_by_actor_id === me.id;
        const grant = (state.app_member_access ?? []).find((g: any) => g.app_id === app.id && g.member_id === me.id);
        const direct = Math.max(isCreator ? 3 : 0, rank[grant?.permission_level] ?? 0);
        const viaRow = me.actor_type === 'agent'
          ? inheritedAgents(state, app.id).find((r) => r.agent_id === me.id)
          : null;
        const via = rank[viaRow?.permission_level] ?? 0;
        const top = Math.max(direct, via);
        if (!top) return { data: [], error: null };
        return { data: [{ level: name_[top], delegated: via > direct, is_creator: isCreator }], error: null };
      }
      return { data: [], error: null };
    },
  };
}

/**
 * An in-memory Gitea. `withOwner` returns a view bound to another owner that
 * shares the same state, so a test can see which owner each call acted on;
 * `ops` records every admin call in order.
 */
export function fakeGitea(over: Record<string, unknown> = {}, owner = "teamclaw-apps", shared?: any) {
  const state = shared ?? {
    ops: [] as any[],
    users: new Map<string, string>(),
    orgs: new Set<string>(),
    teams: new Map<string, { id: number; members: Set<string>; repos: Set<string> }>(),
    collaborators: new Map<string, Map<string, string>>(),
    nextTeamId: 1,
  };
  const repoKey = (appId: string) => `${owner}/tc-app-${appId}`;
  const self: any = {
    owner,
    ops: state.ops,
    state,
    withOwner: (o: string) => (o === owner ? self : fakeGitea(over, o, state)),
    ensureUser: async (username: string, fullName: string) => {
      state.ops.push(["ensureUser", username, fullName]);
      state.users.set(username, fullName);
    },
    ensureOrg: async (org: string) => {
      state.ops.push(["ensureOrg", org]);
      state.orgs.add(org);
    },
    findTeamId: async (org: string, name: string) => state.teams.get(`${org}/${name}`)?.id ?? null,
    ensureReadTeam: async (org: string, name: string) => {
      const key = `${org}/${name}`;
      if (!state.teams.has(key)) state.teams.set(key, { id: state.nextTeamId++, members: new Set(), repos: new Set() });
      return state.teams.get(key)!.id;
    },
    listTeamMembers: async (teamId: number) =>
      [...([...state.teams.values()].find((t: any) => t.id === teamId)?.members ?? [])],
    addTeamMember: async (teamId: number, username: string) => {
      state.ops.push(["addTeamMember", teamId, username]);
      [...state.teams.values()].find((t: any) => t.id === teamId)?.members.add(username);
    },
    removeTeamMember: async (teamId: number, username: string) => {
      state.ops.push(["removeTeamMember", teamId, username]);
      [...state.teams.values()].find((t: any) => t.id === teamId)?.members.delete(username);
    },
    setTeamRepo: async (teamId: number, appId: string, present: boolean) => {
      state.ops.push(["setTeamRepo", teamId, repoKey(appId), present]);
      const team = [...state.teams.values()].find((t: any) => t.id === teamId);
      if (present) team?.repos.add(repoKey(appId));
      else team?.repos.delete(repoKey(appId));
    },
    listCollaborators: async (appId: string) =>
      [...(state.collaborators.get(repoKey(appId)) ?? new Map()).entries()].map(([username, permission]) => ({ username, permission })),
    setCollaborator: async (appId: string, username: string, permission: string) => {
      state.ops.push(["setCollaborator", repoKey(appId), username, permission]);
      if (!state.collaborators.has(repoKey(appId))) state.collaborators.set(repoKey(appId), new Map());
      state.collaborators.get(repoKey(appId))!.set(username, permission);
    },
    removeAllAppAccess: async (appId: string) => {
      state.ops.push(["removeAllAppAccess", repoKey(appId)]);
      const collaborators = state.collaborators.get(repoKey(appId))?.size ?? 0;
      state.collaborators.delete(repoKey(appId));
      let teams = 0;
      for (const team of state.teams.values()) if (team.repos.delete(repoKey(appId))) teams += 1;
      return { collaborators, teams };
    },
    removeCollaborator: async (appId: string, username: string) => {
      state.ops.push(["removeCollaborator", repoKey(appId), username]);
      state.collaborators.get(repoKey(appId))?.delete(username);
    },
    createAppRepo: async (appId: string) => {
      state.ops.push(["createAppRepo", owner, appId]);
      return {
        cloneUrl: `https://gitea.example/${owner}/tc-app-${appId}.git`,
        sshUrl: `git@gitea.example:${owner}/tc-app-${appId}.git`,
      };
    },
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
  return self;
}

/**
 * A repository over `supabase`, with the Gitea forge wired in the way index.ts
 * wires the real one. Tests still say `gitea` / `giteaUnavailableReason` /
 * `giteaAccountAuth` — they become the forge's options here.
 */
export function appsRepo(supabase: any, extra: any = {}) {
  const { gitea, giteaUnavailableReason, giteaAccountAuth, ...rest } = extra;
  return createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => supabase,
    createServiceRoleClient: () => supabase,
    forge: makeGiteaForge({
      gitea: "gitea" in extra ? gitea : fakeGitea(),
      unavailableReason: giteaUnavailableReason,
      accountAuth: giteaAccountAuth,
    }),
    validateAppOrigin: () => ({}),
    ...rest,
  });
}
