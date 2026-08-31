/**
 * Knowledge path ACL — management repository (postgres backend).
 *
 * Design: docs/specs/2026-08-31-knowledge-path-acl-design.md
 *
 * The read side of the ACL — deciding whether a caller may see a path — lives in
 * lib/sync-acl.ts and is deliberately NOT here. This module only creates,
 * changes and removes the rules; every mutation ends by invalidating the cache
 * that module keeps, so an admin's grant is visible on the next sync rather than
 * up to ten seconds later.
 *
 * Owner/admin only, mirroring team-mcp.ts. Ordinary members cannot mark their
 * own directories restricted: permissions scattered across whoever happened to
 * create a folder is exactly the state this feature exists to replace.
 */

import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  actors,
  amuxcFiles,
  amuxcPathAcl,
  amuxcPathAclGrants,
  teamWorkspaceConfig,
} from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";
import { requireActorForTeam, resolveTeamRole } from "./authz.js";
import {
  MAX_ACL_RULES_PER_TEAM,
  invalidateTeamAcl,
  validateAclPrefix,
} from "../sync-acl.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

export interface KnowledgeAclCtx {
  userId?: string | null;
}

/** How many live files sit under a prefix, and how many actors lose them. */
export interface AclImpact {
  affectedFiles: number;
  affectedMembers: number;
}

