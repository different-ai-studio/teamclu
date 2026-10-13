import { ApiError } from "../http-utils.js";

function bearerToken(ctx): string | null {
  const header = ctx.getHeader?.("authorization");
  if (!header || typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || null;
}

function codeParam(ctx): string | null {
  const value = ctx.query?.get?.("code");
  return typeof value === "string" && value.trim() ? value : null;
}

export function registerSupportSessions(router) {
  // The helper has no user session (install failed, or the UI is blank).
  // These routes use the system repository. The short code is the helper's
  // credential; a signed-in supporter presents a bearer instead.
  const system = { auth: "system" };

  router.post("/v1/support-sessions", system, async (ctx) => {
    const body = await ctx.repository.createSupportSession(ctx.json ?? {});
    return { statusCode: 201, body };
  });

  router.post("/v1/support-sessions/redeem", system, async (ctx) => {
    const body = await ctx.repository.redeemSupportSession(ctx.json?.code, bearerToken(ctx));
    return { body };
  });

  router.get("/v1/support-sessions/:id", system, async (ctx) => {
    const body = await ctx.repository.getSupportSession(ctx.params.id, {
      code: codeParam(ctx),
      bearer: bearerToken(ctx),
    });
    return { body };
  });

  router.post("/v1/support-sessions/:id/allow", system, async (ctx) => {
    const body = await ctx.repository.allowSupportSession(ctx.params.id, codeParam(ctx));
    return { body };
  });

  router.post("/v1/support-sessions/:id/bundle", system, async (ctx) => {
    const body = await ctx.repository.uploadSupportBundle(ctx.params.id, codeParam(ctx), ctx.json);
    return { body };
  });

  router.post("/v1/support-sessions/:id/conclusion", system, async (ctx) => {
    const text = ctx.json?.text;
    const body = await ctx.repository.concludeSupportSession(ctx.params.id, bearerToken(ctx), text);
    return { body };
  });

  router.post("/v1/support-sessions/:id/close", system, async (ctx) => {
    const reason = ctx.json?.reason;
    if (reason !== "user_rejected" && reason !== "user_closed" && reason !== "support_closed") {
      throw new ApiError(400, "validation_failed", "invalid close reason");
    }
    const body = await ctx.repository.closeSupportSession(
      ctx.params.id,
      { code: codeParam(ctx), bearer: bearerToken(ctx) },
      reason,
    );
    return { body };
  });
}
