/**
 * Document-library folder rules — management repository (supabase).
 *
 * Owner/admin is checked here, then every ACL read and write uses the service
 * role: `amuxc_path_acl*` has RLS with no policy. The service-role client
 * defaults to schema `amux`. `public.roles` and `public.roles_users` go through
 * `publicFrom` (../public-schema.ts).
 */

import { publicFrom } from "../public-schema.js";
import { ApiError } from "../http-utils.js";
import {
  documentPrefixesOverlap,
  isDocumentLibraryPrefix,
  libraryGrantWidens,
  membersLosingLibraryAccess,
  type LibraryAudience,
  type MemberAccess,
} from "../document-library-access.js";
import { invalidateTeamAcl, MAX_ACL_RULES_PER_TEAM } from "../sync-acl.js";
import { filesUnderPrefix, hasLikeMetachars, resurfaceAclPrefix } from "./knowledge-acl.js";

export type DocumentLibraryRole = {
  id: string;
  code: string;
  name: string;
  status: string;
};

export type DocumentLibrary = {
  id: string;
  pathPrefix: string;
  audience: "roles" | "actors";
  roles: DocumentLibraryRole[];
  actorIds: string[];
};

type StoredRole = {
  id: string;
  code: string;
  name: string;
  status: string;
  isSystem: boolean;
};

interface DocumentLibrariesHost {
  /** Caller-token client; RLS applies. */
  supabase: any;
  /** Service-role client factory; RLS bypassed. `what` is for the error text. */
  serviceRoleClient: (what: string) => Promise<any>;
  /** Resolves the bearer caller's actor in this team, or null. */
  resolveCallerActorForTeam: (teamId: string) => Promise<{ id: string } | null>;
}

/**
 * `alreadyGrantedIds` may stay on the library even if they were deactivated
 * since: the dialog sends back what it loaded, and an admin must be able to
 * save the rest without first reactivating them. A new grant must be active.
 */
export function prepareRoleIds(
  orgRoles: Array<{ id: string; code: string; status: string; isSystem: boolean }>,
  requestedIds: string[],
  alreadyGrantedIds: ReadonlySet<string> = new Set(),
): { roleIds: string[] } {
  const owner = orgRoles.find(
    (role) => role.code === "owner" && role.status === "active" && role.isSystem,
  );
  if (!owner) {
    throw new ApiError(500, "internal_error", "active system owner role is missing");
  }

  const byId = new Map(orgRoles.map((role) => [role.id, role]));
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of requestedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const role = byId.get(id);
    if (!role || (role.status !== "active" && !alreadyGrantedIds.has(id))) {
      throw new ApiError(400, "validation_failed", `role ${id} is missing or not active`);
    }
    unique.push(id);
  }

  return { roleIds: [owner.id, ...unique.filter((id) => id !== owner.id)] };
}

export function assertNoDocumentOverlap(
  existing: Array<{ id: string; pathPrefix: string }>,
  pathPrefix: string,
  selfId: string | null,
): void {
  for (const row of existing) {
    if (selfId !== null && row.id === selfId) continue;
    if (!row.pathPrefix.startsWith("documents/")) continue;
    if (documentPrefixesOverlap(row.pathPrefix, pathPrefix)) {
      throw new ApiError(409, "conflict", `document library prefix overlaps ${row.pathPrefix}`);
    }
  }
}

export function needsRevokeConfirm(input: {
  affectedFiles: number;
  affectedMembers: number;
  confirm: boolean;
}): boolean {
  return input.affectedFiles > 0 && input.affectedMembers > 0 && !input.confirm;
}

function libraryRoles(orgRoles: StoredRole[], roleIds: string[]): DocumentLibraryRole[] {
  const byId = new Map(orgRoles.map((role) => [role.id, role]));
  const roles: DocumentLibraryRole[] = [];
  for (const id of roleIds) {
    const role = byId.get(id);
    if (!role) continue;
    roles.push({ id: role.id, code: role.code, name: role.name, status: role.status });
  }
  return roles;
}

async function loadOrgId(admin: any, teamId: string): Promise<string> {
  const { data: team, error } = await admin
    .from("teams")
    .select("oid")
    .eq("id", teamId)
    .maybeSingle();
  if (error) throw error;
  const orgId = typeof team?.oid === "string" ? team.oid.trim() : "";
  if (!orgId) {
    throw new ApiError(500, "internal_error", `team ${teamId} has no org_id`);
  }
  return orgId;
}

