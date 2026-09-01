/**
 * Sessions + Participants domain — pg-repo implementation.
 *
 * Authz strategy:
 *  - listSessions accepts an explicit actorId (participant filter) or resolves
 *    from ctx.userId + teamId. This mirrors the Supabase RPC
 *    list_current_actor_sessions SECURITY DEFINER pattern.
 *  - markSessionViewed accepts explicit actorId or resolves from ctx.
 *  - createSession ALWAYS resolves createdByActorId server-side from
 *    ctx.userId + teamId (requireActorForTeam, team-scoped); any
 *    client-supplied createdByActorId is ignored. Matches sessions INSERT RLS
 *    (created_by = current actor for team) so multi-team callers can't send a
 *    stale/other-team actor id and trip the RLS WITH CHECK.
 *
 * RPC replacements:
 *  - list_current_actor_sessions   → listSessions (Drizzle join on participants)
 *  - mark_current_actor_session_viewed → markSessionViewed (upsert read marker)
 *  - ensure_gateway_session        → ensureGatewaySession (get-or-create on binding)
 *  - list_gateway_sessions         → listGatewaySessions (one chat's own lineage)
 *  - attach_gateway_session        → attachGatewaySession (move a chat's binding)
 */

import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  sessions,
  sessionParticipants,
  sessionReadMarkers,
  actors,
  agentMemberAccess,
  agents,
  teams,
  teamMembers,
  messages,
} from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";
import { requireActorForTeam, resolveActorForTeam } from "./authz.js";
import { DEFAULT_LIST_LIMIT } from "../routing-utils.js";

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

/**
 * `db.update(sessions)` with the update-set type escaped.
 *
 * Drizzle 0.36 collapses `sessions`'s set-source down to its
 * not-null-without-default columns (`mode`, `teamId`, `title`), so setting any
 * nullable column — `binding`, `gatewayKey` — fails to typecheck even though
 * the column plainly exists. Every other pg-repo module hits this and works
 * around it with the same cast at each call site; centralising it here keeps
 * the escape hatch documented in one place instead of scattered.
 *
 * This matters beyond the editor: the FC container builds with
 * `tsc -p tsconfig.json`, so an un-cast `.set()` breaks the image build and the
 * self-host deploy with it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updateSessions = (db: DbLike): any => db.update(sessions);

export interface SessionsRepoDeps {
  /** Called after a successful markSessionViewed DB write. Best-effort: errors are
   *  logged and swallowed so the mark-viewed outcome is never affected. */
  publishReadEvent?: (args: { userId: string; sessionId: string }) => Promise<void>;
}

interface SessionsCtx {
  userId?: string;
  callerActorId?: string;
}

function mapSession(r: any) {
  return {
    id: r.id,
    teamId: r.teamId,
    title: r.title ?? "",
    mode: r.mode ?? "solo",
    ideaId: r.ideaId ?? null,
    lastMessageAt: iso(r.lastMessageAt),
    lastMessagePreview: r.lastMessagePreview ?? null,
    hasUnread: r.hasUnread === true,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
  };
}

function mapSessionFull(r: any, participants: any[] = []) {
  return {
    id: r.id,
    teamId: r.teamId,
    title: r.title ?? "",
    mode: r.mode ?? "solo",
    ideaId: r.ideaId ?? null,
    primaryAgentId: r.primaryAgentId ?? null,
    createdByActorId: r.createdByActorId ?? null,
    summary: r.summary ?? null,
    lastMessageAt: iso(r.lastMessageAt),
    lastMessagePreview: r.lastMessagePreview ?? null,
    hasUnread: false,
    acpSessionId: r.acpSessionId ?? null,
    binding: r.binding ?? null,
    // See the note in supabase-repo/shared.ts: `binding` says "current",
    // `gatewayKey` says "which chat" and survives `/new`.
    gatewayKey: r.gatewayKey ?? null,
    source: r.source ?? "user",
    cronJobId: r.cronJobId ?? null,
    parentSessionId: r.parentSessionId ?? null,
    threadRootMessageId: r.threadRootMessageId ?? null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
    participants,
  };
}

function mapParticipant(r: any) {
  return {
    sessionId: r.sessionId,
    actorId: r.actorId,
    role: r.role ?? null,
    joinedAt: iso(r.joinedAt),
    // An agent participant's working state for this session (ADR-0005). Null on
    // member rows — not applicable rather than missing. This is what replaces
    // reading `agent_runtimes` from the desktop.
    workspaceId: r.workspaceId ?? null,
    model: r.model ?? null,
    lastProcessedMessageId: r.lastProcessedMessageId ?? null,
  };
}

