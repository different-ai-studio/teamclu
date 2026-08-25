/**
 * Application-layer authorisation helpers.
 *
 * These replace the Supabase SECURITY DEFINER RLS helpers and fix the
 * `current_member_id()` multi-team bug by always resolving the caller's actor
 * per-team rather than returning the oldest actor across all teams.
 *
 * Canonical resolution path:
 *   (userId from JWT sub, teamId from request path) → actorId
 *
 * All identity-dependent repo methods should call one of these instead of
 * querying actors/members directly.
 */

import { and, eq, sql } from "drizzle-orm";
import { actors, agents, agentMemberAccess, teamMembers } from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any; // PgliteDatabase | PostgresJsDatabase — both satisfy at runtime

/**
 * Resolves the actorId for a given (userId, teamId) pair.
 * Returns null if the user has no actor in that team.
 *
 * Replaces `current_actor_id_for_team(teamId)` (correctly team-scoped).
 * Also replaces the BUGGED `current_member_id()` which had no team filter.
 */
export async function resolveActorForTeam(
  db: DbLike,
  userId: string,
  teamId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.userId, userId), eq(actors.teamId, teamId)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Like resolveActorForTeam but throws 403 ApiError when the user has no actor
 * in the requested team.
 */
export async function requireActorForTeam(
  db: DbLike,
  userId: string,
  teamId: string,
): Promise<string> {
  const id = await resolveActorForTeam(db, userId, teamId);
  if (!id) throw new ApiError(403, "forbidden", "not a member of this team");
  return id;
}

/**
 * Ensures the authenticated user is the team owner before owner-only team
 * mutations.
 */
export async function requireTeamOwner(
  db: DbLike,
  userId: string,
  teamId: string,
): Promise<string> {
  const actorId = await requireActorForTeam(db, userId, teamId);
  const [row] = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.memberId, actorId)))
    .limit(1);
  if (!row || row.role !== "owner") {
    throw new ApiError(403, "forbidden", "only team owners may change team share mode");
  }
  return actorId;
}

/**
 * Returns true if the user has any actor in the given team.
 * Replaces `is_team_member(teamId)`.
 */
export async function checkTeamMembership(
  db: DbLike,
  userId: string,
  teamId: string,
): Promise<boolean> {
  return (await resolveActorForTeam(db, userId, teamId)) !== null;
}

/**
 * Resolves the caller's actorId by looking up the agent's team first, then
 * resolving the caller's actor in that team.
 * Replaces `current_actor_for_agent(agentId)`.
 * Returns null if the agent doesn't exist or the user has no actor in its team.
 */
export async function resolveActorForAgent(
  db: DbLike,
  userId: string,
  agentId: string,
): Promise<string | null> {
  // Look up the agent's actor row to get teamId
  const [agentActor] = await db
    .select({ teamId: actors.teamId })
    .from(actors)
    .where(eq(actors.id, agentId))
    .limit(1);
  if (!agentActor) return null;
  return resolveActorForTeam(db, userId, agentActor.teamId);
}

/**
 * Returns true if the caller is the ownerMember of the given agent.
 * Replaces the pattern `agents.owner_member_id = current_actor_id_for_team(team_id)`.
 */
export async function checkAgentOwnership(
  db: DbLike,
  userId: string,
  agentId: string,
): Promise<boolean> {
  const actorId = await resolveActorForAgent(db, userId, agentId);
  if (!actorId) return false;
  const [ag] = await db
    .select({ ownerMemberId: agents.ownerMemberId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return !!ag && ag.ownerMemberId === actorId;
}

/**
 * Returns the caller's team role (owner/admin/member), or null if not a member.
 */
export async function resolveTeamRole(
  db: DbLike,
  userId: string,
  teamId: string,
): Promise<string | null> {
  const actorId = await resolveActorForTeam(db, userId, teamId);
  if (!actorId) return null;
  const [row] = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.memberId, actorId)))
    .limit(1);
  return row?.role ?? null;
}

export interface RemovableActorTarget {
  id: string;
  actor_type?: string | null;
  visibility?: string | null;
  ownerMemberId?: string | null;
}

/**
 * Application-layer mirror of amux.remove_team_actor authz.
 * Throws ApiError on denial; returns caller actor id on success.
 */
export async function assertCanRemoveTeamActor(
  db: DbLike,
  userId: string,
  teamId: string,
  target: RemovableActorTarget,
): Promise<string> {
  const callerActorId = await requireActorForTeam(db, userId, teamId);

  if (callerActorId === target.id) {
    throw new ApiError(403, "forbidden", "cannot remove your own actor");
  }

  const [actorRow] = await db
    .select({ actorType: actors.actorType, teamId: actors.teamId })
    .from(actors)
    .where(eq(actors.id, target.id))
    .limit(1);

  if (!actorRow || actorRow.teamId !== teamId) {
    throw new ApiError(404, "not_found", "actor not found");
  }

  if (actorRow.actorType === "agent") {
    const [ag] = await db
      .select({ visibility: agents.visibility, ownerMemberId: agents.ownerMemberId })
      .from(agents)
      .where(eq(agents.id, target.id))
      .limit(1);

    if (ag?.visibility === "personal") {
      if (callerActorId !== ag.ownerMemberId) {
        throw new ApiError(
          403,
          "forbidden",
          "remove_team_actor requires agent owner for personal agents",
        );
      }
      return callerActorId;
    }

    const role = await resolveTeamRole(db, userId, teamId);
    if (role !== "owner" && role !== "admin") {
      throw new ApiError(
        403,
        "forbidden",
        ag?.visibility === "team"
          ? "remove_team_actor requires owner or admin for team agents"
          : "remove_team_actor requires owner or admin",
      );
    }
    return callerActorId;
  }

  const role = await resolveTeamRole(db, userId, teamId);
  if (role !== "owner" && role !== "admin") {
    throw new ApiError(403, "forbidden", "remove_team_actor requires owner or admin");
  }

  if (actorRow.actorType === "member") {
    const [targetMembership] = await db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.memberId, target.id)))
      .limit(1);

    if (targetMembership?.role === "owner") {
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "owner")));
      if ((countRow?.count ?? 0) <= 1) {
        throw new ApiError(403, "forbidden", "cannot remove the last owner");
      }
    }
  }

  return callerActorId;
}

function mapActorDeleteFkError(raw: string): ApiError {
  const msg = raw.toLowerCase();
  if (msg.includes("idea_activities")) {
    return new ApiError(409, "conflict", "agent_delete_blocked_by_idea_activities");
  }
  if (msg.includes("apps") && msg.includes("actor")) {
    return new ApiError(409, "conflict", "agent_delete_blocked_by_apps");
  }
  if (msg.includes("amuxc_file")) {
    return new ApiError(409, "conflict", "agent_delete_blocked_by_files");
  }
  return new ApiError(409, "conflict", "actor_delete_blocked_by_references");
}

export { mapActorDeleteFkError };

/**
 * Returns the permission_level for (actorId, agentId) from agentMemberAccess,
 * or null if no explicit access row exists.
 */
export async function checkAgentPermission(
  db: DbLike,
  actorId: string,
  agentId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ permissionLevel: agentMemberAccess.permissionLevel })
    .from(agentMemberAccess)
    .where(
      and(
        eq(agentMemberAccess.agentId, agentId),
        eq(agentMemberAccess.memberId, actorId),
      ),
    )
    .limit(1);
  return row?.permissionLevel ?? null;
}
