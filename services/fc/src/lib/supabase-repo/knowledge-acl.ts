/**
 * Knowledge path ACL — management repository (supabase backend, production).
 *
 * Design: docs/specs/2026-08-31-knowledge-path-acl-design.md
 *
 * ## Why every query here uses the service role
 *
 * `amuxc_path_acl*` and `amuxc_access_log` carry RLS with NO policy, which is a
 * deny-all for `authenticated`. That is deliberate: `path_prefix` is a directory
 * name and therefore sensitive, so there is no permissive policy that would be
 * correct (design D7). Authorisation is done here instead — owner/admin, checked
 * before anything is read or written — exactly as the /sync/* handlers do it.
 *
 * The caller-token client is still used for membership + `current_team_role`
 * (roles_users), so a caller cannot assert admin over a team RLS would not show them.
 */

import { ApiError } from "../http-utils.js";
import {
  MAX_ACL_RULES_PER_TEAM,
  invalidateTeamAcl,
  validateAclPrefix,
} from "../sync-acl.js";

export interface AclImpact {
  affectedFiles: number;
  affectedMembers: number;
}

export function assertLegacyDocumentCreate(pathPrefix: string): void {
  if (pathPrefix.startsWith("documents/")) {
    throw new ApiError(
      400,
      "validation_failed",
      "document folders are restricted via /v1/teams/{teamId}/document-libraries",
    );
  }
}

export function assertLegacyDocumentUpdate(roleGrantCount: number): void {
  if (roleGrantCount > 0) {
    throw new ApiError(409, "conflict", "this folder is granted by role");
  }
}

interface KnowledgeAclHost {
  /** Caller-token client; RLS applies. */
  supabase: any;
  /** Service-role client factory; RLS bypassed. `what` is for the error text. */
  serviceRoleClient: (what: string) => Promise<any>;
  /** Resolves the bearer caller's actor in this team, or null. */
  resolveCallerActorForTeam: (teamId: string) => Promise<{ id: string } | null>;
}

/**
 * Put every file under `pathPrefix` back into manifest range for everyone.
 *
 * A newly granted actor would otherwise never receive the directory's existing
 * files: the client advances `last_server_seq` past rows it was not shown, and
 * asks for the manifest by `afterSeq`. Bumping `change_seq` — NOT `version` —
 * makes those rows visible again while staying a no-op for teammates who
 * already hold them, because the client only downloads when the server version
 * is strictly greater than its own.
 *
 * The team counter is bumped first, matching the waterline invariant every
 * other writer follows.
 *
 * Best effort by design: a team that has never synced has no
 * `team_workspace_config` row, and that must not stop an admin from writing
 * rules ahead of first sync.
 */
export async function resurfaceAclPrefix(admin: any, teamId: string, pathPrefix: string): Promise<void> {
  const { data: wc, error: wcErr } = await admin
    .from("team_workspace_config")
    .select("oss_change_seq")
    .eq("team_id", teamId)
    .maybeSingle();
  if (wcErr || !wc) return;

  const nextSeq = Number(wc.oss_change_seq) + 1;
  const { error: bumpErr } = await admin
    .from("team_workspace_config")
    .update({ oss_change_seq: nextSeq })
    .eq("team_id", teamId);
  if (bumpErr) throw bumpErr;

  if (!hasLikeMetachars(pathPrefix)) {
    const { error: filesErr } = await admin
      .from("amuxc_files")
      .update({ change_seq: nextSeq })
      .eq("team_id", teamId)
      .like("path", `${pathPrefix}%`);
    if (filesErr) throw filesErr;
    return;
  }

  const files = await filesUnderPrefix(admin, teamId, pathPrefix, { liveOnly: false });
  for (let i = 0; i < files.length; i += ID_BATCH) {
    const { error: filesErr } = await admin
      .from("amuxc_files")
      .update({ change_seq: nextSeq })
      .in("id", files.slice(i, i + ID_BATCH).map((file) => file.id));
    if (filesErr) throw filesErr;
  }
}

/**
 * `%` and `_` are LIKE wildcards, `\` is its escape character, and PostgREST
 * also turns `*` into `%`. A folder name holding any of them cannot go into a
 * `like` filter as-is: `documents/a_b/%` also matches `documents/axb/…`.
 */
export function hasLikeMetachars(pathPrefix: string): boolean {
  return /[%_*\\]/.test(pathPrefix);
}

const PAGE = 1000;
const ID_BATCH = 200;

/**
 * Files whose path starts with `pathPrefix`, for a prefix that
 * {@link hasLikeMetachars}. The `like` filter is widened to a superset (each
 * `\` becomes `_`) and the exact match is done here.
 */
