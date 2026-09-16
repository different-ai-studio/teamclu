import { describe, expect, it, vi } from "vitest";
import { createOrgRolesModule } from "@/lib/backend/cloud-api/org-roles";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

const ROLE = {
  id: "role-1",
  orgId: "org-1",
  name: "管理员",
  code: "admin",
  description: null,
  isSystem: true,
  status: "active" as const,
  sort: 10,
  parentRoleId: null,
};

const MEMBER_REF = { id: "role-1", code: "admin", name: "管理员" };

function mockClient(handlers: {
  get?: (path: string) => Promise<unknown>;
  post?: (path: string, body?: unknown) => Promise<unknown>;
  patch?: (path: string, body?: unknown) => Promise<unknown>;
  put?: (path: string, body?: unknown) => Promise<unknown>;
  delete?: (path: string) => Promise<unknown>;
}): CloudApiClient {
  return {
    get: vi.fn(handlers.get ?? (async () => { throw new Error("unexpected GET"); })),
    post: vi.fn(handlers.post ?? (async () => { throw new Error("unexpected POST"); })),
    patch: vi.fn(handlers.patch ?? (async () => { throw new Error("unexpected PATCH"); })),
    put: vi.fn(handlers.put ?? (async () => { throw new Error("unexpected PUT"); })),
    delete: vi.fn(handlers.delete ?? (async () => { throw new Error("unexpected DELETE"); })),
    postRaw: vi.fn(async () => { throw new Error("not impl"); }),
    getRaw: vi.fn(async () => { throw new Error("not impl"); }),
  } as unknown as CloudApiClient;
}

describe("org-roles module", () => {
  it("list GETs /v1/teams/:teamId/roles and returns items", async () => {
    const client = mockClient({
      get: async () => ({ items: [ROLE] }),
    });
    const mod = createOrgRolesModule(client);
    const out = await mod.list("team-1");
    expect(client.get).toHaveBeenCalledWith("/v1/teams/team-1/roles");
    expect(out).toEqual([ROLE]);
  });

  it("list returns [] when items is missing", async () => {
    const client = mockClient({ get: async () => ({}) });
    const out = await createOrgRolesModule(client).list("team-1");
    expect(out).toEqual([]);
  });

  it("create POSTs body and returns the role", async () => {
    const client = mockClient({
      post: async () => ROLE,
    });
    const input = { name: "审计", code: "auditor" };
    const out = await createOrgRolesModule(client).create("team-1", input);
    expect(client.post).toHaveBeenCalledWith("/v1/teams/team-1/roles", input);
    expect(out).toEqual(ROLE);
  });

  it("patch PATCHes role path", async () => {
    const client = mockClient({
      patch: async () => ({ ...ROLE, name: "新名" }),
    });
    const patch = { name: "新名" };
    const out = await createOrgRolesModule(client).patch("team-1", "role-1", patch);
    expect(client.patch).toHaveBeenCalledWith("/v1/teams/team-1/roles/role-1", patch);
    expect(out.name).toBe("新名");
  });

  it("remove DELETEs role path", async () => {
    const client = mockClient({
      delete: async () => undefined,
    });
    await createOrgRolesModule(client).remove("team-1", "role-1");
    expect(client.delete).toHaveBeenCalledWith("/v1/teams/team-1/roles/role-1");
  });

  it("listMemberRoles GETs member roles and returns items", async () => {
    const client = mockClient({
      get: async () => ({ items: [MEMBER_REF] }),
    });
    const out = await createOrgRolesModule(client).listMemberRoles("team-1", "actor-1");
    expect(client.get).toHaveBeenCalledWith("/v1/teams/team-1/members/actor-1/roles");
    expect(out).toEqual([MEMBER_REF]);
  });

  it("putMemberRoles PUTs { roleIds } and returns items", async () => {
    const client = mockClient({
      put: async () => ({ items: [MEMBER_REF] }),
    });
    const out = await createOrgRolesModule(client).putMemberRoles("team-1", "actor-1", ["role-1"]);
    expect(client.put).toHaveBeenCalledWith(
      "/v1/teams/team-1/members/actor-1/roles",
      { roleIds: ["role-1"] },
    );
    expect(out).toEqual([MEMBER_REF]);
  });

  it("encodes teamId / roleId / actorId in paths", async () => {
    const client = mockClient({
      get: async () => ({ items: [] }),
      delete: async () => undefined,
    });
    const mod = createOrgRolesModule(client);
    await mod.list("team/a");
    await mod.listMemberRoles("team/a", "actor/b");
    await mod.remove("team/a", "role/c");
    expect(client.get).toHaveBeenCalledWith("/v1/teams/team%2Fa/roles");
    expect(client.get).toHaveBeenCalledWith("/v1/teams/team%2Fa/members/actor%2Fb/roles");
    expect(client.delete).toHaveBeenCalledWith("/v1/teams/team%2Fa/roles/role%2Fc");
  });
});
