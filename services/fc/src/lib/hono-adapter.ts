import type { Context, Hono } from "hono";
import {
  errorResponse,
  extractBearerToken,
  normalizeHeaders,
  parseJsonBody,
  resolveRequestId,
  ApiError,
} from "./http-utils.js";
import { sharedSecretMatches } from "./shared-secret.js";

type Deps = {
  createRepository: (args: { accessToken: string }) => unknown | Promise<unknown>;
  createAuthRepository: () => unknown;
  /** Unauthenticated system repo for marketplace admin (shared-secret routes). */
  createSystemRepository?: () => unknown | Promise<unknown>;
};
type RouteOptions = {
  auth?: "bearer" | "none" | "marketplace-admin" | "app-token" | "cron-tick";
  rawBody?: boolean;
};
type LegacyCtx = Record<string, unknown>;
type LegacyHandler = (ctx: LegacyCtx) => Promise<any> | any;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function synthEvent(c: Context, bodyText: string): any {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headers[k] = v; });
  const url = new URL(c.req.url);
  const queryStringParameters: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryStringParameters[k] = v; });
  return {
    headers,
    body: bodyText,
    isBase64Encoded: false,
    httpMethod: c.req.method,
    path: url.pathname,
    rawPath: url.pathname,
    rawQueryString: url.search.startsWith("?") ? url.search.slice(1) : url.search,
    queryStringParameters,
  };
}

// Positionally extract :param values as RAW (undecoded) path segments, matching
// the legacy createRouter.matchRoute behavior. `routePath` is the matched Hono
// pattern (e.g. "/v1/attachments/:path"); `parts` are the raw request segments.
function rawParams(routePath: string | undefined, parts: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  if (!routePath) return params;
  const patternParts = routePath.split("/").filter(Boolean);
  if (patternParts.length !== parts.length) return params;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = parts[i];
    }
  }
  return params;
}

async function buildCtxFromHono(c: Context, repository: unknown, opts: RouteOptions): Promise<LegacyCtx> {
  const isRaw = opts.rawBody === true;
  const rawBuf = isRaw ? Buffer.from(await c.req.arrayBuffer()) : undefined;
  const bodyText = isRaw ? "" : await c.req.text();
  const event = synthEvent(c, bodyText);
  const headers = normalizeHeaders(event.headers);
  const query = new URLSearchParams();
  const url = new URL(c.req.url);
  url.searchParams.forEach((v, k) => query.set(k, v));
  const parts = url.pathname.split("/").filter(Boolean);
  return {
    repository,
    event,
    parts,
    // Mirror the legacy createRouter: path params are the RAW (undecoded) path
    // segments. Hono's c.req.param() returns percent-DECODED values, which
    // breaks equivalence for routes like /v1/attachments/:path (where the
    // repository expects the still-encoded "foo%2Fbar.png"). Recompute the
    // params positionally from the matched route pattern against raw segments.
    params: rawParams(c.req.routePath, parts),
    query,
    headers,
    json: isRaw ? undefined : parseJsonBody(event),
    rawBody: rawBuf,
    getHeader: (name: string) => headers[name.toLowerCase()],
  };
}

function toResponse(c: Context, result: any, requestId: string): Response {
  if (result?.binary) {
    return new Response(result.binary.bytes, {
      status: result.statusCode ?? 200,
      headers: { "Content-Type": result.binary.mime, "X-Request-Id": requestId },
    });
  }
  if (result?.redirect) {
    return new Response("", {
      status: 302,
      headers: { Location: result.redirect, "X-Request-Id": requestId },
    });
  }
  const status = result?.statusCode ?? 200;
  // 204/205/304 are null-body statuses; the Response constructor throws if given
  // a body. The body is irrelevant for these anyway.
  const nullBody = status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : JSON.stringify(result?.body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": requestId },
  });
}

function errorToResponse(err: unknown, requestId: string): Response {
  const r = errorResponse(err, requestId);
  return new Response(r.body, { status: r.statusCode, headers: r.headers });
}

