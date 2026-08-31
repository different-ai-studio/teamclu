import { sharedSecretMatches } from "./lib/shared-secret.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getAuth } from "./auth/better-auth.js";
import { registerAllRoutes } from "./lib/routes/index.js";
import { createHonoRouterAdapter } from "./lib/hono-adapter.js";
import { isRateLimited, resolveClientIp } from "./lib/rate-limit.js";
import { handleSyncRequest } from "./lib/legacy-sync.js";
import { resolveBackendKind } from "./lib/backend-kind.js";
import * as admin from "./lib/admin-handlers.js";
import { isServable, proxyToApp, type LookupVanityApp } from "./lib/apps-vanity.js";
import { parseAppPublicHost } from "./lib/apps-public-host.js";

export type AppDeps = {
  createRepository: (args: { accessToken: string }) => unknown;
  createAuthRepository: () => unknown;
  createSystemRepository?: () => unknown | Promise<unknown>;
  runCron?: (task: string) => Promise<unknown>;
  /** Resolves a vanity app host to its row; injected so tests need no database. */
  lookupVanityApp?: LookupVanityApp;
};

function sendLegacy(_c: any, r: { statusCode: number; headers?: Record<string, string>; body: string }) {
  return new Response(r.body, {
    status: r.statusCode,
    headers: { "Content-Type": "application/json", ...(r.headers || {}) },
  });
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // --- Deployed apps on their own hostnames -------------------------------
  //
  // Registered FIRST, ahead of CORS and the rate limiter, because these
  // requests are not Cloud API traffic at all: the response belongs to the
  // user's app, and adding our CORS headers or counting a page load against an
  // API budget would both be wrong.
  //
  // Caddy sends every `*.<APPS_PUBLIC_DOMAIN>` request here (it cannot know an
  // app's Function Compute URL — the trigger hostname carries a random suffix),
  // and asks this same service whether a hostname deserves a certificate.
  if (deps.lookupVanityApp) {
    const lookup = deps.lookupVanityApp;

    // Caddy's on-demand TLS gate. Answer 200 only for a hostname that really
    // maps to an app; anything else must 404 so Caddy declines the handshake
    // instead of requesting a certificate for it.
    app.get("/internal/caddy/ask", async (c) => {
      const domain = c.req.query("domain") ?? "";
      if (!parseAppPublicHost(domain)) return c.text("not an app host", 404);
      const found = await lookup(domain);
      return found ? c.text("ok", 200) : c.text("no such app", 404);
    });

    app.use("*", async (c, next) => {
      const host = c.req.header("host");
      if (!parseAppPublicHost(host)) return next();
      const target = await lookup(host!);
      // A hostname whose app exists but has never deployed is a real app with
      // nothing to serve yet — say so, rather than proxying to null.
      if (!isServable(target)) {
        return c.text(target ? "app is not deployed yet" : "no such app", 404);
      }
      return proxyToApp(c.req.raw, target.fcEndpoint);
    });
  }

  // CORS — two modes depending on deployment:
  //
  // FC with custom domain (CORS_HANDLED_BY_PROXY=true): the FC gateway layer
  // injects CORS headers on every response. Hono must stay silent to avoid
  // duplicate Access-Control-Allow-Origin. We still return 204 for OPTIONS
  // so the gateway can attach its CORS headers to the preflight response.
  //
  // Docker self-host + direct FC (CORS_HANDLED_BY_PROXY unset): Hono owns
  // CORS entirely via middleware. Caddy is a transparent proxy that does NOT
  // add CORS headers (see deploy/self-host/caddy/Caddyfile).
  if (process.env.CORS_HANDLED_BY_PROXY) {
    app.options("*", (c) => c.body(null, 204));
  } else {
    app.use("*", cors({
      origin: (origin) => {
        const extra = process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean) ?? [];
        // Allow tauri schemes (production: https://tauri.localhost, dev: tauri://localhost),
        // localhost variants, and any explicitly listed origin.
        if (
          !origin ||
          origin.startsWith("tauri://") ||
          origin.startsWith("https://tauri.localhost") ||
          origin.startsWith("http://localhost") ||
          origin.startsWith("http://127.0.0.1") ||
          extra.includes(origin)
        ) return origin ?? "*";
        return origin;
      },
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "X-Request-Id", "Idempotency-Key", "X-Webhook-Secret"],
      maxAge: 86400,
    }));
  }

  // Container liveness/readiness probe — no DB access.
  app.get("/healthz", (c) => c.json({ ok: true }));

  // Better-Auth HTTP surface (JWKS, OAuth callbacks, session API). Required for
  // BACKEND_KIND=postgres: verifyAccessToken reads JWKS in-process, but OAuth
  // and external callers still need these routes on /api/auth/*.
  if (resolveBackendKind() === "postgres") {
    app.on(["POST", "GET"], "/api/auth/*", (c) => getAuth().handler(c.req.raw));
  }

  // HTTP-triggered cron (replaces FC timer for the Docker/self-host path).
  // Guarded by a shared secret; an external scheduler POSTs { task }.
  app.post("/internal/cron", async (c) => {
    if (!sharedSecretMatches(c.req.header("x-cron-secret"), process.env.CRON_TRIGGER_SECRET)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!deps.runCron) {
      return c.json({ error: "cron_unavailable" }, 503);
    }
    const t = await c.req.text();
    let body: any = {};
    if (t) { try { body = JSON.parse(t); } catch { return c.json({ error: "Invalid JSON body" }, 400); } }
    if (!body.task || typeof body.task !== "string") {
      return c.json({ error: "missing_task" }, 400);
    }
    try {
      const result = await deps.runCron(body.task);
      return c.json(result as any);
    } catch (err: any) {
      if (String(err?.message).startsWith("Unknown cron task")) {
        return c.json({ error: "unknown_task" }, 400);
      }
      throw err;
    }
  });

  // /v1 business routes — registered through the adapter so routes/*.ts are unchanged.
  const v1Router = createHonoRouterAdapter(app, deps);
  registerAllRoutes(v1Router as any);

  // Rate limit everything that is NOT /v1 (mirrors old index.ts). /sync/* is
  // exempt: it is the JWT-authenticated OSS-sync data plane, and one sync tick
  // issues several requests (manifest pages + batch endpoints) — team members
  // behind a shared NAT would exhaust a per-IP budget and starve each other.
  // The limiter exists to shield the unauthenticated admin endpoints
  // (/register, /token, …), which stay covered.
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (
      !(url.pathname.startsWith("/v1/") ||
        url.pathname === "/v1" ||
        url.pathname.startsWith("/sync/") ||
        url.pathname.startsWith("/api/auth/"))
    ) {
      const { ip, source } = resolveClientIp((n) => c.req.header(n));
      // The FC gateway forwards NO client-IP header at all (verified on the
      // deployed function: only accept/host/user-agent/x-forwarded-proto
      // arrive), so every real client lands in the fallback. Key it per path —
      // not one global bucket — and give it a wider budget: it is shared by
      // ALL users of that endpoint, and 10/min global was tight enough to
      // starve legitimate onboarding bursts. 60/min still stops naive
      // brute-force loops.
      const key = ip ?? `unknown:${url.pathname}`;
      const max = ip ? 10 : 60;
      if (isRateLimited(key, max)) {
        const extra = ip === null
          ? ` headers=${[...c.req.raw.headers.keys()].join(",")}`
          : "";
        console.log(`[rate-limit] 429 key=${key} source=${source} path=${url.pathname}${extra}`);
        return c.json({ error: "Too many requests" }, 429);
      }
    }
    await next();
  });

  // Legacy /sync/* (set-mode, team-mode, manifest, upload/*, download, delete, versions)
  // Mounted under /v1/sync/* so a gateway that basicauth-gates the bare
  // /sync* prefix (Shopee test) can't block JWT-authed sync ticks. The /v1
  // mount is stripped before dispatch so the spec names (/sync/manifest, …)
  // stay the switch keys — handler and log tests need no path changes.
  app.all("/v1/sync/*", async (c) => {
    const url = new URL(c.req.url);
    const headers = Object.fromEntries(c.req.raw.headers);
    let body: any = {};
    if (c.req.method === "GET") {
      // The only GET endpoint (/sync/versions) carries its params in the query
      // string; mirror the old syncGetQueryToBody() so teamId/path survive.
      url.searchParams.forEach((v, k) => { body[k] = v; });
    } else {
      const t = await c.req.text();
      body = t ? JSON.parse(t) : {};
    }
    const r = await handleSyncRequest({ path: url.pathname.replace(/^\/v1\/sync/, "/sync"), httpMethod: c.req.method, headers, body });
    return sendLegacy(c, r);
  });

  // Admin/provisioning endpoints (all POST). Each parses JSON body then calls the handler.
  const adminRoutes: Array<[string, (body: any) => Promise<any>]> = [
    ["/reset-secret", (b) => admin.handleResetSecret(b)],
  ];
  for (const [path, fn] of adminRoutes) {
    app.post(path, async (c) => {
      const t = await c.req.text();
      let body: any = {};
      if (t) { try { body = JSON.parse(t); } catch { return c.json({ error: "Invalid JSON body" }, 400); } }
      return sendLegacy(c, await fn(body));
    });
  }
  app.post("/push/dispatch", async (c) => {
    const headers = Object.fromEntries(c.req.raw.headers);
    const t = await c.req.text();
    let body: any = {};
    if (t) { try { body = JSON.parse(t); } catch { return c.json({ error: "Invalid JSON body" }, 400); } }
    return sendLegacy(c, await admin.handlePushDispatch(headers, body));
  });

  // Unknown route -> 404 in the existing error envelope.
  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "Route not found", requestId: c.req.header("x-request-id") ?? "" } }, 404),
  );

  app.onError((err, c) => {
    console.error("[fc] unhandled:", (err as any)?.message, (err as any)?.name);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
