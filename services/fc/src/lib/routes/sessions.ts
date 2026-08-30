import { ApiError } from "../http-utils.js";
import { parseLimit, decodeCursor, nextSessionCursor, requireString } from "../routing-utils.js";

export function registerSessions(router) {
  // `teamId` / `ideaId` are narrowing filters applied server-side so they stay
  // correct under pagination. They are what replaced the removed
  // GET /v1/teams/:teamId/sessions — see 20260802000000.
  //
  // teamId is REQUIRED. Since 20260804020000 the caller's actor is resolved per
  // team (one actor row per user per team), so a team is what identifies who is
  // asking — and it is also the only thing that lets this query use
  // `sessions_team_active_last_message_idx`. The un-scoped fallback that used to
  // serve callers omitting it was O(N) in the caller's session count: measured
  // on 47.112.210.217, 6k sessions took 4.5s and anything past ~13k blew the
  // `authenticated` role's 8s statement_timeout and came back as a 500. A
  // released build that omits teamId now gets an honest 400 instead of a list
  // that degrades into timeouts as its history grows.
  router.get("/v1/sessions", async (ctx) => {
    const limit = parseLimit(ctx.query.get("limit"));
    const cursor = decodeCursor(ctx.query.get("cursor"));
    const teamId = requireString(ctx.query.get("teamId"), "teamId");
    const ideaId = ctx.query.get("ideaId") || null;
    const kind = ctx.query.get("kind") || "all";
    if (!["all", "regular", "cron"].includes(kind)) {
      throw new ApiError(400, "validation_failed", "kind must be all, regular, or cron");
    }
    // Fetch one sentinel row so an exactly-full terminal page does not expose
    // a dead "Load more" cursor. The sentinel is never returned to clients.
    const fetched = await ctx.repository.listSessions({
      limit: limit + 1,
      cursor,
      teamId,
      ideaId,
      kind,
    });
    const hasMore = fetched.length > limit;
    const items = fetched.slice(0, limit);
    return {
      body: {
        items,
        nextCursor: hasMore ? nextSessionCursor(items, limit) : null,
      },
    };
  });

  router.post("/v1/sessions", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    requireString(body.title, "title");
    requireString(body.mode, "mode");
    const out = await ctx.repository.createSession(body);
    return { statusCode: 201, body: out };
  });

  router.get("/v1/sessions/muted", async (ctx) => {
    const out = await ctx.repository.listMutedSessions();
    return { body: out };
  });

  // One gateway chat's own sessions: the current one plus everything `/new`
  // detached from it. Keyed on `gatewayKey` (the chat's binding, which survives
  // detach) so a chat can only enumerate its own lineage. Registered above
  // `/:sessionId` — otherwise "gateway" is read as a session id.
  router.get("/v1/sessions/gateway", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    const gatewayKey = ctx.query.get("gatewayKey");
    requireString(teamId, "teamId");
    requireString(gatewayKey, "gatewayKey");
    const out = await ctx.repository.listGatewaySessions({
      teamId,
      gatewayKey,
      limit: parseLimit(ctx.query.get("limit")),
    });
    return { body: out };
  });

  // teamId is required here for the same reason as on the list: it is what
  // scopes a read to a team the caller has an actor in. Passing it also turns a
  // cross-team id into a 404 at the query level rather than relying on RLS
  // alone to hide the row.
  router.get("/v1/sessions/:sessionId", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const teamId = requireString(ctx.query.get("teamId"), "teamId");
    const out = await ctx.repository.getSession(sessionId, { teamId });
    if (!out) throw new ApiError(404, "not_found", "session not found");
    return { body: out };
  });

  router.patch("/v1/sessions/:sessionId", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const body = ctx.json ?? {};
    const out = await ctx.repository.patchSession(sessionId, body);
    if (!out) throw new ApiError(404, "not_found", "session not found");
    return { body: out };
  });

  router.post("/v1/sessions/:sessionId/mark-viewed", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const body = ctx.json ?? {};
    const lastReadMessageId = typeof body.lastReadMessageId === "string" && body.lastReadMessageId.length > 0
      ? body.lastReadMessageId
      : null;
    // The actor is resolved server-side from the authenticated user inside the
    // repo — the route never supplies a client actorId.
    await ctx.repository.markSessionViewed(sessionId, lastReadMessageId);
    return { statusCode: 204, body: null };
  });

  router.post("/v1/sessions/:sessionId/mark-unread", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    // The actor is resolved server-side from the authenticated user inside the
    // repo — the route never supplies a client actorId.
    await ctx.repository.markSessionUnread(sessionId);
    return { statusCode: 204, body: null };
  });

  router.post("/v1/sessions/:sessionId/join", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    // The actor is resolved server-side from the authenticated user inside the
    // repo (membership-checked self-join). Returns the full session (200) or
    // throws 404/403 from the repo, which the router adapter maps.
    const out = await ctx.repository.joinSession(sessionId);
    return { body: out };
  });

  // GET /v1/teams/:teamId/sessions is gone — it fetched a team's entire session
  // list unpaginated, then filtered participants with an `.in(<every id>)` that
  // outgrew the gateway's URI limit and surfaced as an opaque 500. Use
  // GET /v1/sessions?teamId=… instead, which is paginated and carries the same
  // display-row fields.

  router.get("/v1/sessions/:sessionId/participants", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const out = await ctx.repository.listSessionParticipants(sessionId);
    return { body: out };
  });

  router.get("/v1/sessions/:sessionId/roster", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const out = await ctx.repository.listSessionRoster(sessionId);
    return { body: out };
  });

  router.post("/v1/sessions/:sessionId/participants", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const body = ctx.json ?? {};
    requireString(body.actorId, "actorId");
    const out = await ctx.repository.upsertSessionParticipant(sessionId, body);
    return { body: out };
  });

  // Catch-up cursor, addressed by (session, actor) — where it now lives
  // (ADR-0005). Replaces PATCH /v1/agents/runtimes/:rowId/cursor, which needed
  // a row id minted by a runtime upsert that no longer happens.
  router.patch("/v1/sessions/:sessionId/participants/:actorId/cursor", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.lastProcessedMessageId, "lastProcessedMessageId");
    await ctx.repository.updateParticipantCursor(
      decodeURIComponent(ctx.params.sessionId),
      decodeURIComponent(ctx.params.actorId),
      { lastProcessedMessageId: body.lastProcessedMessageId },
    );
    return { statusCode: 204, body: null };
  });

  // Which model this agent runs on in this session — same (session, actor)
  // addressing as the cursor above (ADR-0005).
  //
  // This column shipped with the ADR-0005 migration and was backfilled once,
  // but no writer was ever wired up, so it froze while both the ADR and the
  // glossary described it as authoritative. The daemon is the only caller:
  // it is the only component that sees which model a runtime settled on, and
  // the only one present for gateway and cron sessions (ADR-0007).
  //
  // `model` is required rather than nullable — every entry point pins a model
  // at creation time, so there is no unpinned state to clear back to.
  router.patch("/v1/sessions/:sessionId/participants/:actorId/model", async (ctx) => {
    const body = ctx.json ?? {};
    const model = requireString(body.model, "model");
    await ctx.repository.updateParticipantModel(
      decodeURIComponent(ctx.params.sessionId),
      decodeURIComponent(ctx.params.actorId),
      { model },
    );
    return { statusCode: 204, body: null };
  });

  router.delete("/v1/sessions/:sessionId/participants/:actorId", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const actorId = decodeURIComponent(ctx.params.actorId);
    await ctx.repository.removeSessionParticipant(sessionId, actorId);
    return { statusCode: 204, body: null };
  });

  // Release a gateway chat's binding so the next inbound message opens a new
  // session. The old row keeps its history; it just stops being the current
  // session for that chat.
  router.post("/v1/sessions/gateway/detach", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.acpSessionId, "acpSessionId");
    const out = await ctx.repository.detachGatewaySession(body.acpSessionId);
    return { body: out };
  });

  // Point a chat's binding at one of that chat's existing sessions — the
  // inverse of /gateway/detach. `attached: false` means the target is unknown
  // or belongs to a different chat; the caller must not report a switch.
  router.post("/v1/sessions/gateway/attach", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.binding, "binding");
    requireString(body.sessionId, "sessionId");
    const out = await ctx.repository.attachGatewaySession({
      binding: body.binding,
      sessionId: body.sessionId,
    });
    return { body: out };
  });

  router.get("/v1/sessions/by-acp/:acpSessionId", async (ctx) => {
    const acpSessionId = decodeURIComponent(ctx.params.acpSessionId);
    const out = await ctx.repository.getSessionByAcp(acpSessionId);
    if (!out) throw new ApiError(404, "not_found", "no session bound to ACP id");
    return { body: out };
  });

  router.post("/v1/sessions/gateway/ensure", async (ctx) => {
    const body = ctx.json ?? {};
    for (const k of ["teamId", "binding", "title", "primaryAgentActorId"]) {
      requireString(body[k], k);
    }
    const out = await ctx.repository.ensureGatewaySession(body);
    return { body: out };
  });

  router.post("/v1/sessions/display-rows", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    if (!Array.isArray(body.sessionIds)) {
      throw new ApiError(400, "validation_failed", "sessionIds must be an array");
    }
    const items = await ctx.repository.listSessionDisplayRows(body.teamId, body.sessionIds);
    return { body: { items } };
  });

  router.post("/v1/sessions/cron", async (ctx) => {
    const body = ctx.json ?? {};
    for (const k of ["teamId", "primaryAgentActorId", "title"]) {
      requireString(body[k], k);
    }
    // cronJobId is optional (daemon-local id); passed through when present.
    const out = await ctx.repository.createCronSession(body);
    return { body: out };
  });
}