export async function filesUnderPrefix(
  admin: any,
  teamId: string,
  pathPrefix: string,
  options: { liveOnly: boolean },
): Promise<Array<{ id: string; path: string }>> {
  const pattern = `${pathPrefix.replace(/\\/g, "_")}%`;
  const matched: Array<{ id: string; path: string }> = [];
  for (let from = 0; ; from += PAGE) {
    let query = admin.from("amuxc_files").select("id, path").eq("team_id", teamId);
    if (options.liveOnly) query = query.eq("deleted", false);
    const { data, error } = await query
      .like("path", pattern)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      if (typeof row?.path === "string" && row.path.startsWith(pathPrefix)) {
        matched.push({ id: row.id, path: row.path });
      }
    }
    if (rows.length < PAGE) return matched;
  }
}

export function makeKnowledgeAclRepo(host: KnowledgeAclHost) {
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

  function assertPrefix(pathPrefix: unknown): string {
    const check = validateAclPrefix(pathPrefix);
    if (!check.ok) throw new ApiError(400, "validation_failed", check.message);
    return pathPrefix as string;
  }

  /**
   * Files and members that a restriction would cut off.
   *
   * Members only — agents inherit their device owner (design D2), so counting
   * them would inflate the number with subjects that hold no access of their own.
   */
  async function impactOf(
    admin: any,
    teamId: string,
    pathPrefix: string,
    keepActorIds: string[],
  ): Promise<AclImpact> {
    const { count, error } = await admin
      .from("amuxc_files")
      .select("id", { count: "exact", head: true })
      .eq("team_id", teamId)
      .eq("deleted", false)
      .like("path", `${pathPrefix}%`);
    if (error) throw error;

    const { data: members, error: mErr } = await admin
      .from("actors")
      .select("id")
      .eq("team_id", teamId)
      .eq("actor_type", "member");
    if (mErr) throw mErr;

    const keep = new Set(keepActorIds);
    return {
      affectedFiles: typeof count === "number" ? count : 0,
      affectedMembers: (members ?? []).filter((m: any) => !keep.has(m.id)).length,
    };
  }

  function mapRule(row: any, actorIds: string[], roleGrantCount = 0) {
    return {
      id: row.id,
      pathPrefix: row.path_prefix,
      actorIds,
      audience: roleGrantCount > 0 ? ("roles" as const) : ("actors" as const),
      createdBy: row.created_by,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  async function loadRule(admin: any, teamId: string, aclId: string) {
    const { data, error } = await admin
      .from("amuxc_path_acl")
      .select("*")
      .eq("id", aclId)
      .eq("team_id", teamId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(404, "not_found", "knowledge ACL rule not found");
    return data;
  }

  async function grantsFor(admin: any, aclIds: string[]): Promise<Map<string, string[]>> {
    const byAcl = new Map<string, string[]>();
    if (aclIds.length === 0) return byAcl;
    const { data, error } = await admin
      .from("amuxc_path_acl_grants")
      .select("acl_id, actor_id")
      .in("acl_id", aclIds);
    if (error) throw error;
    for (const r of data ?? []) {
      const list = byAcl.get(r.acl_id) ?? [];
      list.push(r.actor_id);
      byAcl.set(r.acl_id, list);
    }
    return byAcl;
  }

  async function roleGrantCountsFor(admin: any, aclIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (aclIds.length === 0) return counts;
    const { data, error } = await admin
      .from("amuxc_path_acl_role_grants")
      .select("acl_id")
      .in("acl_id", aclIds);
    if (error) throw error;
    for (const row of data ?? []) {
      counts.set(row.acl_id, (counts.get(row.acl_id) ?? 0) + 1);
    }
    return counts;
  }

  return {
    async listKnowledgeAcl(teamId: string) {
      await requireTeamAdmin(teamId);
      const admin = await host.serviceRoleClient("read knowledge ACL rules");
      const { data, error } = await admin
        .from("amuxc_path_acl")
        .select("*")
        .eq("team_id", teamId)
        .order("path_prefix", { ascending: true });
      if (error) throw error;
      const rules = data ?? [];
      const aclIds = rules.map((r: any) => r.id);
      const byAcl = await grantsFor(admin, aclIds);
      const roleCounts = await roleGrantCountsFor(admin, aclIds);
      return {
        items: rules.map((r: any) =>
          mapRule(r, byAcl.get(r.id) ?? [], roleCounts.get(r.id) ?? 0),
        ),
      };
    },

    /** Dry run for the confirmation screen. Reads only. */
    async previewKnowledgeAcl(teamId: string, body: any = {}) {
      await requireTeamAdmin(teamId);
      const pathPrefix = assertPrefix(body.pathPrefix);
      const actorIds: string[] = Array.isArray(body.actorIds) ? body.actorIds : [];
      const admin = await host.serviceRoleClient("preview knowledge ACL impact");
      return { pathPrefix, ...(await impactOf(admin, teamId, pathPrefix, actorIds)) };
    },

    async createKnowledgeAcl(teamId: string, body: any = {}) {
      const callerActorId = await requireTeamAdmin(teamId);
      const pathPrefix = assertPrefix(body.pathPrefix);
      assertLegacyDocumentCreate(pathPrefix);
      const actorIds: string[] = Array.isArray(body.actorIds) ? body.actorIds : [];
      const admin = await host.serviceRoleClient("create a knowledge ACL rule");

      const { count: ruleCount, error: cErr } = await admin
        .from("amuxc_path_acl")
        .select("id", { count: "exact", head: true })
        .eq("team_id", teamId);
      if (cErr) throw cErr;
      if ((ruleCount ?? 0) >= MAX_ACL_RULES_PER_TEAM) {
        throw new ApiError(
          422,
          "validation_failed",
          `team is at its knowledge ACL rule limit (${MAX_ACL_RULES_PER_TEAM})`,
        );
      }

      // Restricting a populated directory takes it off every unlisted member's
      // disk. Refuse until the caller has been shown the number (design D8).
      const impact = await impactOf(admin, teamId, pathPrefix, actorIds);
      if (impact.affectedFiles > 0 && body.confirmRevokeExisting !== true) {
        throw new ApiError(
          409,
          "confirmation_required",
          `restricting ${pathPrefix} removes ${impact.affectedFiles} already-synced file(s) from ${impact.affectedMembers} member(s); resend with confirmRevokeExisting: true`,
          { details: impact },
        );
      }

      const { data: rule, error } = await admin
        .from("amuxc_path_acl")
        .insert({ team_id: teamId, path_prefix: pathPrefix, created_by: callerActorId })
        .select()
        .single();
      if (error) throw error;

      if (actorIds.length > 0) {
        const { error: gErr } = await admin.from("amuxc_path_acl_grants").insert(
          actorIds.map((actorId) => ({
            acl_id: rule.id,
            actor_id: actorId,
            granted_by: callerActorId,
          })),
        );
        if (gErr) throw gErr;
      }

      // Granted actors may be missing files that predate this rule.
      await resurfaceAclPrefix(admin, teamId, pathPrefix);
      invalidateTeamAcl(teamId);
      return { ...mapRule(rule, actorIds), ...impact };
    },

    async updateKnowledgeAcl(teamId: string, aclId: string, body: any = {}) {
      const callerActorId = await requireTeamAdmin(teamId);
      const admin = await host.serviceRoleClient("update a knowledge ACL rule");
      const rule = await loadRule(admin, teamId, aclId);

      const add: string[] = Array.isArray(body.addActorIds) ? body.addActorIds : [];
      const remove: string[] = Array.isArray(body.removeActorIds) ? body.removeActorIds : [];

      if (add.length > 0 || remove.length > 0) {
        const { count: roleGrantCount, error: roleCountErr } = await admin
          .from("amuxc_path_acl_role_grants")
          .select("acl_id", { count: "exact", head: true })
          .eq("acl_id", aclId);
        if (roleCountErr) throw roleCountErr;
        assertLegacyDocumentUpdate(roleGrantCount ?? 0);
      }

      if (remove.length > 0) {
        const { error } = await admin
          .from("amuxc_path_acl_grants")
          .delete()
          .eq("acl_id", aclId)
          .in("actor_id", remove);
        if (error) throw error;
      }
      if (add.length > 0) {
        const { error } = await admin
          .from("amuxc_path_acl_grants")
          .upsert(
            add.map((actorId) => ({
              acl_id: aclId,
              actor_id: actorId,
              granted_by: callerActorId,
            })),
            { onConflict: "acl_id,actor_id", ignoreDuplicates: true },
          );
        if (error) throw error;
        // Only a grant needs files put back in range; a revocation is the client
        // noticing they stopped arriving.
        await resurfaceAclPrefix(admin, teamId, rule.path_prefix);
      }

      await admin
        .from("amuxc_path_acl")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", aclId);

      invalidateTeamAcl(teamId);
      const byAcl = await grantsFor(admin, [aclId]);
      const roleCounts = await roleGrantCountsFor(admin, [aclId]);
      return mapRule(rule, byAcl.get(aclId) ?? [], roleCounts.get(aclId) ?? 0);
    },

    /** Remove the rule, reopening the prefix to the whole team. */
    async deleteKnowledgeAcl(teamId: string, aclId: string) {
      await requireTeamAdmin(teamId);
      const admin = await host.serviceRoleClient("delete a knowledge ACL rule");
      const rule = await loadRule(admin, teamId, aclId);
      const { error } = await admin.from("amuxc_path_acl").delete().eq("id", aclId);
      if (error) throw error;
      // Everyone gains the directory at once, and none of them hold its files.
      await resurfaceAclPrefix(admin, teamId, rule.path_prefix);
      invalidateTeamAcl(teamId);
    },
  };
}
