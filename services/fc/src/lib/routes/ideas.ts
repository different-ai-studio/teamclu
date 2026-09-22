import { ApiError } from "../http-utils.js";
import { requireString, encodeCursor } from "../routing-utils.js";

const DEFAULT_IDEA_LIMIT = 50;
const MAX_IDEA_LIMIT = 200;

function parseIdeaLimit(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_IDEA_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_IDEA_LIMIT) {
    throw new ApiError(400, "validation_failed", "limit must be an integer from 1 to 200");
  }
  return limit;
}

function decodeIdeaCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return {
      updatedAt: parsed.updatedAt ?? null,
      id: parsed.id ?? null,
    };
  } catch (cause) {
    throw new ApiError(400, "validation_failed", "Invalid cursor", { cause });
  }
}

export function nextIdeaCursor(items, limit) {
  if (!Array.isArray(items) || items.length < limit) return null;
  const last = items[items.length - 1];
  if (!last) return null;
  return encodeCursor({
    updatedAt: last.updatedAt ?? null,
    id: last.id,
  });
}

export function registerIdeas(router) {
  router.get("/v1/ideas", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    const limit = parseIdeaLimit(ctx.query.get("limit"));
    const archived = ctx.query.get("archived") === "true";
    const cursorStr = ctx.query.get("cursor");
    const cursor = cursorStr ? decodeIdeaCursor(cursorStr) : null;
    const page = await ctx.repository.listIdeas({ teamId, archived, limit, cursor });
    const nextCursor = nextIdeaCursor(page.items, limit);
    return { body: { items: page.items, nextCursor } };
  });

  router.post("/v1/ideas", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    requireString(body.title, "title");
    const idea = await ctx.repository.createIdea(body);
    return { statusCode: 201, body: idea };
  });

  router.post("/v1/ideas/reorder", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    if (!Array.isArray(body.ideaIds)) {
      throw new ApiError(400, "validation_failed", "ideaIds is required and must be an array");
    }
    await ctx.repository.reorderIdeas({ teamId: body.teamId, ideaIds: body.ideaIds });
    return { statusCode: 204, body: null };
  });

  router.get("/v1/ideas/:ideaId", async (ctx) => {
    const idea = await ctx.repository.getIdea(ctx.params.ideaId);
    if (!idea) throw new ApiError(404, "not_found", "idea not found");
    return { body: idea };
  });

  router.get("/v1/ideas/:ideaId/activities", async (ctx) => {
    const out = await ctx.repository.listIdeaActivities(ctx.params.ideaId);
    return { body: out };
  });

  router.patch("/v1/ideas/:ideaId", async (ctx) => {
    const idea = await ctx.repository.updateIdea(ctx.params.ideaId, ctx.json ?? {});
    if (!idea) throw new ApiError(404, "not_found", "idea not found");
    return { body: idea };
  });

  router.post("/v1/ideas/:ideaId/archive", async (ctx) => {
    const body = ctx.json ?? {};
    const archived = body.archived === undefined ? true : body.archived === true;
    await ctx.repository.archiveIdea(ctx.params.ideaId, { archived });
    return { statusCode: 204, body: null };
  });

  // PUT, not POST/DELETE: the body says what the like should BE, so a tap
  // that arrives twice — two devices, a retry — settles on the same state
  // instead of toggling back. Returns the row's fresh numbers so the caller
  // doesn't refetch the page to see its own tap land.
  router.put("/v1/ideas/:ideaId/like", async (ctx) => {
    const body = ctx.json ?? {};
    if (typeof body.liked !== "boolean") {
      throw new ApiError(400, "validation_failed", "liked is required and must be a boolean");
    }
    const out = await ctx.repository.setIdeaLike(ctx.params.ideaId, body.liked);
    return { body: out };
  });

  router.post("/v1/ideas/:ideaId/activities", async (ctx) => {
    const body = ctx.json ?? {};
    const kind = body.kind ?? body.activityType ?? body.eventType;
    requireString(kind, "kind");
    requireString(body.actorId, "actorId");
    const activity = await ctx.repository.createIdeaActivity(ctx.params.ideaId, { ...body, kind });
    return { statusCode: 201, body: activity };
  });
}
