/**
 * Org-scoped role catalog + member role assignment — repository (supabase).
 *
 * Design: docs/specs/2026-09-15-org-roles-permissions-design.md §2.1–2.2
 *
 * `org_id` is always `amux.teams.oid` for the path's teamId. Authz:
 * - list catalog / list member roles: any team member
 * - create/patch/delete roles + put member roles: current_team_role in (owner, admin)
 * - system roles are immutable (403); delete with bindings → 409
 * - admin cannot grant/revoke owner; last owner removal → 409
 *
 * RLS also gates reads/writes; the explicit checks give stable API errors
 * (and enforce is_system / binding / owner rules RLS does not).
 */

import { ApiError } from "../http-utils.js";

const ROLE_CODE_RE = /^[a-z][a-z0-9_]*$/;

/** Privilege order for transitional `teamRole` / `role` derivation. */
const TEAM_ROLE_RANK: Record<string, number> = {
  owner: 1,
  admin: 2,
  finance: 3,
  member: 4,
};

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

export type MemberRoleRef = {
  id: string;
  code: string;
  name: string;
};

interface OrgRolesHost {
  /** Caller-token client; RLS applies. Default schema is amux. */
  supabase: any;
  /** Resolves the bearer caller's actor in this team, or null. */
  resolveCallerActorForTeam: (teamId: string) => Promise<{ id: string } | null>;
}

/** Prefer public schema; fall back for in-memory stubs that lack `.schema()`. */
function publicFrom(supabase: any, table: string) {
  if (typeof supabase?.schema === "function") {
    return supabase.schema("public").from(table);
  }
  return supabase.from(table);
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

function mapMemberRoleRef(row: { id: string; code: string; name: string }): MemberRoleRef {
  return { id: row.id, code: row.code, name: row.name };
}

/** Highest privilege among active role codes (`owner > admin > finance > member`). */
export function deriveHighestTeamRole(roles: MemberRoleRef[]): string | null {
  if (!roles.length) return null;
  let best: MemberRoleRef | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const role of roles) {
    const rank = TEAM_ROLE_RANK[role.code] ?? 99;
    if (rank < bestRank) {
      bestRank = rank;
      best = role;
    }
  }
  return best?.code ?? null;
}

/**
 * Map a derived org role code onto `amux.team_members.role` CHECK
 * (`owner|admin|member`). Finance and custom codes mirror as `member`.
 * Empty / null → null (column is nullable).
 */
export function mirrorTeamMembersRole(code: string | null): "owner" | "admin" | "member" | null {
  if (!code) return null;
  if (code === "owner" || code === "admin") return code;
  return "member";
}

/**
 * Transitional dual-write: keep `amux.team_members.role` aligned with
 * roles_users for live SQL/RLS that still reads the legacy column
 * (remove_team_actor last-owner, join_public_team labeling, etc.).
 */
async function dualWriteTeamMembersRole(
  client: any,
  opts: { teamId: string; actorId: string; roleCode: string | null },
): Promise<void> {
  const mirrored = mirrorTeamMembersRole(opts.roleCode);
  const { error } = await client
    .from("team_members")
    .update({ role: mirrored })
    .eq("team_id", opts.teamId)
    .eq("member_id", opts.actorId);
  if (error) throw error;
}

/**
 * The shared tenant (`DEFAULT_ORG_ID`) is an identity NAMESPACE, not a company.
 * Every org-less / phone sign-up is stamped with it, so its members are
 * strangers to one another — on self-host it holds 56 unrelated teams. Because
 * `roles_users` is org-scoped, an automatic `owner` grant there would make one
 * person owner of every other team in the bucket. Nothing above `member` is
 * ever granted automatically in that org; real tenants are unaffected.
 */
function clampSharedTenantRole(orgId: string, code: string): string {
  const sharedOrg = (process.env.DEFAULT_ORG_ID ?? "").trim();
  if (!sharedOrg || orgId !== sharedOrg) return code;
  return code === "member" ? code : "member";
}