export function makeKnowledgeAclRepo(db: DbLike, ctx: KnowledgeAclCtx) {
  function requireUser(): string {
    if (!ctx.userId) throw new ApiError(401, "unauthorized", "authentication required");
    return ctx.userId;
  }

  async function requireTeamAdmin(teamId: string): Promise<string> {
    const userId = requireUser();
    const actorId = await requireActorForTeam(db, userId, teamId);
    const role = await resolveTeamRole(db, userId, teamId);
    if (role !== "owner" && role !== "admin") {
      throw new ApiError(403, "forbidden", "team owner or admin access required");
    }
    return actorId;
  }

  function assertPrefix(pathPrefix: unknown): string {
    const check = validateAclPrefix(pathPrefix);
    if (!check.ok) throw new ApiError(400, "validation_failed", check.message);
    return pathPrefix as string;
  }

  /**
   * Everyone who would lose access if `pathPrefix` were restricted to
   * `keepActorIds`, plus how many live files that covers.
   *
   * This is the number the admin sees before confirming (design D8). It counts
   * MEMBER actors only: agents inherit the device owner (design D2), so counting
   * them would inflate the figure with subjects that have no independent access.
   */
  async function impactOf(
    teamId: string,
    pathPrefix: string,
    keepActorIds: string[],
  ): Promise<AclImpact> {
    const [{ count: fileCount } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(amuxcFiles)
      .where(
        and(
          eq(amuxcFiles.teamId, teamId),
          eq(amuxcFiles.deleted, false),
          like(amuxcFiles.path, `${pathPrefix}%`),
        ),
      );

    const members = await db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.teamId, teamId), eq(actors.actorType, "member")));

    const keep = new Set(keepActorIds);
    return {
      affectedFiles: Number(fileCount ?? 0),
      affectedMembers: members.filter((m: { id: string }) => !keep.has(m.id)).length,
    };
  }

  /**
   * Re-surface every file under `pathPrefix` in the next manifest, for everyone.
   *
   * Without this, a newly granted actor never sees the directory's existing
   * files: the client advances `last_server_seq` past rows it was not shown, and
   * the manifest is queried by `afterSeq`. Bumping `change_seq` puts them back in
   * range.
   *
   * Costs the rest of the team nothing but a no-op: they already hold these
   * versions, and the client's pull only downloads when the server's version is
   * strictly greater than the local one. `version` is untouched here on purpose —
   * bumping it would make every teammate re-download the whole directory.
   *
   * Same waterline order as every other writer: bump the team counter FIRST,
   * inside the transaction, so a manifest reading snapshot N can never miss a row
   * that belongs to it.
   */
  async function resurfacePrefix(tx: DbLike, teamId: string, pathPrefix: string): Promise<void> {
    const [wcRow] = await tx
      .update(teamWorkspaceConfig)
      .set({ ossChangeSeq: sql`${teamWorkspaceConfig.ossChangeSeq} + 1` })
      .where(eq(teamWorkspaceConfig.teamId, teamId))
      .returning({ ossChangeSeq: teamWorkspaceConfig.ossChangeSeq });
    if (!wcRow) return; // team not configured for sync yet — nothing to resurface

    await tx
      .update(amuxcFiles)
      .set({ changeSeq: wcRow.ossChangeSeq })
      .where(and(eq(amuxcFiles.teamId, teamId), like(amuxcFiles.path, `${pathPrefix}%`)));
  }

  async function loadRule(teamId: string, aclId: string) {
    const [row] = await db
      .select()
      .from(amuxcPathAcl)
      .where(and(eq(amuxcPathAcl.id, aclId), eq(amuxcPathAcl.teamId, teamId)))
      .limit(1);
    if (!row) throw new ApiError(404, "not_found", "knowledge ACL rule not found");
    return row;
  }

  async function grantsFor(aclIds: string[]) {
    if (aclIds.length === 0) return new Map<string, string[]>();
    const rows = await db
      .select({ aclId: amuxcPathAclGrants.aclId, actorId: amuxcPathAclGrants.actorId })
      .from(amuxcPathAclGrants)
      .where(inArray(amuxcPathAclGrants.aclId, aclIds));
    const byAcl = new Map<string, string[]>();
    for (const r of rows as { aclId: string; actorId: string }[]) {
      const list = byAcl.get(r.aclId) ?? [];
      list.push(r.actorId);
      byAcl.set(r.aclId, list);
    }
    return byAcl;
  }

  function mapRule(row: any, actorIds: string[]) {
    return {
      id: row.id,
      pathPrefix: row.pathPrefix,
      actorIds,
      createdBy: row.createdBy,
      createdAt: row.createdAt?.toISOString?.() ?? row.createdAt ?? null,
      updatedAt: row.updatedAt?.toISOString?.() ?? row.updatedAt ?? null,
    };
  }

  return {
    async listKnowledgeAcl(teamId: string) {
      await requireTeamAdmin(teamId);
      const rules = await db
        .select()
        .from(amuxcPathAcl)
        .where(eq(amuxcPathAcl.teamId, teamId))
        .orderBy(amuxcPathAcl.pathPrefix);
      const byAcl = await grantsFor(rules.map((r: any) => r.id));
      return { items: rules.map((r: any) => mapRule(r, byAcl.get(r.id) ?? [])) };
    },

    /** Dry run for the confirmation screen. Reads only; changes nothing. */
    async previewKnowledgeAcl(teamId: string, body: any = {}) {
      await requireTeamAdmin(teamId);
      const pathPrefix = assertPrefix(body.pathPrefix);
      const actorIds: string[] = Array.isArray(body.actorIds) ? body.actorIds : [];
      return { pathPrefix, ...(await impactOf(teamId, pathPrefix, actorIds)) };
    },

    async createKnowledgeAcl(teamId: string, body: any = {}) {
      const callerActorId = await requireTeamAdmin(teamId);
      const pathPrefix = assertPrefix(body.pathPrefix);
      const actorIds: string[] = Array.isArray(body.actorIds) ? body.actorIds : [];

      const [{ count: ruleCount } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(amuxcPathAcl)
        .where(eq(amuxcPathAcl.teamId, teamId));
      if (Number(ruleCount ?? 0) >= MAX_ACL_RULES_PER_TEAM) {
        throw new ApiError(
          422,
          "validation_failed",
          `team is at its knowledge ACL rule limit (${MAX_ACL_RULES_PER_TEAM})`,
        );
      }

      // Restricting a directory that already holds files takes it off every
      // unlisted member's disk. Refuse until the caller has seen the number.
      const impact = await impactOf(teamId, pathPrefix, actorIds);
      if (impact.affectedFiles > 0 && body.confirmRevokeExisting !== true) {
        throw new ApiError(
          409,
          "confirmation_required",
          `restricting ${pathPrefix} removes ${impact.affectedFiles} already-synced file(s) from ${impact.affectedMembers} member(s); resend with confirmRevokeExisting: true`,
          { details: impact },
        );
      }

      const created = await db.transaction(async (tx: DbLike) => {
        const [rule] = await (tx.insert(amuxcPathAcl) as any)
          .values({ teamId, pathPrefix, createdBy: callerActorId })
          .returning();
        if (actorIds.length > 0) {
          await (tx.insert(amuxcPathAclGrants) as any).values(
            actorIds.map((actorId) => ({
              aclId: rule.id,
              actorId,
              grantedBy: callerActorId,
            })),
          );
        }
        // Granted actors may already be missing files that predate the rule.
        await resurfacePrefix(tx, teamId, pathPrefix);
        return rule;
      });

      invalidateTeamAcl(teamId);
      return { ...mapRule(created, actorIds), ...impact };
    },

    async updateKnowledgeAcl(teamId: string, aclId: string, body: any = {}) {
      const callerActorId = await requireTeamAdmin(teamId);
      const rule = await loadRule(teamId, aclId);
      const add: string[] = Array.isArray(body.addActorIds) ? body.addActorIds : [];
      const remove: string[] = Array.isArray(body.removeActorIds) ? body.removeActorIds : [];

      await db.transaction(async (tx: DbLike) => {
        if (remove.length > 0) {
          await tx
            .delete(amuxcPathAclGrants)
            .where(
              and(
                eq(amuxcPathAclGrants.aclId, aclId),
                inArray(amuxcPathAclGrants.actorId, remove),
              ),
            );
        }
        if (add.length > 0) {
          await (tx.insert(amuxcPathAclGrants) as any)
            .values(
              add.map((actorId) => ({ aclId, actorId, grantedBy: callerActorId })),
            )
            .onConflictDoNothing();
          // Only a grant needs the files put back in manifest range; a
          // revocation is the client noticing they are gone.
          await resurfacePrefix(tx, teamId, rule.pathPrefix);
        }
        await tx
          .update(amuxcPathAcl)
          .set({ updatedAt: new Date() })
          .where(eq(amuxcPathAcl.id, aclId));
      });

      invalidateTeamAcl(teamId);
      const byAcl = await grantsFor([aclId]);
      return mapRule(rule, byAcl.get(aclId) ?? []);
    },

    /** Remove the rule, reopening the prefix to the whole team. */
    async deleteKnowledgeAcl(teamId: string, aclId: string) {
      await requireTeamAdmin(teamId);
      const rule = await loadRule(teamId, aclId);
      await db.transaction(async (tx: DbLike) => {
        await tx.delete(amuxcPathAcl).where(eq(amuxcPathAcl.id, aclId));
        // Everyone gains the directory at once, and none of them have its files.
        await resurfacePrefix(tx, teamId, rule.pathPrefix);
      });
      invalidateTeamAcl(teamId);
    },
  };
}
