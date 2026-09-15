/**
 * Org-scoped role catalog — repository (supabase backend).
 *
 * Design: docs/specs/2026-09-15-org-roles-permissions-design.md §2.1
 *
 * `org_id` is always `amux.teams.oid` for the path's teamId. Authz:
 * - list: any team member
 * - create/patch/delete: current_team_role in (owner, admin)
 * - system roles are immutable (403); delete with bindings → 409
 *
 * RLS also gates reads/writes; the explicit checks give stable API errors
 * (and enforce is_system / binding rules RLS does not).
 */

import { ApiError } from "../http-utils.js";

const ROLE_CODE_RE = /^[a-z][a-z0-9_]*$/;

export type OrgRole = {
  id: string;
  orgId: string;
  name: string;
  code: string;
  description: string | null;
  isSystem: boolean;
  status: string;
  sort: number;
  parentRoleId: string | null;
};

export type OrgRoleCreate = {
  name: string;
  code: string;
  description?: string;
  sort?: number;
};

export type OrgRolePatch = {
  name?: string;
  description?: string | null;
  status?: "active" | "inactive";
  sort?: number;
};

interface OrgRolesHost {
  /** Caller-token client; RLS applies. */
  supabase: any;
  /** Resolves the bearer caller's actor in this team, or null. */
  resolveCallerActorForTeam: (teamId: string) => Promise<{ id: string } | null>;
}

function mapRole(row: any): OrgRole {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    code: row.code,
    description: row.description ?? null,
    isSystem: Boolean(row.is_system),
    status: row.status,
    sort: Number(row.sort ?? 50),
    parentRoleId: row.parent_role_id ?? null,
  };
}

export function makeOrgRolesRepo(host: OrgRolesHost) {
  async function requireTeamMember(teamId: string): Promise<void> {
    const actor = await host.resolveCallerActorForTeam(teamId);
    if (!actor) throw new ApiError(403, "forbidden", "not a member of this team");
  }

  async function requireTeamManager(teamId: string): Promise<void> {
    await requireTeamMember(teamId);
    const { data, error } = await host.supabase.rpc("current_team_role", {
      target_team_id: teamId,
    });
    if (error) throw error;
    if (data !== "owner" && data !== "admin") {
      throw new ApiError(403, "forbidden", "team owner or admin access required");
    }
  }

  async function resolveOrgId(teamId: string): Promise<string> {
    const { data, error } = await host.supabase
      .from("teams")
      .select("oid")
      .eq("id", teamId)
      .maybeSingle();
    if (error) throw error;
    const oid = data?.oid;
    if (typeof oid !== "string" || !oid.trim()) {
      throw new ApiError(404, "not_found", "team org not found");
    }
    return oid.trim();
  }

  async function loadRole(orgId: string, roleId: string) {
    const { data, error } = await host.supabase
      .from("roles")
      .select("*")
      .eq("id", roleId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(404, "not_found", "org role not found");
    return data;
  }

  function assertCode(code: unknown): string {
    if (typeof code !== "string" || !ROLE_CODE_RE.test(code)) {
      throw new ApiError(
        400,
        "validation_failed",
        "code must match ^[a-z][a-z0-9_]*$",
      );
    }
    return code;
  }

  function assertName(name: unknown): string {
    if (typeof name !== "string" || !name.trim()) {
      throw new ApiError(400, "validation_failed", "name is required");
    }
    return name.trim();
  }

  return {
    async listOrgRoles(teamId: string): Promise<OrgRole[]> {
      await requireTeamMember(teamId);
      const orgId = await resolveOrgId(teamId);
      const { data, error } = await host.supabase
        .from("roles")
        .select("*")
        .eq("org_id", orgId)
        .order("sort", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(mapRole);
    },

    async createOrgRole(teamId: string, input: OrgRoleCreate = {} as OrgRoleCreate): Promise<OrgRole> {
      await requireTeamManager(teamId);
      const orgId = await resolveOrgId(teamId);
      const name = assertName(input?.name);
      const code = assertCode(input?.code);
      const sort =
        input?.sort === undefined || input?.sort === null
          ? 50
          : Number(input.sort);
      if (!Number.isFinite(sort)) {
        throw new ApiError(400, "validation_failed", "sort must be an integer");
      }

      const row: Record<string, unknown> = {
        org_id: orgId,
        name,
        code,
        is_system: false,
        status: "active",
        sort,
      };
      if (input?.description !== undefined) {
        row.description = input.description;
      }

      const { data, error } = await host.supabase
        .from("roles")
        .insert(row)
        .select()
        .single();
      if (error) throw error;
      return mapRole(data);
    },

    async patchOrgRole(teamId: string, roleId: string, patch: OrgRolePatch = {}): Promise<OrgRole> {
      await requireTeamManager(teamId);
      const orgId = await resolveOrgId(teamId);
      const existing = await loadRole(orgId, roleId);
      if (existing.is_system) {
        throw new ApiError(403, "forbidden", "系统角色不可修改");
      }

      const updates: Record<string, unknown> = {};
      if (patch.name !== undefined) updates.name = assertName(patch.name);
      if (patch.description !== undefined) updates.description = patch.description;
      if (patch.status !== undefined) {
        if (patch.status !== "active" && patch.status !== "inactive") {
          throw new ApiError(400, "validation_failed", "status must be active or inactive");
        }
        updates.status = patch.status;
      }
      if (patch.sort !== undefined) {
        const sort = Number(patch.sort);
        if (!Number.isFinite(sort)) {
          throw new ApiError(400, "validation_failed", "sort must be an integer");
        }
        updates.sort = sort;
      }

      if (Object.keys(updates).length === 0) {
        return mapRole(existing);
      }

      const { data, error } = await host.supabase
        .from("roles")
        .update(updates)
        .eq("id", roleId)
        .eq("org_id", orgId)
        .select()
        .single();
      if (error) throw error;
      return mapRole(data);
    },

    async deleteOrgRole(teamId: string, roleId: string): Promise<void> {
      await requireTeamManager(teamId);
      const orgId = await resolveOrgId(teamId);
      const existing = await loadRole(orgId, roleId);
      if (existing.is_system) {
        throw new ApiError(403, "forbidden", "系统角色不可修改");
      }

      const { count, error: cErr } = await host.supabase
        .from("roles_users")
        .select("id", { count: "exact", head: true })
        .eq("role_id", roleId);
      if (cErr) throw cErr;
      const bindingCount = typeof count === "number" ? count : 0;
      if (bindingCount > 0) {
        throw new ApiError(409, "conflict", "role still has member bindings", {
          details: { bindingCount },
        });
      }

      const { error } = await host.supabase
        .from("roles")
        .delete()
        .eq("id", roleId)
        .eq("org_id", orgId);
      if (error) throw error;
    },
  };
}
