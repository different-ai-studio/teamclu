import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
export { resolveBackendKind } from "./lib/backend-kind.js";
import { resolveBackendKind } from "./lib/backend-kind.js";
import { runCronTask } from "./lib/cron.js";
import {
  createSupabaseAuthRepository,
  createSupabaseBusinessRepository,
  publishableKeyFromEnv,
} from "./lib/supabase-repo.js";
import { getDb } from "./db/client.js";
import { createPgBusinessRepository } from "./lib/pg-repo/index.js";
import { createPgAuthRepository } from "./lib/pg-repo/auth.js";
import { queryParams } from "./lib/routing-utils.js";
import { dispatchPush } from "./lib/push-dispatch.js";
import { pushDeps, pgPushDeps } from "./lib/admin-handlers.js";
import { verifyAccessToken } from "./auth/verify.js";
import { ApiError } from "./lib/http-utils.js";
import { getFcClient, makeFcOps, resolveFcEndpoint } from "./lib/provisioning/fc-client.js";
import { startDeploy as startDeployImpl, finalizeDeploy as finalizeDeployImpl } from "./lib/provisioning/app-deploy.js";
import { readAppsAdminUrl } from "./lib/provisioning/app-postgres.js";
import { makeAppDataOps, type AppDataOps } from "./lib/provisioning/app-data-db.js";
import { makeTeardownAppDeps, type TeardownAppDeps } from "./lib/provisioning/app-delete.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { resolveAppsOss, getAppsS3Client } from "./lib/provisioning/apps-oss.js";
import { readGiteaConfig, makeGiteaClient } from "./lib/provisioning/gitea.js";
import { readGotrueOAuthConfig, makeGotrueOAuthClient } from "./lib/provisioning/gotrue-oauth.js";
import { makeVanityLookup } from "./lib/apps-vanity.js";
import { createServiceRoleClient } from "./lib/supabase.js";
import type { JWTVerifyGetKey } from "jose";

// ---------------------------------------------------------------------------
// Environment (used only for /v1 business API). Read lazily inside the deps
// closures so importing this module never requires env at load time.
// ---------------------------------------------------------------------------
const SUPABASE_URL_FN = () =>
  process.env.FC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL || "";
// Public, browser-reachable GoTrue base used for OAuth `authorize` redirects.
// SUPABASE_URL is typically an internal/VPC address the browser can't reach.
const SUPABASE_PUBLIC_URL_FN = () =>
  process.env.SUPABASE_PUBLIC_URL || process.env.SUPABASE_URL || "";
const SUPABASE_PUBLISHABLE_KEY = () => publishableKeyFromEnv(process.env);

// Build a body-like object from a GET event's query string (used by the only
// GET endpoint on the legacy /sync/* API, /sync/versions). Delegates to
// queryParams() so it reads event.queryStringParameters / event.queryParameters
// — the fields the FC HTTP trigger actually populates — with rawQueryString /
// rawPath fallbacks. Reading rawQueryString alone drops teamId & path and 400s
// the request ("teamId is required").
//
// Retained as an exported pure helper because sync-versions-query.test.ts pins
// its query-parsing contract. The /sync GET path itself is now handled inside
// createApp (which mirrors this same parsing).
export function syncGetQueryToBody(event: any) {
  const body: Record<string, string> = {};
  for (const [k, v] of queryParams(event)) body[k] = v;
  return body;
}