/** Active role refs for a user in one org. Shared by assign + repo listing. */
async function activeOrgRolesForUser(
  client: any,
  orgId: string,
  userId: string,
): Promise<MemberRoleRef[]> {
  const { data: bindings, error } = await publicFrom(client, "roles_users")
    .select("role_id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) throw error;
  const roleIds = [...new Set((bindings ?? []).map((b: any) => b.role_id).filter(Boolean))];
  if (!roleIds.length) return [];
  const { data: roles, error: rolesErr } = await publicFrom(client, "roles")
    .select("id, code, name, status")
    .in("id", roleIds)
    .eq("status", "active");
  if (rolesErr) throw rolesErr;
  return (roles ?? []).map(mapMemberRoleRef);
}

/**
 * Assign a system org role (`owner` / `member` / …) for a user under a team's org.
 * Idempotent: existing active row is a no-op. Used by team create / invite claim.
 *
 * `admin` MUST be a **service-role** Supabase client. `roles_users` writes are
 * gated by `is_org_role_manager`, which needs an existing owner/admin binding —
 * chicken-and-egg for new teams and invitees. Service-role bypasses that RLS.
 * Passing the caller JWT silently fails (or used to no-op); do not do that.
 *
 * Dual-writes `amux.team_members.role` (finance → member) so RPCs / SQL that
 * still read the legacy column stay aligned. Prefer this exported helper over
 * any caller-JWT wrapper.
 */
export async function assignSystemOrgRole(
  admin: any,
  opts: { teamId: string; userId: string; code: string },
): Promise<void> {
  const { teamId, userId, code } = opts;
  if (!userId || !String(userId).trim()) {
    throw new ApiError(500, "internal_error", "assignSystemOrgRole requires userId");
  }
  if (!code || !String(code).trim()) {
    throw new ApiError(500, "internal_error", "assignSystemOrgRole requires role code");
  }

  const { data: team, error: teamErr } = await admin
    .from("teams")
    .select("oid")
    .eq("id", teamId)
    .maybeSingle();
  if (teamErr) throw teamErr;
  const orgId = typeof team?.oid === "string" ? team.oid.trim() : "";
  if (!orgId) {
    throw new ApiError(
      500,
      "internal_error",
      `team ${teamId} has no org_id; cannot assign system role ${code}`,
    );
  }

  const effectiveCode = clampSharedTenantRole(orgId, code);

  const { data: role, error: roleErr } = await publicFrom(admin, "roles")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", effectiveCode)
    .eq("is_system", true)
    .maybeSingle();
  if (roleErr) throw roleErr;
  if (!role?.id) {
    throw new ApiError(500, "internal_error", `system role ${effectiveCode} missing for org`);
  }

  // `status` matters: an inactive binding satisfied the old existence probe, so
  // the grant no-op'd while current_team_role (which filters status='active')
  // still saw nothing — a member with no effective role and no error raised.
  const { data: existing, error: existErr } = await publicFrom(admin, "roles_users")
    .select("id, status")
    .eq("user_id", userId)
    .eq("role_id", role.id)
    .is("store_id", null)
    .maybeSingle();
  if (existErr) throw existErr;
  if (existing?.id) {
    if (existing.status !== "active") {
      const { error: reviveErr } = await publicFrom(admin, "roles_users")
        .update({ status: "active" })
        .eq("id", existing.id);
      if (reviveErr) throw reviveErr;
    }
  } else {
    const { error: insertErr } = await publicFrom(admin, "roles_users").insert({
      user_id: userId,
      role_id: role.id,
      org_id: orgId,
      status: "active",
      store_id: null,
      is_primary: false,
      expires_at: null,
    });
    if (insertErr) {
      // Unique race: another writer won — still mirror below.
      if (insertErr.code !== "23505") throw insertErr;
    }
  }

  const { data: actor, error: actorErr } = await admin
    .from("actors")
    .select("id")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (actorErr) throw actorErr;
  if (typeof actor?.id === "string" && actor.id) {
    // Mirror the user's FULL active role set, not just the code being granted.
    // Mirroring `code` alone demoted a re-entering owner to 'member' in the
    // legacy column that remove_team_actor's last-owner guard reads.
    const active = await activeOrgRolesForUser(admin, orgId, userId);
    await dualWriteTeamMembersRole(admin, {
      teamId,
      actorId: actor.id,
      roleCode: deriveHighestTeamRole(active) ?? effectiveCode,
    });
  }
}

/**
 * Batch-load active org roles for actors that have a `userId`.
 * Mutates each actor with `roles` + derived `teamRole` (and `role` when present).
 */
export type WithOrgRoles<T> = T & { roles: MemberRoleRef[]; teamRole: string | null };

export async function enrichActorsWithOrgRoles<
  T extends {
    id?: string;
    userId?: string | null;
    kind?: string | null;
    roles?: MemberRoleRef[];
    teamRole?: string | null;
    role?: string | null;
  },
>(supabase: any, teamId: string, actors: T[]): Promise<Array<WithOrgRoles<T>>> {
  if (!actors.length) return [];

  const { data: team, error: teamErr } = await supabase
    .from("teams")
    .select("oid")
    .eq("id", teamId)
    .maybeSingle();
  if (teamErr) throw teamErr;
  const orgId = typeof team?.oid === "string" ? team.oid.trim() : "";
  if (!orgId) {
    return actors.map((a) => ({ ...a, roles: a.roles ?? [], teamRole: a.teamRole ?? null }));
  }

  const userIds = [
    ...new Set(
      actors
        .map((a) => a.userId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const byUser = new Map<string, MemberRoleRef[]>();
  if (userIds.length > 0) {
    const { data: bindings, error: bindErr } = await publicFrom(supabase, "roles_users")
      .select("user_id, role_id")
      .eq("org_id", orgId)
      .eq("status", "active")
      .in("user_id", userIds);
    if (bindErr) throw bindErr;
    const roleIds = [...new Set((bindings ?? []).map((b: any) => b.role_id).filter(Boolean))];
    const roleById = new Map<string, MemberRoleRef>();
    if (roleIds.length > 0) {
      const { data: roles, error: rolesErr } = await publicFrom(supabase, "roles")
        .select("id, code, name, status")
        .in("id", roleIds)
        .eq("status", "active");
      if (rolesErr) throw rolesErr;
      for (const r of roles ?? []) {
        roleById.set(r.id, mapMemberRoleRef(r));
      }
    }
    for (const row of bindings ?? []) {
      const ref = roleById.get(row.role_id);
      if (!ref) continue;
      const uid = row.user_id as string;
      const list = byUser.get(uid) ?? [];
      list.push(ref);
      byUser.set(uid, list);
    }
  }

  return actors.map((actor) => {
    const kind = actor.kind ?? null;
    if (kind && kind !== "user" && kind !== "member") {
      return { ...actor, roles: [], teamRole: null };
    }
    const roles = actor.userId ? (byUser.get(actor.userId) ?? []) : [];
    const teamRole = deriveHighestTeamRole(roles);
    const next: WithOrgRoles<T> = { ...actor, roles, teamRole };
    if ("role" in actor || actor.role !== undefined) {
      (next as WithOrgRoles<T> & { role: string | null }).role = teamRole;
    }
    return next;
  });
}

export function makeOrgRolesRepo(host: OrgRolesHost) {
  async function requireTeamMember(teamId: string): Promise<void> {
    const actor = await host.resolveCallerActorForTeam(teamId);
    if (!actor) throw new ApiError(403, "forbidden", "not a member of this team");
  }

  async function requireTeamManager(teamId: string): Promise<string> {
    await requireTeamMember(teamId);
    const { data, error } = await host.supabase.rpc("current_team_role", {
      target_team_id: teamId,
    });
    if (error) throw error;
    if (data !== "owner" && data !== "admin") {
      throw new ApiError(403, "forbidden", "team owner or admin access required");
    }
    return data as string;
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
    const { data, error } = await publicFrom(host.supabase, "roles")
      .select("*")
      .eq("id", roleId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(404, "not_found", "org role not found");
    return data;
  }

  async function resolveActorUserId(teamId: string, actorId: string): Promise<string | null> {
    const { data, error } = await host.supabase
      .from("actors")
      .select("id, user_id, actor_type")
      .eq("id", actorId)
      .eq("team_id", teamId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(404, "not_found", "actor not found");
    const userId = data.user_id;
    if (typeof userId !== "string" || !userId.trim()) return null;
    return userId.trim();
  }

  async function listActiveMemberRoles(orgId: string, userId: string): Promise<MemberRoleRef[]> {
    const { data: bindings, error } = await publicFrom(host.supabase, "roles_users")
      .select("role_id")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .eq("status", "active");
    if (error) throw error;
    const roleIds = (bindings ?? []).map((b: any) => b.role_id).filter(Boolean);
    if (!roleIds.length) return [];
    const { data: roles, error: rolesErr } = await publicFrom(host.supabase, "roles")
      .select("id, code, name, status")
      .in("id", roleIds)
      .eq("status", "active");
    if (rolesErr) throw rolesErr;
    return (roles ?? []).map(mapMemberRoleRef);
  }

  async function countActiveOwners(orgId: string, excludeUserId?: string): Promise<number> {
    const { data: ownerRole, error: roleErr } = await publicFrom(host.supabase, "roles")
      .select("id")
      .eq("org_id", orgId)
      .eq("code", "owner")
      .eq("is_system", true)
      .maybeSingle();
    if (roleErr) throw roleErr;
    if (!ownerRole?.id) return 0;

    let q = publicFrom(host.supabase, "roles_users")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("role_id", ownerRole.id)
      .eq("status", "active");
    if (excludeUserId) {
      q = q.neq("user_id", excludeUserId);
    }
    const { count, error } = await q;
    if (error) throw error;
    return typeof count === "number" ? count : 0;
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
      const { data, error } = await publicFrom(host.supabase, "roles")
        .select("*")
        .eq("org_id", orgId)
        .order("sort", { ascending: true });
      if (error) throw error;
      // System roles first, each group still in sort order (Array#sort is stable).
      return (data ?? []).map(mapRole).sort((a, b) => Number(b.isSystem) - Number(a.isSystem));
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

      const { data, error } = await publicFrom(host.supabase, "roles")
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

      const { data, error } = await publicFrom(host.supabase, "roles")
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

      const { count, error: cErr } = await publicFrom(host.supabase, "roles_users")
        .select("id", { count: "exact", head: true })
        .eq("role_id", roleId);
      if (cErr) throw cErr;
      const bindingCount = typeof count === "number" ? count : 0;
      if (bindingCount > 0) {
        throw new ApiError(409, "conflict", "role still has member bindings", {
          details: { bindingCount },
        });
      }

      const { error } = await publicFrom(host.supabase, "roles")
        .delete()
        .eq("id", roleId)
        .eq("org_id", orgId);
      if (error) throw error;
    },

    async listMemberRoles(teamId: string, actorId: string): Promise<MemberRoleRef[]> {
      await requireTeamMember(teamId);
      const userId = await resolveActorUserId(teamId, actorId);
      if (!userId) return [];
      const orgId = await resolveOrgId(teamId);
      return listActiveMemberRoles(orgId, userId);
    },

    /**
     * Replace the member's active org-role set.
     *
     * Not a single SQL transaction (no put RPC yet): roles_users diffs first,
     * then dual-write `team_members.role`. Prefer a future RPC for true atomicity.
     */
    async putMemberRoles(
      teamId: string,
      actorId: string,
      roleIds: string[],
    ): Promise<MemberRoleRef[]> {
      const callerRole = await requireTeamManager(teamId);
      const userId = await resolveActorUserId(teamId, actorId);
      if (!userId) {
        throw new ApiError(400, "validation_failed", "actor has no user_id (agents/external cannot hold org roles)");
      }
      const orgId = await resolveOrgId(teamId);

      if (!Array.isArray(roleIds)) {
        throw new ApiError(400, "validation_failed", "roleIds must be an array");
      }
      const uniqueIds = [...new Set(roleIds.map((id) => String(id)))];

      // Load target role rows (must all belong to this org and be active).
      const targetRoles: Array<{ id: string; code: string; name: string; status: string }> = [];
      for (const roleId of uniqueIds) {
        const row = await loadRole(orgId, roleId);
        if (row.status !== "active") {
          throw new ApiError(400, "validation_failed", "cannot assign inactive org role", {
            details: { roleId, status: row.status },
          });
        }
        targetRoles.push({
          id: row.id,
          code: row.code,
          name: row.name,
          status: row.status,
        });
      }

      const current = await listActiveMemberRoles(orgId, userId);
      const currentIds = new Set(current.map((r) => r.id));
      const nextIds = new Set(targetRoles.map((r) => r.id));

      const grantingOwner =
        targetRoles.some((r) => r.code === "owner") && !current.some((r) => r.code === "owner");
      const revokingOwner =
        current.some((r) => r.code === "owner") && !targetRoles.some((r) => r.code === "owner");

      if (callerRole === "admin" && (grantingOwner || revokingOwner)) {
        throw new ApiError(403, "forbidden", "admin cannot grant or revoke owner");
      }

      if (revokingOwner) {
        const otherOwners = await countActiveOwners(orgId, userId);
        if (otherOwners === 0) {
          throw new ApiError(409, "conflict", "cannot remove the last owner");
        }
      }

      const toRemove = [...currentIds].filter((id) => !nextIds.has(id));
      const toAdd = [...nextIds].filter((id) => !currentIds.has(id));

      for (const roleId of toRemove) {
        const { error } = await publicFrom(host.supabase, "roles_users")
          .delete()
          .eq("org_id", orgId)
          .eq("user_id", userId)
          .eq("role_id", roleId)
          .is("store_id", null);
        if (error) throw error;
      }

      for (const roleId of toAdd) {
        const { error } = await publicFrom(host.supabase, "roles_users").insert({
          user_id: userId,
          role_id: roleId,
          org_id: orgId,
          status: "active",
          store_id: null,
          is_primary: false,
          expires_at: null,
        });
        if (error) {
          if (error.code === "23505") continue;
          throw error;
        }
      }

      const items = await listActiveMemberRoles(orgId, userId);
      await dualWriteTeamMembersRole(host.supabase, {
        teamId,
        actorId,
        roleCode: deriveHighestTeamRole(items),
      });
      return items;
    },
  };
}