export function createHonoRouterAdapter(app: Hono, deps: Deps) {
  function register(method: Method, pattern: string, optionsOrHandler: RouteOptions | LegacyHandler, handlerMaybe?: LegacyHandler) {
    const [options, handler]: [RouteOptions, LegacyHandler] =
      typeof optionsOrHandler === "function" ? [{}, optionsOrHandler] : [optionsOrHandler, handlerMaybe as LegacyHandler];
    const auth = options.auth ?? "bearer";
    const fn = async (c: Context) => {
      const requestId = resolveRequestId(Object.fromEntries(c.req.raw.headers));
      try {
        let repository: unknown;
        if (auth === "marketplace-admin") {
          if (
            !sharedSecretMatches(
              c.req.header("x-webhook-secret"),
              process.env.MARKETPLACE_ADMIN_SECRET,
            )
          ) {
            throw new ApiError(401, "unauthorized", "marketplace admin secret required");
          }
          if (!deps.createSystemRepository) {
            throw new ApiError(503, "unavailable", "marketplace admin repository not configured");
          }
          repository = await deps.createSystemRepository();
        } else if (auth === "cron-tick") {
          // The heartbeat that drives scheduled tasks. Not a person and not an
          // app: a compose sidecar in each current container deployment; the
          // legacy adapter also accepts the retired Alibaba FC timer shape,
          // both presenting APP_CRON_SECRET. `sharedSecretMatches` fails closed
          // on an unset secret, so a deployment that never configured one has
          // no scheduler rather than an open one.
          // Two ways in, because the two heartbeats cannot both use a header.
          //
          // The compose sidecar curls it and sends `Authorization: Bearer`.
          // The legacy Alibaba FC timer shape drove a web function by POSTing to a
          // path from its payload, and that payload carries only `path`,
          // `method` and `body` — there is no way to attach a header. So the
          // secret may also arrive in the body, which (unlike a query string)
          // stays out of URLs and access logs.
          // Read the header directly rather than through `extractBearerToken`:
          // that helper THROWS a 401 when the header is absent, which is right
          // for a route where a bearer is the only way in — and fatal here,
          // because the timer's request has no header and must still get as far
          // as the body.
          const auth = c.req.header("authorization") ?? "";
          const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
          let fromBody: string | undefined;
          if (!bearer) {
            try {
              const parsed = JSON.parse(await c.req.raw.clone().text() || "{}");
              if (parsed && typeof parsed.secret === "string") fromBody = parsed.secret;
            } catch {
              // Not JSON, or no body. Falls through to the 401 below.
            }
          }
          if (!sharedSecretMatches(bearer || fromBody, process.env.APP_CRON_SECRET)) {
            throw new ApiError(401, "unauthorized", "app cron secret required");
          }
          // No repository. The tick works on a raw service-role client, not on
          // the business repository, and building one here meant two clients per
          // minute plus a 503 guard on a dependency the handler never touched —
          // which passed on a deployment that had `createSystemRepository` wired
          // but no service-role key, then failed further in with an unrelated
          // error.
          repository = undefined;
        } else if (auth === "app-token") {
          // The deployed app itself, not a person. It presents the per-app
          // token that finalizeDeploy sealed into app_secrets and wrote into
          // its function env, and the ROUTE verifies it - this only hands over
          // a service-role repository so the route has something that can read
          // app_secrets at all. Nothing is authorized here, and the route must
          // not assume otherwise.
          if (!deps.createSystemRepository) {
            throw new ApiError(503, "unavailable", "app token repository not configured");
          }
          repository = await deps.createSystemRepository();
        } else if (auth !== "none") {
          const token = extractBearerToken(Object.fromEntries(c.req.raw.headers));
          // createRepository may be async (postgres factory verifies the JWT and
          // resolves userId before constructing the repo). Awaiting a sync return
          // (supabase factory) is harmless. A thrown verifyAccessToken (bad/expired
          // token) propagates to the catch below and is mapped to 401 by errorResponse.
          repository = await deps.createRepository({ accessToken: token });
        } else {
          repository = deps.createAuthRepository();
        }
        const ctx = await buildCtxFromHono(c, repository, options);
        const result = await handler(ctx);
        return toResponse(c, result, requestId);
      } catch (err) {
        return errorToResponse(err, requestId);
      }
    };
    const verb = method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    app[verb](pattern, fn);
  }

  return {
    get: (p: string, o: RouteOptions | LegacyHandler, h?: LegacyHandler) => register("GET", p, o, h),
    post: (p: string, o: RouteOptions | LegacyHandler, h?: LegacyHandler) => register("POST", p, o, h),
    put: (p: string, o: RouteOptions | LegacyHandler, h?: LegacyHandler) => register("PUT", p, o, h),
    patch: (p: string, o: RouteOptions | LegacyHandler, h?: LegacyHandler) => register("PATCH", p, o, h),
    delete: (p: string, o: RouteOptions | LegacyHandler, h?: LegacyHandler) => register("DELETE", p, o, h),
    postRaw: (p: string, o: RouteOptions | LegacyHandler, h?: LegacyHandler) =>
      typeof o === "function"
        ? register("POST", p, { rawBody: true }, o)
        : register("POST", p, { ...o, rawBody: true }, h),
  };
}
