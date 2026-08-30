/**
 * Actors / Directory domain — pg-repo implementation.
 *
 * Contract methods implemented here:
 *  - getActor(id)
 *  - upsertExternalActor({ teamId, source, sourceId, displayName })
 *  - listTeamActors(teamId, { kind, limit })
 *  - getTeamDirectory(teamId)
 *
 * Agent-visibility filter:
 *   The actor_directory VIEW is caller-independent (returns ALL actors).
 *   Visibility filtering happens here:
 *     - member actors always included
 *     - agents included when agentVisibility='team' OR ownerMemberId=<callerActorId>
 *   When no callerActorId is available (e.g. internal/contract calls), we include
 *   all team-visible agents (matching Supabase default behavior).
 *
 * Agent-status filter:
 *   Listings (listTeamActors / getTeamDirectory) additionally drop retired
 *   agents — see ../agent-status.ts. The by-id and sync readers below stay
 *   unfiltered on purpose.
 */

import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { actors, agents, members, teamMembers, teams, actorDirectory, actorClientVersions } from "../../db/schema/index.js";
import { RETIRED_AGENT_STATUSES } from "../agent-status.js";
import { resolveActorForTeam, requireActorForTeam } from "./authz.js";
import { DEFAULT_LIST_LIMIT } from "../routing-utils.js";
import { ApiError } from "../http-utils.js";

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface ActorsCtx {
  userId?: string;
  /** resolved actor id for the calling team — set by the route layer when available */
  callerActorId?: string;
}

function mapActorRow(r: any) {
  return {
    id: r.id as string,
    teamId: r.teamId as string,
    kind: (r.actorType ?? r.kind) as string,
    displayName: r.displayName as string,
    avatarUrl: (r.avatarUrl ?? null) as string | null,
    metadata: null as null,
  };
}

function mapMemberRow(r: any) {
  return {
    actorId: r.id as string,
    teamId: r.teamId as string,
    role: r.teamRole as string,
    joinedAt: iso(r.createdAt)!,
  };
}

/**
 * Maps an actor_directory VIEW row to the full directory-actor shape used by
 * the /v1/actors/by-ids route (parity with supabase-repo `mapDirectoryActor`).
 *
 * Note: the pg `actor_directory` view does not expose `user_email` / `user_phone`
 * (those come from a SECURITY DEFINER contact join in the Supabase schema), so
 * `email`/`phone` are always null here. `agentKind` is likewise not projected by
 * the view and is null — matching Supabase's own `agentKind: null`.
 */
function mapDirectoryActorRow(r: any) {
  return {
    id: r.id as string,
    teamId: (r.teamId ?? null) as string | null,
    kind: (r.actorType ?? null) as string | null,
    displayName: (r.displayName ?? null) as string | null,
    avatarUrl: (r.avatarUrl ?? null) as string | null,
    userId: (r.userId ?? null) as string | null,
    invitedByActorId: (r.invitedByActorId ?? null) as string | null,
    teamRole: (r.teamRole ?? null) as string | null,
    memberStatus: (r.memberStatus ?? null) as string | null,
    agentStatus: (r.agentStatus ?? null) as string | null,
    agentTypes: (r.agentTypes ?? null) as string | null,
    agentKind: null as null,
    defaultAgentType: (r.defaultAgentType ?? null) as string | null,
    defaultWorkspaceId: (r.defaultWorkspaceId ?? null) as string | null,
    visibility: (r.agentVisibility ?? null) as string | null,
    agentOwnerMemberId: (r.ownerMemberId ?? null) as string | null,
    lastActiveAt: iso(r.lastActiveAt),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    email: null as null,
    phone: null as null,
    // This schema has no source / source_id columns: `upsertExternalActor` above
    // encodes the pair into userId as `<source>:<sourceId>`, so that is where
    // they are read back from. Only external rows carry it — a member's userId
    // is an auth user id, which has no colon.
    ...splitExternalSource(r.actorType, r.userId),
  };
}

/**
 * `<source>:<sourceId>` → the pair, for external actors only. Splits on the
 * FIRST colon: a gateway id can itself contain colons (the URN forms the
 * channels build, e.g. `wecom:corp/user`).
 */
function splitExternalSource(actorType: unknown, userId: unknown) {
  if (actorType !== "external" || typeof userId !== "string") {
    return { source: null as string | null, sourceId: null as string | null };
  }
  const cut = userId.indexOf(":");
  if (cut <= 0) return { source: null as string | null, sourceId: userId || null };
  return { source: userId.slice(0, cut), sourceId: userId.slice(cut + 1) || null };
}

