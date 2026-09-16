/**
 * Org roles CRUD — routes + repository authz.
 *
 * Design: docs/specs/2026-09-15-org-roles-permissions-design.md §2.1
 * OpenAPI: GET/POST /v1/teams/{teamId}/roles, PATCH/DELETE .../roles/{roleId}
 *
 * Shortcuts RBAC listTeamRoles lives at GET /v1/teams/:teamId/shortcut-roles
 * after the path collision fix (OpenAPI Task 2 claimed /roles for org roles).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { ApiError } from "../src/lib/http-utils.js";
import {
  assignSystemOrgRole,
  deriveHighestTeamRole,
  makeOrgRolesRepo,
  mirrorTeamMembersRole,
} from "../src/lib/supabase-repo/org-roles.js";

const TEAM = "11111111-1111-1111-1111-111111111111";
const ORG = "22222222-2222-2222-2222-222222222222";
const SYSTEM_ROLE = "33333333-3333-3333-3333-333333333333";
const ADMIN_ROLE = "33333333-3333-3333-3333-333333333334";
const MEMBER_ROLE = "33333333-3333-3333-3333-333333333335";
const CUSTOM_ROLE = "44444444-4444-4444-4444-444444444444";
const ACTOR = "55555555-5555-5555-5555-555555555555";
const USER = "66666666-6666-6666-6666-666666666666";
const OTHER_USER = "77777777-7777-7777-7777-777777777777";

const SYSTEM_ITEMS = [
  {
    id: SYSTEM_ROLE,
    orgId: ORG,
    name: "拥有者",
    code: "owner",
    description: "系统角色：拥有者",
    isSystem: true,
    status: "active",
    sort: 10,
    parentRoleId: null,
  },
  {
    id: "33333333-3333-3333-3333-333333333334",
    orgId: ORG,
    name: "管理员",
    code: "admin",
    description: "系统角色：管理员",
    isSystem: true,
    status: "active",
    sort: 20,
    parentRoleId: null,
  },
  {
    id: "33333333-3333-3333-3333-333333333335",
    orgId: ORG,
    name: "成员",
    code: "member",
    description: "系统角色：成员",
    isSystem: true,
    status: "active",
    sort: 30,
    parentRoleId: null,
  },
  {
    id: "33333333-3333-3333-3333-333333333336",
    orgId: ORG,
    name: "财务",
    code: "finance",
    description: "系统角色：财务",
    isSystem: true,
    status: "active",
    sort: 40,
    parentRoleId: null,
  },
];

function fakeRepo(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string, result: unknown = null) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  return {
    calls,
    listOrgRoles: record("listOrgRoles", SYSTEM_ITEMS),
    createOrgRole: record("createOrgRole", {
      id: CUSTOM_ROLE,
      orgId: ORG,
      name: "审计",
      code: "auditor",
      description: null,
      isSystem: false,
      status: "active",
      sort: 50,
      parentRoleId: null,
    }),
    patchOrgRole: record("patchOrgRole", {
      id: CUSTOM_ROLE,
      orgId: ORG,
      name: "审计员",
      code: "auditor",
      description: null,
      isSystem: false,
      status: "active",
      sort: 50,
      parentRoleId: null,
    }),
    deleteOrgRole: record("deleteOrgRole"),
    listMemberRoles: record("listMemberRoles", [
      { id: MEMBER_ROLE, code: "member", name: "成员" },
    ]),
    putMemberRoles: record("putMemberRoles", [
      { id: ADMIN_ROLE, code: "admin", name: "管理员" },
      { id: MEMBER_ROLE, code: "member", name: "成员" },
    ]),
    listTeamRoles: record("listTeamRoles", [{ id: "sr-1", teamId: TEAM, code: "admin", name: "Admin" }]),
    ...overrides,
  };
}

function request(overrides: Record<string, unknown>, repo: unknown) {
  return handleBusinessApiRequest(
    {
      headers: { Authorization: "Bearer caller-token" },
      ...overrides,
    } as never,
    { createRepository: () => repo } as never,
  );
}

// ── Route registration / wiring ─────────────────────────────────────────────

describe("org roles routes", () => {
  test("GET /v1/teams/:teamId/roles lists seeded system roles", async () => {
    const repo = fakeRepo();
    const res = await request({ httpMethod: "GET", path: `/v1/teams/${TEAM}/roles` }, repo);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.items.length, 4);
    assert.deepEqual(
      body.items.map((r: { code: string }) => r.code).sort(),
      ["admin", "finance", "member", "owner"],
    );
    assert.deepEqual(repo.calls[0], { method: "listOrgRoles", args: [TEAM] });
  });

  test("POST /v1/teams/:teamId/roles creates a custom role", async () => {
    const repo = fakeRepo();
    const res = await request(
      {
        httpMethod: "POST",
        path: `/v1/teams/${TEAM}/roles`,
        body: JSON.stringify({ name: "审计", code: "auditor" }),
      },
      repo,
    );
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.code, "auditor");
    assert.equal(body.isSystem, false);
    assert.deepEqual(repo.calls[0], {
      method: "createOrgRole",
      args: [TEAM, { name: "审计", code: "auditor" }],
    });
  });

  test("PATCH system role surfaces 403 from repository", async () => {
    const repo = fakeRepo({
      patchOrgRole: async () => {
        throw new ApiError(403, "forbidden", "系统角色不可修改");
      },
    });
    const res = await request(
      {
        httpMethod: "PATCH",
        path: `/v1/teams/${TEAM}/roles/${SYSTEM_ROLE}`,
        body: JSON.stringify({ name: "hacked" }),
      },
      repo,
    );
    assert.equal(res.statusCode, 403);
  });

  test("DELETE role with bindings surfaces 409 from repository", async () => {
    const repo = fakeRepo({
      deleteOrgRole: async () => {
        throw new ApiError(409, "conflict", "role still has member bindings", {
          details: { bindingCount: 2 },
        });
      },
    });
    const res = await request(
      { httpMethod: "DELETE", path: `/v1/teams/${TEAM}/roles/${CUSTOM_ROLE}` },
      repo,
    );
    assert.equal(res.statusCode, 409);
  });

  test("non-admin create surfaces 403 from repository", async () => {
    const repo = fakeRepo({
      createOrgRole: async () => {
        throw new ApiError(403, "forbidden", "team owner or admin access required");
      },
    });
    const res = await request(
      {
        httpMethod: "POST",
        path: `/v1/teams/${TEAM}/roles`,
        body: JSON.stringify({ name: "x", code: "x" }),
      },
      repo,
    );
    assert.equal(res.statusCode, 403);
  });

  test("GET /v1/teams/:teamId/shortcut-roles calls listTeamRoles (relocated)", async () => {
    const repo = fakeRepo();
    const res = await request(
      { httpMethod: "GET", path: `/v1/teams/${TEAM}/shortcut-roles` },
      repo,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(repo.calls[0], { method: "listTeamRoles", args: [TEAM] });
  });

  test("GET /v1/teams/:teamId/members/:actorId/roles lists member roles", async () => {
    const repo = fakeRepo();
    const res = await request(
      { httpMethod: "GET", path: `/v1/teams/${TEAM}/members/${ACTOR}/roles` },
      repo,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.items[0].code, "member");
    assert.deepEqual(repo.calls[0], { method: "listMemberRoles", args: [TEAM, ACTOR] });
  });

  test("PUT /v1/teams/:teamId/members/:actorId/roles replaces role set", async () => {
    const repo = fakeRepo();
    const res = await request(
      {
        httpMethod: "PUT",
        path: `/v1/teams/${TEAM}/members/${ACTOR}/roles`,
        body: JSON.stringify({ roleIds: [ADMIN_ROLE, MEMBER_ROLE] }),
      },
      repo,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(
      body.items.map((r: { code: string }) => r.code).sort(),
      ["admin", "member"],
    );
    assert.deepEqual(repo.calls[0], {
      method: "putMemberRoles",
      args: [TEAM, ACTOR, [ADMIN_ROLE, MEMBER_ROLE]],
    });
  });
});

// ── Repository authz (in-memory supabase stub) ──────────────────────────────

type RoleRow = {
  id: string;
  org_id: string;
  name: string;
  code: string;
  description: string | null;
  is_system: boolean;
  status: string;
  sort: number;
  parent_role_id: string | null;
};

type BindingRow = {
  id: string;
  user_id: string;
  role_id: string;
  org_id: string;
  status: string;
  store_id: string | null;
};

function makeStubHost(opts: {
  teamRole: string | null;
  roles: RoleRow[];
  bindings?: BindingRow[];
  /** When set, deleteOrgRole binding count uses this instead of bindings.length. */
  bindingCount?: number;
  member?: boolean;
  actorUserId?: string | null;
}) {
  const roles = opts.roles.map((r) => ({ ...r }));
  const bindings: BindingRow[] = (opts.bindings ?? []).map((b) => ({ ...b }));
  let bindingCountOverride = opts.bindingCount;
  const actorUserId = opts.actorUserId === undefined ? USER : opts.actorUserId;
  /** Mirrored `amux.team_members.role` for the ACTOR fixture. */
  const teamMembers: Array<{ team_id: string; member_id: string; role: string | null }> = [
    { team_id: TEAM, member_id: ACTOR, role: null },
  ];

  type Filter = { col: string; val: unknown; op?: string };

  function matchRoleFilters(row: RoleRow, filters: Filter[]) {
    return filters.every((f) => {
      if (f.op === "in") return (f.val as string[]).includes((row as any)[f.col]);
      return (row as any)[f.col] === f.val;
    });
  }

  function matchBindingFilters(row: BindingRow, filters: Filter[]) {
    return filters.every((f) => {
      if (f.op === "in") return (f.val as string[]).includes((row as any)[f.col]);
      if (f.op === "neq") return (row as any)[f.col] !== f.val;
      if (f.op === "is" && f.val === null) return (row as any)[f.col] == null;
      return (row as any)[f.col] === f.val;
    });
  }

  function rolesQuery() {
    const filters: Filter[] = [];
    const api: any = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return api;
      },
      in(col: string, vals: string[]) {
        filters.push({ col, val: vals, op: "in" });
        return api;
      },
      order: async () => ({
        data: roles.filter((r) => matchRoleFilters(r, filters)),
        error: null,
      }),
      maybeSingle: async () => ({
        data: roles.find((r) => matchRoleFilters(r, filters)) ?? null,
        error: null,
      }),
      single: async () => {
        const row = roles.find((r) => matchRoleFilters(r, filters)) ?? null;
        return { data: row, error: null };
      },
      then(resolve: (v: unknown) => void) {
        return Promise.resolve({
          data: roles.filter((r) => matchRoleFilters(r, filters)),
          error: null,
        }).then(resolve);
      },
    };
    return api;
  }

  function rolesUsersQuery(mode: "select" | "delete" | "insert", payload?: any) {
    if (mode === "insert") {
      const row: BindingRow = {
        id: `ru-${bindings.length + 1}`,
        user_id: payload.user_id,
        role_id: payload.role_id,
        org_id: payload.org_id,
        status: payload.status ?? "active",
        store_id: payload.store_id ?? null,
      };
      bindings.push(row);
      return {
        select() {
          return { single: async () => ({ data: row, error: null }) };
        },
        then(resolve: (v: unknown) => void) {
          return Promise.resolve({ data: row, error: null }).then(resolve);
        },
      };
    }

    const filters: Filter[] = [];
    const api: any = {
      select(_cols?: string, selOpts?: { count?: string; head?: boolean }) {
        api._countHead = Boolean(selOpts?.count && selOpts?.head);
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return api;
      },
      neq(col: string, val: unknown) {
        filters.push({ col, val, op: "neq" });
        return api;
      },
      in(col: string, vals: string[]) {
        filters.push({ col, val: vals, op: "in" });
        return api;
      },
      is(col: string, val: unknown) {
        filters.push({ col, val, op: "is" });
        return api;
      },
      maybeSingle: async () => ({
        data: bindings.find((b) => matchBindingFilters(b, filters)) ?? null,
        error: null,
      }),
      then(resolve: (v: unknown) => void) {
        const matched = bindings.filter((b) => matchBindingFilters(b, filters));
        if (mode === "delete") {
          for (const b of matched) {
            const idx = bindings.indexOf(b);
            if (idx >= 0) bindings.splice(idx, 1);
          }
          return Promise.resolve({ error: null }).then(resolve);
        }
        if (api._countHead) {
          const count =
            bindingCountOverride !== undefined ? bindingCountOverride : matched.length;
          return Promise.resolve({ count, error: null, data: null }).then(resolve);
        }
        return Promise.resolve({ data: matched, error: null }).then(resolve);
      },
    };
    return api;
  }

  function actorsQuery() {
    const filters: Filter[] = [];
    const api: any = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return api;
      },
      limit() {
        return api;
      },
      maybeSingle: async () => {
        const byId = filters.find((f) => f.col === "id")?.val;
        const byTeam = filters.find((f) => f.col === "team_id")?.val;
        const byUser = filters.find((f) => f.col === "user_id")?.val;
        if (byTeam !== undefined && byTeam !== TEAM) {
          return { data: null, error: null };
        }
        if (byId !== undefined) {
          return {
            data:
              byId === ACTOR
                ? { id: ACTOR, user_id: actorUserId, actor_type: "member" }
                : null,
            error: null,
          };
        }
        if (byUser !== undefined) {
          return {
            data:
              byUser === actorUserId
                ? { id: ACTOR, user_id: actorUserId, actor_type: "member" }
                : null,
            error: null,
          };
        }
        return { data: null, error: null };
      },
    };
    return api;
  }

  function teamMembersQuery() {
    const filters: Filter[] = [];
    let patch: Record<string, unknown> | null = null;
    const api: any = {
      update(row: Record<string, unknown>) {
        patch = row;
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return api;
      },
      then(resolve: (v: unknown) => void) {
        if (patch) {
          for (const row of teamMembers) {
            if (filters.every((f) => (row as any)[f.col] === f.val)) {
              Object.assign(row, patch);
            }
          }
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return api;
  }

  const supabase = {
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "current_team_role") {
        assert.equal(args.target_team_id, TEAM);
        return { data: opts.teamRole, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    from(table: string) {
      if (table === "teams") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: { oid: ORG }, error: null }),
                };
              },
            };
          },
        };
      }
      if (table === "actors") {
        return actorsQuery();
      }
      if (table === "team_members") {
        return teamMembersQuery();
      }
      if (table === "roles") {
        return {
          select() {
            return rolesQuery();
          },
          insert(payload: Record<string, unknown>) {
            const row: RoleRow = {
              id: CUSTOM_ROLE,
              org_id: payload.org_id as string,
              name: payload.name as string,
              code: payload.code as string,
              description: (payload.description as string | null) ?? null,
              is_system: false,
              status: "active",
              sort: (payload.sort as number) ?? 50,
              parent_role_id: null,
            };
            roles.push(row);
            return {
              select() {
                return {
                  single: async () => ({ data: row, error: null }),
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            const filters: Filter[] = [];
            const api: any = {
              eq(col: string, val: unknown) {
                filters.push({ col, val });
                return api;
              },
              select() {
                return {
                  single: async () => {
                    const row = roles.find((r) => matchRoleFilters(r, filters));
                    if (row) Object.assign(row, patch);
                    return { data: row, error: null };
                  },
                };
              },
            };
            return api;
          },
          delete() {
            const filters: Filter[] = [];
            const api: any = {
              eq(col: string, val: unknown) {
                filters.push({ col, val });
                return api;
              },
              then(resolve: (v: unknown) => void) {
                const idx = roles.findIndex((r) => matchRoleFilters(r, filters));
                if (idx >= 0) roles.splice(idx, 1);
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
            return api;
          },
        };
      }
      if (table === "roles_users") {
        return {
          select(cols?: string, selOpts?: { count?: string; head?: boolean }) {
            const q = rolesUsersQuery("select");
            return q.select(cols, selOpts);
          },
          insert(payload: Record<string, unknown>) {
            return rolesUsersQuery("insert", payload);
          },
          update(patch: Record<string, unknown>) {
            const filters: Filter[] = [];
            const api: any = {
              eq(col: string, val: unknown) {
                filters.push({ col, val });
                return api;
              },
              is(col: string, val: unknown) {
                filters.push({ col, val, op: "is" });
                return api;
              },
              then(resolve: (v: unknown) => void) {
                for (const row of bindings) {
                  if (matchBindingFilters(row, filters)) Object.assign(row, patch);
                }
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
            return api;
          },
          delete() {
            return rolesUsersQuery("delete");
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return {
    supabase,
    resolveCallerActorForTeam: async () =>
      opts.member === false ? null : { id: "actor-1" },
    _roles: roles,
    _bindings: bindings,
    _teamMembers: teamMembers,
    setBindingCount(n: number) {
      bindingCountOverride = n;
    },
  };
}

const seededSystem: RoleRow = {
  id: SYSTEM_ROLE,
  org_id: ORG,
  name: "拥有者",
  code: "owner",
  description: "系统角色：拥有者",
  is_system: true,
  status: "active",
  sort: 10,
  parent_role_id: null,
};

const seededAdmin: RoleRow = {
  id: ADMIN_ROLE,
  org_id: ORG,
  name: "管理员",
  code: "admin",
  description: "系统角色：管理员",
  is_system: true,
  status: "active",
  sort: 20,
  parent_role_id: null,
};

const seededMember: RoleRow = {
  id: MEMBER_ROLE,
  org_id: ORG,
  name: "成员",
  code: "member",
  description: "系统角色：成员",
  is_system: true,
  status: "active",
  sort: 30,
  parent_role_id: null,
};

const seededCustom: RoleRow = {
  id: CUSTOM_ROLE,
  org_id: ORG,
  name: "审计",
  code: "auditor",
  description: null,
  is_system: false,
  status: "active",
  sort: 50,
  parent_role_id: null,
};

const systemCatalog = [seededSystem, seededAdmin, seededMember];

describe("makeOrgRolesRepo", () => {
  test("listOrgRoles returns seeded system roles for a member", async () => {
    const host = makeStubHost({
      teamRole: "member",
      roles: [seededSystem],
      member: true,
    });
    const repo = makeOrgRolesRepo(host);
    const items = await repo.listOrgRoles(TEAM);
    assert.equal(items.length, 1);
    assert.equal(items[0].code, "owner");
    assert.equal(items[0].isSystem, true);
    assert.equal(items[0].orgId, ORG);
  });

  test("createOrgRole inserts a custom role for admin", async () => {
    const host = makeStubHost({ teamRole: "admin", roles: [seededSystem] });
    const repo = makeOrgRolesRepo(host);
    const row = await repo.createOrgRole(TEAM, { name: "审计", code: "auditor" });
    assert.equal(row.code, "auditor");
    assert.equal(row.isSystem, false);
    assert.equal(row.orgId, ORG);
  });

  test("patchOrgRole on system role → 403", async () => {
    const host = makeStubHost({ teamRole: "owner", roles: [seededSystem] });
    const repo = makeOrgRolesRepo(host);
    await assert.rejects(
      () => repo.patchOrgRole(TEAM, SYSTEM_ROLE, { name: "nope" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 403);
        assert.match(err.message, /系统角色/);
        return true;
      },
    );
  });

  test("deleteOrgRole with bindings → 409", async () => {
    const host = makeStubHost({
      teamRole: "admin",
      roles: [seededCustom],
      bindingCount: 3,
    });
    const repo = makeOrgRolesRepo(host);
    await assert.rejects(
      () => repo.deleteOrgRole(TEAM, CUSTOM_ROLE),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 409);
        assert.equal((err as ApiError).details?.bindingCount, 3);
        return true;
      },
    );
    assert.equal(host._roles.length, 1, "role row kept when bindings present");
  });

  test("deleteOrgRole without bindings removes role", async () => {
    const host = makeStubHost({
      teamRole: "admin",
      roles: [seededCustom],
      bindingCount: 0,
    });
    const repo = makeOrgRolesRepo(host);
    await repo.deleteOrgRole(TEAM, CUSTOM_ROLE);
    assert.equal(host._roles.length, 0);
  });

  test("createOrgRole as non-admin → 403", async () => {
    const host = makeStubHost({ teamRole: "member", roles: [] });
    const repo = makeOrgRolesRepo(host);
    await assert.rejects(
      () => repo.createOrgRole(TEAM, { name: "x", code: "x" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 403);
        return true;
      },
    );
  });

  test("putMemberRoles replaces the active set", async () => {
    const host = makeStubHost({
      teamRole: "owner",
      roles: systemCatalog,
      bindings: [
        {
          id: "ru-1",
          user_id: USER,
          role_id: MEMBER_ROLE,
          org_id: ORG,
          status: "active",
          store_id: null,
        },
      ],
    });
    const repo = makeOrgRolesRepo(host);
    const items = await repo.putMemberRoles(TEAM, ACTOR, [ADMIN_ROLE, MEMBER_ROLE]);
    assert.deepEqual(items.map((r) => r.code).sort(), ["admin", "member"]);
    assert.equal(host._bindings.length, 2);
    assert.ok(host._bindings.every((b) => b.user_id === USER));
    assert.equal(host._teamMembers[0].role, "admin", "dual-writes highest privilege to team_members.role");
  });

  test("putMemberRoles: inactive role id → 400", async () => {
    const inactive = { ...seededCustom, status: "inactive" };
    const host = makeStubHost({
      teamRole: "owner",
      roles: [...systemCatalog, inactive],
      bindings: [],
    });
    const repo = makeOrgRolesRepo(host);
    await assert.rejects(
      () => repo.putMemberRoles(TEAM, ACTOR, [CUSTOM_ROLE]),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /inactive/i);
        return true;
      },
    );
    assert.equal(host._bindings.length, 0);
  });

  test("putMemberRoles: empty roles dual-writes null to team_members.role", async () => {
    const host = makeStubHost({
      teamRole: "owner",
      roles: systemCatalog,
      bindings: [
        {
          id: "ru-1",
          user_id: USER,
          role_id: MEMBER_ROLE,
          org_id: ORG,
          status: "active",
          store_id: null,
        },
      ],
    });
    host._teamMembers[0].role = "member";
    const repo = makeOrgRolesRepo(host);
    const items = await repo.putMemberRoles(TEAM, ACTOR, []);
    assert.deepEqual(items, []);
    assert.equal(host._teamMembers[0].role, null);
  });

  test("makeOrgRolesRepo does not expose assignSystemOrgRole (caller-JWT footgun)", () => {
    const host = makeStubHost({ teamRole: "owner", roles: systemCatalog });
    const repo = makeOrgRolesRepo(host) as Record<string, unknown>;
    assert.equal("assignSystemOrgRole" in repo, false);
  });

  test("putMemberRoles: admin cannot grant owner → 403", async () => {
    const host = makeStubHost({
      teamRole: "admin",
      roles: systemCatalog,
      bindings: [
        {
          id: "ru-1",
          user_id: USER,
          role_id: MEMBER_ROLE,
          org_id: ORG,
          status: "active",
          store_id: null,
        },
      ],
    });
    const repo = makeOrgRolesRepo(host);
    await assert.rejects(
      () => repo.putMemberRoles(TEAM, ACTOR, [SYSTEM_ROLE, MEMBER_ROLE]),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 403);
        assert.match(err.message, /owner/i);
        return true;
      },
    );
  });

  test("putMemberRoles: admin cannot revoke owner → 403", async () => {
    const host = makeStubHost({
      teamRole: "admin",
      roles: systemCatalog,
      bindings: [
        {
          id: "ru-1",
          user_id: USER,
          role_id: SYSTEM_ROLE,
          org_id: ORG,
          status: "active",
          store_id: null,
        },
      ],
    });
    const repo = makeOrgRolesRepo(host);
    await assert.rejects(
      () => repo.putMemberRoles(TEAM, ACTOR, [MEMBER_ROLE]),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 403);
        return true;
      },
    );
  });

  test("putMemberRoles: removing last owner → 409", async () => {
    const host = makeStubHost({
      teamRole: "owner",
      roles: systemCatalog,
      bindings: [
        {
          id: "ru-1",
          user_id: USER,
          role_id: SYSTEM_ROLE,
          org_id: ORG,
          status: "active",
          store_id: null,
        },
      ],
    });
    const repo = makeOrgRolesRepo(host);
    await assert.rejects(
      () => repo.putMemberRoles(TEAM, ACTOR, [MEMBER_ROLE]),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /last owner/i);
        return true;
      },
    );
  });

  test("putMemberRoles: owner can revoke when another owner remains", async () => {
    const host = makeStubHost({
      teamRole: "owner",
      roles: systemCatalog,
      bindings: [
        {
          id: "ru-1",
          user_id: USER,
          role_id: SYSTEM_ROLE,
          org_id: ORG,
          status: "active",
          store_id: null,
        },
        {
          id: "ru-2",
          user_id: OTHER_USER,
          role_id: SYSTEM_ROLE,
          org_id: ORG,
          status: "active",
          store_id: null,
        },
      ],
    });
    const repo = makeOrgRolesRepo(host);
    const items = await repo.putMemberRoles(TEAM, ACTOR, [MEMBER_ROLE]);
    assert.deepEqual(items.map((r) => r.code), ["member"]);
    assert.equal(
      host._bindings.filter((b) => b.role_id === SYSTEM_ROLE).length,
      1,
    );
  });

  test("assignSystemOrgRole inserts member binding (invite claim path)", async () => {
    const host = makeStubHost({
      teamRole: "owner",
      roles: systemCatalog,
      bindings: [],
    });
    // Service-role stub (same shape as FC admin client); caller JWT must not be used.
    await assignSystemOrgRole(host.supabase, {
      teamId: TEAM,
      userId: USER,
      code: "member",
    });
    assert.equal(host._bindings.length, 1);
    assert.equal(host._bindings[0].role_id, MEMBER_ROLE);
    assert.equal(host._bindings[0].user_id, USER);
    assert.equal(host._bindings[0].org_id, ORG);
    assert.equal(host._teamMembers[0].role, "member");
  });

  test("assignSystemOrgRole throws when userId missing (no silent skip)", async () => {
    const host = makeStubHost({ teamRole: "owner", roles: systemCatalog, bindings: [] });
    await assert.rejects(
      () => assignSystemOrgRole(host.supabase, { teamId: TEAM, userId: "", code: "owner" }),
      (err: any) => err instanceof ApiError && err.statusCode === 500 && /userId/.test(err.message),
    );
  });

  test("assignSystemOrgRole throws when team has no oid (no silent skip)", async () => {
    const host = makeStubHost({ teamRole: "owner", roles: systemCatalog, bindings: [] });
    const noOid = {
      ...host.supabase,
      from(table: string) {
        if (table === "teams") {
          return {
            select() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: { oid: null }, error: null }),
                  };
                },
              };
            },
          };
        }
        return host.supabase.from(table);
      },
    };
    await assert.rejects(
      () => assignSystemOrgRole(noOid, { teamId: TEAM, userId: USER, code: "owner" }),
      (err: any) => err instanceof ApiError && err.statusCode === 500 && /org_id/.test(err.message),
    );
  });

  test("assignSystemOrgRole documents service-role: caller-JWT insert is rejected (RLS mock)", async () => {
    // roles_users_write_org_manager requires is_org_role_manager — brand-new
    // team creators / invitees are not managers yet. Production uses service_role.
    const rlsDenied = {
      code: "42501",
      message: "new row violates row-level security policy for table \"roles_users\"",
    };
    const callerJwtClient = {
      from(table: string) {
        if (table === "teams") {
          return {
            select() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: { oid: ORG }, error: null }),
                  };
                },
              };
            },
          };
        }
        throw new Error(`unexpected from(${table})`);
      },
      schema() {
        return {
          from(table: string) {
            if (table === "roles") {
              return {
                select() {
                  const api: any = {
                    eq() {
                      return api;
                    },
                    maybeSingle: async () => ({
                      data: { id: MEMBER_ROLE },
                      error: null,
                    }),
                  };
                  return api;
                },
              };
            }
            if (table === "roles_users") {
              return {
                select() {
                  const api: any = {
                    eq() {
                      return api;
                    },
                    is() {
                      return api;
                    },
                    maybeSingle: async () => ({ data: null, error: null }),
                  };
                  return api;
                },
                insert() {
                  return {
                    then(resolve: (v: unknown) => void) {
                      return Promise.resolve({ data: null, error: rlsDenied }).then(resolve);
                    },
                  };
                },
              };
            }
            throw new Error(`unexpected public.from(${table})`);
          },
        };
      },
    };

    await assert.rejects(
      () =>
        assignSystemOrgRole(callerJwtClient, {
          teamId: TEAM,
          userId: USER,
          code: "member",
        }),
      (err: any) => err?.code === "42501",
    );

    // Service-role path (stub without RLS) succeeds — what createTeam/claim use.
    const admin = makeStubHost({
      teamRole: "owner",
      roles: systemCatalog,
      bindings: [],
    });
    await assignSystemOrgRole(admin.supabase, {
      teamId: TEAM,
      userId: USER,
      code: "member",
    });
    assert.equal(admin._bindings.length, 1);
    assert.equal(admin._teamMembers[0].role, "member");
  });

  test("deriveHighestTeamRole prefers owner > admin > finance > member", () => {
    assert.equal(
      deriveHighestTeamRole([
        { id: MEMBER_ROLE, code: "member", name: "成员" },
        { id: ADMIN_ROLE, code: "admin", name: "管理员" },
      ]),
      "admin",
    );
    assert.equal(deriveHighestTeamRole([]), null);
  });

  test("shared tenant (DEFAULT_ORG_ID) never receives an automatic role above member", async () => {
    // The shared org is an identity namespace, not a company: on self-host it
    // holds 56 unrelated teams. roles_users is org-scoped, so an automatic
    // `owner` there would own every other team in the bucket.
    const host = makeStubHost({ teamRole: "owner", roles: systemCatalog, bindings: [] });
    const previous = process.env.DEFAULT_ORG_ID;
    process.env.DEFAULT_ORG_ID = ORG;
    try {
      await assignSystemOrgRole(host.supabase, { teamId: TEAM, userId: USER, code: "owner" });
    } finally {
      if (previous === undefined) delete process.env.DEFAULT_ORG_ID;
      else process.env.DEFAULT_ORG_ID = previous;
    }
    assert.equal(host._bindings.length, 1);
    assert.equal(host._bindings[0].role_id, MEMBER_ROLE);
    assert.equal(host._teamMembers[0].role, "member");
  });

  test("a real tenant still receives owner (the clamp is scoped to the shared org)", async () => {
    const host = makeStubHost({ teamRole: "owner", roles: systemCatalog, bindings: [] });
    const previous = process.env.DEFAULT_ORG_ID;
    process.env.DEFAULT_ORG_ID = "99999999-9999-9999-9999-999999999999";
    try {
      await assignSystemOrgRole(host.supabase, { teamId: TEAM, userId: USER, code: "owner" });
    } finally {
      if (previous === undefined) delete process.env.DEFAULT_ORG_ID;
      else process.env.DEFAULT_ORG_ID = previous;
    }
    assert.equal(host._bindings[0].role_id, SYSTEM_ROLE);
    assert.equal(host._teamMembers[0].role, "owner");
  });

  test("assignSystemOrgRole reactivates an inactive binding instead of no-op'ing", async () => {
    // current_team_role filters status='active'; the old existence probe did
    // not, so an inactive row meant "granted" while the user held nothing.
    const host = makeStubHost({
      teamRole: "owner",
      roles: systemCatalog,
      bindings: [
        {
          id: "ru-inactive",
          user_id: USER,
          role_id: MEMBER_ROLE,
          org_id: ORG,
          status: "inactive",
          store_id: null,
        },
      ],
    });
    await assignSystemOrgRole(host.supabase, { teamId: TEAM, userId: USER, code: "member" });
    assert.equal(host._bindings.length, 1);
    assert.equal(host._bindings[0].status, "active");
  });

  test("assignSystemOrgRole mirrors the full role set, so it never demotes an owner", async () => {
    // join_public_team is idempotent and re-runs with code 'member' for a
    // caller who already owns the team. Mirroring only that code rewrote
    // team_members.role to 'member' — the column remove_team_actor's
    // last-owner guard reads.
    const host = makeStubHost({
      teamRole: "owner",
      roles: systemCatalog,
      bindings: [
        {
          id: "ru-owner",
          user_id: USER,
          role_id: SYSTEM_ROLE,
          org_id: ORG,
          status: "active",
          store_id: null,
        },
      ],
    });
    await assignSystemOrgRole(host.supabase, { teamId: TEAM, userId: USER, code: "member" });
    assert.equal(host._teamMembers[0].role, "owner");
  });

  test("mirrorTeamMembersRole maps finance/custom to member; empty → null", () => {
    assert.equal(mirrorTeamMembersRole("owner"), "owner");
    assert.equal(mirrorTeamMembersRole("admin"), "admin");
    assert.equal(mirrorTeamMembersRole("finance"), "member");
    assert.equal(mirrorTeamMembersRole("member"), "member");
    assert.equal(mirrorTeamMembersRole("auditor"), "member");
    assert.equal(mirrorTeamMembersRole(null), null);
  });
});
