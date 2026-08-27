import { ApiError } from "../http-utils.js";
import { parseLimit, requireString } from "../routing-utils.js";

/**
 * Normalize the optional repo URL an app is imported from.
 *
 * The daemon validates it again before handing it to `git clone` — that check
 * is the security boundary, since it is the one next to the process spawn. This
 * one exists so a typo is a 400 at create time instead of a row that can never
 * be seeded. Same allowlist: http(s) / ssh / git://, or scp-like `git@host:path`.
 */
function normalizeGitRemoteUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new ApiError(400, "validation_failed", "gitRemoteUrl must be a string");
  }
  const url = raw.trim();
  if (!url) return null;
  const schemed = /^(https?|ssh|git):\/\/[^\s]+$/.test(url);
  const scpLike = /^[^\s:/@]+@[^\s:/@]+:[^\s]+$/.test(url);
  if (!schemed && !scpLike) {
    throw new ApiError(
      400,
      "validation_failed",
      "gitRemoteUrl must be an http(s), ssh or git:// address",
    );
  }
  return url;
}

export function registerApps(router) {
  router.get("/v1/apps", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    requireString(teamId, "teamId");
    const limit = parseLimit(ctx.query.get("limit"));
    const items = await ctx.repository.listApps({ teamId, limit });
    return { body: { items } };
  });

  router.post("/v1/apps", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    requireString(body.name, "name");
    requireString(body.type, "type");
    const out = await ctx.repository.createApp({
      ...body,
      gitRemoteUrl: normalizeGitRemoteUrl(body.gitRemoteUrl),
    });
    return { statusCode: 201, body: out };
  });

  router.get("/v1/apps/:appId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getApp(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.patch("/v1/apps/:appId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const body = ctx.json ?? {};
    const out = await ctx.repository.updateApp(appId, body);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.post("/v1/apps/:appId/deploy", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const body = ctx.json ?? {};
    const out = await ctx.repository.deployApp(appId, body);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { statusCode: 202, body: out };
  });

  router.post("/v1/apps/:appId/deploy/finalize", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const body = ctx.json ?? {};
    const out = await ctx.repository.finalizeDeploy(appId, body);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.get("/v1/apps/:appId/sessions", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const items = await ctx.repository.listAppSessions(appId);
    return { body: { items } };
  });

  // Secret response — never log the body (private deploy key).
  router.get("/v1/apps/:appId/git-credential", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getAppGitCredential(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.get("/v1/apps/:appId/git-head", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getAppGitHead(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.get("/v1/apps/:appId/membership", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getAppMembership(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

}