/** Visibility filter expression for actor_directory queries */
function visibilityFilter(callerActorId?: string) {
  // Include non-agent actors always.
  // For agents: include if team-visible OR owned by caller (when known).
  if (callerActorId) {
    return or(
      sql`${actorDirectory.actorType} <> 'agent'`,
      eq(actorDirectory.agentVisibility, "team"),
      eq(actorDirectory.ownerMemberId, callerActorId),
    );
  }
  return or(
    sql`${actorDirectory.actorType} <> 'agent'`,
    eq(actorDirectory.agentVisibility, "team"),
  );
}

/**
 * Status filter for actor_directory LISTINGS: keep every non-agent row and
 * every agent that has not been retired. `isNull` carries the members (their
 * agent_status is null) and is what keeps the `notInArray` from swallowing
 * them — `null NOT IN (...)` is null, i.e. filtered out.
 */
function listableAgentStatusFilter() {
  return or(
    isNull(actorDirectory.agentStatus),
    notInArray(actorDirectory.agentStatus, RETIRED_AGENT_STATUSES as unknown as string[]),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeActorsRepo(db: DbLike, ctx: ActorsCtx = {}) {
  return {
    /**
     * Returns `{ displayName }` for the given actor id, or null if not found.
     */
    async getActor(id: string) {
      const [r] = await db
        .select({ id: actors.id, displayName: actors.displayName })
        .from(actors)
        .where(eq(actors.id, id))
        .limit(1);
      if (!r) return null;
      const versions = await db
        .select({
          clientType: actorClientVersions.clientType,
          version: actorClientVersions.version,
          deviceId: actorClientVersions.deviceId,
          build: actorClientVersions.build,
          lastReportedAt: actorClientVersions.lastReportedAt,
        })
        .from(actorClientVersions)
        .where(eq(actorClientVersions.actorId, id))
        .orderBy(actorClientVersions.clientType, desc(actorClientVersions.lastReportedAt));
      return {
        displayName: r.displayName,
        clientVersions: versions.map((v) => ({
          clientType: v.clientType,
          version: v.version,
          deviceId: v.deviceId,
          build: v.build ?? null,
          lastReportedAt:
            v.lastReportedAt instanceof Date ? v.lastReportedAt.toISOString() : v.lastReportedAt,
        })),
      };
    },

    /**
     * Upserts an external actor (e.g. WeCom contact) identified by source+sourceId.
     * Uses a get-or-create pattern safe against races.
     *
     * Supabase RPC `upsert_external_actor` is replaced by this Drizzle approach:
     *   1. Look for an existing actor in the team whose displayName is a sentinel match
     *      — we use userId = `${source}:${sourceId}` as the lookup key.
     *   2. If found, update displayName; if not, insert a new actor row with
     *      actorType='external'.
     */
    async upsertExternalActor({ teamId, source, sourceId, displayName }: {
      teamId: string;
      source: string;
      sourceId: string;
      displayName: string;
    }) {
      const userId = `${source}:${sourceId}`;
      // Try update first (race-safe: unique index on team_id + user_id)
      const updated = await (db.update(actors) as any)
        .set({ displayName, updatedAt: new Date() })
        .where(and(eq(actors.teamId, teamId), eq(actors.userId, userId)))
        .returning({ id: actors.id });

      if (updated.length > 0) {
        return { actorId: updated[0].id as string };
      }

      // Insert — may race but the unique index will protect us; caller can retry on conflict
      const [inserted] = await (db.insert(actors) as any)
        .values({ teamId, actorType: "external", displayName, userId })
        .returning({ id: actors.id });
      return { actorId: inserted.id as string };
    },

    /**
     * Lists actors in a team, with optional kind filter.
     * Returns paged result: `{ items }`.
     * agent-visibility filter applied at query time.
     */
    async listTeamActors(teamId: string, { kind = null, limit = 200 }: { kind?: string | null; limit?: number } = {}) {
      const callerActorId = ctx.callerActorId ?? (ctx.userId ? await resolveActorForTeam(db, ctx.userId, teamId) ?? undefined : undefined);
      const visFilter = visibilityFilter(callerActorId);
      const conditions = [
        eq(actorDirectory.teamId, teamId),
        visFilter!,
        listableAgentStatusFilter()!,
      ];
      if (kind) {
        conditions.push(eq(actorDirectory.actorType, kind));
      }

      const rows = await db
        .select()
        .from(actorDirectory)
        .where(and(...conditions))
        .limit(limit);

      return {
        items: rows.map(mapDirectoryActorRow),
      };
    },

    /**
     * Returns the full directory for a team: all actors + member join info.
     * agent-visibility and agent-status filters applied at query time.
     */
    async getTeamDirectory(teamId: string) {
      const callerActorId = ctx.callerActorId ?? (ctx.userId ? await resolveActorForTeam(db, ctx.userId, teamId) ?? undefined : undefined);
      const visFilter = visibilityFilter(callerActorId);
      const rows = await db
        .select()
        .from(actorDirectory)
        .where(and(eq(actorDirectory.teamId, teamId), visFilter!, listableAgentStatusFilter()!));

      const actorsList = rows.map(mapActorRow);
      const membersList = rows
        .filter((r: any) => r.actorType === "member" && r.teamRole)
        .map(mapMemberRow);

      return { actors: actorsList, members: membersList };
    },

    /**
     * Updates display_name / avatar_url for the given actor and returns the
     * directory-actor shape (consistent with getActor/listTeamActors).
     */
    async updateCurrentActorProfile(actorId: string, { displayName, avatarUrl }: { displayName?: string; avatarUrl?: string }) {
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (displayName !== undefined) set.displayName = displayName;
      if (avatarUrl !== undefined) set.avatarUrl = avatarUrl;
      const [r] = await (db.update(actors) as any)
        .set(set)
        .where(eq(actors.id, actorId))
        .returning();
      if (!r) throw new ApiError(404, "not_found", "actor not found");
      return mapActorRow(r);
    },

    /**
     * Returns the calling member's row in a team as
     * `{ id, displayName, role, joinedAt }`, or null when the given user is not a
     * member of the team. Mirrors supabase-repo `getCurrentTeamMember`: it looks
     * up the member actor in `actor_directory` (by team + user), then joins
     * `team_members` for `joinedAt`. `userId` is the subject being resolved (an
     * explicit route param), not necessarily the caller.
     */
    async getCurrentTeamMember(teamId: string, userId: string) {
      const [actor] = await db
        .select({
          id: actorDirectory.id,
          displayName: actorDirectory.displayName,
          teamRole: actorDirectory.teamRole,
        })
        .from(actorDirectory)
        .where(
          and(
            eq(actorDirectory.teamId, teamId),
            eq(actorDirectory.userId, userId),
            eq(actorDirectory.actorType, "member"),
          ),
        )
        .limit(1);
      if (!actor) return null;
      const [tm] = await db
        .select({ joinedAt: teamMembers.joinedAt })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.memberId, actor.id)))
        .limit(1);
      return {
        id: actor.id as string,
        displayName: (actor.displayName ?? "") as string,
        role: (actor.teamRole ?? null) as string | null,
        joinedAt: tm?.joinedAt ? iso(tm.joinedAt) : null,
      };
    },

    // Resolve the caller's member actor id in a team (route:
    // /v1/directory/current-member-actor). Mirrors supabase-repo.ts:1570 —
    // a resolution endpoint keyed by (teamId, userId), not a caller-identity
    // gate. Returns null when the user has no member actor in the team.
    async resolveCurrentMemberActor(teamId: string, userId: string) {
      const [row] = await db
        .select({ id: actors.id })
        .from(actors)
        .where(
          and(
            eq(actors.teamId, teamId),
            eq(actors.userId, userId),
            eq(actors.actorType, "member"),
          ),
        )
        .limit(1);
      return row ? { id: row.id as string } : null;
    },

    // Resolve a user's first (oldest) member actor across all teams (route:
    // /v1/directory/first-member-actor-for-user). Mirrors
    // supabase-repo.ts:1583 — ordered by created_at then id for determinism.
    // Returns { id, team_id } (snake_case team_id kept for client parity) or null.
    async resolveFirstMemberActorForUser(userId: string) {
      const [row] = await db
        .select({ id: actors.id, teamId: actors.teamId })
        .from(actors)
        .where(and(eq(actors.userId, userId), eq(actors.actorType, "member")))
        .orderBy(actors.createdAt, actors.id)
        .limit(1);
      return row ? { id: row.id as string, team_id: (row.teamId ?? null) as string | null } : null;
    },

    /**
     * Batch actor-directory lookup by ids, optionally scoped to a team.
     * Returns the full directory-actor shape (parity with supabase-repo
     * `listActorDirectoryByIds`). Agent-visibility filtering is applied here (the
     * pg `actor_directory` view is caller-independent) using the caller's actor
     * so personal agents owned by others are excluded — matching what RLS does on
     * the Supabase side.
     */
    async listActorDirectoryByIds(actorIds: string[], teamId: string | null) {
      if (!Array.isArray(actorIds) || actorIds.length === 0) return [];
      const callerActorId =
        ctx.callerActorId ??
        (ctx.userId && teamId
          ? (await resolveActorForTeam(db, ctx.userId, teamId)) ?? undefined
          : undefined);
      // Batch by-id lookup is used to name seats the caller already holds (e.g.
      // session participants, the daemon resolving its own actor). Always return
      // the caller's own row when explicitly requested — visibility otherwise
      // compares ownerMemberId (a member id) to callerActorId (often an agent
      // id) and would hide a personal agent from itself.
      const visibility = callerActorId
        ? or(visibilityFilter(callerActorId)!, eq(actorDirectory.id, callerActorId))
        : visibilityFilter(callerActorId)!;
      const conditions = [inArray(actorDirectory.id, actorIds), visibility];
      if (teamId) conditions.push(eq(actorDirectory.teamId, teamId));
      const rows = await db
        .select()
        .from(actorDirectory)
        .where(and(...conditions));
      return rows.map(mapDirectoryActorRow);
    },

    /**
     * Returns actor_directory rows for a team updated after the given cursor.
     * Used by the sync-v1 incremental sync endpoint.
     * No visibility filter applied — matches the permissive Supabase behavior
     * used by the sync service which already runs with elevated privileges.
     */
    // Keyset-paginated on (updated_at, id). Unbounded before: a team with 10k
    // actors returned 3.1MB in a single response.
    async listActorDirectoryForSync(
      teamId: string,
      updatedAfter: string | null,
      { limit = DEFAULT_LIST_LIMIT, cursor = null }: {
        limit?: number;
        cursor?: { updatedAt?: string | null; id?: string | null } | null;
      } = {},
    ) {
      const conditions = [eq(actorDirectory.teamId, teamId)];
      if (updatedAfter) {
        conditions.push(sql`${actorDirectory.updatedAt} > ${updatedAfter}::timestamptz`);
      }
      if (cursor?.updatedAt) {
        const at = cursor.updatedAt;
        conditions.push(
          sql`(${actorDirectory.updatedAt} > ${at}::timestamptz OR (${actorDirectory.updatedAt} = ${at}::timestamptz AND ${actorDirectory.id} > ${cursor.id ?? null}))`,
        );
      }
      const rows = await db
        .select({
          id: actorDirectory.id,
          teamId: actorDirectory.teamId,
          actorType: actorDirectory.actorType,
          displayName: actorDirectory.displayName,
          memberStatus: actorDirectory.memberStatus,
          agentStatus: actorDirectory.agentStatus,
          lastActiveAt: actorDirectory.lastActiveAt,
          createdAt: actorDirectory.createdAt,
          updatedAt: actorDirectory.updatedAt,
        })
        .from(actorDirectory)
        .where(and(...conditions))
        .orderBy(asc(actorDirectory.updatedAt), asc(actorDirectory.id))
        .limit(limit);
      return rows.map((r: any) => ({
        id: r.id,
        team_id: r.teamId,
        actor_type: r.actorType,
        display_name: r.displayName,
        member_status: r.memberStatus ?? null,
        agent_status: r.agentStatus ?? null,
        last_active_at: r.lastActiveAt ? new Date(r.lastActiveAt).toISOString() : null,
        created_at: r.createdAt ? new Date(r.createdAt).toISOString() : null,
        updated_at: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
      }));
    },

    /**
     * Returns the calling member's default agent for a team: `{ defaultAgentId }`
     * (null when unset). The caller's own actor is resolved server-side from the
     * JWT — never supplied by the client.
     */
    async getMemberDefaultAgent(teamId: string) {
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "authentication required");
      const callerActorId = await requireActorForTeam(db, ctx.userId, teamId);
      const [r] = await db
        .select({ defaultAgentId: members.defaultAgentId })
        .from(members)
        .where(eq(members.id, callerActorId))
        .limit(1);
      return { defaultAgentId: (r?.defaultAgentId ?? null) as string | null };
    },

    /**
     * Sets (agentId) or clears (null) the calling member's default agent.
     * Rejects an agent that is not in the team, not active, or not visible to
     * the caller (personal agents owned by someone else) — 409 for the former
     * two, 403 for visibility. Returns `{ defaultAgentId }`.
     */
    async setMemberDefaultAgent(teamId: string, agentId: string | null) {
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "authentication required");
      const callerActorId = await requireActorForTeam(db, ctx.userId, teamId);

      if (agentId != null) {
        const [ag] = await db
          .select({
            teamId: actors.teamId,
            actorType: actors.actorType,
            status: agents.status,
            visibility: agents.visibility,
            ownerMemberId: agents.ownerMemberId,
          })
          .from(actors)
          .innerJoin(agents, eq(agents.id, actors.id))
          .where(eq(actors.id, agentId))
          .limit(1);
        if (!ag || ag.actorType !== "agent" || ag.teamId !== teamId) {
          throw new ApiError(409, "invalid_agent", "agent is not in this team");
        }
        if (ag.status !== "active") {
          throw new ApiError(409, "invalid_agent", "agent is not active");
        }
        const visible = ag.visibility === "team" || ag.ownerMemberId === callerActorId;
        if (!visible) {
          throw new ApiError(403, "forbidden", "agent is not visible to caller");
        }
      }

      const [r] = await (db.update(members) as any)
        .set({ defaultAgentId: agentId, updatedAt: new Date() })
        .where(eq(members.id, callerActorId))
        .returning({ defaultAgentId: members.defaultAgentId });
      if (!r) throw new ApiError(404, "not_found", "member not found");
      return { defaultAgentId: (r.defaultAgentId ?? null) as string | null };
    },

    async getTeamDefaultAgent(teamId: string) {
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "authentication required");
      await requireActorForTeam(db, ctx.userId, teamId); // membership gate
      const [r] = await db
        .select({ defaultAgentId: teams.defaultAgentId })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);
      return { defaultAgentId: (r?.defaultAgentId ?? null) as string | null };
    },

    async setTeamDefaultAgent(teamId: string, agentId: string | null) {
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "authentication required");
      const callerActorId = await requireActorForTeam(db, ctx.userId, teamId);
      // owner/admin gate
      const [tm] = await db
        .select({ role: teamMembers.role })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.memberId, callerActorId)))
        .limit(1);
      if (!tm || (tm.role !== "owner" && tm.role !== "admin")) {
        throw new ApiError(403, "forbidden", "only team owner/admin can set the team default agent");
      }
      if (agentId != null) {
        const [ag] = await db
          .select({
            teamId: actors.teamId,
            actorType: actors.actorType,
            status: agents.status,
            visibility: agents.visibility,
          })
          .from(actors)
          .innerJoin(agents, eq(agents.id, actors.id))
          .where(eq(actors.id, agentId))
          .limit(1);
        if (!ag || ag.actorType !== "agent" || ag.teamId !== teamId) {
          throw new ApiError(409, "invalid_agent", "agent is not in this team");
        }
        if (ag.status !== "active") {
          throw new ApiError(409, "invalid_agent", "agent is not active");
        }
        if (ag.visibility !== "team") {
          throw new ApiError(409, "invalid_agent", "team default agent must be team-visible");
        }
      }
      const [r] = await (db.update(teams) as any)
        .set({ defaultAgentId: agentId, updatedAt: new Date() })
        .where(eq(teams.id, teamId))
        .returning({ defaultAgentId: teams.defaultAgentId });
      return { defaultAgentId: (r?.defaultAgentId ?? null) as string | null };
    },

    async getEffectiveDefaultAgent(teamId: string) {
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "authentication required");
      const callerActorId = await requireActorForTeam(db, ctx.userId, teamId);
      const [m] = await db
        .select({ defaultAgentId: members.defaultAgentId })
        .from(members)
        .where(eq(members.id, callerActorId))
        .limit(1);
      if (m?.defaultAgentId) return { defaultAgentId: m.defaultAgentId as string };
      const [t] = await db
        .select({ defaultAgentId: teams.defaultAgentId })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);
      return { defaultAgentId: (t?.defaultAgentId ?? null) as string | null };
    },
  };
}