async function loadOrgRoles(admin: any, orgId: string): Promise<StoredRole[]> {
  const { data, error } = await publicFrom(admin, "roles")
    .select("id, code, name, status, is_system")
    .eq("org_id", orgId);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    code: row.code,
    name: row.name ?? "",
    status: row.status,
    isSystem: Boolean(row.is_system),
  }));
}

/** Active role codes per member, matching {@link loadCallerRoles} filters. */
async function loadMemberAccess(admin: any, teamId: string, orgId: string): Promise<MemberAccess[]> {
  const { data: members, error } = await admin
    .from("actors")
    .select("id, user_id")
    .eq("team_id", teamId)
    .eq("actor_type", "member");
  if (error) throw error;

  const withUser = (members ?? []).filter((member: any) => member.user_id);
  if (withUser.length === 0) return [];

  const userIds = [...new Set(withUser.map((member: any) => member.user_id))];
  const { data: bindings, error: bindErr } = await publicFrom(admin, "roles_users")
    .select("user_id, role_id")
    .eq("org_id", orgId)
    .in("user_id", userIds)
    .eq("status", "active")
    .is("store_id", null);
  if (bindErr) throw bindErr;

  const roleIds = [...new Set((bindings ?? []).map((row: any) => row.role_id).filter(Boolean))];
  const codeByRole = new Map<string, string>();
  if (roleIds.length > 0) {
    const { data: roles, error: rolesErr } = await publicFrom(admin, "roles")
      .select("id, code")
      .in("id", roleIds)
      .eq("status", "active")
      .eq("org_id", orgId);
    if (rolesErr) throw rolesErr;
    for (const role of roles ?? []) codeByRole.set(role.id, role.code);
  }

  const codesByUser = new Map<string, string[]>();
  for (const binding of bindings ?? []) {
    const code = codeByRole.get(binding.role_id);
    if (!code) continue;
    const list = codesByUser.get(binding.user_id) ?? [];
    if (!list.includes(code)) list.push(code);
    codesByUser.set(binding.user_id, list);
  }

  return withUser.map((member: any) => ({
    actorId: member.id,
    roleCodes: codesByUser.get(member.user_id) ?? [],
  }));
}

async function countLiveFiles(admin: any, teamId: string, pathPrefix: string): Promise<number> {
  if (hasLikeMetachars(pathPrefix)) {
    return (await filesUnderPrefix(admin, teamId, pathPrefix, { liveOnly: true })).length;
  }
  const { count, error } = await admin
    .from("amuxc_files")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId)
    .eq("deleted", false)
    .like("path", `${pathPrefix}%`);
  if (error) throw error;
  return typeof count === "number" ? count : 0;
}

async function previousAudience(
  admin: any,
  aclId: string | null,
  orgRoles: StoredRole[],
): Promise<{ audience: LibraryAudience; grantedRoleIds: string[] }> {
  if (!aclId) return { audience: { kind: "open" }, grantedRoleIds: [] };

  const { data: roleRows, error } = await admin
    .from("amuxc_path_acl_role_grants")
    .select("role_id")
    .eq("acl_id", aclId);
  if (error) throw error;
  const grantedRoleIds = (roleRows ?? []).map((row: any) => row.role_id).filter(Boolean);
  if (grantedRoleIds.length > 0) {
    const codeById = new Map(orgRoles.map((role) => [role.id, role.code]));
    const roleCodes: string[] = [];
    for (const id of grantedRoleIds) {
      const code = codeById.get(id);
      if (code && !roleCodes.includes(code)) roleCodes.push(code);
    }
    return { audience: { kind: "roles", roleCodes }, grantedRoleIds };
  }

  const { data: actorRows, error: actorErr } = await admin
    .from("amuxc_path_acl_grants")
    .select("actor_id")
    .eq("acl_id", aclId);
  if (actorErr) throw actorErr;
  return {
    audience: {
      kind: "actors",
      actorIds: (actorRows ?? []).map((row: any) => row.actor_id).filter(Boolean),
    },
    grantedRoleIds: [],
  };
}

function readRoleIds(body: any): string[] {
  if (body?.roleIds === undefined || body?.roleIds === null) return [];
  if (!Array.isArray(body.roleIds)) {
    throw new ApiError(400, "validation_failed", "roleIds must be an array");
  }
  return body.roleIds;
}