// Deploy provisioning deps (FC function + optionally a Postgres schema).
// Returns a bare `deployUnavailableReason` when FC is unconfigured so
// deployApp/finalizeDeploy surface a 503 that NAMES the missing variable rather
// than crashing at import — or, as before, answering with an opaque
// "deploy provisioning not configured" that costs an SSH session to decode.
//
// Two things must be configured, and they are not the same thing:
//   * the artifact profile (apps-oss.ts) — which OSS bucket and credentials the
//     code zip is staged under. NOT automatically the deployment's default S3
//     config, which on self-host is a box-local MinIO that FC cannot read.
//   * APPS_FC_ENDPOINT / ALIYUN_ACCOUNT_ID / ROLE_ARN — without one of them
//     every FC call fails deep inside the SDK.
//
// The apps database is a SEPARATE, softer requirement — only `data_app` needs
// it. Static apps deploy fine without APPS_DB_ADMIN_URL; asking for one is what
// raises the error, not merely having the module loaded.
function makeDeployDeps() {
  const resolved = resolveAppsOss();
  if (resolved.error) return { deployUnavailableReason: resolved.error };
  const profile = resolved.profile;
  // Same resolution the client uses, so "configured" here and "usable" there
  // cannot drift — including the ROLE_ARN fallback.
  if (!resolveFcEndpoint()) {
    return {
      deployUnavailableReason:
        "FC endpoint is not configured: set APPS_FC_ENDPOINT, ALIYUN_ACCOUNT_ID, or a ROLE_ARN to derive it from",
    };
  }
  const bucket = profile.bucket;
  const fcOps = makeFcOps(getFcClient(profile), {
    bucket,
    role: process.env.ROLE_ARN,
    // Region of the function, which is also where its Node layer must come
    // from — a layer ARN is region-scoped.
    region: profile.region,
  });
  const appsAdminUrl = process.env.APPS_DB_ADMIN_URL?.trim() || undefined;
  const s3 = getAppsS3Client(profile);
  // 30 min: the daemon runs `pnpm install && pnpm build` between minting this
  // URL and using it, and a cold install on a modest laptop outlasts 15.
  const mintUploadUrl = (ossObjectName: string) =>
    getSignedUrl(s3 as any, new PutObjectCommand({ Bucket: bucket, Key: ossObjectName }), { expiresIn: 1800 });
  return {
    // The caller's `region` is ignored: `fc_region` must record where the
    // function actually went, which is the apps region, not the deployment's
    // default REGION.
    startDeploy: (a: { appId: string; region: string }) =>
      startDeployImpl({ mintUploadUrl }, { ...a, region: profile.region }),
    finalizeDeploy: (a: {
      appId: string;
      slug: string;
      orgId?: string | null;
      appType: string;
      fcFunctionName: string;
      ossObjectName: string;
      platformOAuthEnv?: Record<string, string>;
    }) => finalizeDeployImpl({ appsAdminUrl, fcOps }, a),
  };
}

/**
 * Deps for reclaiming an app's cloud resources on delete.
 *
 * Returned under a `teardownDeps` key, NOT spread flat: both repo factories
 * destructure `teardownDeps` and pass it on as a unit. Returning the bare
 * `{ fcOps, deleteOssObject }` made the spread land those two at the top
 * level, where nothing reads them — so `teardownDeps` was `undefined` on every
 * real request and deleting an app left its FC function, HTTP trigger and OSS
 * artifact in place. The site stayed reachable while the dialog said it had
 * been taken down.
 */
/**
 * Deps for browsing an app's own Postgres from the control panel.
 *
 * Separate from makeDeployDeps even though both need APPS_DB_ADMIN_URL: deploy
 * is unavailable without OSS *and* FC, while browsing needs neither. Folding
 * this into that function would make a missing FC endpoint hide the data
 * browser too.
 */
function makeAppDataDeps(): { appData?: AppDataOps; appDataUnavailableReason?: string } {
  const adminUrl = readAppsAdminUrl();
  if (!adminUrl) return { appDataUnavailableReason: "APPS_DB_ADMIN_URL is not set" };
  return { appData: makeAppDataOps(adminUrl) };
}

function makeTeardownDeps(): { teardownDeps?: TeardownAppDeps } {
  const resolved = resolveAppsOss();
  if (resolved.error) return {};
  const profile = resolved.profile;
  if (!resolveFcEndpoint()) return {};
  const fcOps = makeFcOps(getFcClient(profile), {
    bucket: profile.bucket,
    role: process.env.ROLE_ARN,
    region: profile.region,
  });
  const s3 = getAppsS3Client(profile);
  return { teardownDeps: makeTeardownAppDeps({ bucket: profile.bucket, s3, fcOps }) };
}

// Gitea repo provisioning deps. Returns `giteaUnavailableReason` when any of
// GITEA_URL / GITEA_TOKEN / GITEA_OWNER is empty so createApp surfaces a 503
// that names the missing variable rather than half-provisioning a row.
function makeGiteaDeps() {
  const resolved = readGiteaConfig();
  if (resolved.error) return { giteaUnavailableReason: resolved.error };
  return { gitea: makeGiteaClient(resolved.config) };
}

