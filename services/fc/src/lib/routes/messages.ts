import { ApiError } from "../http-utils.js";
import {
  requireString,
  parseMessageLimit,
  decodeMessageCursor,
  nextMessageCursor,
} from "../routing-utils.js";
import {
  completeTurnTraceUpload,
  createTurnTraceDownload,
  parseTurnTraceClaim,
  parseTurnTraceTarget,
  prepareTurnTraceUpload,
} from "../turn-trace.js";

export function registerMessages(router) {
  // Paginated backward from the newest message. `nextCursor` was hardcoded to
  // null here while the repository fetched the entire history unbounded, so a
  // long-running session degraded until it timed out — see the limits in
  // routing-utils. Omitting `limit` now yields the most recent
  // DEFAULT_MESSAGE_LIST_LIMIT messages (oldest-first within the page) plus a
  // cursor for the page before it.
  router.get("/v1/sessions/:sessionId/messages", async (ctx) => {
    const limit = parseMessageLimit(ctx.query.get("limit"));
    const cursor = decodeMessageCursor(ctx.query.get("cursor"));
    const items = await ctx.repository.listMessages(
      decodeURIComponent(ctx.params.sessionId),
      { limit, cursor },
    );
    return { body: { items, nextCursor: nextMessageCursor(items, limit) } };
  });

  router.post("/v1/sessions/:sessionId/messages", async (ctx) => {
    const body = ctx.json;
    requireString(body.id, "id");
    requireString(body.teamId, "teamId");
    requireString(body.senderActorId, "senderActorId");
    requireString(body.content, "content");

    const idempotencyKey = ctx.getHeader("idempotency-key");
    if (idempotencyKey && idempotencyKey !== body.id) {
      throw new ApiError(400, "validation_failed", "Idempotency-Key must match message id");
    }

    const message = await ctx.repository.insertMessage(decodeURIComponent(ctx.params.sessionId), body);
    return { body: message };
  });

  router.patch("/v1/messages/:messageId", async (ctx) => {
    const patch = ctx.json ?? {};
    const message = await ctx.repository.patchMessage(decodeURIComponent(ctx.params.messageId), patch);
    // `null` is PostgREST matching no row — absent, or not updatable by this
    // caller under RLS. Answering 200 with a null body told the caller the
    // write landed when nothing was written.
    if (!message) {
      throw new ApiError(404, "not_found", "message not found");
    }
    return { body: message };
  });

  router.delete("/v1/messages/:messageId", async (ctx) => {
    await ctx.repository.deleteMessage(decodeURIComponent(ctx.params.messageId));
    return { statusCode: 204 };
  });

  // Turn execution trace (#1455 Phase 2). The daemon uploads at turn end and
  // attaches the pointer to its reply; clients expand tool cards by fetching a
  // short-lived download URL. See lib/turn-trace.ts for the authorization.
  router.post("/v1/sessions/:sessionId/turns/:turnId/trace/prepare", async (ctx) => {
    const body = ctx.json ?? {};
    const target = parseTurnTraceTarget(
      decodeURIComponent(ctx.params.sessionId),
      decodeURIComponent(ctx.params.turnId),
      body.teamId,
    );
    const claim = parseTurnTraceClaim(target, body);
    return { body: await prepareTurnTraceUpload(ctx.repository, claim) };
  });

  router.post("/v1/sessions/:sessionId/turns/:turnId/trace/complete", async (ctx) => {
    const body = ctx.json ?? {};
    const target = parseTurnTraceTarget(
      decodeURIComponent(ctx.params.sessionId),
      decodeURIComponent(ctx.params.turnId),
      body.teamId,
    );
    const claim = parseTurnTraceClaim(target, body);
    return { body: await completeTurnTraceUpload(ctx.repository, claim, body.status) };
  });

  router.get("/v1/sessions/:sessionId/turns/:turnId/trace", async (ctx) => {
    const target = parseTurnTraceTarget(
      decodeURIComponent(ctx.params.sessionId),
      decodeURIComponent(ctx.params.turnId),
      ctx.query.get("teamId"),
    );
    const download = await createTurnTraceDownload(ctx.repository, target);
    if (!download) {
      throw new ApiError(404, "not_found", "turn trace not found");
    }
    return { body: download };
  });
}
