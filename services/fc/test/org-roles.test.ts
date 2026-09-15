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
import { makeOrgRolesRepo } from "../src/lib/supabase-repo/org-roles.js";

const TEAM = "11111111-1111-1111-1111-111111111111";
const ORG = "22222222-2222-2222-2222-222222222222";
const SYSTEM_ROLE = "33333333-3333-3333-3333-333333333333";
const CUSTOM_ROLE = "44444444-4444-4444-4444-444444444444";

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

function makeStubHost(opts: {
  teamRole: string | null;
  roles: RoleRow[];
  bindingCount?: number;
  member?: boolean;
}) {
  const roles = [...opts.roles];
  let bindingCount = opts.bindingCount ?? 0;

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
      if (table === "roles") {
        return {
          select() {
            return {
              eq(_col: string, val: string) {
                const filtered = roles.filter((r) => r.org_id === val || r.id === val);
                return {
                  order: async () => ({ data: filtered.filter((r) => r.org_id === ORG), error: null }),
                  maybeSingle: async () => ({
                    data: roles.find((r) => r.id === val && r.org_id === ORG) ?? null,
                    error: null,
                  }),
                  // chained .eq(id).eq(org) for load
                  eq(_c2: string, v2: string) {
                    const row = roles.find((r) => r.id === val && r.org_id === v2) ?? null;
                    return {
                      maybeSingle: async () => ({ data: row, error: null }),
                    };
                  },
                };
              },
            };
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
            return {
              eq(_c: string, id: string) {
                return {
                  eq(_c2: string, orgId: string) {
                    const row = roles.find((r) => r.id === id && r.org_id === orgId);
                    if (row) Object.assign(row, patch);
                    return {
                      select() {
                        return {
                          single: async () => ({ data: row, error: null }),
                        };
                      },
                    };
                  },
                };
              },
            };
          },
          delete() {
            return {
              eq(_c: string, id: string) {
                return {
                  eq: async (_c2: string, orgId: string) => {
                    const idx = roles.findIndex((r) => r.id === id && r.org_id === orgId);
                    if (idx >= 0) roles.splice(idx, 1);
                    return { error: null };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "roles_users") {
        return {
          select(_cols: string, opts?: { count?: string; head?: boolean }) {
            return {
              eq: async () => ({
                count: bindingCount,
                error: null,
                data: null,
              }),
            };
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
    setBindingCount(n: number) {
      bindingCount = n;
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
});