function makeGotrueOAuthDeps() {
  const resolved = readGotrueOAuthConfig();
  if (resolved.error) return { gotrueUnavailableReason: resolved.error };
  return { gotrue: makeGotrueOAuthClient(resolved.config) };
}

export { makeGiteaDeps };

/**
 * Vanity-host lookup, wired for whichever backend this deployment runs.
 *
 * Exported so the container entry (server.ts) and the FC handler below share
 * ONE wiring. They are two separate `createApp()` calls, and the first version
 * of this feature configured only the handler — so the self-host container,
 * the only deployment that actually serves vanity hosts, registered neither
 * the proxy nor the `ask` endpoint and answered a plain 404.
 */
export function vanityLookup() {
  return makeVanityLookup({
    backendKind: () => resolveBackendKind(),
    getDb,
    getServiceRoleClient: createServiceRoleClient,
  });
}

export function makeAuthRepoFactory(kind: "supabase" | "postgres") {
  if (kind === "postgres") {
    return () => createPgAuthRepository();
  }
  return () =>
    createSupabaseAuthRepository({
      supabaseUrl: SUPABASE_URL_FN(),
      supabasePublicUrl: SUPABASE_PUBLIC_URL_FN(),
      publishableKey: SUPABASE_PUBLISHABLE_KEY(),
      // Phone login (partner-aligned). Enabled only when all four are set.
      // PHONE_EMAIL_DOMAIN is part of the account identity — it must match the
      // partner SaaS sharing this GoTrue (see supabase-repo/phone-auth.ts).
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
      defaultOrgId: process.env.DEFAULT_ORG_ID || undefined,
      phoneEmailDomain: process.env.PHONE_EMAIL_DOMAIN || undefined,
      phoneAuthEncryptionKey: process.env.PHONE_AUTH_ENCRYPTION_KEY || undefined,
      smsDebugMode: process.env.SMS_DEBUG_MODE === "1" || process.env.SMS_DEBUG_MODE === "true",
    });
}

export function makeBusinessRepoFactory(
  kind: "supabase" | "postgres",
  // Tests may inject a local JWKS + issuer/audience baseURL so verifyAccessToken
  // can validate tokens signed by an in-memory key. Production omits this and
  // uses the remote JWKS at AUTH_BASE_URL.
  verifyOpts?: { keyset?: JWTVerifyGetKey; baseURL?: string },
) {
  if (kind === "postgres") {
    // ROOT-CAUSE FIX: verify the bearer JWT and resolve the authenticated
    // user id (claims.sub) BEFORE constructing the repo, so every authz check
    // gated on ctx.userId actually has an identity. A bad/expired token makes
    // verifyAccessToken reject; the hono adapter's try/catch maps it to 401.
    return async ({ accessToken }: { accessToken: string }) => {
      let claims;
      try {
        claims = await verifyAccessToken(accessToken, verifyOpts ?? {});
      } catch (cause) {
        // Bad / expired / unverifiable token → fail closed as 401 (not an opaque
        // 500). errorResponse passes ApiError through verbatim.
        throw new ApiError(401, "invalid_token", "Invalid or expired access token", { cause });
      }
      return createPgBusinessRepository({
        db: getDb(),
        userId: claims.sub,
        accessToken,
        // Lazy push hook: pgPushDeps() is constructed on first call and reused.
        // push_idempotency_claim and list_session_push_targets are now served
        // by Drizzle queries via buildPgPushDeps() — no Supabase service-role.
        dispatchPush: async (record) => { await dispatchPush(record, pgPushDeps()); },
        ...makeDeployDeps(),
        ...makeTeardownDeps(),
      ...makeAppDataDeps(),
        ...makeAppDataDeps(),
        ...makeGiteaDeps(),
        ...makeGotrueOAuthDeps(),
        publishReadEvent: async ({ userId, sessionId }) => {
          const { mqtt } = pgPushDeps();
          if (!mqtt) return;
          const payload = JSON.stringify({ type: "read", session_id: sessionId, ts: Date.now() });
          await mqtt.publish(`inbox/${userId}`, payload);
        },
      });
    };
  }
  return ({ accessToken }: { accessToken: string }) =>
    createSupabaseBusinessRepository({
      supabaseUrl: SUPABASE_URL_FN(),
      supabasePublicUrl: SUPABASE_PUBLIC_URL_FN(),
      publishableKey: SUPABASE_PUBLISHABLE_KEY(),
      accessToken,
      ...makeDeployDeps(),
      ...makeTeardownDeps(),
      ...makeAppDataDeps(),
      ...makeGiteaDeps(),
      ...makeGotrueOAuthDeps(),
    });
}

