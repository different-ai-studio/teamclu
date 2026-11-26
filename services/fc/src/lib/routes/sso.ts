// Enterprise IM sign-in routes (WeCom first). The protocol lives in
// lib/sso/sso-service.ts; these only adapt HTTP. Every route is auth:"none"
// so ctx.repository is the auth repository, which carries the SSO service;
// the admin routes check the bearer themselves (an org owner/admin of the
// team's org).
import { ApiError, extractBearerToken } from "../http-utils.js";
import { requestOrigin } from "../team-llm-defaults.js";

function sso(ctx) {
  const service = ctx.repository?.ssoService?.();
  if (!service) throw new ApiError(501, "not_implemented", "enterprise sign-in is not available on this deployment");
  return service;
}

function html(status: number, page: string) {
  return {
    statusCode: status,
    binary: { bytes: Buffer.from(page, "utf8"), mime: "text/html; charset=utf-8" },
    headers: { "Cache-Control": "no-store" },
  };
}

function text(status: number, body: string) {
  return {
    statusCode: status,
    binary: { bytes: Buffer.from(body, "utf8"), mime: "text/plain; charset=utf-8" },
  };
}

function origin(ctx): string | null {
  return requestOrigin((name) => ctx.getHeader(name));
}

export function registerSso(router) {
  router.get("/v1/auth/sso/:provider/authorize", { auth: "none", noStore: true }, async (ctx) => {
    const provider = decodeURIComponent(ctx.params.provider);
    const redirect = ctx.query.get("redirect");
    const codeChallenge = ctx.query.get("code_challenge");
    if (!redirect) throw new ApiError(400, "validation_failed", "redirect is required");
    if (!codeChallenge) throw new ApiError(400, "validation_failed", "code_challenge is required");
    const method = ctx.query.get("code_challenge_method");
    if (method && method.toLowerCase() !== "s256") {
      throw new ApiError(400, "validation_failed", "code_challenge_method must be S256");
    }
    const location = await sso(ctx).loginAuthorizeUrl({
      provider,
      redirect,
      codeChallenge,
      requestOrigin: origin(ctx),
      lang: ctx.query.get("lang") ?? undefined,
    });
    return { redirect: location };
  });

  // Registered before the generic `/:provider/callback` shape would matter:
  // these two paths are WeCom's, named in its provider console.
  router.get("/v1/auth/sso/wecom/install-callback", { auth: "none", noStore: true }, async (ctx) => {
    const out = await sso(ctx).handleInstallCallback({
      provider: "wecom",
      authCode: ctx.query.get("auth_code"),
      state: ctx.query.get("state"),
    });
    return html(out.status, out.html);
  });

  router.get("/v1/auth/sso/wecom/suite-callback", { auth: "none", noStore: true }, async (ctx) => {
    const out = await sso(ctx).handleSuiteCallback({ method: "GET", query: ctx.query, body: "" });
    return text(out.status, out.text);
  });

  router.post("/v1/auth/sso/wecom/suite-callback", { auth: "none", rawBody: true, maxBodyBytes: 64 * 1024 }, async (ctx) => {
    const body = ctx.rawBody ? Buffer.from(ctx.rawBody).toString("utf8") : "";
    const out = await sso(ctx).handleSuiteCallback({ method: "POST", query: ctx.query, body });
    return text(out.status, out.text);
  });

  router.get("/v1/auth/sso/:provider/callback", { auth: "none", noStore: true }, async (ctx) => {
    const provider = decodeURIComponent(ctx.params.provider);
    const out = await sso(ctx).handleLoginCallback({
      provider,
      code: ctx.query.get("code"),
      state: ctx.query.get("state"),
    });
    if ("redirect" in out) return { redirect: out.redirect };
    return html(out.status, out.html);
  });

  router.post("/v1/auth/sso/exchange", { auth: "none", noStore: true }, async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.code || typeof body.code !== "string") throw new ApiError(400, "validation_failed", "code is required");
    if (!body.codeVerifier || typeof body.codeVerifier !== "string") {
      throw new ApiError(400, "validation_failed", "codeVerifier is required");
    }
    const out = await sso(ctx).exchange({ code: body.code, codeVerifier: body.codeVerifier });
    return { body: out };
  });

  router.get("/v1/teams/:teamId/sso/:provider", { auth: "none", noStore: true }, async (ctx) => {
    const out = await sso(ctx).binding({
      provider: decodeURIComponent(ctx.params.provider),
      accessToken: extractBearerToken(ctx.headers),
      teamId: decodeURIComponent(ctx.params.teamId),
    });
    return { body: out };
  });

  router.post("/v1/teams/:teamId/sso/:provider/install", { auth: "none", noStore: true }, async (ctx) => {
    const out = await sso(ctx).installUrl({
      provider: decodeURIComponent(ctx.params.provider),
      accessToken: extractBearerToken(ctx.headers),
      teamId: decodeURIComponent(ctx.params.teamId),
      requestOrigin: origin(ctx),
    });
    return { body: out };
  });

  router.delete("/v1/teams/:teamId/sso/:provider", { auth: "none" }, async (ctx) => {
    const out = await sso(ctx).unbind({
      provider: decodeURIComponent(ctx.params.provider),
      accessToken: extractBearerToken(ctx.headers),
      teamId: decodeURIComponent(ctx.params.teamId),
    });
    return { body: out };
  });
}
