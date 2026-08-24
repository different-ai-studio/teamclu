/**
 * Agents domain — pg-repo implementation.
 *
 * Owner-gated mutations (updateOwnedAgentProfile, shareAgentToTeam,
 * makeAgentPersonal) use team-scoped owner resolution via
 * resolveActorForAgent + checkAgentOwnership — never the bugged global
 * current_member_id().
 *
 * checkAgentPermission(agentId, actorId) → { allowed, role } reads from
 * agentMemberAccess directly.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { actors, agents, agentMemberAccess } from "../../db/schema/index.js";
import {
  resolveActorForAgent,
  resolveActorForTeam,
  checkAgentOwnership,
  checkAgentPermission as authzCheckAgentPermission,
} from "./authz.js";
import { ApiError } from "../http-utils.js";
import { normalizeAgentTypes } from "../agent-types.js";
import { isListableAgentStatus } from "../agent-status.js";

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface AgentsCtx {
  userId?: string;
  callerActorId?: string;
  /**
   * Mints the one-shot agent invite. Injected rather than imported so this repo
   * does not reach into the teams repo (and so the owner check on
   * `targetActorId` stays in one place). Wired in pg-repo/index.ts.
   */
  mintAgentInvite?: (
    teamId: string,
    input: { displayName: string; targetActorId: string; ttlSeconds: number },
  ) => Promise<{ token: string; expiresAt?: string | null }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeAgentsRepo(db: DbLike, ctx: AgentsCtx = {}) {
  return {
    async resolveCallerActorForTeam(teamId: string) {
      const id = ctx.callerActorId ?? (ctx.userId ? await resolveActorForTeam(db, ctx.userId, teamId) : undefined);
      return id ? { id } : null;
    },

    async authorizeAgentManagement(agentId: string, teamId: string) {
      if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
      const [target] = await db
        .select({ teamId: actors.teamId, ownerMemberId: agents.ownerMemberId })
        .from(agents)
        .innerJoin(actors, eq(actors.id, agents.id))
        .where(eq(agents.id, agentId))
        .limit(1);
      // Scoped to the team the caller named, so this cannot be used to probe
      // agent ids in teams the caller is not a member of.
      if (!target || target.teamId !== teamId) throw new ApiError(404, "not_found", "agent not found");
      const requesterActorId = ctx.callerActorId ?? (ctx.userId ? await resolveActorForTeam(db, ctx.userId, target.teamId) : undefined);
      if (!requesterActorId) throw new ApiError(403, "forbidden", "team membership required");
      const role = await authzCheckAgentPermission(db, requesterActorId, agentId);
      if (target.ownerMemberId !== requesterActorId && role !== "admin") {
        throw new ApiError(403, "forbidden", "agent owner or admin access required");
      }
      return { teamId: target.teamId, requesterActorId };
    },

    /**
     * Idempotent per (team, device, owner): returns the caller-owned agent already bound
     * to this machine in this team, creating it when absent, plus a one-shot
     * invite for the local daemon to claim.
     *
     * An agent bound to the device but owned by another account counts as absent
     * — a shared machine gets one agent per account, and neither silently takes
     * over the other's (mirrors amux.ensure_agent_for_device).
     *
     * Concurrency: the Supabase path serializes on an advisory lock inside the
     * RPC. Here the unique index (team_id, device_id, owner_member_id) is the arbiter — the loser
     * of a race catches the violation and re-reads the winner's row, so two cold
     * starts still converge on one agent.
     */
    /**
     * Read-only lookup: this machine's agent in this team, if the caller owns one.
     * Mirrors amux.find_agent_for_device.
     */
    async findAgentForDevice(teamId: string, input: { deviceId: string }) {
      const deviceId = (input.deviceId ?? "").trim();
      if (!deviceId) throw new ApiError(400, "validation_failed", "deviceId is required");
      const callerActorId =
        ctx.callerActorId ??
        (ctx.userId ? await resolveActorForTeam(db, ctx.userId, teamId) : undefined);
      if (!callerActorId) return { agentId: null, displayName: null };
      const [row] = await db
        .select({ id: agents.id, displayName: actors.displayName })
        .from(agents)
        .innerJoin(actors, eq(actors.id, agents.id))
        .where(
          and(
            eq(actors.teamId, teamId),
            eq(agents.deviceId, deviceId),
            eq(agents.ownerMemberId, callerActorId),
          ),
        )
        .limit(1);
      return { agentId: row?.id ?? null, displayName: row?.displayName ?? null };
    },

    async ensureAgentForDevice(
      teamId: string,
      input: { deviceId: string; displayName: string },
    ) {
      const deviceId = (input.deviceId ?? "").trim();
      const displayName = (input.displayName ?? "").trim();
      if (!deviceId) throw new ApiError(400, "validation_failed", "deviceId is required");
      if (!displayName) throw new ApiError(400, "validation_failed", "displayName is required");
      if (!ctx.mintAgentInvite) {
        throw new ApiError(500, "not_wired", "ensureAgentForDevice needs mintAgentInvite");
      }

      const callerActorId =
        ctx.callerActorId ??
        (ctx.userId ? await resolveActorForTeam(db, ctx.userId, teamId) : undefined);
      if (!callerActorId) {
        throw new ApiError(403, "forbidden", "team membership required");
      }

      const findOwned = async (): Promise<string | null> => {
        const [row] = await db
          .select({ id: agents.id, displayName: actors.displayName })
          .from(agents)
          .innerJoin(actors, eq(actors.id, agents.id))
          .where(
            and(
              eq(actors.teamId, teamId),
              eq(agents.deviceId, deviceId),
              eq(agents.ownerMemberId, callerActorId),
            ),
          )
          .limit(1);
        return row?.id ?? null;
      };

      let agentId = await findOwned();
      let created = false;

      if (!agentId) {
        try {
          // One transaction so a unique-index violation on the agents insert also
          // rolls back the actor row instead of leaving a nameless orphan behind.
          agentId = await (db as any).transaction(async (tx: any) => {
            const [actor] = await tx
              .insert(actors)
              .values({
                teamId,
                actorType: "agent",
                displayName,
                invitedByActorId: callerActorId,
              })
              .returning();
            await tx.insert(agents).values({
              id: actor.id,
              ownerMemberId: callerActorId,
              status: "active",
              agentKind: "claude",
              deviceId,
              teamId,
              // visibility deliberately omitted: the column default is
              // 'personal', which is the wanted default now that nothing asks.
            });
            await tx
              .insert(agentMemberAccess)
              .values({
                agentId: actor.id,
                memberId: callerActorId,
                permissionLevel: "admin",
                grantedByMemberId: callerActorId,
              })
              .onConflictDoNothing();
            return actor.id as string;
          });
          created = true;
        } catch (err) {
          // Lost the race: findOwned (no status filter) finds the winner's row.
          agentId = await findOwned();
          if (!agentId) throw err;
        }
      }
      // displayName is create-only (parity with amux.ensure_agent_for_device):
      // re-applying it on a rebind would overwrite a later rename with whatever
      // the client last sent — the hostname, when the user skipped naming.

      const invite = await ctx.mintAgentInvite(teamId, {
        displayName,
        targetActorId: agentId,
        // Claimed immediately by `amuxd init`; a tight window avoids leaving live
        // agent invites behind when init fails.
        ttlSeconds: 600,
      });

      return {
        agentId,
        token: invite.token,
        expiresAt: invite.expiresAt ?? null,
        created,
      };
    },

    /**
     * Lists all agent actors connected to a team (visibility = team OR personal
     * when owned by caller). Returns items with kind="agent".
     *
     * Replaces the list_connected_agents RPC.
     */
    async listConnectedAgents(teamId: string) {
      // Join actors + agents for the given team
      const rows = await db
        .select({
          id: actors.id,
          teamId: actors.teamId,
          displayName: actors.displayName,
          avatarUrl: actors.avatarUrl,
          actorType: actors.actorType,
          agentKind: agents.agentKind,
          status: agents.status,
          visibility: agents.visibility,
          ownerMemberId: agents.ownerMemberId,
          agentTypes: agents.agentTypes,
          defaultAgentType: agents.defaultAgentType,
          defaultWorkspaceId: agents.defaultWorkspaceId,
          createdAt: agents.createdAt,
          updatedAt: agents.updatedAt,
        })
        .from(actors)
        .innerJoin(agents, eq(agents.id, actors.id))
        .where(eq(actors.teamId, teamId));

      const callerActorId = ctx.callerActorId ?? (ctx.userId ? await resolveActorForTeam(db, ctx.userId, teamId) ?? undefined : undefined);
      const permissionByAgent = new Map<string, string>();
      if (callerActorId && rows.length > 0) {
        const accessRows = await db
          .select({
            agentId: agentMemberAccess.agentId,
            permissionLevel: agentMemberAccess.permissionLevel,
          })
          .from(agentMemberAccess)
          .where(
            and(
              eq(agentMemberAccess.memberId, callerActorId),
              inArray(agentMemberAccess.agentId, rows.map((row) => row.id)),
            ),
          );
        for (const access of accessRows) {
          permissionByAgent.set(access.agentId, access.permissionLevel);
        }
      }
      const items = rows
        .filter((r) => isListableAgentStatus(r.status))
        .filter(
          (r) =>
            r.visibility === "team" ||
            (callerActorId && r.ownerMemberId === callerActorId) ||
            permissionByAgent.has(r.id),
        )
        .map((r) => ({
          id: r.id,
          teamId: r.teamId,
          kind: "agent" as const,
          displayName: r.displayName,
          avatarUrl: r.avatarUrl ?? null,
          agentKind: r.agentKind,
          agentStatus: r.status ?? null,
          visibility: r.visibility ?? null,
          ownerMemberId: r.ownerMemberId ?? null,
          isOwner: callerActorId ? r.ownerMemberId === callerActorId : false,
          agentTypes: r.agentTypes ?? null,
          defaultAgentType: r.defaultAgentType ?? null,
          defaultWorkspaceId: r.defaultWorkspaceId ?? null,
          agentId: r.id,
          permissionLevel: permissionByAgent.get(r.id) ?? null,
          createdAt: iso(r.createdAt),
          updatedAt: iso(r.updatedAt),
        }));

      return { items };
    },

    /**
     * Returns { allowed, role } for (agentId, actorId).
     * allowed=true + role=string when an agentMemberAccess row exists;
     * allowed=false + role=null when not.
     *
     * Replaces check_agent_permission RPC.
     */
    async checkAgentPermission(agentId: string, actorId: string) {
      const role = await authzCheckAgentPermission(db, actorId, agentId);
      return { allowed: role !== null, role };
    },

    /**
     * Grants (or updates) access for actorId on agentId.
     * Returns { actorId, role }.
     *
     * Replaces the agent_member_access upsert via PostgREST.
     */
    async grantAgentAccess(
      agentId: string,
      { actorId, role }: { actorId: string; role: string },
    ) {
      // Upsert on (agentId, memberId)
      const existing = await db
        .select({ id: agentMemberAccess.id })
        .from(agentMemberAccess)
        .where(
          and(
            eq(agentMemberAccess.agentId, agentId),
            eq(agentMemberAccess.memberId, actorId),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        await (db.update(agentMemberAccess) as any)
          .set({ permissionLevel: role, updatedAt: new Date() })
          .where(
            and(
              eq(agentMemberAccess.agentId, agentId),
              eq(agentMemberAccess.memberId, actorId),
            ),
          );
      } else {
        await (db.insert(agentMemberAccess) as any).values({
          agentId,
          memberId: actorId,
          permissionLevel: role,
        });
      }

      return { actorId, role };
    },

    /**
     * Removes access for actorId on agentId. No-op if row doesn't exist.
     *
     * Replaces agent_member_access delete via PostgREST.
     */
    async revokeAgentAccess(agentId: string, actorId: string) {
      await (db.delete(agentMemberAccess) as any).where(
        and(
          eq(agentMemberAccess.agentId, agentId),
          eq(agentMemberAccess.memberId, actorId),
        ),
      );
    },

    /**
     * Revokes an agent-access grant by its own access-row id. No-op if the row
     * doesn't exist. Mirrors supabase-repo `removeAgentAccessById` (a plain delete
     * by primary key; the route/authz layer gates who may call it).
     */
    async removeAgentAccessById(accessId: string) {
      await (db.delete(agentMemberAccess) as any).where(eq(agentMemberAccess.id, accessId));
    },

    /**
     * Lists all access rows for an agent.
     * Items have keys: { actorId, agentActorId, role } plus extra fields.
     *
     * Replaces agent_member_access select via PostgREST.
     */
    async listAgentAccess(agentId: string) {
      const rows = await db
        .select({
          id: agentMemberAccess.id,
          agentId: agentMemberAccess.agentId,
          memberId: agentMemberAccess.memberId,
          permissionLevel: agentMemberAccess.permissionLevel,
          grantedByMemberId: agentMemberAccess.grantedByMemberId,
          createdAt: agentMemberAccess.createdAt,
          updatedAt: agentMemberAccess.updatedAt,
        })
        .from(agentMemberAccess)
        .where(eq(agentMemberAccess.agentId, agentId));

      const items = rows.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        agentActorId: r.agentId,
        actorId: r.memberId,
        memberId: r.memberId,
        role: r.permissionLevel,
        permissionLevel: r.permissionLevel,
        grantedByMemberId: r.grantedByMemberId ?? null,
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
      }));

      return { items };
    },

    /**
     * Returns actor id strings for all members with 'admin' permission on agentId.
     *
     * Replaces list_agent_admin_member_actor_ids RPC.
     */
    async listAgentAdminMembers(agentId: string) {
      const rows = await db
        .select({ memberId: agentMemberAccess.memberId })
        .from(agentMemberAccess)
        .where(
          and(
            eq(agentMemberAccess.agentId, agentId),
            eq(agentMemberAccess.permissionLevel, "admin"),
          ),
        );
      return { items: rows.map((r) => r.memberId as string) };
    },

    /**
     * Sets agent visibility to 'team'. Owner-gated via team-scoped resolution.
     *
     * Replaces share_agent_to_team RPC.
     */
    async shareAgentToTeam(agentId: string) {
      // AUTHZ FIX (#5): fail closed — 401 if no identity, 403 if not owner.
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "shareAgentToTeam: authenticated caller required");
      const isOwner = await checkAgentOwnership(db, ctx.userId, agentId);
      if (!isOwner) throw new ApiError(403, "forbidden", "not the agent owner");
      await (db.update(agents) as any)
        .set({ visibility: "team", updatedAt: new Date() })
        .where(eq(agents.id, agentId));
    },

    /**
     * Sets agent visibility to 'personal'. Owner-gated via team-scoped resolution.
     *
     * Replaces make_agent_personal RPC.
     */
    async makeAgentPersonal(agentId: string) {
      // AUTHZ FIX (#5): fail closed — 401 if no identity, 403 if not owner.
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "makeAgentPersonal: authenticated caller required");
      const isOwner = await checkAgentOwnership(db, ctx.userId, agentId);
      if (!isOwner) throw new ApiError(403, "forbidden", "not the agent owner");
      await (db.update(agents) as any)
        .set({ visibility: "personal", updatedAt: new Date() })
        .where(eq(agents.id, agentId));
    },

    /**
     * Updates the display_name / visibility of an owned agent.
     * Uses team-scoped owner resolution — not global current_member_id().
     *
     * Replaces update_owned_agent_profile RPC.
     */
    async updateOwnedAgentProfile(
      agentId: string,
      patch: { displayName?: string | null; visibility?: string | null },
    ) {
      // AUTHZ FIX (#5): fail closed — 401 if no identity, 403 if not owner.
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "updateOwnedAgentProfile: authenticated caller required");
      const callerActorId = await resolveActorForAgent(db, ctx.userId, agentId);
      if (!callerActorId) throw new ApiError(403, "forbidden", "not a member of this team");
      const [ag] = await db
        .select({ ownerMemberId: agents.ownerMemberId })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      if (!ag || ag.ownerMemberId !== callerActorId) {
        throw new ApiError(403, "forbidden", "not the agent owner");
      }

      const updates: Record<string, any> = { updatedAt: new Date() };
      if (patch.displayName !== undefined) {
        // Update the actor row's displayName
        if (patch.displayName !== null) {
          await (db.update(actors) as any)
            .set({ displayName: patch.displayName, updatedAt: new Date() })
            .where(eq(actors.id, agentId));
        }
      }
      if (patch.visibility !== undefined && patch.visibility !== null) {
        updates.visibility = patch.visibility;
      }
      await (db.update(agents) as any).set(updates).where(eq(agents.id, agentId));
    },

    /**
     * Updates the default workspace / agentKind / defaultAgentType for an agent.
     * Owner-gated via team-scoped resolution.
     *
     * Replaces update_agent_defaults RPC.
     */
    async updateAgentDefaults(
      agentId: string,
      patch: {
        defaultWorkspaceId?: string | null;
        agentKind?: string | null;
        defaultAgentType?: string | null;
      },
    ) {
      // AUTHZ FIX (#5): fail closed — 401 if no identity, 403 if not owner.
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "updateAgentDefaults: authenticated caller required");
      const isOwner = await checkAgentOwnership(db, ctx.userId, agentId);
      if (!isOwner) throw new ApiError(403, "forbidden", "not the agent owner");

      const updates: Record<string, any> = { updatedAt: new Date() };
      if (patch.defaultWorkspaceId !== undefined) {
        updates.defaultWorkspaceId = patch.defaultWorkspaceId;
      }
      if (patch.agentKind !== undefined && patch.agentKind !== null) {
        updates.agentKind = patch.agentKind;
      }
      if (patch.defaultAgentType !== undefined) {
        updates.defaultAgentType = patch.defaultAgentType;
      }
      await (db.update(agents) as any).set(updates).where(eq(agents.id, agentId));
    },

    /**
     * Ensures the agent's agentTypes / defaultAgentType are set.
     * No-op if already set.
     */
    async ensureAgentTypes({
      supportedTypes,
      defaultAgentType,
    }: {
      supportedTypes: string[];
      /** `null` clears the record: this device runs no agent right now. */
      defaultAgentType: string | null;
    }) {
      let agentActorId = ctx.callerActorId;
      if (!agentActorId && ctx.userId) {
        const [row] = await db
          .select({ id: actors.id })
          .from(actors)
          .where(and(eq(actors.userId, ctx.userId), eq(actors.actorType, "agent")))
          .limit(1);
        agentActorId = row?.id;
      }
      if (!agentActorId) {
        throw new ApiError(403, "forbidden", "ensureAgentTypes: no agent actor visible to caller");
      }
      // Keep the default a member of the supported set (see normalizeAgentTypes).
      const norm = normalizeAgentTypes(supportedTypes, defaultAgentType);
      await (db.update(agents) as any)
        .set({
          agentTypes: norm.supportedTypes,
          defaultAgentType: norm.defaultAgentType,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentActorId));
    },

    /**
     * Returns agentTypes / defaultAgentType for a list of agent ids.
     *
     * Replaces agents select via PostgREST.
     */
    async listAgentDefaults(agentIds: string[]) {
      if (!Array.isArray(agentIds) || agentIds.length === 0) return [];
      const rows = await db
        .select({
          id: agents.id,
          agentTypes: agents.agentTypes,
          defaultAgentType: agents.defaultAgentType,
          defaultWorkspaceId: agents.defaultWorkspaceId,
        })
        .from(agents)
        .where(inArray(agents.id, agentIds));
      return rows.map((r) => ({
        id: r.id,
        agentTypes: Array.isArray(r.agentTypes) ? r.agentTypes : null,
        defaultAgentType: r.defaultAgentType ?? null,
        // The amuxd daemon reads this to resolve the gateway runtime's working
        // directory from its own agent's default workspace.
        defaultWorkspaceId: r.defaultWorkspaceId ?? null,
      }));
    },
  };
}
