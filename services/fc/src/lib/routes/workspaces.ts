import { ApiError } from "../http-utils.js";
import { requireString, encodeCursor } from "../routing-utils.js";

const DEFAULT_WORKSPACE_LIMIT = 50;
const MAX_WORKSPACE_LIMIT = 200;

function parseWorkspaceLimit(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_WORKSPACE_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WORKSPACE_LIMIT) {
    throw new ApiError(400, "validation_failed", "limit must be an integer from 1 to 200");
  }
  return limit;
}

export function registerWorkspaces(router) {
  router.get("/v1/workspaces", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    const limit = parseWorkspaceLimit(ctx.query.get("limit"));
    const cursorStr = ctx.query.get("cursor");
    const cursor = cursorStr ? decodeWorkspaceCursor(cursorStr) : null;
    const agentId = ctx.query.get("agentId");
    const page = await ctx.repository.listWorkspaces({ teamId, limit, cursor, agentId });
    const nextCursor = nextWorkspaceCursor(page.items, limit);
    return { body: { items: page.items, nextCursor } };
  });

  router.post("/v1/workspaces", async (ctx) => {
    const body = ctx.json;
    if (!body) throw new ApiError(400, "validation_failed", "body is required");
    requireString(body.teamId, "teamId");
    requireString(body.name, "name");
    const w = await ctx.repository.upsertWorkspace({
      id: body.id,
      teamId: body.teamId,
      name: body.name,
      path: body.path ?? body.slug ?? null,
      agentId: body.agentId ?? null,
      createdByMemberId: body.createdByMemberId ?? null,
      slug: body.slug ?? body.path ?? null,
      archived: body.archived ?? false,
    });
    return { body: w };
  });

  router.post("/v1/workspaces/by-ids", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    if (!Array.isArray(body.ids)) {
      throw new ApiError(400, "validation_failed", "ids must be an array");
    }
    const items = await ctx.repository.listWorkspacesByIdsSlim(body.teamId, body.ids);
    return { body: { items } };
  });

  router.get("/v1/workspaces/:workspaceId", async (ctx) => {
    const w = await ctx.repository.getWorkspace(ctx.params.workspaceId);
    if (!w) throw new ApiError(404, "not_found", "workspace not found");
    return { body: w };
  });

  router.patch("/v1/workspaces/:workspaceId", async (ctx) => {
    const body = ctx.json ?? {};
    const w = await ctx.repository.patchWorkspace(ctx.params.workspaceId, body);
    if (!w) throw new ApiError(404, "not_found", "workspace not found");
    return { body: w };
  });

  // NOTE: GET /v1/teams/:teamId/workspace-config lives in routes/team-share.ts
  // and returns the merged shape (syncMode, llm).
  // The legacy { defaultWorkspaceId, pinnedWorkspaceIds } shape is exposed via
  // GET /v1/teams/:teamId/workspace-defaults so that merged endpoint can own
  // the canonical path.
  router.get("/v1/teams/:teamId/workspace-defaults", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const cfg = await ctx.repository.getTeamWorkspaceConfig(teamId);
    if (!cfg) {
      throw new ApiError(404, "not_found", "config not set");
    }
    return { body: cfg };
  });

  router.put("/v1/teams/:teamId/workspace-config", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const body = ctx.json ?? {};
    const cfg = await ctx.repository.putTeamWorkspaceConfig(teamId, {
      defaultWorkspaceId: body.defaultWorkspaceId ?? null,
      pinnedWorkspaceIds: body.pinnedWorkspaceIds ?? [],
    });
    return { body: cfg };
  });
}

function decodeWorkspaceCursor(value) {
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

export function nextWorkspaceCursor(items, limit) {
  if (!Array.isArray(items) || items.length < limit) return null;
  const last = items[items.length - 1];
  if (!last) return null;
  return encodeCursor({
    updatedAt: last.updatedAt ?? null,
    id: last.id,
  });
}