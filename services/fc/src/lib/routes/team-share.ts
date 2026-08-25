import { ApiError } from "../http-utils.js";

function validateLlmConfigInput(body) {
  const enabled = body?.enabled;
  if (typeof enabled !== "boolean") {
    throw new ApiError(400, "validation_failed", "enabled must be a boolean");
  }
  let baseUrl = null;
  if (body.baseUrl !== undefined && body.baseUrl !== null) {
    if (typeof body.baseUrl !== "string") {
      throw new ApiError(400, "validation_failed", "baseUrl must be a string or null");
    }
    baseUrl = body.baseUrl.trim() || null;
  }
  const rawModels = body?.models;
  if (!Array.isArray(rawModels)) {
    throw new ApiError(400, "validation_failed", "models must be an array of {id,name}");
  }
  const models = rawModels.map((m) => {
    if (!m || typeof m !== "object" || typeof m.id !== "string" || typeof m.name !== "string") {
      throw new ApiError(400, "validation_failed", "each model must be an object with string id and name");
    }
    return { id: m.id, name: m.name };
  });
  return { enabled, baseUrl, models };
}

export function registerTeamShare(router) {
  router.get("/v1/teams/:teamId/workspace-config", async (ctx) => {
    const result = await ctx.repository.getWorkspaceConfig(ctx.params.teamId);
    return { body: result };
  });

  router.put("/v1/teams/:teamId/llm-config", async (ctx) => {
    const input = validateLlmConfigInput(ctx.json ?? {});
    const result = await ctx.repository.setLlmConfig(ctx.params.teamId, input);
    return { body: result };
  });
}