/** System/admin repository — no user JWT (marketplace admin shared-secret routes). */
export function makeSystemRepoFactory(kind: "supabase" | "postgres") {
  if (kind === "postgres") {
    return () =>
      createPgBusinessRepository({
        db: getDb(),
        // Admin marketplace methods do not call requireUser().
        userId: undefined,
        ...makeDeployDeps(),
      });
  }
  return () => {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (!serviceKey) {
      throw new ApiError(
        503,
        "unavailable",
        "SUPABASE_SERVICE_ROLE_KEY is required for marketplace admin",
      );
    }
    return createSupabaseBusinessRepository({
      supabaseUrl: SUPABASE_URL_FN(),
      supabasePublicUrl: SUPABASE_PUBLIC_URL_FN(),
      // Service-role key as both the client key and bearer — bypasses RLS for
      // catalog writes. Admin endpoints never call getUser().
      publishableKey: serviceKey,
      accessToken: serviceKey,
      ...makeDeployDeps(),
      ...makeGiteaDeps(),
      ...makeGotrueOAuthDeps(),
    });
  };
}

// The single Hono app owns ALL routing (OPTIONS, /v1, /sync, admin, 404, 500,
// rate-limiting). The repository deps build lazily per-request.
const app = createApp({
  createRepository: makeBusinessRepoFactory(resolveBackendKind()),
  createAuthRepository: makeAuthRepoFactory(resolveBackendKind()),
  createSystemRepository: makeSystemRepoFactory(resolveBackendKind()),
  runCron: (task: string) => runCronTask(getDb(), task),
  lookupVanityApp: vanityLookup(),
});

const honoHandler = handle(app);

// FC 3.0 HTTP trigger may populate queryParameters (or queryStringParameters)
// but leave rawQueryString empty/absent. hono/aws-lambda's v2 processor (used
// when event.rawPath exists) reads ONLY rawQueryString for the query string —
// it does NOT fall back to structured params. Backfill rawQueryString via
// queryParams() so GET query params (e.g. /v1/sync/actor-directory?teamId=…)
// are not silently dropped.
export function normalizeFcEvent(event: any): any {
  if (!event.rawQueryString || event.rawQueryString === "") {
    const s = queryParams(event).toString();
    if (s) event.rawQueryString = s;
  }
  return event;
}

// ---------------------------------------------------------------------------
// Timer-event detection
//
// Aliyun FC timer events carry triggerName / triggerTime and a custom payload
// string, but do NOT have rawPath / requestContext (those are HTTP-only).
// We use the absence of rawPath + requestContext as the definitive signal.
// ---------------------------------------------------------------------------
function isTimerEvent(event: any): boolean {
  if (event == null || typeof event !== "object") return false;
  // HTTP events always have rawPath (FC 3.0) or requestContext (FC 2.0/3.0).
  if (event.rawPath != null || event.requestContext != null) return false;
  // Timer events have either triggerName or triggerTime, plus a payload field.
  return (event.triggerName != null || event.triggerTime != null) && event.payload != null;
}

export async function handler(event: any, context: any) {
  // FC 3.0 HTTP trigger passes a Buffer; FC 2.0 may pass a JSON string.
  if (Buffer.isBuffer(event)) {
    event = JSON.parse(event.toString());
  } else if (typeof event === "string") {
    event = JSON.parse(event);
  }

  // Route timer events to cron handlers before the Hono app sees them.
  if (isTimerEvent(event)) {
    let payload: { task?: string };
    try {
      payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
    } catch {
      return { error: "invalid_payload", message: "Timer payload is not valid JSON" };
    }
    if (!payload.task) {
      return { error: "missing_task", message: "Timer payload must include a task field" };
    }
    return runCronTask(getDb(), payload.task);
  }

  normalizeFcEvent(event);
  return honoHandler(event, context);
}