// ── Sync wire shapes (snake_case) ──────────────────────────────────────────
// Consumed directly by the desktop client's lib/sync/* (no client-side mapper),
// so these must match supabase-repo's sync SELECT columns exactly.
function mapSessionSyncRow(r: any) {
  return {
    id: r.id,
    team_id: r.teamId,
    title: r.title ?? null,
    mode: r.mode ?? null,
    primary_agent_id: r.primaryAgentId ?? null,
    idea_id: r.ideaId ?? null,
    summary: r.summary ?? null,
    last_message_preview: r.lastMessagePreview ?? null,
    last_message_at: iso(r.lastMessageAt),
    created_by_actor_id: r.createdByActorId ?? null,
    source: r.source ?? "user",
    cron_job_id: r.cronJobId ?? null,
    parent_session_id: r.parentSessionId ?? null,
    thread_root_message_id: r.threadRootMessageId ?? null,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

function mapSessionParticipantSyncRow(r: any) {
  return {
    id: r.id,
    session_id: r.sessionId,
    actor_id: r.actorId,
    joined_at: iso(r.joinedAt),
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

export function makeSessionsRepo(db: DbLike, ctx: SessionsCtx = {}, deps: SessionsRepoDeps = {}) {
  // Resolve every actor id that belongs to the authenticated user (one per team).
  // Mirrors `app.current_actor_id()` semantics but across ALL the user's actors
  // rather than just the globally-oldest one — fixing the multi-team blind spot.
  async function resolveActorIdsForUser(userId: string): Promise<string[]> {
    const rows = await db
      .select({ id: actors.id })
      .from(actors)
      .where(eq(actors.userId, userId));
    return rows.map((r: any) => r.id).filter(Boolean);
  }

  return {
    // ── List sessions (participant-filtered) ──────────────────────────────────
    /**
     * AUTHZ (#10): lists the CURRENT ACTOR's sessions, resolved from ctx.userId.
     * Mirrors the Supabase RPC `list_current_actor_sessions`: scoped to the
     * authenticated user's participating sessions, across all their teams
     * unless narrowed.
     *
     * A client-supplied actorId is NEVER trusted. teamId and ideaId are
     * optional narrowing filters (still scoped to the user's actors), supplied
     * by GET /v1/sessions as query params — they are what let this endpoint
     * replace the removed GET /v1/teams/:teamId/sessions. When no identity is
     * available the result is empty (fail closed) — an unauthenticated caller
     * sees nothing rather than every team's sessions.
     */
    async listSessions({
      teamId,
      ideaId,
      kind = "all",
      limit = 50,
      cursor = null,
    }: {
      teamId?: string;
      ideaId?: string;
      kind?: "all" | "regular" | "cron";
      limit?: number;
      cursor?: { lastMessageAt?: string | null; createdAt?: string; id?: string } | null;
    } = {}) {
      // teamId is required, matching GET /v1/sessions and the supabase-repo
      // path: a team is what identifies the caller's actor, and on the supabase
      // side it is also the only thing that keeps the query on an index.
      if (!teamId) {
        throw new ApiError(400, "validation_failed", "teamId is required");
      }

      // Resolve the caller's actor ids from the authenticated user.
      const actorIds = ctx.userId ? await resolveActorIdsForUser(ctx.userId) : [];
      if (actorIds.length === 0) {
        // No identity / no actors → no visible sessions (fail closed).
        return [];
      }

      // Participant filter: any of the user's actors participates in the session.
      const participantFilter = sql`EXISTS (
            SELECT 1 FROM session_participants sp
            WHERE sp.session_id = sessions.id
              AND sp.actor_id IN (${sql.join(actorIds, sql`, `)})
          )`;

      // Optional team narrowing (scoped to the user's actors regardless).
      const teamFilter = teamId ? sql`sessions.team_id = ${teamId}` : sql`TRUE`;

      // Optional idea narrowing. Filtering here rather than in the client is
      // what keeps "sessions for this idea" correct once the list is paginated
      // — a client-side filter over page 1 silently misses matches on page 2.
      const ideaFilter = ideaId ? sql`sessions.idea_id = ${ideaId}` : sql`TRUE`;
      const kindFilter = kind === "cron"
        ? sql`sessions.source = 'cron'`
        : kind === "regular"
          ? sql`COALESCE(sessions.source, 'user') <> 'cron'`
          : sql`TRUE`;

      let cursorFilter = sql`TRUE`;
      if (cursor) {
        const cursorCreatedAt = cursor.createdAt ? new Date(cursor.createdAt) : null;
        if (cursor.lastMessageAt != null) {
          const cursorLastMessageAt = new Date(cursor.lastMessageAt);
          cursorFilter = sql`(
            sessions.last_message_at < ${cursorLastMessageAt}
            OR sessions.last_message_at IS NULL
            OR (sessions.last_message_at = ${cursorLastMessageAt} AND sessions.created_at < ${cursorCreatedAt})
            OR (sessions.last_message_at = ${cursorLastMessageAt} AND sessions.created_at = ${cursorCreatedAt} AND sessions.id < ${cursor.id ?? null})
          )`;
        } else {
          cursorFilter = sql`(
            sessions.last_message_at IS NULL
            AND (
              sessions.created_at < ${cursorCreatedAt}
              OR (sessions.created_at = ${cursorCreatedAt} AND sessions.id < ${cursor.id ?? null})
            )
          )`;
        }
      }

      // Read markers for any of the user's actors (to compute hasUnread).
      const readMarkerSubq = sql`(
            SELECT MAX(srm.last_read_at) FROM session_read_markers srm
            WHERE srm.session_id = sessions.id
              AND srm.actor_id IN (${sql.join(actorIds, sql`, `)})
          )`;

      const rows = await (db as any).execute(sql`
        SELECT
          sessions.id,
          sessions.team_id AS "teamId",
          sessions.idea_id AS "ideaId",
          sessions.mode,
          sessions.title,
          sessions.last_message_preview AS "lastMessagePreview",
          sessions.last_message_at AS "lastMessageAt",
          sessions.source,
          sessions.cron_job_id AS "cronJobId",
          sessions.created_at AS "createdAt",
          sessions.updated_at AS "updatedAt",
          sessions.summary,
          sessions.primary_agent_id AS "primaryAgentId",
          sessions.created_by_actor_id AS "createdByActorId",
          (
            SELECT COUNT(*) FROM session_participants sp
            WHERE sp.session_id = sessions.id
          )::int AS "participantCount",
          CASE
            WHEN sessions.last_message_at IS NULL THEN FALSE
            WHEN (${readMarkerSubq}) IS NULL THEN TRUE
            WHEN (${readMarkerSubq}) < sessions.last_message_at THEN TRUE
            ELSE FALSE
          END AS "hasUnread"
        FROM sessions
        WHERE (${teamFilter})
          AND (${ideaFilter})
          AND (${kindFilter})
          AND (${participantFilter})
          AND (${cursorFilter})
          AND sessions.parent_session_id IS NULL
          -- No archived_at filter, unlike the Supabase RPC: this schema has no
          -- such column (see the note in ensureGatewaySession below). Archive
          -- semantics live entirely in the supabase path.
        ORDER BY
          sessions.last_message_at DESC NULLS LAST,
          sessions.created_at DESC,
          sessions.id DESC
        LIMIT ${limit}
      `);

      const result = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
      return result.map((r: any) => ({
        id: r.id,
        teamId: r.teamId,
        title: r.title ?? "",
        mode: r.mode ?? "solo",
        ideaId: r.ideaId ?? null,
        lastMessageAt: iso(r.lastMessageAt),
        lastMessagePreview: r.lastMessagePreview ?? null,
        hasUnread: r.hasUnread === true,
        source: r.source ?? "user",
        cronJobId: r.cronJobId ?? null,
        summary: r.summary ?? null,
        primaryAgentId: r.primaryAgentId ?? null,
        createdByActorId: r.createdByActorId ?? null,
        participantCount: Number(r.participantCount ?? 0),
        createdAt: iso(r.createdAt)!,
        updatedAt: iso(r.updatedAt)!,
      }));
    },

    // ── getSession ────────────────────────────────────────────────────────────
    // `teamId` is required by GET /v1/sessions/:sessionId and optional here, so
    // the internal callers that already own the row can keep calling it with an
    // id alone. Mirrors the supabase-repo signature.
    async getSession(sessionId: string, { teamId }: { teamId?: string | null } = {}) {
      const [r] = await db
        .select()
        .from(sessions)
        .where(teamId ? and(eq(sessions.id, sessionId), eq(sessions.teamId, teamId)) : eq(sessions.id, sessionId))
        .limit(1);
      if (!r) return null;
      const parts = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      return mapSessionFull(r, parts.map(mapParticipant));
    },

    // ── joinSession (self-join via share link) ────────────────────────────────
    /**
     * AUTHZ: adds the AUTHENTICATED caller (resolved from ctx.userId in the
     * session's team) as a participant. Idempotent. Fails closed:
     *  - 401 when there is no authenticated user.
     *  - 404 when the session does not exist.
     *  - 403 when the caller has no actor in the session's team.
     */
    async joinSession(sessionId: string) {
      if (!ctx.userId) {
        throw new ApiError(401, "missing_auth", "cannot resolve actor for join");
      }
      const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      if (!s) throw new ApiError(404, "not_found", "session not found");

      const actorId = await resolveActorForTeam(db, ctx.userId, s.teamId);
      if (!actorId) {
        throw new ApiError(403, "forbidden", "not a member of this session's team");
      }

      await (db.insert(sessionParticipants) as any)
        .values({ sessionId, actorId, role: "member" })
        .onConflictDoNothing();

      const parts = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      return mapSessionFull(s, parts.map(mapParticipant));
    },

    // ── createSession ─────────────────────────────────────────────────────────
    async createSession(input: {
      id?: string;
      teamId: string;
      title: string;
      mode?: string;
      ideaId?: string | null;
      createdByActorId?: string;
      primaryAgentId?: string;
      appId?: string | null;
      participantActorIds?: string[];
      additionalActorIds?: string[];
    }) {
      const id = input.id ?? crypto.randomUUID();
      // AUTHZ: created_by is ALWAYS resolved server-side from the authenticated
      // caller scoped to the target team (requireActorForTeam is team-scoped),
      // never from the client-supplied input.createdByActorId. A multi-team
      // user's client can send the wrong team's actor id (stale current-team
      // value); ignoring it keeps parity with supabase-repo and matches the
      // sessions INSERT RLS WITH CHECK (created_by = current actor for team).
      let createdByActorId: string | undefined;
      if (ctx.userId) {
        createdByActorId = await requireActorForTeam(db, ctx.userId, input.teamId);
      }
      const insertRow: any = {
        id,
        teamId: input.teamId,
        title: input.title,
        mode: input.mode ?? "collab",
        ideaId: input.ideaId ?? null,
      };
      if (createdByActorId) insertRow.createdByActorId = createdByActorId;
      if (input.primaryAgentId) insertRow.primaryAgentId = input.primaryAgentId;
      if (input.appId) insertRow.appId = input.appId;

      const [r] = await (db.insert(sessions) as any).values(insertRow).returning();

      // Bootstrap participants
      const participantIds = Array.from(
        new Set(
          [
            createdByActorId,
            ...(input.participantActorIds ?? []),
            ...(input.additionalActorIds ?? []),
          ].filter((x): x is string => typeof x === "string" && x.length > 0),
        ),
      );

      let parts: any[] = [];
      if (participantIds.length > 0) {
        parts = await (db.insert(sessionParticipants) as any)
          .values(participantIds.map((actorId) => ({ sessionId: id, actorId })))
          .onConflictDoNothing()
          .returning();
      }

      return mapSessionFull(r, parts.map(mapParticipant));
    },

    // ── patchSession ──────────────────────────────────────────────────────────
    async patchSession(sessionId: string, patch: { title?: string; summary?: string; mode?: string; archivedAt?: string | null }) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.title !== undefined) updates.title = patch.title;
      if (patch.summary !== undefined) updates.summary = patch.summary;
      if (patch.mode !== undefined) updates.mode = patch.mode;

      const [r] = await (db.update(sessions) as any)
        .set(updates)
        .where(eq(sessions.id, sessionId))
        .returning();
      if (!r) return null;

      const parts = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      return mapSessionFull(r, parts.map(mapParticipant));
    },

    // ── getSessionByAcp ───────────────────────────────────────────────────────
    async getSessionByAcp(acpSessionId: string) {
      const [r] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.acpSessionId, acpSessionId))
        .limit(1);
      if (!r) return null;
      const parts = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, r.id));
      return mapSessionFull(r, parts.map(mapParticipant));
    },

    // ── detachGatewaySession ──────────────────────────────────────────────────
    /**
     * Release a gateway chat's binding so the next inbound message opens a new
     * session. The old row keeps its history and simply stops being the current
     * session for that chat; `ensureGatewaySession` then misses on the binding
     * and creates a fresh one. Nothing is deleted.
     *
     * The detach time is appended to the title because a gateway session's
     * title comes from the chat itself ("WeCom DM: LiangLiang") and would
     * otherwise repeat identically for every generation of the conversation.
     */
    async detachGatewaySession(acpSessionId: string) {
      const [existing] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.acpSessionId, acpSessionId))
        .limit(1);
      // Unknown id, or a session never bound to a gateway chat: nothing to
      // detach. The caller treats this as "no new session needed".
      if (!existing || !existing.binding) {
        return { sessionId: existing?.id ?? null, detached: false };
      }
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const title = existing.title ? `${existing.title} (${stamp})` : existing.title;
      await updateSessions(db)
        .set({ binding: null, title })
        .where(eq(sessions.id, existing.id));
      return { sessionId: existing.id, detached: true };
    },

    // ── listGatewaySessions ───────────────────────────────────────────────────
    /**
     * One gateway chat's own sessions, newest first — the current one plus every
     * session `/new` detached from it. Scoped to `gatewayKey` (never nulled), so
     * a chat sees only its own lineage: not another chat's, not the desktop's.
     */
    async listGatewaySessions(input: { teamId: string; gatewayKey: string; limit?: number }) {
      const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
      const rows = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.teamId, input.teamId), eq(sessions.gatewayKey, input.gatewayKey)))
        .orderBy(desc(sql`coalesce(${sessions.lastMessageAt}, ${sessions.createdAt})`), desc(sessions.id))
        .limit(limit);
      return {
        items: rows.map((r) => ({
          sessionId: r.id,
          acpSessionId: r.acpSessionId ?? null,
          title: r.title,
          isCurrent: r.binding != null && r.binding === input.gatewayKey,
          lastMessageAt: iso(r.lastMessageAt),
          createdAt: iso(r.createdAt),
        })),
      };
    },

    // ── attachGatewaySession ──────────────────────────────────────────────────
    /**
     * The inverse of `detachGatewaySession`: point a chat's binding at one of
     * that chat's existing sessions, so the next inbound message continues
     * there. Because (teamId, binding) is unique, the binding is *moved* —
     * released from its current holder (same title timestamp suffix detach
     * applies) and then set on the target, in that order.
     *
     * Fails soft with attached=false when the target is unknown or belongs to a
     * different chat, so a caller cannot hijack another conversation's session
     * and the gateway can report "no such session" rather than a phantom switch.
     */
    async attachGatewaySession(input: { binding: string; sessionId: string }) {
      const [target] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, input.sessionId), eq(sessions.gatewayKey, input.binding)))
        .limit(1);
      if (!target) return { sessionId: null, acpSessionId: null, attached: false };

      // Already current: idempotent no-op.
      if (target.binding === input.binding) {
        return { sessionId: target.id, acpSessionId: target.acpSessionId ?? null, attached: true };
      }

      const [holder] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.teamId, target.teamId), eq(sessions.binding, input.binding)))
        .limit(1);
      if (holder) {
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        await updateSessions(db)
          .set({ binding: null, title: holder.title ? `${holder.title} (${stamp})` : holder.title })
          .where(eq(sessions.id, holder.id));
      }

      await updateSessions(db).set({ binding: input.binding }).where(eq(sessions.id, target.id));
      return { sessionId: target.id, acpSessionId: target.acpSessionId ?? null, attached: true };
    },

    // ── markSessionViewed ─────────────────────────────────────────────────────
    /**
     * AUTHZ (#10): the read marker's actor is ALWAYS resolved server-side from
     * ctx.userId + the session's team — never from a client-supplied actor — so a
     * caller cannot mark a session read on behalf of someone else.
     *
     * Signature matches the Supabase backend: (sessionId, lastReadMessageId).
     * The optional 2nd-positional explicit actorId is reserved for trusted
     * server/gateway callers that operate WITHOUT an authenticated user
     * (ctx.userId absent); pass it as `{ actorId }`. The route never does.
     *
     * Fails CLOSED: with an authenticated user but no actor in the session's team
     * (or a missing session) it throws 403/404 rather than silently no-opping. A
     * call with neither ctx.userId nor a trusted actorId throws 401.
     */
    async markSessionViewed(
      sessionId: string,
      lastReadMessageId?: string | null,
      trusted?: { actorId?: string | null },
    ) {
      let resolvedActorId: string | null = null;

      if (ctx.userId) {
        // Authenticated path — resolve from the session's team. Authoritative.
        const [s] = await db.select({ teamId: sessions.teamId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        if (!s) throw new ApiError(404, "not_found", "session not found");
        resolvedActorId = await resolveActorForTeam(db, ctx.userId, s.teamId);
        if (!resolvedActorId) {
          throw new ApiError(403, "forbidden", "not a member of this session's team");
        }
      } else if (trusted?.actorId) {
        // Trusted server/gateway caller (no JWT) — accept the explicit actor.
        resolvedActorId = trusted.actorId;
      } else {
        // No identity at all — fail closed.
        throw new ApiError(401, "missing_auth", "cannot resolve actor for mark-viewed");
      }

      await (db.insert(sessionReadMarkers) as any)
        .values({
          sessionId,
          actorId: resolvedActorId,
          lastReadAt: new Date(),
          lastReadMessageId: lastReadMessageId ?? null,
        })
        .onConflictDoUpdate({
          target: [sessionReadMarkers.sessionId, sessionReadMarkers.actorId],
          set: {
            lastReadAt: new Date(),
            lastReadMessageId: lastReadMessageId ?? null,
            updatedAt: new Date(),
          },
        });

      if (deps.publishReadEvent && ctx.userId) {
        deps.publishReadEvent({ userId: ctx.userId, sessionId }).catch((err: unknown) => {
          console.error("[markSessionViewed] publishReadEvent failed (best-effort):", err);
        });
      }
    },

    /**
     * Mark a session unread for the calling actor by deleting their read
     * marker, so the session re-derives as unread. Actor resolution + fail-closed
     * semantics mirror markSessionViewed.
     */
    async markSessionUnread(sessionId: string, trusted?: { actorId?: string | null }) {
      let resolvedActorId: string | null = null;

      if (ctx.userId) {
        const [s] = await db
          .select({ teamId: sessions.teamId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        if (!s) throw new ApiError(404, "not_found", "session not found");
        resolvedActorId = await resolveActorForTeam(db, ctx.userId, s.teamId);
        if (!resolvedActorId) {
          throw new ApiError(403, "forbidden", "not a member of this session's team");
        }
      } else if (trusted?.actorId) {
        resolvedActorId = trusted.actorId;
      } else {
        throw new ApiError(401, "missing_auth", "cannot resolve actor for mark-unread");
      }

      await db
        .delete(sessionReadMarkers)
        .where(
          and(
            eq(sessionReadMarkers.sessionId, sessionId),
            eq(sessionReadMarkers.actorId, resolvedActorId),
          ),
        );
    },

    // ── ensureGatewaySession ──────────────────────────────────────────────────
    /**
     * Idempotent get-or-create on the (teamId, binding) unique key.
     * Returns { sessionId, gatewaySessionId, created }.
     * gatewaySessionId = the binding string (acts as the external gateway session id).
     */
    async ensureGatewaySession(input: {
      teamId: string;
      binding: string;
      title: string;
      primaryAgentActorId: string;
      ownerMemberActorIds: string[];
      participantActorIds: string[];
    }) {
      // Try to find existing session by binding
      const [existing] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.teamId, input.teamId), eq(sessions.binding, input.binding)))
        .limit(1);

      // Participants are refreshed for existing rows too, not just on create.
      // The session is keyed by (teamId, binding) and lives forever, so a
      // create-only write freezes membership at whatever the first message
      // saw: re-onboard the daemon (new agent actor id) or grant an admin
      // owner access later and neither ever gets added — the chat then works
      // end to end while staying invisible in every session list, which
      // filters on participation alone.
      const syncParticipants = async (sessionId: string) => {
        const participantIds = Array.from(
          new Set(
            [
              input.primaryAgentActorId,
              ...input.ownerMemberActorIds,
              ...input.participantActorIds,
            ].filter((x): x is string => typeof x === "string" && x.length > 0),
          ),
        );
        if (participantIds.length === 0) return;
        await (db.insert(sessionParticipants) as any)
          .values(participantIds.map((actorId) => ({ sessionId, actorId })))
          .onConflictDoNothing();
      };

      if (existing) {
        await syncParticipants(existing.id);
        // Backfill the chat marker on rows that predate it, so a long-running
        // conversation becomes listable by `/sessions` without a data migration.
        if (!existing.gatewayKey) {
          await updateSessions(db)
            .set({ gatewayKey: input.binding })
            .where(eq(sessions.id, existing.id));
        }
        // NOTE: un-archiving on a new message lives in the
        // `amux.ensure_gateway_session` SQL function (the supabase path, which
        // is what production runs). It is deliberately not mirrored here: this
        // schema has no `archived_at` column at all — `listSessions` above does
        // not filter on it either — so half-implementing the semantics would
        // only add a new inconsistency.
        return {
          sessionId: existing.id,
          gatewaySessionId: existing.binding ?? existing.id,
          acpSessionId: existing.acpSessionId ?? null,
          created: false,
        };
      }

      // Create new session with binding
      const id = crypto.randomUUID();
      const [r] = await (db.insert(sessions) as any)
        .values({
          id,
          teamId: input.teamId,
          title: input.title,
          mode: "gateway",
          primaryAgentId: input.primaryAgentActorId,
          createdByActorId: input.primaryAgentActorId,
          binding: input.binding,
          gatewayKey: input.binding,
          source: "gateway",
        })
        .returning();

      await syncParticipants(id);

      return {
        sessionId: r.id,
        gatewaySessionId: r.binding ?? r.id,
        acpSessionId: r.acpSessionId ?? null,
        created: true,
      };
    },

    // ── createCronSession ─────────────────────────────────────────────────────
    async createCronSession(input: {
      id?: string;
      teamId: string;
      primaryAgentActorId: string;
      title: string;
      createdByActorId?: string;
      cronJobId?: string | null;
    }) {
      const id = input.id ?? crypto.randomUUID();
      const [r] = await (db.insert(sessions) as any)
        .values({
          id,
          teamId: input.teamId,
          title: input.title,
          mode: "collab",
          primaryAgentId: input.primaryAgentActorId,
          createdByActorId: input.createdByActorId ?? input.primaryAgentActorId,
          source: "cron",
          cronJobId: input.cronJobId ?? null,
        })
        .returning();

      // Bootstrap primary agent as participant
      await (db.insert(sessionParticipants) as any)
        .values([{ sessionId: id, actorId: input.primaryAgentActorId }])
        .onConflictDoNothing();

      // Mirror gateway sessions: add human admins so desktop "查看对话" works
      // under sessions_select_if_participant_or_creator RLS.
      const adminRows = await db
        .select({ memberId: agentMemberAccess.memberId })
        .from(agentMemberAccess)
        .where(
          and(
            eq(agentMemberAccess.agentId, input.primaryAgentActorId),
            eq(agentMemberAccess.permissionLevel, "admin"),
          ),
        );
      if (adminRows.length > 0) {
        await (db.insert(sessionParticipants) as any)
          .values(
            adminRows.map((row) => ({
              sessionId: id,
              actorId: row.memberId,
            })),
          )
          .onConflictDoNothing();
      }

      return { sessionId: r.id, ...mapSessionFull(r, []) };
    },

    // ── listSessionsForTeamSince ──────────────────────────────────────────────
    async listSessionsForTeamSince(
      teamId: string,
      updatedAfter: string | null,
      { limit = DEFAULT_LIST_LIMIT, cursor = null }: { limit?: number; cursor?: { updatedAt?: string | null; id?: string } | null } = {},
    ) {
      const conditions = [eq(sessions.teamId, teamId), isNull(sessions.parentSessionId)];
      if (updatedAfter) conditions.push(gt(sessions.updatedAt, new Date(updatedAfter)));
      if (cursor?.updatedAt) {
        // Keyset: strictly after (updatedAt, id).
        const cursorUpdatedAt = new Date(cursor.updatedAt);
        conditions.push(
          sql`(sessions.updated_at > ${cursorUpdatedAt} OR (sessions.updated_at = ${cursorUpdatedAt} AND sessions.id > ${cursor.id ?? null}))`,
        );
      }
      // Ascending and id-tiebroken so paging is deterministic: this query had no
      // ORDER BY at all before, which made any cursor meaningless.
      const rows = await db
        .select()
        .from(sessions)
        .where(and(...conditions))
        .orderBy(asc(sessions.updatedAt), asc(sessions.id))
        .limit(limit);
      return rows.map(mapSessionSyncRow);
    },

    // ── createThread ──────────────────────────────────────────────────────────
    async createThread(
      parentSessionId: string,
      { rootMessageId }: { rootMessageId: string },
    ) {
      if (!rootMessageId?.trim()) {
        throw new ApiError(400, "validation_failed", "rootMessageId is required");
      }
      const [parent] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, parentSessionId))
        .limit(1);
      if (!parent) throw new ApiError(404, "not_found", "parent session not found");
      if (parent.parentSessionId) {
        throw new ApiError(400, "validation_failed", "cannot open a thread on a thread session");
      }

      const callerActorId =
        ctx.callerActorId ??
        (ctx.userId ? await requireActorForTeam(db, ctx.userId, parent.teamId) : null);
      if (!callerActorId) {
        throw new ApiError(401, "missing_identity", "authentication required");
      }

      const parentSeats = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, parentSessionId));
      if (!parentSeats.some((s: { actorId: string }) => s.actorId === callerActorId)) {
        throw new ApiError(403, "forbidden", "not a participant in the parent session");
      }

      const [existing] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.threadRootMessageId, rootMessageId))
        .limit(1);
      if (existing) {
        const parts = await db
          .select()
          .from(sessionParticipants)
          .where(eq(sessionParticipants.sessionId, existing.id));
        return mapSessionFull(existing, parts.map(mapParticipant));
      }

      const [rootMsg] = await db
        .select()
        .from(messages)
        .where(
          and(eq(messages.id, rootMessageId), eq(messages.sessionId, parentSessionId)),
        )
        .limit(1);
      if (!rootMsg) {
        throw new ApiError(404, "not_found", "root message not found in parent session");
      }
      if (rootMsg.kind !== "agent_reply") {
        throw new ApiError(
          400,
          "validation_failed",
          "rootMessageId must reference an agent_reply message",
        );
      }

      const childId = crypto.randomUUID();
      const preview = (rootMsg.content ?? "").trim().slice(0, 80);
      const threadTitle = preview
        ? `${parent.title} · ${preview}${preview.length >= 80 ? "…" : ""}`
        : `${parent.title} · 话题`;

      const [child] = await (db.insert(sessions) as any)
        .values({
          id: childId,
          teamId: parent.teamId,
          title: threadTitle,
          mode: parent.mode,
          ideaId: parent.ideaId,
          primaryAgentId: parent.primaryAgentId,
          createdByActorId: callerActorId,
          source: "thread",
          parentSessionId,
          threadRootMessageId: rootMessageId,
        })
        .returning();

      const participantIds = parentSeats
        .map((s: { actorId: string }) => s.actorId)
        .filter(Boolean);
      let parts: any[] = [];
      if (participantIds.length > 0) {
        parts = await (db.insert(sessionParticipants) as any)
          .values(participantIds.map((actorId: string) => ({ sessionId: childId, actorId })))
          .onConflictDoNothing()
          .returning();
      }

      return mapSessionFull(child, parts.map(mapParticipant));
    },

    async listThreadSummaries(parentSessionId: string) {
      const [parent] = await db
        .select({ id: sessions.id, teamId: sessions.teamId })
        .from(sessions)
        .where(eq(sessions.id, parentSessionId))
        .limit(1);
      if (!parent) throw new ApiError(404, "not_found", "parent session not found");

      const callerActorId =
        ctx.callerActorId ??
        (ctx.userId ? await resolveActorForTeam(db, ctx.userId, parent.teamId) : null);
      if (!callerActorId) {
        throw new ApiError(401, "missing_identity", "authentication required");
      }

      const seats = await db
        .select({ id: sessionParticipants.id })
        .from(sessionParticipants)
        .where(
          and(
            eq(sessionParticipants.sessionId, parentSessionId),
            eq(sessionParticipants.actorId, callerActorId),
          ),
        )
        .limit(1);
      if (seats.length === 0) {
        throw new ApiError(403, "forbidden", "not a participant in the parent session");
      }

      const threadRows = await db
        .select({
          threadSessionId: sessions.id,
          rootMessageId: sessions.threadRootMessageId,
          lastMessageAt: sessions.lastMessageAt,
          participantCount: sql<number>`(
            SELECT COUNT(*)::int FROM session_participants sp
            WHERE sp.session_id = ${sessions.id}
          )`,
          messageCount: sql<number>`(
            SELECT COUNT(*)::int FROM messages m
            WHERE m.session_id = ${sessions.id}
          )`,
        })
        .from(sessions)
        .where(eq(sessions.parentSessionId, parentSessionId));

      return threadRows.map((r: any) => ({
        threadSessionId: r.threadSessionId,
        rootMessageId: r.rootMessageId,
        messageCount: r.messageCount ?? 0,
        lastMessageAt: iso(r.lastMessageAt),
        participantCount: r.participantCount ?? 0,
      }));
    },

    // ── listSessionDisplayRows ────────────────────────────────────────────────
    async listSessionDisplayRows(teamId: string, sessionIds: string[]) {
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) return [];
      const rows = await db
        .select({ id: sessions.id, title: sessions.title })
        .from(sessions)
        .where(and(eq(sessions.teamId, teamId), inArray(sessions.id, sessionIds)));
      return rows;
    },

    // ── listSessionIdsForActor ────────────────────────────────────────────────
    async listSessionIdsForActor(actorId: string) {
      const rows = await db
        .select({ sessionId: sessionParticipants.sessionId })
        .from(sessionParticipants)
        .where(eq(sessionParticipants.actorId, actorId));
      return rows.map((r) => r.sessionId).filter(Boolean);
    },

    // ── listSessionRoster ─────────────────────────────────────────────────────
    /**
     * Display names for session participants, read from `actors` directly.
     *
     * Unlike `listSessionParticipants` (which joins `actor_directory`), this path
     * bypasses agent-visibility filtering so a personal agent authenticated as
     * itself can resolve its own display name for session-context injection.
     *
     * AUTHZ: caller must be a participant in the session (403 otherwise).
     * Only returns rows for actors already seated in `session_participants`.
     */
    async listSessionRoster(sessionId: string) {
      const [s] = await db
        .select({ id: sessions.id, teamId: sessions.teamId, title: sessions.title })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!s) throw new ApiError(404, "not_found", "session not found");

      const callerActorId =
        ctx.callerActorId ??
        (ctx.userId ? await resolveActorForTeam(db, ctx.userId, s.teamId) : null);
      if (!callerActorId) {
        throw new ApiError(401, "missing_identity", "authentication required");
      }

      const seats = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      const isParticipant = seats.some((seat: any) => seat.actorId === callerActorId);
      if (!isParticipant) {
        throw new ApiError(403, "forbidden", "not a participant in this session");
      }

      const actorIds = seats.map((seat: any) => seat.actorId).filter(Boolean);
      const actorRows =
        actorIds.length === 0
          ? []
          : await db
              .select({
                id: actors.id,
                displayName: actors.displayName,
                actorType: actors.actorType,
              })
              .from(actors)
              .where(inArray(actors.id, actorIds));
      const actorsById = new Map(actorRows.map((row: any) => [row.id, row]));

      let selfAgent: {
        visibility: string;
        ownerMemberId: string | null;
        ownerDisplayName: string | null;
      } | null = null;
      const callerActor = actorsById.get(callerActorId);
      if (callerActor?.actorType === "agent") {
        const [agentRow] = await db
          .select({
            visibility: agents.visibility,
            ownerMemberId: agents.ownerMemberId,
          })
          .from(agents)
          .where(eq(agents.id, callerActorId))
          .limit(1);
        if (agentRow) {
          let ownerDisplayName: string | null = null;
          if (agentRow.ownerMemberId) {
            const ownerFromRoster = actorsById.get(agentRow.ownerMemberId);
            if (ownerFromRoster?.displayName) {
              ownerDisplayName = ownerFromRoster.displayName;
            } else {
              const [ownerRow] = await db
                .select({ displayName: actors.displayName })
                .from(actors)
                .where(eq(actors.id, agentRow.ownerMemberId))
                .limit(1);
              ownerDisplayName = ownerRow?.displayName ?? null;
            }
          }
          selfAgent = {
            visibility: agentRow.visibility,
            ownerMemberId: agentRow.ownerMemberId ?? null,
            ownerDisplayName,
          };
        }
      }

      return {
        sessionId,
        callerActorId,
        title: s.title ?? null,
        selfAgent,
        items: seats.map((seat: any) => {
          const actor = actorsById.get(seat.actorId);
          return {
            actorId: seat.actorId,
            displayName: actor?.displayName ?? null,
            kind: actor?.actorType ?? null,
            isSelf: seat.actorId === callerActorId,
          };
        }),
      };
    },

    // ── listSessionParticipants ───────────────────────────────────────────────
    async listSessionParticipants(sessionId: string) {
      const rows = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      return { items: rows.map(mapParticipant) };
    },

    // ── updateParticipantCursor ───────────────────────────────────────────────
    /**
     * How far this agent has read in this session. Keyed by (session, actor),
     * which is the participant row's own key — no runtime row id involved.
     */
    async updateParticipantCursor(
      sessionId: string,
      actorId: string,
      { lastProcessedMessageId }: { lastProcessedMessageId: string | null },
    ) {
      await (db as any)
        .update(sessionParticipants)
        .set({ lastProcessedMessageId, updatedAt: new Date() })
        .where(
          and(
            eq(sessionParticipants.sessionId, sessionId),
            eq(sessionParticipants.actorId, actorId),
          ),
        );
    },

    // ── updateParticipantModel ────────────────────────────────────────────────
    /**
     * Which model this agent runs on in this session. Same key as the cursor
     * above, and same reason it belongs here rather than on a runtime row.
     *
     * Added late: the ADR-0005 migration created the column and backfilled it
     * from `agent_runtimes.current_model`, but no writer was ever wired up, so
     * it sat frozen while the glossary called it authoritative.
     */
    async updateParticipantModel(
      sessionId: string,
      actorId: string,
      { model }: { model: string },
    ) {
      await (db as any)
        .update(sessionParticipants)
        .set({ model, updatedAt: new Date() })
        .where(
          and(
            eq(sessionParticipants.sessionId, sessionId),
            eq(sessionParticipants.actorId, actorId),
          ),
        );
    },

    // ── upsertSessionParticipant ──────────────────────────────────────────────
    async upsertSessionParticipant(
      sessionId: string,
      input: { actorId: string; role?: string | null },
    ) {
      const row: any = { sessionId, actorId: input.actorId };
      if (input.role !== undefined) row.role = input.role;

      // DO NOTHING, matching supabase-repo: re-joining must not rewrite an
      // existing row. See the note there — under RLS the UPDATE arm is refused
      // outright, and it also demoted owners to "member".
      await (db.insert(sessionParticipants) as any)
        .values(row)
        .onConflictDoNothing({
          target: [sessionParticipants.sessionId, sessionParticipants.actorId],
        });

      // Read back rather than RETURNING: DO NOTHING returns no row when the
      // participant was already there, which is the common case.
      const [r] = await (db.select() as any)
        .from(sessionParticipants)
        .where(
          and(
            eq(sessionParticipants.sessionId, sessionId),
            eq(sessionParticipants.actorId, input.actorId),
          ),
        )
        .limit(1);

      // The write and the read are separate statements, so the row can be gone
      // by now (a concurrent removeSessionParticipant). Say so instead of
      // dereferencing undefined and surfacing an opaque 500.
      if (!r) {
        throw new Error(
          `upsertSessionParticipant: participant ${input.actorId} not found in session ${sessionId} after insert`,
        );
      }

      return {
        sessionId: r.sessionId,
        actorId: r.actorId,
        role: r.role ?? null,
        joinedAt: iso(r.joinedAt),
      };
    },

    // ── removeSessionParticipant ──────────────────────────────────────────────
    async removeSessionParticipant(sessionId: string, actorId: string) {
      await (db.delete(sessionParticipants) as any)
        .where(
          and(
            eq(sessionParticipants.sessionId, sessionId),
            eq(sessionParticipants.actorId, actorId),
          ),
        );
    },

    // ── listSessionParticipantsForSync ────────────────────────────────────────
    // Keyset-paginated on (updated_at, id), like the other *ForSync readers.
    async listSessionParticipantsForSync(
      sessionId: string,
      updatedAfter: string | null,
      { limit = DEFAULT_LIST_LIMIT, cursor = null }: {
        limit?: number;
        cursor?: { updatedAt?: string | null; id?: string | null } | null;
      } = {},
    ) {
      const conditions = [eq(sessionParticipants.sessionId, sessionId)];
      if (updatedAfter) {
        conditions.push(gt(sessionParticipants.updatedAt, new Date(updatedAfter)));
      }
      if (cursor?.updatedAt) {
        const at = new Date(cursor.updatedAt);
        conditions.push(
          sql`(${sessionParticipants.updatedAt} > ${at} OR (${sessionParticipants.updatedAt} = ${at} AND ${sessionParticipants.id} > ${cursor.id ?? null}))`,
        );
      }
      const rows = await db
        .select()
        .from(sessionParticipants)
        .where(and(...conditions))
        .orderBy(asc(sessionParticipants.updatedAt), asc(sessionParticipants.id))
        .limit(limit);
      return rows.map(mapSessionParticipantSyncRow);
    },
  };
}