function assertLibraryPrefix(pathPrefix: unknown): string {
  if (typeof pathPrefix !== "string" || !isDocumentLibraryPrefix(pathPrefix)) {
    throw new ApiError(
      400,
      "validation_failed",
      "pathPrefix must be a top-level documents/ folder",
    );
  }
  return pathPrefix;
}

async function replaceWithRoleGrants(
  admin: any,
  aclId: string,
  roleIds: string[],
  grantedBy: string,
  options: { deleteAclOnRoleInsertFailure?: boolean } = {},
): Promise<void> {
  // Role rows land before any delete. A failed insert must not leave the rule
  // with zero grants: sync would treat that as an actor rule that denies owner.
  const { error: insertErr } = await admin.from("amuxc_path_acl_role_grants").upsert(
    roleIds.map((roleId) => ({
      acl_id: aclId,
      role_id: roleId,
      granted_by: grantedBy,
    })),
    { onConflict: "acl_id,role_id" },
  );
  if (insertErr) {
    if (options.deleteAclOnRoleInsertFailure) {
      const { error: cleanupErr } = await admin.from("amuxc_path_acl").delete().eq("id", aclId);
      if (cleanupErr) throw cleanupErr;
    }
    throw insertErr;
  }

  const { error: actorErr } = await admin.from("amuxc_path_acl_grants").delete().eq("acl_id", aclId);
  if (actorErr) throw actorErr;

  if (roleIds.length === 0) return;
  const { error: roleErr } = await admin
    .from("amuxc_path_acl_role_grants")
    .delete()
    .eq("acl_id", aclId)
    .not("role_id", "in", `(${roleIds.join(",")})`);
  if (roleErr) throw roleErr;
}

async function grantsByAcl(
  admin: any,
  table: "amuxc_path_acl_grants" | "amuxc_path_acl_role_grants",
  idColumn: "actor_id" | "role_id",
  aclIds: string[],
): Promise<Map<string, string[]>> {
  const byAcl = new Map<string, string[]>();
  if (aclIds.length === 0) return byAcl;
  const { data, error } = await admin.from(table).select(`acl_id, ${idColumn}`).in("acl_id", aclIds);
  if (error) throw error;
  for (const row of data ?? []) {
    const list = byAcl.get(row.acl_id) ?? [];
    if (row[idColumn]) list.push(row[idColumn]);
    byAcl.set(row.acl_id, list);
  }
  return byAcl;
}

export function makeDocumentLibrariesRepo(host: DocumentLibrariesHost) {
  async function requireTeamAdmin(teamId: string): Promise<string> {
    const actor = await host.resolveCallerActorForTeam(teamId);
    if (!actor) throw new ApiError(403, "forbidden", "not a member of this team");

    // Authz SoT is roles_users via current_team_role (not team_members.role).
    const { data, error } = await host.supabase.rpc("current_team_role", {
      target_team_id: teamId,
    });
    if (error) throw error;
    if (data !== "owner" && data !== "admin") {
      throw new ApiError(403, "forbidden", "team owner or admin access required");
    }
    return actor.id;
  }

  async function resolveWrite(teamId: string, body: any, mode: "preview" | "create" | "put", aclId?: string) {
    const callerActorId = await requireTeamAdmin(teamId);
    const admin = await host.serviceRoleClient(
      mode === "preview"
        ? "preview a document library"
        : mode === "create"
          ? "create a document library"
          : "update a document library",
    );

    let pathPrefix: string;
    let putRowId: string | null = null;
    if (mode === "put") {
      const { data, error } = await admin
        .from("amuxc_path_acl")
        .select("id, path_prefix")
        .eq("id", aclId)
        .eq("team_id", teamId)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new ApiError(404, "not_found", "document library not found");
      if (!isDocumentLibraryPrefix(data.path_prefix)) {
        throw new ApiError(400, "validation_failed", "path is not a document library");
      }
      pathPrefix = data.path_prefix;
      putRowId = data.id;
    } else {
      pathPrefix = assertLibraryPrefix(body?.pathPrefix);
    }

    const orgId = await loadOrgId(admin, teamId);
    const orgRoles = await loadOrgRoles(admin, orgId);

    let existingId: string | null = putRowId;
    if (mode === "create") {
      const { data: rules, error } = await admin
        .from("amuxc_path_acl")
        .select("id, path_prefix")
        .eq("team_id", teamId);
      if (error) throw error;
      const rows = rules ?? [];
      existingId = rows.find((row: any) => row.path_prefix === pathPrefix)?.id ?? null;
      assertNoDocumentOverlap(
        rows.map((row: any) => ({ id: row.id, pathPrefix: row.path_prefix })),
        pathPrefix,
        existingId,
      );
    } else if (mode === "put") {
      const { data: rules, error } = await admin
        .from("amuxc_path_acl")
        .select("id, path_prefix")
        .eq("team_id", teamId);
      if (error) throw error;
      assertNoDocumentOverlap(
        (rules ?? []).map((row: any) => ({ id: row.id, pathPrefix: row.path_prefix })),
        pathPrefix,
        putRowId,
      );
    } else if (mode === "preview") {
      const { data, error } = await admin
        .from("amuxc_path_acl")
        .select("id")
        .eq("team_id", teamId)
        .eq("path_prefix", pathPrefix)
        .maybeSingle();
      if (error) throw error;
      existingId = data?.id ?? null;
    }

    const previous = await previousAudience(admin, existingId, orgRoles);
    // Owner is resolved before any ACL write. A missing active system owner is 500.
    const { roleIds } = prepareRoleIds(orgRoles, readRoleIds(body), new Set(previous.grantedRoleIds));

    const members = await loadMemberAccess(admin, teamId, orgId);
    const previously = previous.audience;
    const codeById = new Map(orgRoles.map((role) => [role.id, role.code]));
    const nextRoleCodes: string[] = [];
    for (const id of roleIds) {
      const code = codeById.get(id);
      if (code && !nextRoleCodes.includes(code)) nextRoleCodes.push(code);
    }
    if (!nextRoleCodes.includes("owner")) nextRoleCodes.unshift("owner");

    const affectedMembers = membersLosingLibraryAccess(members, previously, nextRoleCodes).length;
    const affectedFiles = await countLiveFiles(admin, teamId, pathPrefix);
    if (
      mode !== "preview" &&
      needsRevokeConfirm({
        affectedFiles,
        affectedMembers,
        confirm: body?.confirmRevokeExisting === true,
      })
    ) {
      throw new ApiError(
        409,
        "confirmation_required",
        `restricting ${pathPrefix} removes ${affectedFiles} already-synced file(s) from ${affectedMembers} member(s); resend with confirmRevokeExisting: true`,
        { details: { affectedFiles, affectedMembers } },
      );
    }

    return {
      admin,
      callerActorId,
      pathPrefix,
      roleIds,
      roles: libraryRoles(orgRoles, roleIds),
      affectedFiles,
      affectedMembers,
      existingId,
      widens: libraryGrantWidens(
        previously.kind === "roles"
          ? { kind: "roles", roleIds: previous.grantedRoleIds }
          : { kind: previously.kind },
        roleIds,
      ),
    };
  }

  function savedLibrary(plan: {
    existingId: string | null;
    pathPrefix: string;
    roles: DocumentLibraryRole[];
    affectedFiles: number;
    affectedMembers: number;
  }, aclId: string): DocumentLibrary & { affectedFiles: number; affectedMembers: number } {
    return {
      id: aclId,
      pathPrefix: plan.pathPrefix,
      audience: "roles",
      roles: plan.roles,
      actorIds: [],
      affectedFiles: plan.affectedFiles,
      affectedMembers: plan.affectedMembers,
    };
  }

  return {
    async listDocumentLibraries(teamId: string) {
      await requireTeamAdmin(teamId);
      const admin = await host.serviceRoleClient("read document libraries");
      const { data, error } = await admin
        .from("amuxc_path_acl")
        .select("id, path_prefix")
        .eq("team_id", teamId)
        .order("path_prefix", { ascending: true });
      if (error) throw error;
      const rules = (data ?? []).filter((row: any) => isDocumentLibraryPrefix(row.path_prefix));
      const aclIds = rules.map((row: any) => row.id);
      const actorGrants = await grantsByAcl(admin, "amuxc_path_acl_grants", "actor_id", aclIds);
      const roleGrants = await grantsByAcl(admin, "amuxc_path_acl_role_grants", "role_id", aclIds);

      const roleIds = [...new Set([...roleGrants.values()].flat())];
      const rolesById = new Map<string, DocumentLibraryRole>();
      if (roleIds.length > 0) {
        const { data: roles, error: rolesErr } = await publicFrom(admin, "roles")
          .select("id, code, name, status")
          .in("id", roleIds);
        if (rolesErr) throw rolesErr;
        for (const role of roles ?? []) {
          rolesById.set(role.id, {
            id: role.id,
            code: role.code,
            name: role.name ?? "",
            status: role.status,
          });
        }
      }

      return {
        items: rules.map((row: any) => {
          const grantedRoleIds = roleGrants.get(row.id) ?? [];
          if (grantedRoleIds.length > 0) {
            const roles: DocumentLibraryRole[] = [];
            for (const id of grantedRoleIds) {
              const role = rolesById.get(id);
              if (role) roles.push(role);
            }
            const library: DocumentLibrary = {
              id: row.id,
              pathPrefix: row.path_prefix,
              audience: "roles",
              roles,
              actorIds: [],
            };
            return library;
          }
          const library: DocumentLibrary = {
            id: row.id,
            pathPrefix: row.path_prefix,
            audience: "actors",
            roles: [],
            actorIds: actorGrants.get(row.id) ?? [],
          };
          return library;
        }),
      };
    },

    async previewDocumentLibrary(teamId: string, body: any = {}) {
      const plan = await resolveWrite(teamId, body, "preview");
      return {
        pathPrefix: plan.pathPrefix,
        affectedFiles: plan.affectedFiles,
        affectedMembers: plan.affectedMembers,
      };
    },

    async createDocumentLibrary(teamId: string, body: any = {}) {
      const plan = await resolveWrite(teamId, body, "create");
      let aclId = plan.existingId;
      const createdAcl = !aclId;
      if (!aclId) {
        const { count, error: countErr } = await adminCount(plan.admin, teamId);
        if (countErr) throw countErr;
        if ((count ?? 0) >= MAX_ACL_RULES_PER_TEAM) {
          throw new ApiError(
            422,
            "validation_failed",
            `team is at its knowledge ACL rule limit (${MAX_ACL_RULES_PER_TEAM})`,
          );
        }
        const { data: inserted, error } = await plan.admin
          .from("amuxc_path_acl")
          .insert({
            team_id: teamId,
            path_prefix: plan.pathPrefix,
            created_by: plan.callerActorId,
          })
          .select("id")
          .single();
        if (error) throw error;
        aclId = inserted.id;
      }

      await replaceWithRoleGrants(plan.admin, aclId, plan.roleIds, plan.callerActorId, {
        deleteAclOnRoleInsertFailure: createdAcl,
      });
      // Only a widened audience needs existing files put back in range.
      if (plan.widens) await resurfaceAclPrefix(plan.admin, teamId, plan.pathPrefix);
      invalidateTeamAcl(teamId);
      return savedLibrary(plan, aclId);
    },

    async putDocumentLibrary(teamId: string, aclId: string, body: any = {}) {
      const plan = await resolveWrite(teamId, body, "put", aclId);
      await replaceWithRoleGrants(plan.admin, aclId, plan.roleIds, plan.callerActorId);
      // Narrowing is the client noticing files stopped arriving; nothing to resurface.
      if (plan.widens) await resurfaceAclPrefix(plan.admin, teamId, plan.pathPrefix);
      invalidateTeamAcl(teamId);
      return savedLibrary(plan, aclId);
    },

    async deleteDocumentLibrary(teamId: string, aclId: string) {
      await requireTeamAdmin(teamId);
      const admin = await host.serviceRoleClient("delete a document library");
      const { data, error } = await admin
        .from("amuxc_path_acl")
        .select("id, path_prefix")
        .eq("id", aclId)
        .eq("team_id", teamId)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new ApiError(404, "not_found", "document library not found");
      if (!isDocumentLibraryPrefix(data.path_prefix)) {
        throw new ApiError(400, "validation_failed", "path is not a document library");
      }
      const { error: deleteErr } = await admin.from("amuxc_path_acl").delete().eq("id", aclId);
      if (deleteErr) throw deleteErr;
      await resurfaceAclPrefix(admin, teamId, data.path_prefix);
      invalidateTeamAcl(teamId);
    },
  };
}

async function adminCount(admin: any, teamId: string) {
  return admin
    .from("amuxc_path_acl")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId);
}
