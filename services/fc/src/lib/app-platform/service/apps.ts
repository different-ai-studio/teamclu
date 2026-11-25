/**
 * The app platform's business operations: create, read, update and delete
 * apps; who may do what to them; deploy, environment, cron, storage, logs and
 * data.
 *
 * P2.4a of docs/specs/2026-11-25-app-platform-p2-de-team.md moved these out of
 * supabase-repo.ts unchanged; `makeAppsRepo` is spread into the business
 * repository, so `this` is still the whole repository. P2.4b takes the TeamClu
 * parts (teams, actors, workspaces, sessions) out behind AppTenantHooks.
 */
import {
  type AppAccessGrantee,
  appAccessRecipientUserId,
  publishAppAccessChanged,
} from "../../app-access-notify.js";
import {
  JOB_COLUMNS as CRON_JOB_COLUMNS,
  executeAppCronJob,
} from "../../app-cron-runner.js";
import {
  assertTimeZone,
  computeNextRun,
  parseCronExpression,
} from "../../app-cron-schedule.js";
import {
  MAX_ENV_VARS_PER_APP,
  parseEnvKey,
  parseEnvValue,
} from "../../app-env.js";
import {
  assertLifecycleAvailable,
  lifecycleRpc,
  operationView,
} from "../../app-lifecycle.js";
import {
  type AppPermissionLevel,
  appLevelAtLeast,
  callAgentInheritance,
  callCallerAppAccess,
  higherAppLevel,
  parseAppPermissionLevel,
  storedAppPermissionLevel,
} from "../../app-permission.js";
import {
  appsRegion,
} from "../../app-platform/region.js";
import {
  type AppAuthInfo,
  buildAppAuthInfo,
} from "../../apps-auth-info.js";
import {
  type AuthScope,
  parseAuthRules,
  parseAuthScope,
  validateAuthPathConfig,
} from "../../apps-auth-paths.js";
import {
  customDomainRecords,
  makeDomainToken,
  normalizeCustomDomain,
  verificationTxtName,
  verifyDomainOwnership,
} from "../../apps-custom-domain.js";
import {
  resolveAppFunctionName,
} from "../../apps-function-identity.js";
import {
  appDeploymentOriginHost,
} from "../../apps-origin-auth.js";
import {
  invalidateAppHosts,
} from "../../apps-vanity.js";
import {
  ApiError,
} from "../../http-utils.js";
import {
  type AuthMode,
  applyAuthModeChange,
  buildPlatformAuthEnv,
  parseAuthAudience,
  parseAuthMode,
} from "../../provisioning/app-auth-mode.js";
import {
  type AppDataTarget,
  type FilterOp,
  decodeRowKey,
  describeDbError,
  parsePageLimit,
} from "../../provisioning/app-data-db.js";
import {
  type TeardownAppDeps,
  teardownAppResources,
} from "../../provisioning/app-delete.js";
import {
  isAppDeployPreflightExpired,
  preflightAppDeploy as checkAppDeployPreflight,
  verifyAppDeployPreflight,
} from "../../provisioning/app-deploy-preflight.js";
import {
  reclaimStaleDeploy,
  supabaseReclaimStore,
} from "../../provisioning/app-deploy-reclaim.js";
import {
  appOssObjectName,
  assertDeployAllowed,
  buildAppStorageEnv,
  checkDeployInProgress,
  deployUnavailable,
  needsDatabase,
  parseAppDeployDeclaration,
  parseArtifactVerification,
  parseDeployToken,
  parseDeployedImage,
  parseOptionalGitCommitSha,
  readAppsCloudApiUrl,
} from "../../provisioning/app-deploy.js";
import {
  isLegalFcTransition,
} from "../../provisioning/app-fc-status.js";
import {
  appFileKey,
  appFilesPrefix,
  normalizeAppFolderPrefix,
} from "../../provisioning/app-files.js";
import {
  type AppLogKind,
} from "../../provisioning/app-logs.js";
import {
  parseAppMigrations,
} from "../../provisioning/app-migrations.js";
import {
  type AppLanguage,
} from "../../provisioning/app-runtime-catalog.js";
import {
  driftFields,
  projectFunction,
  projectOriginSecurity,
  providerErrorCode,
} from "../../provisioning/app-runtime-info.js";
import {
  readRuntimeObservations,
} from "../../provisioning/app-runtime-observations.js";
import {
  APP_STORAGE_TOKEN_KIND,
  deleteAppSecretSupabase,
  getAppSecretSupabase,
  open as openAppSecret,
  putAppSecretSupabase,
  seal as sealAppSecret,
} from "../../provisioning/app-secrets.js";
import {
  type AppStorageOps,
  isOverQuota,
} from "../../provisioning/app-storage.js";
import {
  encodeCursor,
} from "../../routing-utils.js";
import {
  APP_COLUMNS,
  appFunctionTargetFromRow,
  appIso,
  appRelationshipFor,
  chunkedIn,
  slugify,
} from "../../supabase-repo/shared.js";
import {
  clientProvisionError,
  isLegalStatusTransition,
} from "../../validation/app-status.js";
import {
  parseAppType,
} from "../../validation/app-type.js";
import {
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

/** Allocated code rows must not enter a historical worker's UUID fallback. */
function validateAllocatedAppIdentity(row: any, forCleanup = false): void {
  const target = appFunctionTargetFromRow(row);
  resolveAppFunctionName({ ...target, fcFunctionName: row.fc_function_name, legacyFallback: "uuid" });
  // An initial deploy_error may precede allocation; cleanup cannot use that exception.
  if (target.functionNamingMode === "app_code" && !row.fc_function_name
      && ((row.fc_status && row.fc_status !== "not_deployed" && (forCleanup || row.fc_status !== "deploy_error")) || row.fc_endpoint || row.env_deployed_at || row.start_spec)) {
    throw new ApiError(409, "invalid_app_function_identity", "invalid app function identity");
  }
}

/**
 * The client-facing shape of an app's custom domain.
 *
 * The DNS records ride along on every response so a client never reconstructs
 * them — the TXT value embeds a token it would otherwise have to remember
 * across requests.
 */
function customDomainView(row: any) {
  const domain = (row.custom_domain ?? null) as string | null;
  return {
    domain,
    verified: Boolean(row.custom_domain_verified_at),
    verifiedAt: row.custom_domain_verified_at ?? null,
    dns: domain
      ? customDomainRecords({ id: row.id, slug: row.slug, appCode: row.app_code, usesAppCodeDomain: row.uses_app_code_domain, functionNamingMode: appFunctionTargetFromRow(row).functionNamingMode }, domain, row.custom_domain_token ?? "")
      : [],
  };
}

function mapAppAccessRow(r: any) {
  return {
    memberId: r.member_id,
    permissionLevel: storedAppPermissionLevel(r.permission_level) ?? r.permission_level,
    grantedByMemberId: r.granted_by_member_id ?? null,
    createdAt: appIso(r.created_at)!,
  };
}

function mapAppCronJobRow(r: any) {
  return {
    id: r.id,
    appId: r.app_id,
    name: r.name,
    enabled: Boolean(r.enabled),
    // `schedule` on the wire, `schedule_expr` in the column: the column name
    // exists to leave room for a second kind of schedule later, and the API
    // should not have to be renamed if that ever happens.
    schedule: r.schedule_expr,
    timezone: r.timezone,
    method: r.method,
    path: r.path,
    headers: r.headers ?? {},
    body: r.body ?? null,
    timeoutMs: r.timeout_ms,
    lastRunAt: appIso(r.last_run_at),
    nextRunAt: appIso(r.next_run_at),
    createdAt: appIso(r.created_at)!,
    updatedAt: appIso(r.updated_at)!,
  };
}

function mapAppEnvRow(r: any) {
  return {
    key: r.key,
    isSecret: Boolean(r.is_secret),
    // A secret's value never leaves the server, not even to the person who set
    // it. `null` here is the whole contract: the panel shows "已设置" and the
    // only way to change it is to type a new one.
    value: r.is_secret ? null : (r.value ?? ""),
    updatedAt: appIso(r.updated_at)!,
  };
}

function mapAppCronRunRow(r: any) {
  return {
    id: r.id,
    jobId: r.job_id,
    startedAt: appIso(r.started_at)!,
    finishedAt: appIso(r.finished_at),
    status: r.status,
    responseStatus: r.response_status ?? null,
    durationMs: r.duration_ms ?? null,
    error: r.error ?? null,
  };
}

/**
 * Turn a driver error into an ApiError without letting the query or the row
 * values escape.
 *
 * Postgres error objects carry `query`, `parameters`, and frequently a fragment
 * of the offending value in `detail`. Rethrowing one as-is puts the user's
 * business data into an HTTP body and, worse, into whatever logs the error.
 */
const APP_DATA_CONSTRAINT_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  "23505": { status: 409, code: "duplicate_key", message: "a row with this unique value already exists" },
  "23502": { status: 400, code: "not_null_violation", message: "a required column was left empty" },
  "23503": { status: 409, code: "foreign_key_violation", message: "the row refers to a row that does not exist, or is still referred to" },
  "23514": { status: 400, code: "check_violation", message: "a value breaks one of the table's check constraints" },
};

async function runAppData<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    const { sqlstate } = describeDbError(e);
    if (sqlstate === "57014") {
      throw new ApiError(504, "query_timeout", "the query took too long and was cancelled");
    }
    // 22P02 invalid_text_representation: the filter value cannot be coerced to
    // the column's type ("abc" against an integer column). That is the caller's
    // input being wrong, not the database failing.
    if (sqlstate === "22P02" || sqlstate === "22007") {
      throw new ApiError(400, "invalid_filter_value", "a value does not match the column's type");
    }
    // Constraint violations on a write are the row being wrong, not the
    // database failing — and the user can fix them. Named by SQLSTATE only:
    // the driver's message and detail carry the offending value.
    const constraint = APP_DATA_CONSTRAINT_ERRORS[sqlstate ?? ""];
    if (constraint) throw new ApiError(constraint.status, constraint.code, constraint.message);
    console.warn(`[apps] app data query failed (sqlstate ${sqlstate ?? "unknown"})`);
    throw new ApiError(502, "app_data_query_failed", `the app database rejected the query${sqlstate ? ` (${sqlstate})` : ""}`);
  }
}

/**
 * Bounds for a log read, applied here rather than trusted from the caller.
 *
 * The window is capped at the retention period: asking for more is not an
 * error, it is a window that is mostly empty, and clamping says so by
 * returning what exists. The row cap is what keeps one call from returning
 * more text than its caller can hold.
 */
export const APP_LOGS_MAX_MINUTES = 7 * 24 * 60;
export const APP_LOGS_MAX_ROWS = 200;

function parseLogMinutes(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, APP_LOGS_MAX_MINUTES);
}

function parseLogLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(n, APP_LOGS_MAX_ROWS);
}

function parseLogKind(raw: unknown): AppLogKind {
  return raw === "request" || raw === "all" ? raw : "app";
}

function parseLogText(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

const APP_DATA_FILTER_OPS: readonly FilterOp[] = ["eq", "contains", "isNull", "notNull"];

/** `filterColumn` + `filterOp` (+ `filterValue`), or nothing. */
function parseAppDataFilter(query: any): { column: string; op: FilterOp; value?: unknown } | null {
  const column = query?.filterColumn;
  if (typeof column !== "string" || !column) return null;
  const op = query?.filterOp;
  if (!APP_DATA_FILTER_OPS.includes(op)) {
    throw new ApiError(400, "validation_failed", `filterOp must be one of ${APP_DATA_FILTER_OPS.join(", ")}`);
  }
  return { column, op, value: query?.filterValue };
}

/**
 * Constant-time string compare for secrets that arrive over the wire.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * expected length, so lengths are folded in as a boolean instead of short
 * -circuiting: both branches do the same work and the comparison always runs
 * over equal-length buffers.
 */
function constantTimeEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(String(expected), "utf8");
  const b = Buffer.from(String(actual ?? ""), "utf8");
  const padded = Buffer.alloc(a.length);
  b.copy(padded, 0, 0, Math.min(a.length, b.length));
  return timingSafeEqual(a, padded) && a.length === b.length;
}

function assertNoUnexpectedOriginEntries(summary: { driftFields: string[] }): void {
  const fields = summary.driftFields.filter(field => field === "extraHttpTriggers" || field === "customDomainAliases");
  if (fields.length) throw new ApiError(409, "origin_security_drift", `origin security drift: ${fields.join(", ")}`);
}


export function makeAppsRepo(host: any) {
  const {
    supabase, serviceRoleClient, getCurrentUser, forge, appView,
    startDeploy, finalizeDeploy, deployUnavailableReason, gotrue, gotrueUnavailableReason,
    appData, appDataUnavailableReason, appStorage, appStorageUnavailableReason, appLogs, appLogsUnavailableReason,
    readRuntimeCatalog, readAppFunction, validateAppOrigin, readAppOriginSecurity,
    publishSessionParticipantInbox, applyKeysetCursor, appEnvSecretKind, archiveSessionsForWorkspace,
  } = host;

  /** Best-effort: a grant or revoke succeeds whether or not the hint lands. */
  function scheduleAppAccessChanged(teamId: string, appId: string, grantee: AppAccessGrantee | null | undefined) {
    if (!publishSessionParticipantInbox) return;
    const userId = appAccessRecipientUserId(grantee);
    if (!userId) return;
    void publishAppAccessChanged({
      teamId,
      appId,
      userId,
      publish: publishSessionParticipantInbox,
    }).catch((err: unknown) => {
      console.error("[app-access] notify failed (swallowed):", err);
    });
  }

  /**
   * The bytes to judge a quota against, re-measuring when the stored number is
   * too old to trust.
   *
   * The design called for a periodic sweep. This is that, minus the scheduler:
   * measurement happens at the two moments it actually decides something - a
   * signed upload and an STS mint - and at most once per staleness window per
   * app. A cron would have had to exist, be wired on both deploy targets, and
   * still leave the gap between its last run and this request; this closes the
   * gap and needs no infrastructure. When no quota is in force there is nothing
   * to decide, so nothing is measured.
   */
  const USAGE_STALE_MS = 15 * 60 * 1000;
  async function usageForQuotaDecision(app, ops, quotaBytes) {
    if (quotaBytes == null || quotaBytes <= 0) return app.storage_bytes ?? null;
    const countedAt = app.storage_counted_at ? Date.parse(app.storage_counted_at) : NaN;
    if (Number.isFinite(countedAt) && Date.now() - countedAt < USAGE_STALE_MS) {
      return app.storage_bytes ?? null;
    }
    const usage = await ops.measure(ops.bucketFor(app), appFilesPrefix(app.id));
    const admin = await serviceRoleClient("record app storage usage");
    await admin
      .from("apps")
      .update({ storage_bytes: usage.bytes, storage_counted_at: new Date().toISOString() })
      .eq("id", app.id);
    return usage.bytes;
  }

  /**
   * Mint + seal + return the storage env for one finalize.
   *
   * Returns undefined (rather than throwing) when the deployment has no apps
   * storage profile or no public Cloud API URL: file storage is optional, and a
   * deployment without it must still be able to deploy apps.
   */
  async function buildStorageEnvForFinalize(app) {
    if (!appStorage) return undefined;
    const cloudApiUrl = readAppsCloudApiUrl();
    if (!cloudApiUrl) return undefined;
    const token = randomBytes(32).toString("base64url");
    const admin = await serviceRoleClient("seal app storage token");
    await putAppSecretSupabase(admin, app.id, APP_STORAGE_TOKEN_KIND, token);
    return buildAppStorageEnv({
      appId: app.id,
      token,
      bucket: appStorage.bucketFor(app),
      prefix: appFilesPrefix(app.id),
      region: appStorage.region,
      endpoint: appStorage.endpoint,
      cloudApiUrl,
    });
  }

  /** Move the app into "env changed since the last deploy". */
  async function touchAppEnv(admin: any, appId: string, at: string): Promise<void> {
    const { error } = await admin
      .from("apps")
      .update({ env_updated_at: at, updated_at: at })
      .eq("id", appId);
    if (error) throw error;
  }

  /**
   * The operator's own variables, decrypted, for baking into the function.
   *
   * The CALLER's client, not the service role: finalize has already established
   * that this caller is `admin` on the app, and the RLS select policy admits
   * them. Escalating would make every deploy depend on a service-role key being
   * configured, which is how an app with no env vars at all would stop being
   * deployable on a deployment that never needed one.
   *
   * Reading `ciphertext` here is safe for the same reason the table's comment
   * gives: the sealing key lives in FC's environment, never in the database, so
   * the ciphertext is not the secret.
   *
   * A secret whose ciphertext will not open is SKIPPED rather than fatal. The
   * encryption key changing (or a row written under an older one) must not make
   * every deploy of the app fail; the app then runs without that variable,
   * which the operator can see and fix, instead of not running at all.
   */
  async function buildUserEnvForFinalize(appId: string): Promise<Record<string, string>> {
    const { data, error } = await supabase
      .from("app_env_vars")
      .select("key, is_secret, value, ciphertext")
      .eq("app_id", appId);
    if (error) throw error;
    const out: Record<string, string> = {};
    for (const row of data ?? []) {
      if (!row.is_secret) {
        if (typeof row.value === "string") out[row.key] = row.value;
        continue;
      }
      try {
        out[row.key] = openAppSecret(appEnvSecretKind(row.key), row.ciphertext);
      } catch (e) {
        console.warn(`[apps] skipping env secret ${row.key}: ${e}`);
      }
    }
    return out;
  }

  /** The app row the agent path authorises against, read past `apps` RLS. */
  async function readAppForAgentGitCredential(appId: string) {
    const admin = await serviceRoleClient("read app for agent git credential");
    const { data, error } = await admin
      .from("apps")
      .select("id, team_id, git_remote_url, git_auth_kind, created_by_actor_id")
      .eq("id", appId)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  }

  /**
   * The caller's `agent` actor in `teamId`, or null when the caller is not an
   * agent there. `actors_team_user_idx` allows one actor per (team, user), so
   * this is the daemon's own actor and never a human's.
   */
  async function resolveCurrentAgentActor(teamId: string): Promise<string | null> {
    const { data: userData, error: userErr } = await getCurrentUser();
    if (userErr) throw userErr;
    const userId = userData?.user?.id;
    if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
    const { data, error } = await supabase
      .from("actors")
      .select("id")
      .eq("team_id", teamId)
      .eq("user_id", userId)
      .eq("actor_type", "agent")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const id = data?.id;
    return typeof id === "string" && id.trim() ? id : null;
  }

  return {
    // --- Apps domain (production passthrough) ---
    //
    // With the caller's bearer forwarded, RLS already enforces visibility on
    // amux.apps / amux.sessions, so these methods carry no manual visibility
    // WHERE clause. mapApp exposes the canonical 12-key contract shape.

    async listApps({ teamId, limit = 100 }: { teamId: string; limit?: number }) {
      return (await this.listAppsPage({ teamId, limit })).items;
    },

    /**
     * One page of a team's apps, newest first, and where the next starts.
     *
     * The cursor is made here, from the raw row, not by the route from the
     * mapped one: `mapApp` rounds `created_at` to milliseconds, and a keyset
     * on the rounded value would skip every row created later in that same
     * millisecond. `id` breaks ties so rows sharing a timestamp are neither
     * skipped nor repeated.
     */
    async listAppsPage({ teamId, limit = 100, cursor = null }: {
      teamId: string;
      limit?: number;
      cursor?: { createdAt: string; id?: string | null } | null;
    }) {
      let query = supabase
        .from("apps")
        .select(APP_COLUMNS)
        .eq("team_id", teamId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);
      if (cursor?.createdAt) query = applyKeysetCursor(query, "created_at", cursor.createdAt, cursor.id);
      const { data, error } = await query;
      if (error) throw error;
      const rows = data ?? [];
      const viewer = await this.resolveAppViewer(teamId, rows.map((r: any) => r.id));
      const last = rows.length >= limit ? rows[rows.length - 1] : null;
      return {
        items: rows.map((r: any) => ({
          ...appView(r),
          ...appRelationshipFor(r, viewer.actorId, viewer.grants),
        })),
        nextCursor: last ? encodeCursor({ createdAt: String(last.created_at), id: last.id }) : null,
      };
    },

    async getAppAuthInfo(appId: string): Promise<AppAuthInfo> {
      const app = await this.getApp(appId);
      if (!app) throw new ApiError(404, "not_found", "app not found");
      // Caller-scoped read: the gateway uses the app tenant pointer, not a
      // currently selected team or a service-role catalog query.
      const { data: raw, error } = await supabase.from("apps")
        .select("org_id, auth_rules").eq("id", appId).maybeSingle();
      if (error) throw error;
      if (!raw) throw new ApiError(404, "not_found", "app not found");
      // The app's own org is the catalog (P2.3): seeing the app already means
      // being a member of that org (amux.caller_sees_app), which is also what
      // `roles_select_org_member` asks — so the caller's token reads it, from
      // whichever team of the org they are in. `org_id` has been NOT NULL
      // since 20260924100000; the team fallback is for rows older than that.
      const orgId = raw.org_id ?? (await this.resolveTeamOrgId(app.teamId));
      let organization: AppAuthInfo["organization"] = null;
      let roles: AppAuthInfo["roles"] = [];
      if (orgId) {
        const { data: catalog, error: catalogError } = await supabase.schema("public")
          .from("roles").select("id, code, name, status, is_system, sort")
          .eq("org_id", orgId).order("sort", { ascending: true });
        if (catalogError) throw catalogError;
        const { data: org, error: orgError } = await supabase.schema("public")
          .from("orgs").select("id, name").eq("id", orgId).maybeSingle();
        if (orgError) throw orgError;
        if (!org) throw new ApiError(503, "app_org_unavailable", "application organization metadata unavailable");
        organization = { id: orgId, name: org.name };
        // System roles first, each group still in sort order, as listOrgRoles.
        roles = (catalog ?? [])
          .filter((role: any) => role.status === "active")
          .sort((a: any, b: any) => Number(Boolean(b.is_system)) - Number(Boolean(a.is_system)))
          .map(({ id, code, name, status }: any) => ({ id, code, name, status }));
      }
      return buildAppAuthInfo({
        appId: app.id,
        teamId: app.teamId,
        organization,
        roles,
        authMode: app.authMode,
        authScope: app.authScope,
        authAudience: app.authAudience,
        authRules: raw.auth_rules ?? [],
      });
    },

    async getApp(appId: string) {
      // RLS returns nothing (PGRST116 on .single()) when the app is not
      // visible to the caller; surface that as null so the route 404s.
      const { data, error } = await supabase
        .from("apps")
        .select(APP_COLUMNS)
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const viewer = await this.resolveAppViewer(data.team_id, [data.id]);
      const permission = await this.resolveAppCallerPermissionForApp(data);
      return { ...appView(data), canManageDeployment: permission?.level === "admin", ...appRelationshipFor(data, viewer.actorId, viewer.grants),
        originSecurity: projectOriginSecurity(await readAppOriginSecurity(data)) };
    },

    /**
     * The caller's member actor in this team, and which of `appIds` they hold a
     * grant on (app id → who granted it).
     *
     * The grants are read with the service role, filtered to that actor and to
     * apps RLS already showed the caller — so nothing the caller could not see
     * leaves. The caller's own token cannot do this: `app_member_access_select`
     * matches `current_member_id()`, the user's oldest actor, which hides their
     * grants in every team after the first.
     *
     * Never fails the list. Without the grants every app still gets a
     * relationship; only a team app the caller was also invited to reads as
     * `team`, and an invited app loses the inviter's name.
     */
    async resolveAppViewer(
      teamId: string,
      appIds: string[],
    ): Promise<{ actorId: string | null; grants: Map<string, string | null> | null }> {
      const { data: userData, error: userErr } = await getCurrentUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      // Member or agent, so an agent's own apps read as its own.
      const actorId = (await this.resolveCurrentActor(teamId, userId))?.id ?? null;
      if (!actorId || appIds.length === 0) return { actorId, grants: null };
      try {
        const admin = await serviceRoleClient("read the caller's app grants");
        const rows = await chunkedIn(appIds, async (chunk) => {
          const { data, error } = await admin
            .from("app_member_access")
            .select("app_id, granted_by_member_id")
            .eq("member_id", actorId)
            .in("app_id", chunk);
          if (error) throw error;
          return data ?? [];
        });
        return {
          actorId,
          grants: new Map(rows.map((g: any) => [g.app_id, g.granted_by_member_id ?? null])),
        };
      } catch (e) {
        console.warn(`[apps] app grants unavailable for the list: ${String(e)}`);
        return { actorId, grants: null };
      }
    },

    async createApp(input: {
      teamId: string;
      name: string;
      type: string;
      visibility?: string;
      gitRemoteUrl?: string | null;
      /**
       * The code is already a git checkout on the caller's machine, so this
       * deployment provisions no repo for it.
       *
       * Distinct from "no `gitRemoteUrl`", which has always meant "mint a Gitea
       * repo": a local checkout with no `origin` supplies neither a URL nor a
       * reason to create one, and without this flag it would silently get a
       * Gitea repo it never pushes to.
       */
      localOnly?: boolean;
      /**
       * Actors (in practice: agents) to grant `write` on the new app. Agents
       * get no access by default (spec decision 6); this is the create
       * dialog's "also grant these agents" list. A grant that fails is logged
       * and skipped — it must not undo a created app.
       */
      grantActorIds?: string[];
    }) {
      // Resolve the caller's actor in this team — the RLS insert policy
      // (created_by_actor_id = amux.current_actor_id_for_team(team_id)) requires
      // it. A member or an agent: a daemon's agent creates apps for the agents
      // on its machine (`amuxd app create`), and that policy takes any actor.
      const { data: userData, error: userErr } = await getCurrentUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      const resolved = await this.resolveCurrentActor(input.teamId, userId);
      if (!resolved?.id) throw new ApiError(403, "forbidden", "not a member of this team");
      const createdByActorId = resolved.id;
      // `workspaces.created_by_member_id` references `amux.members`, which an
      // agent is not; its insert policy takes null.
      const createdByMemberId = resolved.actorType === "agent" ? null : createdByActorId;
      const slug = slugify(input.name);
      const visibility = input.visibility === "team" ? "team" : "personal";
      const importUrl = input.gitRemoteUrl?.trim() || null;
      const localOnly = input.localOnly === true;
      if (!importUrl && !localOnly) forge.assertCanHostRepo();

      // The app's tenant, settled here rather than at the first finalize.
      //
      // `apps.org_id` is a live tenant pointer (migration 20260923200000): the
      // login page narrows its account picker by it and the proxy gateway
      // resolves admission against it, so an app that reaches either of them
      // without one is simply broken — and it used to reach them that way for
      // its whole life before a successful deploy.
      //
      // `teams.oid` is nullable by design (a team is created before it has an
      // org), so this can legitimately fail. It is answered with a 409 naming
      // the cause, because the alternative once org_id is NOT NULL is a
      // constraint violation surfacing as a 500 at the moment someone is
      // trying to create an app.
      const appOrgId = await this.resolveTeamOrgId(input.teamId);
      if (!appOrgId) {
        throw new ApiError(
          409,
          "team_has_no_org",
          "该团队尚未关联组织，无法创建应用",
        );
      }

      // 1:1 workspace for the app. created_by_member_id = the resolved actor so
      // the workspace RLS insert policy is satisfied (same actor identity).
      const { data: ws, error: wsErr } = await supabase
        .from("workspaces")
        .insert({
          team_id: input.teamId,
          created_by_member_id: createdByMemberId,
          name: `app-${slug}-${Math.random().toString(36).slice(2, 8)}`,
        })
        .select("id")
        .single();
      if (wsErr) throw wsErr;

      let row: any;
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await supabase
          .from("apps")
          .insert({
            team_id: input.teamId,
            created_by_actor_id: createdByActorId,
            org_id: appOrgId,
            function_naming_mode: "app_code",
            name: input.name,
            slug,
            type: input.type,
            visibility,
            workspace_id: ws.id,
            git_remote_url: importUrl,
            // A local checkout needs no provisioning at all — the files are
            // already there. Leaving it `pending` would send the desktop down
            // the seed path, which writes the starter template over whatever the
            // user pointed us at.
            provision_status: localOnly ? "ready" : "pending",
          })
          .select(APP_COLUMNS)
          .single();
        if (!result.error) {
          row = result.data;
          break;
        }
        // Retry only the random-code collision; name/slug and other errors
        // must still reach the caller. Reuse the workspace already created.
        if (
          result.error.code !== "23505" ||
          !String(result.error.message).includes('"apps_app_code_key"') ||
          attempt === 4
        ) {
          throw result.error;
        }
      }

      for (const actorId of [...new Set(input.grantActorIds ?? [])]) {
        if (typeof actorId !== "string" || !actorId || actorId === resolved.id) continue;
        try {
          await this.setAppAccess(row.id, actorId, "write");
        } catch (e) {
          console.warn(`[apps] initial grant to ${actorId} on ${row.id} skipped: ${String((e as Error)?.message ?? e)}`);
        }
      }

      // Both import paths stop here: the app's code lives somewhere we did not
      // provision, so there is no repo of ours to create and no deploy key to
      // hold. `git_auth_kind` stays null, which is what makes deploy build the
      // workdir as it sits.
      if (importUrl || localOnly) return appView(row);

      try {
        // Ours to host: the forge creates the repo and says where it lives.
        const repo = await forge.provisionRepo(row);
        const { data: updated, error: updErr } = await supabase
          .from("apps")
          .update({
            git_remote_url: repo.remoteUrl,
            git_auth_kind: repo.authKind,
            provision_status: "repo_created",
            provision_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .select(APP_COLUMNS)
          .single();
        if (updErr) throw updErr;
        await forge.appAccessChanged(row.id);
        return appView(updated);
      } catch (e: unknown) {
        const msg = e instanceof ApiError ? e.message : String((e as Error)?.message ?? e);
        const { data: errored, error: errUpd } = await supabase
          .from("apps")
          .update({
            provision_status: "error",
            provision_error: msg,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .select(APP_COLUMNS)
          .single();
        if (errUpd) throw errUpd;
        if (e instanceof ApiError) throw e;
        throw forge.provisionFailed(msg, { app: appView(errored) });
      }
    },

    async updateApp(
      appId: string,
      patch: {
        name?: string;
        visibility?: string;
        provisionStatus?: string;
        /**
         * Why the client moved `provisionStatus` to `error` (deploy key fetch,
         * daemon seed, local folder). Stored in `provision_error`; ignored for
         * any other status.
         */
        provisionError?: string;
        fcStatus?: string;
        deployError?: string;
        deployToken?: string;
        authMode?: string;
        authAudience?: string;
        authScope?: string;
        /** Raw from the client; parsed and validated before it is stored. */
        authRules?: unknown;
        /**
         * Raw from the client. Takes effect on the next deploy — see
         * `typePendingRedeploy` in mapApp.
         */
        type?: unknown;
      },
    ) {
      // RLS apps_update_if_creator blocks non-creators: the UPDATE matches zero
      // rows and .maybeSingle() returns null → surface as null (route 404s).
      const { data: cur } = await supabase
        .from("apps")
        .select(
          "provision_status, fc_status, name, slug, app_code, uses_app_code_domain, auth_mode, auth_audience, auth_scope, auth_rules, oauth_client_id, oauth_app_id, team_id, org_id, created_by_actor_id, custom_domain, deploy_token, deploy_started_at, visibility",
        )
        .eq("id", appId)
        .maybeSingle();
      // Authorize BEFORE any side effect, not after.
      //
      // `apps_select_if_visible` lets any teammate read a team-visible app,
      // while `apps_update_if_creator` gates the write. Running the auth-mode
      // change first meant a non-creator's PATCH deleted the app's GoTrue
      // client (a hard DELETE) and its sealed secret with a service-role
      // client, and only then matched zero rows and answered 404 — the live
      // app's login destroyed by a request the API called "not found".
      //
      // The gate is `admin`, not creator: design §5.2 gives admin grantees
      // authMode plus deploy, and a grantee who can deploy must also be able to
      // write `fc_status` back — otherwise their own deploy is stranded at
      // `awaiting_build` forever with nothing able to report the failure.
      // Not visible to the caller under `apps_select_if_visible` → 404, and
      // emphatically no escalation: a row we cannot read is not one we may
      // write with a service-role client.
      if (!cur) return null;
      const callerPermission = await this.resolveAppCallerPermissionForApp({
        id: appId,
        team_id: cur.team_id,
        created_by_actor_id: cur.created_by_actor_id,
      });
      if (callerPermission?.level !== "admin") return null;
      if (patch.fcStatus === "deploy_error") {
        if (!patch.deployToken || patch.deployToken !== cur.deploy_token) {
          throw new ApiError(409, "deploy_token_mismatch", "failure must match the current deployment attempt");
        }
        // The client owns the local build, never an active provider finalize.
        if (!["awaiting_build", "building"].includes(cur.fc_status)) {
          throw new ApiError(409, "lifecycle_conflict", "this build no longer owns the deploy state");
        }
        const admin = await serviceRoleClient("validate deployment failure lifecycle");
        const { data: lifecycle, error } = await admin.from("app_lifecycle_operations")
          .select("token, kind, in_flight").eq("app_id", appId).neq("status", "succeeded").maybeSingle();
        if (error) throw error;
        if (lifecycle && (lifecycle.kind !== "deploy" || lifecycle.token !== patch.deployToken || lifecycle.in_flight)) {
          throw new ApiError(409, "lifecycle_conflict", "this failure does not own the build lifecycle");
        }
      }
      const callerIsCreator = await this.isAppCreator({ ...cur, id: appId });

      // Validated before the auth-mode change below, which has side effects (it
      // writes and deletes secrets with a service-role client): a PATCH that is
      // going to be refused for its `type` must not have done that first.
      const nextType = parseAppType(patch.type);

      const set: any = { updated_at: new Date().toISOString() };
      if (typeof patch.name === "string" && patch.name.length > 0) set.name = patch.name;
      if (patch.visibility === "team" || patch.visibility === "personal") {
        set.visibility = patch.visibility;
      }
      // Written as-is and nothing else moves: whether the function gets a
      // database is decided at the next finalize (needsDatabase), which also
      // stamps `deployed_type`. Switching away from data_app never drops the
      // schema — it is named from slug + id and provisioning is idempotent, so
      // switching back finds the data where it was.
      if (nextType !== undefined) set.type = nextType;

      const nextAuthMode = parseAuthMode(patch.authMode);
      if (nextAuthMode !== undefined && cur) {
        const fromAuthMode = (cur.auth_mode ?? "none") as AuthMode;
        if (nextAuthMode !== fromAuthMode) {
          const admin = await serviceRoleClient("store app secrets");
          const oauth = await applyAuthModeChange(
            {
              gotrue,
              gotrueUnavailableReason,
              secrets: {
                putSecret: (kind, plaintext) => putAppSecretSupabase(admin, appId, kind, plaintext),
                deleteSecret: (kind) => deleteAppSecretSupabase(admin, appId, kind),
              },
            },
            {
              appId,
              name: cur.name,
              slug: cur.slug,
              appCode: cur.app_code,
              usesAppCodeDomain: cur.uses_app_code_domain,
              from: fromAuthMode,
              to: nextAuthMode,
              oauthClientId: cur.oauth_client_id ?? null,
              oauthAppId: cur.oauth_app_id ?? null,
            },
          );
          set.auth_mode = nextAuthMode;
          set.oauth_client_id = oauth.oauthClientId;
          set.oauth_app_id = oauth.oauthAppId;
        }
      }

      const nextAudience = parseAuthAudience(patch.authAudience);
      if (nextAudience !== undefined) set.auth_audience = nextAudience;

      // Scope and rules are validated as a PAIR, because "paths with nothing
      // required" is only visible when both are known — and the two halves can
      // arrive in separate PATCHes, so whichever is absent is read from the row.
      const nextScope = parseAuthScope(patch.authScope);
      const nextRules = patch.authRules === undefined ? undefined : parseAuthRules(patch.authRules);
      if (nextScope !== undefined || nextRules !== undefined) {
        const scope = nextScope ?? ((cur?.auth_scope ?? "all") as AuthScope);
        const rules = nextRules ?? parseAuthRules(cur?.auth_rules ?? []);
        validateAuthPathConfig(scope, rules);
        if (nextRules !== undefined) {
          // Refuse role codes that are not in the team's active org catalog.
          const wanted = [
            ...new Set(rules.flatMap((r) => (Array.isArray(r.roles) ? r.roles : []))),
          ];
          if (wanted.length > 0 && cur?.team_id) {
            // The app's org, not its team's (P2.3); the same since
            // 20260923200000 except for rows from before org_id existed.
            const orgId = cur.org_id ?? (await this.resolveTeamOrgId(cur.team_id));
            if (orgId) {
              const rolesClient =
                typeof supabase?.schema === "function"
                  ? supabase.schema("public")
                  : supabase;
              const { data: catalog, error: catalogErr } = await rolesClient
                .from("roles")
                .select("code")
                .eq("org_id", orgId)
                .eq("status", "active");
              if (catalogErr) throw catalogErr;
              const known = new Set((catalog ?? []).map((r: { code: string }) => r.code));
              const unknown = wanted.filter((c) => !known.has(c));
              if (unknown.length > 0) {
                throw new ApiError(
                  400,
                  "validation_failed",
                  `unknown auth rule role codes: ${unknown.join(", ")}`,
                  { details: { unknown } },
                );
              }
            }
          }
          set.auth_rules = rules;
        }
        if (nextScope !== undefined) set.auth_scope = scope;
      }

      if (typeof patch.provisionStatus === "string") {
        const from = cur?.provision_status ?? "";
        if (isLegalStatusTransition(from, patch.provisionStatus)) {
          set.provision_status = patch.provisionStatus;
          if (patch.provisionStatus === "error") {
            // The client reports seed failures here, and they happen on the
            // user's machine where nothing server-side can see them. Without
            // the reason the row read `error` with nothing behind it.
            set.provision_error = clientProvisionError(patch.provisionError);
          } else if (patch.provisionStatus === "ready" && from === "error") {
            // A reseed that worked: the old seed failure no longer describes
            // the app.
            set.provision_error = null;
          }
        } else if (set.name === undefined && set.visibility === undefined && set.type === undefined) {
          // A settings edit that carries a stale provisionStatus along is still
          // a settings edit; only a PATCH that is nothing BUT the illegal
          // transition is refused.
          throw new ApiError(400, "invalid_status_transition",
            `cannot move provision_status ${from} -> ${patch.provisionStatus}`);
        }
      }
      // Deploy-lifecycle writeback — the desktop owns the daemon-build step of
      // the deploy, so it is the only party that can report that the build never
      // finished. Without it the row stayed at `awaiting_build` indefinitely.
      if (typeof patch.fcStatus === "string") {
        if (!isLegalFcTransition(cur?.fc_status, patch.fcStatus)) {
          throw new ApiError(400, "invalid_deploy_transition",
            `cannot move fc_status ${cur?.fc_status ?? "not_deployed"} -> ${patch.fcStatus}`);
        }
        set.fc_status = patch.fcStatus;
        if (patch.fcStatus === "deploy_error") {
          set.provision_error = typeof patch.deployError === "string" && patch.deployError
            ? patch.deployError
            : "deploy failed";
        }
      }
      // The creator writes with their own token so RLS stays a second gate.
      // An `admin` grantee cannot: `apps_update_if_creator` is creator-only, so
      // their UPDATE would match zero rows and 404 despite being authorized.
      // Same escalation the sibling grant write uses (see setAppAccess).
      const writer = callerIsCreator
        ? supabase
        : await serviceRoleClient("apply an app update authorized by an admin grant");
      let update = writer.from("apps").update(set).eq("id", appId);
      if (patch.fcStatus === "deploy_error") {
        // The database clears attempt fields and finishes its lifecycle in
        // this transaction. Guard the write against late results from a build.
        update = update.eq("deploy_token", patch.deployToken).eq("fc_status", cur.fc_status);
        update = cur.deploy_started_at == null ? update.is("deploy_started_at", null) : update.eq("deploy_started_at", cur.deploy_started_at);
      }
      const { data, error } = await update.select(APP_COLUMNS).maybeSingle();
      if (error) throw error;
      if (!data) {
        if (patch.fcStatus === "deploy_error") throw new ApiError(409, "deploy_token_mismatch", "deployment changed before failure was recorded");
        return null;
      }
      // The proxy caches auth settings per host; without this a saved rule waits out the TTL.
      invalidateAppHosts({ id: appId, slug: cur.slug, appCode: cur.app_code, usesAppCodeDomain: cur.uses_app_code_domain, customDomain: cur.custom_domain });
      // Team visibility is read access for the whole team in Gitea too.
      if (set.visibility !== undefined && set.visibility !== cur.visibility) await forge.appAccessChanged(appId);
      return appView(data);
    },

    /**
     * Authorize a custom-domain write, and hand back the client that can do it.
     *
     * Same shape as updateApp's gate, and for the same two reasons: the caller
     * must hold `admin` on an app they can already SEE (a row we cannot read is
     * not one we may write with a service role), and `apps_update_if_creator`
     * is creator-only — so an authorized admin grantee needs the service-role
     * client or their UPDATE matches zero rows and 404s despite being allowed.
     * That mismatch is the P0 the apps audit found on the deploy methods.
     */
    async authorizeCustomDomainWrite(appId: string): Promise<{ cur: any; writer: any } | null> {
      const { data: cur } = await supabase
        .from("apps")
        .select(
          "id, slug, app_code, function_naming_mode, uses_app_code_domain, team_id, created_by_actor_id, custom_domain, custom_domain_token, custom_domain_verified_at",
        )
        .eq("id", appId)
        .maybeSingle();
      if (!cur) return null;
      const permission = await this.resolveAppCallerPermissionForApp({
        id: appId,
        team_id: cur.team_id,
        created_by_actor_id: cur.created_by_actor_id,
      });
      if (permission?.level !== "admin") return null;
      const callerIsCreator = await this.isAppCreator(cur);
      const writer = callerIsCreator
        ? supabase
        : await serviceRoleClient("bind an app custom domain authorized by an admin grant");
      return { cur, writer };
    },

    /**
     * The custom domain with the DNS records to publish, for whoever may
     * change it. The records embed the verification token, which is not on the
     * app row, so this is how a client shows them again after a reload —
     * without re-binding, which only an admin could do anyway. Null for a
     * caller who is not an admin of a visible app (404, same as the writes).
     */
    async getAppCustomDomain(appId: string) {
      const gate = await this.authorizeCustomDomainWrite(appId);
      if (!gate) return null;
      return customDomainView(gate.cur);
    },

    async setAppCustomDomain(appId: string, rawDomain: unknown) {
      const gate = await this.authorizeCustomDomainWrite(appId);
      if (!gate) return null;
      const domain = normalizeCustomDomain(rawDomain);

      // Binding the SAME name again is idempotent: same token, verification
      // intact. That makes this the way a client re-reads the DNS records it
      // has to display — the TXT value embeds the token, which is not in the
      // app row, so after a reload there is no other way to show them. Minting
      // a new token there would invalidate a record the owner had already
      // published, purely because they reopened the page.
      //
      // A DIFFERENT name resets both. The proof belongs to one binding, and
      // carrying it over would let a domain that changed hands stay verified.
      const sameDomain = gate.cur.custom_domain === domain;
      const token = (sameDomain && gate.cur.custom_domain_token) || makeDomainToken();
      const verifiedAt = sameDomain ? (gate.cur.custom_domain_verified_at ?? null) : null;

      const { data, error } = await gate.writer
        .from("apps")
        .update({
          custom_domain: domain,
          custom_domain_token: token,
          custom_domain_verified_at: verifiedAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", appId)
        .select("id, slug, app_code, function_naming_mode, uses_app_code_domain, custom_domain, custom_domain_token, custom_domain_verified_at")
        .maybeSingle();
      if (error) {
        // 23505 is the unique index on lower(custom_domain): another app has
        // it. Say which case it is rather than surfacing a constraint name.
        if ((error as any).code === "23505") {
          throw new ApiError(409, "domain_taken", `${domain} is already bound to another app`);
        }
        throw error;
      }
      if (!data) return null;
      // The old name must stop resolving here immediately, and the new one must
      // not be remembered as a miss from before it existed.
      invalidateAppHosts({ id: appId, slug: gate.cur.slug, appCode: gate.cur.app_code, usesAppCodeDomain: gate.cur.uses_app_code_domain, customDomain: gate.cur.custom_domain });
      invalidateAppHosts({ id: appId, slug: data.slug, appCode: data.app_code, usesAppCodeDomain: data.uses_app_code_domain, customDomain: domain });
      return customDomainView(data);
    },

    async verifyAppCustomDomain(appId: string) {
      const gate = await this.authorizeCustomDomainWrite(appId);
      if (!gate) return null;
      const domain = gate.cur.custom_domain as string | null;
      const token = gate.cur.custom_domain_token as string | null;
      if (!domain || !token) {
        throw new ApiError(409, "no_custom_domain", "this app has no custom domain to verify");
      }

      const proven = await verifyDomainOwnership(domain, token);
      if (!proven) {
        // Retryable, and usually just propagation — so 409 with the record to
        // add, not a 400 that reads like the request was malformed.
        throw new ApiError(
          409,
          "dns_verification_failed",
          `no matching TXT record at ${verificationTxtName(domain)} yet; DNS may still be propagating`,
        );
      }

      const { data, error } = await gate.writer
        .from("apps")
        .update({ custom_domain_verified_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", appId)
        .select("id, slug, app_code, function_naming_mode, uses_app_code_domain, custom_domain, custom_domain_token, custom_domain_verified_at")
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      // Until this drops, the hostname is cached as "not an app" from the
      // requests made while it was still unverified.
      invalidateAppHosts({ id: appId, slug: data.slug, appCode: data.app_code, usesAppCodeDomain: data.uses_app_code_domain, customDomain: domain });
      return customDomainView(data);
    },

    async deleteAppCustomDomain(appId: string) {
      const gate = await this.authorizeCustomDomainWrite(appId);
      if (!gate) return null;
      const { data, error } = await gate.writer
        .from("apps")
        .update({
          custom_domain: null,
          custom_domain_token: null,
          custom_domain_verified_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", appId)
        .select("id, slug, app_code, function_naming_mode, uses_app_code_domain, custom_domain, custom_domain_token, custom_domain_verified_at")
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      invalidateAppHosts({ id: appId, slug: gate.cur.slug, appCode: gate.cur.app_code, usesAppCodeDomain: gate.cur.uses_app_code_domain, customDomain: gate.cur.custom_domain });
      return customDomainView(data);
    },

    // Who writes the deploy state. The creator uses their own token so RLS
    // stays a second gate; an `admin` grantee cannot, because
    // `apps_update_if_creator` turns their UPDATE into a zero-row match that
    // the conditional writes below read as a lost race. Same escalation as
    // updateApp and authorizeCustomDomainWrite. Only called after the caller
    // was resolved as `admin`.
    async appDeployWriter(app: { id: string; team_id: string; created_by_actor_id: string | null }) {
      return (await this.isAppCreator(app))
        ? supabase
        : await serviceRoleClient("write app deploy state authorized by an admin grant");
    },

    async preflightAppDeploy(appId: string, input: { revision?: string; gitCommitSha?: string; declaration?: unknown; migrationIntent?: boolean }) {
      const { data: existing, error } = await supabase.from("apps")
        .select("id, slug, app_code, function_naming_mode, fc_function_name, fc_endpoint, env_deployed_at, start_spec, team_id, created_by_actor_id, provision_status, git_auth_kind, git_remote_url, fc_status, deploy_started_at, deploy_token, deploy_attempt_id")
        .eq("id", appId).maybeSingle();
      if (error) throw error;
      if (!existing) return null;
      const permission = await this.resolveAppCallerPermissionForApp(existing);
      if (!permission || permission.level !== "admin") return null;
      const target = appFunctionTargetFromRow(existing);
      validateAllocatedAppIdentity(existing);
      appDeploymentOriginHost(target, existing.fc_endpoint);
      if (existing.provision_status !== "ready") throw new ApiError(409, "app_not_ready", "app must be seeded before deploy");
      assertLifecycleAvailable(existing.fc_status);
      const progress = checkDeployInProgress({ fc_status: existing.fc_status, deploy_started_at: existing.deploy_started_at });
      if (progress === "blocked") throw new ApiError(409, "deploy_in_progress", "a deploy is already in progress");
      if (progress === "stale") {
        // Any in-progress status, `deploying` included (app-deploy-reclaim.ts).
        const reclaimed = await reclaimStaleDeploy(
          supabaseReclaimStore(await serviceRoleClient("reclaim stale app deployment")), appId,
          { fcStatus: existing.fc_status, deployStartedAt: existing.deploy_started_at, deployToken: existing.deploy_token },
        );
        if (reclaimed !== "reclaimed") throw new ApiError(409, "deploy_in_progress", "a deploy is already in progress");
        existing.deploy_token = null;
        existing.deploy_started_at = null;
        existing.fc_status = "deploy_error";
      }
      const revision = String(input?.revision ?? "");
      // A hosted repo's forge vouches for the revision; every other app names
      // it by content digest.
      if (forge.hostsRepo(existing)) {
        await forge.deployGuard(existing, "preflight", { revision, gitCommitSha: input.gitCommitSha });
      } else if (!revision.startsWith("sha256:")) {
        throw new ApiError(400, "validation_failed", "imported deploy requires a content digest");
      }
      validateAppOrigin({ ...target, slug: existing.slug });
      const info = await this.getAppRuntimeInfo(appId);
      if (!info) return null;
      assertNoUnexpectedOriginEntries(info.originSecurity);
      const result = checkAppDeployPreflight(appId, revision, input.declaration, info.currentDeployment,
        { region: info.deploymentContract.region, capabilities: info.capabilities,
          originSecurity: info.originSecurity, catalogComplete: info.sourceStatus.officialLayers.complete, migrationIntent: input.migrationIntent === true });
      if (existing.deploy_token && !isAppDeployPreflightExpired(existing.deploy_token)) {
        try {
          verifyAppDeployPreflight(existing.deploy_token, appId, revision, input.declaration, info.currentDeployment);
          return { ...result, token: existing.deploy_token, attemptId: existing.deploy_attempt_id ?? null };
        } catch {
          throw new ApiError(409, "preflight_in_progress", "another approved preflight is still valid; retry after ten minutes");
        }
      }
      const writer = await this.appDeployWriter(existing);
      const attemptId = randomUUID();
      let update = writer.from("apps").update({ deploy_token: result.token, deploy_attempt_id: attemptId }).eq("id", appId);
      update = existing.deploy_token === null || existing.deploy_token === undefined
        ? update.is("deploy_token", null) : update.eq("deploy_token", existing.deploy_token);
      update = existing.fc_status === null || existing.fc_status === undefined
        ? update.is("fc_status", null) : update.eq("fc_status", existing.fc_status);
      const { data: updated, error: updateError } = await update.select("id").maybeSingle();
      if (updateError) throw updateError;
      if (!updated) throw new ApiError(409, "deploy_in_progress", "app deploy state changed during preflight");
      return { ...result, attemptId };
    },

    async cancelAppDeployPreflight(appId: string, input: { deployToken?: string }) {
      if (typeof input?.deployToken !== "string" || !input.deployToken.trim()) {
        throw new ApiError(400, "validation_failed", "deployToken is required");
      }
      const { data: existing, error } = await supabase.from("apps")
        .select("id, team_id, created_by_actor_id").eq("id", appId).maybeSingle();
      if (error) throw error;
      if (!existing) return null;
      if ((await this.resolveAppCallerPermissionForApp(existing))?.level !== "admin") return null;
      const admin = await serviceRoleClient("cancel app deployment preflight");
      const cancelled = await lifecycleRpc(admin, "cancel_app_deploy_preflight", { p_app_id: appId, p_token: input.deployToken });
      return { cancelled: cancelled === true };
    },

    async deployApp(appId: string, input: { gitCommitSha?: string; revision?: string; declaration?: unknown; preflightToken?: string; useAppCodeDomain?: boolean }) {
      // Optional: only a Gitea-managed app pins its deploy to a forge commit.
      const gitCommitSha = parseOptionalGitCommitSha(input?.gitCommitSha);
      // What the checkout declares, read by the daemon before it asked for a
      // deploy. It decides which handle this deploy carries — an OSS upload or
      // a registry to push an image to — so it has to arrive here, not at
      // finalize where the rest of the declaration does.
      if (input?.useAppCodeDomain !== undefined && typeof input.useAppCodeDomain !== "boolean") {
        throw new ApiError(400, "validation_failed", "useAppCodeDomain must be a boolean");
      }
      const declaration = parseAppDeployDeclaration(input?.declaration);
      const declaredBuildKind = declaration.build.kind;
      // Visibility + readiness gate. RLS on amux.apps returns nothing when the
      // app is not visible to the caller → surface null so the route 404s.
      const { data: existing, error: selErr } = await supabase
        .from("apps")
        .select("id, slug, app_code, function_naming_mode, uses_app_code_domain, team_id, created_by_actor_id, provision_status, runtime, auth_mode, fc_status, fc_function_name, fc_region, deploy_started_at, deploy_token, git_auth_kind, git_remote_url")
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing) return null;
      const permission = await this.resolveAppCallerPermissionForApp(existing);
      if (!permission || permission.level !== "admin") return null;
      if (!input?.preflightToken || existing.deploy_token !== input.preflightToken) {
        throw new ApiError(409, "preflight_mismatch", "preflight token does not match this app");
      }
      if (isAppDeployPreflightExpired(input.preflightToken)) throw new ApiError(409, "preflight_expired", "preflight expired; retry");
      const revision = String(input.revision ?? "");
      if (forge.hostsRepo(existing)) {
        await forge.deployGuard(existing, "deploy", { revision, gitCommitSha });
      } else if (!revision.startsWith("sha256:")) {
        throw new ApiError(400, "validation_failed", "imported deploy requires its content digest");
      }
      if (existing.provision_status !== "ready") {
        throw new ApiError(409, "app_not_ready", "app must be seeded (provision_status=ready) before deploy");
      }
      assertDeployAllowed({ id: existing.id, slug: existing.slug, appCode: existing.app_code, usesAppCodeDomain: existing.uses_app_code_domain, auth_mode: existing.auth_mode, runtime: existing.runtime });
      const progress = checkDeployInProgress({
        fc_status: existing.fc_status,
        deploy_started_at: existing.deploy_started_at,
      });
      if (progress === "blocked") {
        throw new ApiError(409, "deploy_in_progress", "a deploy is already in progress");
      }
      resolveAppFunctionName({ ...appFunctionTargetFromRow(existing), fcFunctionName: existing.fc_function_name });
      validateAppOrigin({ ...appFunctionTargetFromRow(existing), slug: existing.slug });
      const info = await this.getAppRuntimeInfo(appId);
      if (!info) return null;
      assertNoUnexpectedOriginEntries(info.originSecurity);
      verifyAppDeployPreflight(input.preflightToken, appId, revision, declaration, info.currentDeployment);
      if (progress === "stale") throw new ApiError(409, "deploy_in_progress", "stale deployment must be reconciled before starting; request a new preflight");
      if (!startDeploy) throw deployUnavailable(deployUnavailableReason);
      const writer = await this.appDeployWriter(existing);
      const lifecycleAdmin = await serviceRoleClient("app deployment lifecycle");
      await lifecycleRpc(lifecycleAdmin, "begin_app_lifecycle", { p_app_id: appId, p_kind: "deploy", p_token: input.preflightToken });
      const deployToken = input.preflightToken;
      const deployStartedAt = new Date().toISOString();
      try {
        const r = await startDeploy({
          ...appFunctionTargetFromRow(existing),
          appId,
          region: existing.fc_region || appsRegion(),
          fcFunctionName: existing.fc_function_name,
          buildKind: declaredBuildKind,
          gitCommitSha,
          // Only consulted when a function is first minted, so an app that has
          // already deployed keeps the name stored on its row.
          slug: existing.slug,
        });
        let update = writer
          .from("apps")
          .update({
            fc_function_name: existing.fc_function_name || r.fcFunctionName,
            fc_region: existing.fc_region || r.fcRegion,
            fc_status: "awaiting_build",
            provision_error: null,
            deploy_token: deployToken,
            deploy_use_app_code_domain: existing.uses_app_code_domain === true || input?.useAppCodeDomain === true,
            deploy_started_at: deployStartedAt,
            // runtime and git_commit_sha are the last successful deployment.
            // The proposal travels in this response and is committed at finalize.
            updated_at: deployStartedAt,
          })
          .eq("id", appId).eq("deploy_token", input.preflightToken);
        update = existing.fc_status === null || existing.fc_status === undefined
          ? update.is("fc_status", null) : update.eq("fc_status", existing.fc_status);
        const { data: row, error: updErr } = await update.select(APP_COLUMNS).maybeSingle();
        if (updErr) throw updErr;
        if (!row) throw new ApiError(409, "deploy_in_progress", "app deploy state changed before upload handle was issued");
        return {
          ...appView(row),
          // Exactly one of these is set — see startDeploy. The daemon branches
          // on which one it got.
          ossObjectName: r.ossObjectName,
          presignedPut: r.presignedPut,
          image: r.image,
          deployToken,
          gitCommitSha,
          revision,
        };
      } catch (e: any) {
        let failure = writer
          .from("apps")
          .update({
            fc_status: "deploy_error",
            provision_error: String(e?.message ?? e),
            deploy_use_app_code_domain: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", appId).eq("deploy_token", deployToken);
        failure = existing.fc_status == null ? failure.is("fc_status", null) : failure.eq("fc_status", existing.fc_status);
        failure = existing.deploy_started_at == null ? failure.is("deploy_started_at", null) : failure.eq("deploy_started_at", existing.deploy_started_at);
        const { error: failureError } = await failure;
        if (failureError) throw failureError;
        // The failure transition's trigger also completes the matching
        // non-flight lifecycle. A lost state claim must not release it.
        throw new ApiError(502, "deploy_failed", String(e?.message ?? e));
      }
    },

    async finalizeDeploy(
      appId: string,
      input: { gitCommitSha?: string; revision?: string; deployToken: string; declaration?: unknown; image?: unknown; artifactVerification?: unknown; migrations?: unknown },
    ) {
      const gitCommitSha = parseOptionalGitCommitSha(input?.gitCommitSha);
      const declaration = parseAppDeployDeclaration(input?.declaration);
      // Shape-checked before anything is claimed, so a malformed list is a
      // 400 on a deploy that changed nothing.
      const migrations = parseAppMigrations(input?.migrations);
      const deployToken = parseDeployToken(input?.deployToken);
      // Visibility gate. RLS on amux.apps returns nothing when the app is not
      // visible to the caller → surface null so the route 404s.
      const { data: existing, error: selErr } = await supabase
        .from("apps")
        .select("id, slug, app_code, function_naming_mode, uses_app_code_domain, deploy_use_app_code_domain, team_id, org_id, created_by_actor_id, type, fc_function_name, fc_status, runtime, auth_mode, oauth_client_id, deploy_token, oss_bucket, custom_domain, git_auth_kind")
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing) return null;
      const permission = await this.resolveAppCallerPermissionForApp(existing);
      if (!permission || permission.level !== "admin") return null;
      if (!existing.deploy_token || existing.deploy_token !== deployToken) {
        throw new ApiError(409, "deploy_token_mismatch", "deployToken does not match the in-progress deploy");
      }
      assertDeployAllowed({ id: existing.id, slug: existing.slug, appCode: existing.app_code, usesAppCodeDomain: existing.uses_app_code_domain, auth_mode: existing.auth_mode, runtime: existing.runtime });
      if (!existing.fc_function_name) throw new ApiError(409, "not_deploying", "app has no function; call deploy first");
      if (!isLegalFcTransition(existing.fc_status, "deploying")) {
        throw new ApiError(409, "invalid_deploy_state", `cannot finalize from fc_status ${existing.fc_status}`);
      }
      if (!finalizeDeploy) throw deployUnavailable(deployUnavailableReason);
      // The approved choice belongs to this token. Older in-flight attempts
      // may have no choice recorded; an already active app never reverts.
      const usesAppCodeDomain = existing.uses_app_code_domain === true || existing.deploy_use_app_code_domain === true;
      const revision = String(input?.revision ?? "");
      const artifactVerification = parseArtifactVerification(input?.artifactVerification, revision);
      resolveAppFunctionName({ ...appFunctionTargetFromRow(existing), fcFunctionName: existing.fc_function_name });
      validateAppOrigin({ ...appFunctionTargetFromRow(existing), slug: existing.slug });
      const info = await this.getAppRuntimeInfo(appId);
      if (!info) return null;
      assertNoUnexpectedOriginEntries(info.originSecurity);
      verifyAppDeployPreflight(deployToken, appId, revision, declaration, info.currentDeployment);
      if (forge.hostsRepo(existing)) await forge.deployGuard(existing, "finalize", { revision, gitCommitSha });
      const writer = await this.appDeployWriter(existing);
      const lifecycleAdmin = await serviceRoleClient("app deployment lifecycle");
      let { data: lifecycle, error: lifecycleError } = await lifecycleAdmin.from("app_lifecycle_operations")
        .select("id, token, kind, status").eq("app_id", appId).neq("status", "succeeded").maybeSingle();
      if (lifecycleError) throw lifecycleError;
      if (!lifecycle) lifecycle = await lifecycleRpc(lifecycleAdmin, "begin_app_lifecycle", { p_app_id: appId, p_kind: "deploy", p_token: deployToken });
      if (!lifecycle || lifecycle.kind !== "deploy" || lifecycle.token !== deployToken) throw new ApiError(409, "lifecycle_conflict", "this deploy no longer owns the app lifecycle");
      // This supersedes the feature's token-only claim: retain that token check
      // AND main's state/lifecycle checks before FC or storage mutation.
      const { data: claimed, error: claimError } = await writer.from("apps")
        .update({ fc_status: "deploying", updated_at: new Date().toISOString() })
        .eq("id", appId).eq("deploy_token", deployToken).eq("fc_status", existing.fc_status)
        .select("id").maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) throw new ApiError(409, "deploy_in_progress", "this deploy is already finalizing or its token changed");
      // updated_at = when finalize took over; app-deploy-reclaim.ts measures
      // an in-flight attempt's age from it, not from deploy_started_at.
      const { error: flightError } = await lifecycleAdmin.from("app_lifecycle_operations").update({ in_flight: true, updated_at: new Date().toISOString() }).eq("id", lifecycle.id).neq("status", "succeeded");
      if (flightError) throw flightError;
      try {
        // Convenience env for the app's own code. The login wall does not
        // depend on it: the proxy gateway enforces the wall before a request
        // reaches the function at all, so an app that has never been redeployed
        // is still protected the moment auth_mode flips.
        let platformAuthEnv: Record<string, string> | undefined;
        if ((existing.auth_mode ?? "none") === "platform") {
          platformAuthEnv = buildPlatformAuthEnv({ appId, slug: existing.slug, appCode: existing.app_code, usesAppCodeDomain });
        }
        // Which database this app's data lives in is a fact decided once, at
        // the first successful finalize — not a property re-derived from the
        // team's CURRENT org. `teams.oid` is nullable and nothing guards it, so
        // re-deriving after it changes would provision a brand-new empty schema
        // in a different database and take the app live with no data. Deploy
        // where the data already is.
        const orgId = existing.org_id ?? (await this.resolveTeamOrgId(existing.team_id));
        // A FRESH storage token every finalize, sealed and injected in the same
        // breath. Reusing an existing one looks tempting and is the exact trap
        // the app's Postgres password documents at app-postgres.ts:28 - a
        // credential that is stored but never handed to the function is one the
        // app cannot use, and the failure only shows up on the second deploy.
        const storageEnv = await buildStorageEnvForFinalize(existing);
        // Read at finalize, not at deploy start: an env edit made while a build
        // was running belongs to the function that is about to be written, and
        // reading it earlier would ship the previous values under a deploy the
        // operator watched succeed after their change.
        const userEnv = await buildUserEnvForFinalize(appId);
        const envDeployedAt = new Date().toISOString();
        const r = await finalizeDeploy({
          ...appFunctionTargetFromRow(existing),
          appId,
          slug: existing.slug,
          orgId,
          appType: existing.type,
          fcFunctionName: existing.fc_function_name,
          ossObjectName: appOssObjectName(appId),
          platformAuthEnv,
          storageEnv,
          userEnv,
          // What the daemon read out of the app's own declaration.
          declaration,
          // The image that build pushed. A container app has no code object,
          // so without this the function would be pointed at whatever the
          // previous deploy happened to leave in OSS.
          image: parseDeployedImage(input?.image, declaration),
          // The repo's migrations/*.sql at the built revision; run before the
          // function is touched (app-migrations.ts).
          migrations,
          gitCommitSha: gitCommitSha ?? null,
        });
        const { data: row, error: updErr } = await writer
          .from("apps")
          .update({
            fc_status: "live",
            uses_app_code_domain: usesAppCodeDomain,
            fc_endpoint: r.fcEndpoint,
            ...(gitCommitSha ? { git_commit_sha: gitCommitSha } : {}),
            // What is now running, as opposed to what the deploy set out to
            // build. They differ when an app's declaration changed mid-deploy.
            runtime: declaration.build.kind,
            start_spec: declaration.start,
            artifact_verification: artifactVerification,
            // The function that just went live carries this auth_mode's env.
            // Recording it here is what lets `authModePendingRedeploy` clear —
            // and what makes the pending state a property of the row rather
            // than of one desktop's memory.
            deployed_auth_mode: existing.auth_mode ?? "none",
            // And the type this finalize actually built with — the value read
            // above and handed to needsDatabase, not whatever the row says by
            // now: a PATCH that lands while the function is being written did
            // not reach it. Clears `typePendingRedeploy`.
            deployed_type: existing.type,
            // Same idea for the environment: what is baked into the function
            // that just went live. Compared against env_updated_at to tell the
            // operator their last env change is not live yet.
            env_deployed_at: envDeployedAt,
            // Backfill for rows created before createApp settled the tenant.
            //
            // This used to be gated on `needsDatabase(existing.type)`, because
            // org_id then meant "the org database this app's schema lives in"
            // and a static app has no schema anywhere. Under the live-tenant
            // meaning (20260923200000) every app has a tenant, static ones
            // included — they have a login wall like any other.
            //
            // The data plane does not get confused by that: it gates on the
            // app TYPE before it ever reads org_id (the `app_has_no_database`
            // 409 above the read in appDataTarget, and the same check in
            // app-deploy), so a non-null org_id on a static app never sends
            // anyone looking for a schema.
            ...(orgId ? { org_id: orgId } : {}),
            provision_error: null,
            deploy_token: null,
            deploy_use_app_code_domain: null,
            deploy_started_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", appId).eq("deploy_token", deployToken)
          .select(APP_COLUMNS)
          .maybeSingle();
        if (updErr) throw updErr;
        if (!row) throw new ApiError(409, "deploy_token_mismatch", "deployToken no longer owns the in-progress deploy");
        await lifecycleRpc(lifecycleAdmin, "finish_app_lifecycle", { p_operation_id: lifecycle.id, p_token: deployToken });
        // The proxy caches fc_endpoint/fc_status per host.
        invalidateAppHosts({ id: appId, slug: existing.slug, appCode: existing.app_code, usesAppCodeDomain: row.uses_app_code_domain, customDomain: existing.custom_domain });
        return appView(row);
      } catch (e: any) {
        await writer
          .from("apps")
          .update({
            fc_status: "deploy_error",
            provision_error: String(e?.message ?? e),
            deploy_use_app_code_domain: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", appId).eq("deploy_token", deployToken).eq("fc_status", "deploying");
        if (!/timeout|timedout|etimedout|econnreset/i.test(String(e?.code ?? ""))) {
          await lifecycleRpc(lifecycleAdmin, "finish_app_lifecycle", { p_operation_id: lifecycle.id, p_token: deployToken });
        }
        if (e instanceof ApiError) throw e;
        throw new ApiError(502, "finalize_failed", String(e?.message ?? e));
      }
    },

    /**
     * Resolve an app for the data browser: visibility, permission tier, whether
     * it has a database at all, and which one.
     *
     * Returns null for "the caller cannot see this app" so the route 404s —
     * indistinguishable, on purpose, from the app not existing.
     */
    async resolveAppDataTarget(
      appId: string,
      required: "write" | "admin",
    ): Promise<{ target: AppDataTarget } | null> {
      const { data: app, error } = await supabase
        .from("apps")
        .select("id, slug, team_id, org_id, type, fc_endpoint, created_by_actor_id")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!app) return null;

      const permission = await this.resolveAppCallerPermissionForApp(app);
      // `read` is not "read-only access to the data" — design §6 hides the
      // feature from that tier entirely, so it must not learn the app has one.
      if (!permission || permission.level === "read") return null;
      if (required === "admin" && permission.level !== "admin") {
        throw new ApiError(403, "forbidden", "editing this app's data requires admin access");
      }

      // Two distinct 409s, not one 404: the control panel shows a different
      // sentence for each, and "not found" would be a third, wrong story.
      if (!needsDatabase(app.type)) {
        throw new ApiError(409, "app_has_no_database", "this app type has no database");
      }
      if (!app.fc_endpoint) {
        throw new ApiError(409, "app_not_deployed", "the database is created by the first deploy");
      }

      let orgId = app.org_id ?? null;
      if (!orgId) {
        // A row that predates apps.org_id. Deriving is the best we can do and
        // it is the one case where we may be pointed at the wrong database
        // (design §3.1) — so it goes in the log, without any of the data.
        orgId = await this.resolveTeamOrgId(app.team_id);
        console.warn(`[apps] app ${appId} has no org_id; deriving it from the team`);
      }
      if (!orgId) {
        throw new ApiError(409, "app_org_unknown", "this app is not associated with an org database");
      }

      return { target: { orgId, appId: app.id, slug: app.slug } };
    },

    /** Shared guard: the ops facade is only present when FC has an admin URL. */
    requireAppData() {
      if (!appData) {
        throw new ApiError(
          503,
          "app_data_unavailable",
          appDataUnavailableReason
            ? `app data browsing is not configured: ${appDataUnavailableReason}`
            : "app data browsing is not configured",
        );
      }
      return appData;
    },

    async listAppDataTables(appId: string) {
      const resolved = await this.resolveAppDataTarget(appId, "write");
      if (!resolved) return null;
      const ops = this.requireAppData();
      return { items: await runAppData(() => ops.listTables(resolved.target)) };
    },

    async readAppDataRows(appId: string, table: string, query: any = {}) {
      const resolved = await this.resolveAppDataTarget(appId, "write");
      if (!resolved) return null;
      const ops = this.requireAppData();
      return runAppData(() =>
        ops.readRows(resolved.target, {
          table,
          after: typeof query.after === "string" ? query.after : null,
          direction: query.direction === "desc" ? "desc" : "asc",
          filter: parseAppDataFilter(query),
          limit: parsePageLimit(query.limit),
        }),
      );
    },

    async insertAppDataRow(appId: string, table: string, body: any = {}) {
      const resolved = await this.resolveAppDataTarget(appId, "admin");
      if (!resolved) return null;
      const ops = this.requireAppData();
      const values = body?.values ?? {};
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new ApiError(400, "validation_failed", "values must be an object of column values");
      }
      const row = await runAppData(() => ops.insertRow(resolved.target, { table, values }));
      return { row };
    },

    async updateAppDataRow(appId: string, table: string, rowKey: string, body: any = {}) {
      const resolved = await this.resolveAppDataTarget(appId, "admin");
      if (!resolved) return null;
      const ops = this.requireAppData();
      const patch = body?.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new ApiError(400, "validation_failed", "patch must be an object of column values");
      }
      const row = await runAppData(() =>
        ops.updateRow(resolved.target, { table, key: decodeRowKey(rowKey), patch }),
      );
      return { row };
    },

    async deleteAppDataRow(appId: string, table: string, rowKey: string) {
      const resolved = await this.resolveAppDataTarget(appId, "admin");
      if (!resolved) return null;
      const ops = this.requireAppData();
      await runAppData(() => ops.deleteRow(resolved.target, { table, key: decodeRowKey(rowKey) }));
      return { ok: true };
    },

    /**
     * What the deployed function itself printed, plus one row per request.
     *
     * Authorized like the data browser and for the same reason: an app's log
     * lines carry whatever it decided to print, which is its users' data. So
     * `read` gets the same 404 the feature gives a non-member, and the caller's
     * own permission on the app row is what decides — never the SLS credential,
     * which is one service account for every app on the deployment.
     *
     * The function name is read off the row rather than derived, so an app
     * deployed under an older naming scheme still finds its own logs; deriving
     * it is only the fallback for a row that predates the column.
     */
    async getAppRuntimeInfo(appId: string, language?: AppLanguage) {
      const { data: app, error } = await supabase
        .from("apps")
        .select("id, slug, app_code, function_naming_mode, team_id, type, created_by_actor_id, fc_status, fc_endpoint, fc_function_name, fc_region, runtime, start_spec, artifact_verification, git_commit_sha, env_deployed_at, updated_at, undeploy_operation")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!app) return null;

      const permission = await this.resolveAppCallerPermissionForApp(app);
      if (!permission) return null;

      validateAllocatedAppIdentity(app);
      appDeploymentOriginHost(appFunctionTargetFromRow(app), app.fc_endpoint);
      const region = app.fc_region || appsRegion();
      const cleanupAt = Date.parse(app.undeploy_operation?.updatedAt ?? "");
      const deployedAt = Date.parse(app.env_deployed_at ?? "");
      const completedUninstall = app.undeploy_operation?.status === "succeeded"
        && Number.isFinite(cleanupAt) && (!Number.isFinite(deployedAt) || cleanupAt >= deployedAt)
        && ["uninstalled", "awaiting_build", "building", "deploying", "deploy_error"].includes(app.fc_status);
      const offline = ["uninstalling", "uninstall_failed", "uninstalled"].includes(app.fc_status);
      // A failed later deploy may leave the last successful snapshot intact.
      const deployed = app.fc_status === "live" || !!app.env_deployed_at || !!app.start_spec || !!app.fc_endpoint;
      const catalog = await readRuntimeCatalog(region, language);
      const sourceStatus: any = { ...catalog.sourceStatus,
        provider: { checkedAt: null, observedAt: null, complete: !deployed || offline, stale: false,
          errors: [], error: null, provenance: "Alibaba FC 2023-03-30 GetFunction" } };
      let currentDeployment: any = null;
      if (deployed) {
        currentDeployment = {
          runtime: app.runtime ?? null,
          startSpec: app.start_spec ?? null,
          commit: app.git_commit_sha ?? null,
          artifactVerification: app.artifact_verification ?? null,
          deployedAt: app.env_deployed_at ?? null,
          functionName: app.fc_function_name ?? null,
          provider: null,
          ...(offline ? { serving: false, historical: true } : {}),
          ...(completedUninstall && offline ? { uninstallOperationId: app.undeploy_operation.id } : {}),
          drift: false,
          driftFields: [],
        };
        sourceStatus.provider.checkedAt = new Date().toISOString();
        if (offline) {
          // Retained successful configuration is history, not an active provider read.
        } else if (app.fc_function_name) {
          try {
            const provider = projectFunction(await readAppFunction(app.fc_function_name, region));
            currentDeployment.provider = provider;
            currentDeployment.driftFields = driftFields(app.start_spec, provider, region, app.runtime);
            currentDeployment.drift = currentDeployment.driftFields.length > 0;
            sourceStatus.provider.complete = true;
            sourceStatus.provider.observedAt = sourceStatus.provider.checkedAt;
          } catch (e) {
            sourceStatus.provider.error = providerErrorCode(e);
            sourceStatus.provider.errors = [sourceStatus.provider.error];
            if (completedUninstall && sourceStatus.provider.error === "function_missing") {
              // A restoration may have partially created FC before failing.
              // Only a confirmed missing function can reuse removed-provider evidence.
              Object.assign(currentDeployment, { historical: true, serving: false,
                uninstallOperationId: app.undeploy_operation.id });
              sourceStatus.provider.complete = true;
            } else {
              currentDeployment.drift = sourceStatus.provider.error === "function_missing";
              if (currentDeployment.drift) currentDeployment.driftFields = ["providerFunction"];
            }
          }
        } else {
          sourceStatus.provider.error = "function_name_missing";
          sourceStatus.provider.errors = [sourceStatus.provider.error];
          currentDeployment.drift = true;
          currentDeployment.driftFields = ["providerFunction"];
        }
      }
      return {
        deploymentContract: {
          method: app.runtime === "container" ? "container" : "agent_build_to_fc_custom_runtime",
          target: { os: "linux", arch: "x86_64" },
          region,
          artifact: app.runtime === "container" ? "container_image" : "linux_x86_64_artifact",
          requiredDeclarationFields: app.runtime === "container"
            ? ["build.kind", "build.dockerfile", "start.port"]
            : ["build.kind", "build.output", "start.fcRuntime", "start.command", "start.args", "start.port", "start.layers"],
        },
        currentDeployment,
        originSecurity: projectOriginSecurity(await readAppOriginSecurity(app)),
        capabilities: catalog.candidates,
        observations: readRuntimeObservations(language),
        sourceStatus,
      };
    },

    async getAppLogs(appId: string, query: any = {}) {
      const { data: app, error } = await supabase
        .from("apps")
        .select("id, slug, app_code, function_naming_mode, team_id, type, fc_status, fc_endpoint, fc_function_name, created_by_actor_id")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!app) return null;

      const permission = await this.resolveAppCallerPermissionForApp(app);
      if (!permission || permission.level === "read") return null;

      // Distinguishable from "no logs in that window", which is the answer that
      // sends someone looking for a bug that is not there.
      if (!app.fc_status || app.fc_status === "not_deployed") {
        throw new ApiError(
          409,
          "app_not_deployed",
          "this app has never been deployed, so it has no logs yet",
        );
      }
      if (!appLogs) {
        throw new ApiError(
          503,
          "app_logs_unavailable",
          appLogsUnavailableReason
            ? `app logs are not configured: ${appLogsUnavailableReason}`
            : "app logs are not configured",
        );
      }

      validateAllocatedAppIdentity(app);
      const target = appFunctionTargetFromRow(app);
      appDeploymentOriginHost(target, app.fc_endpoint);
      try {
        return await appLogs({
          functionName: resolveAppFunctionName({ ...target, fcFunctionName: app.fc_function_name, legacyFallback: "uuid" }),
          sinceMinutes: parseLogMinutes(query.sinceMinutes),
          limit: parseLogLimit(query.limit),
          kind: parseLogKind(query.kind),
          contains: parseLogText(query.contains),
          requestId: parseLogText(query.requestId),
        });
      } catch (e: any) {
        if (e instanceof ApiError) throw e;
        // A logstore that exists but has never received a row answers with a
        // 4xx rather than an empty page. That is "nothing yet", not a failure
        // the caller can act on.
        if (/LogStoreNotExist|IndexConfigNotExist|ProjectNotExist/i.test(String(e?.code ?? ""))) {
          return { items: [], truncated: false, from: null, to: null };
        }
        console.warn(`[apps] app log read failed: ${e?.code ?? e}`);
        throw new ApiError(502, "app_logs_failed", "could not read this app's logs");
      }
    },

    async listAppSessions(appId: string) {
      // RLS on sessions governs visibility; a caller who cannot see the app's
      // sessions gets an empty list.
      const { data, error } = await supabase
        .from("sessions")
        .select("id, team_id, title, mode, last_message_at, created_at, updated_at")
        .eq("app_id", appId);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.id,
        teamId: r.team_id,
        title: r.title ?? "",
        mode: r.mode ?? "collab",
        lastMessageAt: appIso(r.last_message_at),
        createdAt: appIso(r.created_at)!,
        updatedAt: appIso(r.updated_at)!,
      }));
    },

    /**
     * Whether the caller is the actor that created this app.
     *
     * The creator-only gate for operations with side effects outside Postgres,
     * which RLS cannot roll back. RLS still has the last word on the write
     * itself; this only makes sure nothing irreversible happens first.
     */
    async isAppCreator(app: { id: string; team_id: string; created_by_actor_id: string | null }): Promise<boolean> {
      const { data: userData, error: userErr } = await getCurrentUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      // Member or agent: a daemon's agent creates apps too, and is their creator.
      //
      // Every caller uses this to pick the client for an `apps` UPDATE, so it
      // must say exactly what `apps_update_if_creator` says — otherwise the
      // caller's own token meets a policy that refuses it and the write is a
      // silent zero-row match. Since 20261126200000 that policy is the
      // platform's creator test (`caller_app_access.is_creator`), so this asks
      // the same function. A database without it still has the actor policy.
      const platform = await callCallerAppAccess(supabase, app.id);
      if (platform !== undefined) return platform?.isCreator === true;
      const resolved = await this.resolveCurrentActor(app.team_id, userId);
      return Boolean(resolved?.id) && app.created_by_actor_id === resolved!.id;
    },

    /**
     * `public.orgs.id` for a team (`amux.teams.oid`). Null when the team has
     * no org — data_app finalize then fails with a clear error rather than
     * inventing a shared database.
     */
    async resolveTeamOrgId(teamId: string): Promise<string | null> {
      const { data, error } = await supabase
        .from("teams")
        .select("oid")
        .eq("id", teamId)
        .maybeSingle();
      if (error) throw error;
      const oid = data?.oid;
      return typeof oid === "string" && oid.trim() ? oid.trim() : null;
    },

    /**
     * Effective per-app permission for the caller. Creator → admin; no access row
     * and not creator → null. Used for git credentials and deploy gates.
     *
     * The creator may be an agent actor — a daemon creating apps for the agents
     * on its machine (`amuxd app`) — and administers its own apps like anyone
     * else. Since 20261117000000 an agent can also be a grantee:
     * `app_member_access.member_id` references `amux.actors`, and grants are
     * looked up by the caller's actor id. `callerMemberId` is still null for an
     * agent, because the other `*_member_id` columns it is written to (who set
     * an env var, who made a cron job) reference `amux.members`;
     * `callerActorId` is the caller either way, and is what a grant records as
     * its grantor.
     *
     * Since 20261120120000 an active agent also inherits its owner's level
     * (`amux.agent_inherited_app_level`; the rule lives in the database). The
     * higher of the agent's own grant and the inherited level wins.
     * `inherited` is true when the level came from the owner — the callers
     * that change who has access, or delete the app, refuse such a caller
     * (`assertNotInheritedFor`): those are the two things a bot never does on
     * its owner's behalf.
     */
    async resolveAppCallerPermissionForApp(app: {
      id: string;
      team_id: string;
      created_by_actor_id: string | null;
    }): Promise<{
      level: AppPermissionLevel;
      /**
       * The caller's actor in the app's team, for what the legacy tables
       * record (who granted, who set an env var). Null for a caller with a
       * level but no actor there — an agent reaching its owner's app in
       * another team of the same org.
       */
      callerActorId: string | null;
      callerMemberId: string | null;
      inherited: boolean;
    } | null> {
      const { data: userData, error: userErr } = await getCurrentUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");

      const resolved = await this.resolveCurrentActor(app.team_id, userId);
      const callerActorId = resolved?.id ?? null;
      const isAgent = resolved?.actorType === "agent";
      const callerMemberId = callerActorId && !isAgent ? callerActorId : null;

      // The level is the platform's (20261126100000): creator, user grants and
      // delegations inside the app's org, by account rather than by actor.
      // Since P2.3 the caller needs no actor in the app's team for it.
      const platform = await callCallerAppAccess(supabase, app.id);
      if (platform !== undefined) {
        if (!platform) return null;
        return { level: platform.level, callerActorId, callerMemberId, inherited: platform.delegated };
      }

      // A database without that migration: the legacy actor rule.
      if (!callerActorId) return null;
      if (app.created_by_actor_id === callerActorId) {
        return { level: "admin", callerActorId, callerMemberId, inherited: false };
      }

      const { data: access, error: accErr } = await supabase
        .from("app_member_access")
        .select("permission_level")
        .eq("app_id", app.id)
        .eq("member_id", callerActorId)
        .maybeSingle();
      if (accErr) throw accErr;
      const granted = storedAppPermissionLevel(access?.permission_level);

      let inheritedLevel: AppPermissionLevel | null = null;
      if (isAgent && granted !== "admin") {
        const viaOwner = await callAgentInheritance(supabase, "agent_inherited_app_level", {
          p_app_id: app.id,
          p_actor_id: callerActorId,
        });
        inheritedLevel = storedAppPermissionLevel(viaOwner);
      }

      const level = higherAppLevel(granted, inheritedLevel);
      if (!level) return null;
      const inherited = level !== granted;
      return { level, callerActorId, callerMemberId, inherited };
    },

    /**
     * Refuse a caller whose level on the app came from its owner. Changing
     * who has access and deleting the app stay with people and explicitly
     * granted actors.
     */
    assertNotInheritedFor(
      permission: { inherited?: boolean } | null,
      action: "manage_access" | "delete_app",
    ): void {
      if (!permission?.inherited) return;
      const what = action === "manage_access" ? "change who can access" : "delete";
      throw new ApiError(
        403,
        "inherited_access_not_allowed",
        `an agent cannot ${what} an app it reaches through its owner; ask a person with admin on the app`,
      );
    },

    /**
     * Who, if anyone, the caller is for this app's git credentials — and the
     * app row to act on. One rule, shared by mint and revoke, so the two can
     * never drift apart.
     */
    async resolveAppGitCredentialActor(
      appId: string,
    ): Promise<{ actorId: string; app: Record<string, any>; readOnly: boolean } | null> {
      const { data: visible, error: selErr } = await supabase
        .from("apps")
        .select("id, team_id, visibility, git_remote_url, git_auth_kind, created_by_actor_id")
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;

      if (visible) {
        const permission = await this.resolveAppCallerPermissionForApp(visible);
        // A member the app knows about is answered on the member rules alone,
        // never by falling through to the agent path below. `read` may download
        // the code but not push to it, so its key cannot push.
        //
        // An agent's `read` grant does not narrow its key. The agent path below
        // still gives every agent of the team a writable one (phase 1 leaves it
        // alone — the daemon's own seed/clone/deploy run on it), so narrowing
        // here would hand a granted agent less than an ungranted one.
        // A caller with a level but no actor in the app's team (an agent
        // reaching its owner's app in another team) has no one to issue the
        // credential to here; it falls through to the paths below.
        if (permission?.callerActorId) {
          return {
            actorId: permission.callerActorId,
            app: visible,
            readOnly: permission.level === "read" && permission.callerMemberId !== null,
          };
        }
        // A teammate with no grant on a team-visible app. The app list shows it
        // to them with a download button, and refusing the repo made that
        // button a dead end — while their own daemon, on the agent path below,
        // could already push to it. Same terms as `read`.
        if (visible.visibility === "team") {
          const { data: userData, error: userErr } = await getCurrentUser();
          if (userErr) throw userErr;
          const userId = userData?.user?.id;
          const member = userId
            ? await this.resolveCurrentMemberActor(visible.team_id, userId)
            : null;
          if (member?.id) return { actorId: member.id, app: visible, readOnly: true };
        }
      }

      // Agent-actor path. The daemon holds its own cloud account, so it never
      // resolves to a member actor and the member rules above always decline
      // it — yet the daemon is the only thing on the machine that can hand
      // `git push` a credential (the agent's own push has none, and the key is
      // deliberately not persisted anywhere). Authorisation is therefore
      // team-scoped: any agent actor in the app's team may mint a key for a
      // Gitea-managed app in that team.
      //
      // Coarser than the per-app member rules on purpose, and accepted when
      // this path was chosen. An agent can hold a per-app grant now, and that
      // grant is what Gitea enforces on its own HTTPS pushes; this deploy-key
      // path keeps the team-wide rule until the daemon's git moves to HTTPS and
      // the keys are retired (phase-1 plan, "旧 deploy key 路径"). The blast
      // radius is one repo per key, and the key's title names the agent actor.
      //
      // The row is re-read with the service role because `apps.visibility`
      // defaults to `personal`, which `apps_select_if_visible` hides from every
      // actor but the creator — including the daemon of the very machine the
      // app is checked out on.
      const app = visible ?? (await readAppForAgentGitCredential(appId));
      if (!app) return null;
      const agentActorId = await resolveCurrentAgentActor(app.team_id);
      if (!agentActorId) return null;
      return { actorId: agentActorId, app, readOnly: false };
    },

    async getAppGitCredential(appId: string) {
      const resolved = await this.resolveAppGitCredentialActor(appId);
      if (!resolved) return null;
      return forge.issueCredential(resolved.app as { id: string }, resolved.actorId, {
        readOnly: resolved.readOnly,
      });
    },

    /**
     * Authorize a write to an app's stored repo credential, and hand back the
     * client that can do it. Same gate as updateApp: `admin` on an app the
     * caller can already see, with the service role only for an admin grantee
     * that `apps_update_if_creator` would otherwise refuse.
     */
    async authorizeAppGitCredentialWrite(appId: string): Promise<{ cur: any; writer: any } | null> {
      const { data: cur, error } = await supabase
        .from("apps")
        .select("id, team_id, created_by_actor_id, git_remote_url, git_auth_kind")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!cur) return null;
      const permission = await this.resolveAppCallerPermissionForApp(cur);
      if (permission?.level !== "admin") return null;
      if (forge.hostsRepo(cur)) {
        throw new ApiError(
          409,
          "git_credential_not_applicable",
          "this app's repo is hosted by this deployment, which issues its own deploy keys",
        );
      }
      const callerIsCreator = await this.isAppCreator(cur);
      const writer = callerIsCreator
        ? supabase
        : await serviceRoleClient("write an app git credential authorized by an admin grant");
      return { cur, writer };
    },

    /**
     * Store (or replace) the token for an imported app's http(s) repo.
     *
     * The secret is written before the row names it, and deleted only after the
     * row stops naming it (clearAppGitHttpsCredential), so a row that says
     * `https_token` always has a secret behind it. The other order leaves a
     * window in which every fetch reads "no credential".
     */
    async setAppGitHttpsCredential(appId: string, input: unknown) {
      const gate = await this.authorizeAppGitCredentialWrite(appId);
      if (!gate) return null;
      const { authKind } = await forge.storeExternalCredential(gate.cur, input);
      const { data, error } = await gate.writer
        .from("apps")
        .update({ git_auth_kind: authKind, updated_at: new Date().toISOString() })
        .eq("id", appId)
        .select(APP_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return appView(data);
    },

    /** Forget an imported app's stored token. Idempotent. */
    async clearAppGitHttpsCredential(appId: string) {
      const gate = await this.authorizeAppGitCredentialWrite(appId);
      if (!gate) return null;
      const { data, error } = await gate.writer
        .from("apps")
        .update({ git_auth_kind: null, updated_at: new Date().toISOString() })
        .eq("id", appId)
        .select(APP_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      await forge.forgetExternalCredential(gate.cur);
      return appView(data);
    },

    /**
     * Hand a JIT key back the moment its holder is done with it
     * (`amuxd git-ssh` calls this as soon as ssh exits).
     *
     * Authorised exactly like minting, and the key must carry the caller's own
     * actor in its title — otherwise revoking would be a way to kill a push
     * another machine is in the middle of.
     */
    async revokeAppGitCredential(appId: string, credentialId: number) {
      const resolved = await this.resolveAppGitCredentialActor(appId);
      if (!resolved) return null;
      const { actorId } = resolved;
      const revoked = await forge.revokeCredential(resolved.app as { id: string }, actorId, credentialId);
      // `revoked: false` is not an error the caller can act on — the key is
      // unusable either way, which is the whole point of asking.
      return { revoked };
    },

    /**
     * Default-branch HEAD on the app's Gitea repo.
     *
     * `compare` is opt-in because the deploy path calls this on every deploy
     * and only wants the sha: doing the extra /compare round trip there would
     * buy a number nothing reads. The panel asks for it; the deploy does not.
     */
    async getAppGitHead(appId: string, opts: { compare?: boolean } = {}) {
      const { data: existing, error: selErr } = await supabase
        .from("apps")
        .select("id, git_auth_kind, git_commit_sha, git_remote_url")
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing) return null;
      // Null for a repo this deployment does not host: "we cannot see the
      // branch" is a legitimate, permanent state for an imported app.
      return forge.repoHead(existing, { compare: opts.compare === true });
    },

    async getAppMembership(appId: string) {
      const { data: userData, error: userErr } = await getCurrentUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      // Bypass apps RLS: membership is team-scoped, not visibility-scoped. A
      // logged-in user checking access to a deployed app may not pass
      // apps_select_if_visible yet still need a truthful member/non-member answer.
      const admin = await serviceRoleClient("read app team for membership check");
      const { data: row, error } = await admin
        .from("apps")
        .select("id, team_id")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!row) return null;
      const resolved = await this.resolveCurrentMemberActor(row.team_id, userId);
      return { member: Boolean(resolved?.id) };
    },

    /**
     * Creator or `admin` grant on this app — required to list/set/remove access.
     * Returns null when the app is not visible or the caller lacks manage rights
     * (routes surface 404 to avoid leaking app existence).
     */
    async resolveAppAccessManager(appId: string): Promise<{
      callerActorId: string;
      callerMemberId: string | null;
      teamId: string;
    } | null> {
      const { data: app, error } = await supabase
        .from("apps")
        .select("id, team_id, created_by_actor_id")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!app) return null;

      const permission = await this.resolveAppCallerPermissionForApp(app);
      if (!permission || permission.level !== "admin") return null;
      this.assertNotInheritedFor(permission, "manage_access");
      return {
        callerActorId: permission.callerActorId,
        callerMemberId: permission.callerMemberId,
        teamId: app.team_id,
      };
    },

    async listAppAccess(appId: string) {
      const manager = await this.resolveAppAccessManager(appId);
      if (!manager) return null;
      // RLS only exposes all rows to the creator; admin grantees see self only.
      // After the manage gate, read the full grant list with service role.
      const admin = await serviceRoleClient("list app member access");
      const { data, error } = await admin
        .from("app_member_access")
        .select("member_id, permission_level, granted_by_member_id, created_at")
        .eq("app_id", appId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const rows = data ?? [];

      // The agents that reach the app through their owner (20261120120000).
      // Listed after the grants, read-only: the way to take one away is to
      // take its owner's access away.
      const inheritedRows = await callAgentInheritance(admin, "app_inherited_agents", { p_app_id: appId });
      const granted = new Set(rows.map((r: any) => r.member_id));
      const inherited = ((inheritedRows ?? []) as any[]).filter(
        (r) => r.agent_id && !granted.has(r.agent_id) && storedAppPermissionLevel(r.permission_level),
      );

      // Who each grantee is: the access tab shows agents apart from people,
      // greys out an agent whose daemon never claimed an account, and shows
      // the NAME from here — the caller's own directory hides agents it may
      // not talk to, which left those rows as bare ids.
      const ids = [
        ...new Set(
          [
            ...rows.map((r: any) => r.member_id),
            ...inherited.flatMap((r) => [r.agent_id, r.owner_actor_id]),
          ].filter(Boolean),
        ),
      ];
      const actors = new Map<string, any>();
      if (ids.length > 0) {
        const found = await chunkedIn(ids, async (chunk) => {
          const { data: actorRows, error: actorErr } = await admin
            .from("actors")
            .select("id, actor_type, user_id, display_name")
            .in("id", chunk);
          if (actorErr) throw actorErr;
          return actorRows ?? [];
        });
        for (const a of found) actors.set(a.id, a);
      }
      const describe = (actorId: string) => {
        const actor = actors.get(actorId);
        return {
          actorType: actor?.actor_type ?? null,
          connected: actor ? actor.actor_type !== "agent" || !!actor.user_id : null,
          displayName: actor?.display_name ?? null,
        };
      };
      return [
        ...rows.map((r: any) => ({
          ...mapAppAccessRow(r),
          ...describe(r.member_id),
          inherited: false,
          inheritedFrom: null,
        })),
        ...inherited.map((r) => ({
          memberId: r.agent_id,
          permissionLevel: storedAppPermissionLevel(r.permission_level)!,
          grantedByMemberId: null,
          createdAt: null,
          ...describe(r.agent_id),
          inherited: true,
          inheritedFrom: { actorId: r.owner_actor_id, displayName: actors.get(r.owner_actor_id)?.display_name ?? null },
        })),
      ];
    },

    async setAppAccess(appId: string, memberId: string, permissionLevel: string) {
      const level = parseAppPermissionLevel(permissionLevel);
      const manager = await this.resolveAppAccessManager(appId);
      if (!manager) return null;
      // RLS manage policy is creator-only; admin grantees write via service role.
      const admin = await serviceRoleClient("manage app member access");
      // The grantee is any actor in the app's team — a member or an agent. The
      // database trigger enforces the team boundary; checking here first turns
      // its 23514 into a sentence the access tab can show, and catches an agent
      // that has no account yet (a device agent before its daemon claimed it),
      // which could hold the row but never act on it.
      const { data: grantee, error: granteeErr } = await admin
        .from("actors")
        .select("id, team_id, actor_type, user_id")
        .eq("id", memberId)
        .maybeSingle();
      if (granteeErr) throw granteeErr;
      if (!grantee || grantee.team_id !== manager.teamId
          || (grantee.actor_type !== "member" && grantee.actor_type !== "agent")) {
        throw new ApiError(422, "grantee_not_in_team", "the grantee must be a member or agent of the app's team");
      }
      if (grantee.actor_type === "agent" && !grantee.user_id) {
        throw new ApiError(422, "agent_not_connected", "this agent has no account yet; connect its daemon first");
      }
      const { data: priorAccess, error: priorErr } = await admin
        .from("app_member_access")
        .select("permission_level")
        .eq("app_id", appId)
        .eq("member_id", memberId)
        .maybeSingle();
      if (priorErr) throw priorErr;
      const now = new Date().toISOString();
      const { data, error } = await admin
        .from("app_member_access")
        .upsert(
          {
            app_id: appId,
            member_id: memberId,
            permission_level: level,
            granted_by_member_id: manager.callerActorId,
            updated_at: now,
          },
          { onConflict: "app_id,member_id" },
        )
        .select("member_id, permission_level, granted_by_member_id, created_at")
        .single();
      if (error) throw error;
      const priorLevel = storedAppPermissionLevel(priorAccess?.permission_level);
      if (level === "read" && priorLevel && appLevelAtLeast(priorLevel, "write")) {
        await forge.memberWriteRevoked(appId, memberId);
      }
      await forge.appAccessChanged(appId);
      scheduleAppAccessChanged(manager.teamId, appId, grantee);
      return mapAppAccessRow(data);
    },

    async removeAppAccess(appId: string, memberId: string) {
      const manager = await this.resolveAppAccessManager(appId);
      if (!manager) return null;
      const admin = await serviceRoleClient("manage app member access");
      // Who to tell, read before the row goes. A failed lookup only costs the
      // hint; the revoke itself must not depend on it.
      const { data: grantee, error: granteeErr } = await admin
        .from("actors")
        .select("actor_type, user_id")
        .eq("id", memberId)
        .maybeSingle();
      if (granteeErr) console.warn(`[app-access] grantee lookup for ${memberId} failed: ${granteeErr.message}`);
      const { error } = await admin
        .from("app_member_access")
        .delete()
        .eq("app_id", appId)
        .eq("member_id", memberId);
      if (error) throw error;
      await forge.memberWriteRevoked(appId, memberId);
      await forge.appAccessChanged(appId);
      scheduleAppAccessChanged(manager.teamId, appId, granteeErr ? null : grantee);
      return true;
    },

    // --- App file storage (design 2026-09-09-app-storage-design) ---
    //
    // Every human-facing operation goes through resolveAppStorageAccess, which
    // is the ONLY place the three tiers are compared. The app's own path
    // (mintAppStorageCredentials) deliberately does not use it: an app is not a
    // member and has no permission level, it has a token.

    async resolveAppStorageAccess(appId: string, minLevel: AppPermissionLevel) {
      const { data: app, error } = await supabase
        .from("apps")
        .select(
          "id, team_id, created_by_actor_id, oss_bucket, storage_bytes, storage_counted_at, storage_quota_bytes",
        )
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!app) return null;
      const permission = await this.resolveAppCallerPermissionForApp(app);
      if (!permission) return null;
      if (!appLevelAtLeast(permission.level, minLevel)) return null;
      return { app, level: permission.level };
    },

    /** 503 that names the missing variable rather than "not configured". */
    requireAppStorage(): AppStorageOps {
      if (!appStorage) {
        throw new ApiError(
          503,
          "app_storage_unavailable",
          appStorageUnavailableReason || "app file storage is not configured",
        );
      }
      return appStorage;
    },

    async listAppFiles(
      appId: string,
      query: {
        prefix?: string | null;
        after?: string | null;
        limit?: number;
        /** "/" to browse one level; absent lists every key under the prefix. */
        delimiter?: string | null;
      } = {},
    ) {
      const access = await this.resolveAppStorageAccess(appId, "read");
      if (!access) return null;
      const ops = this.requireAppStorage();
      const bucket = ops.bucketFor(access.app);
      // A caller-supplied prefix filters WITHIN the app's own space; it is
      // appended to the app prefix and can never replace it.
      const sub = normalizeAppFolderPrefix(query.prefix);
      const page = await ops.list(bucket, `${appFilesPrefix(appId)}${sub}`, {
        after: query.after ?? null,
        limit: query.limit,
        delimiter: query.delimiter ?? null,
      });
      // Paths come back relative to the filtered prefix; re-attach the caller's
      // sub-prefix so what the client sees is always relative to the app root.
      const items = sub ? page.items.map((e) => ({ ...e, path: `${sub}${e.path}` })) : page.items;
      const folders = sub ? page.folders.map((f) => `${sub}${f}`) : page.folders;
      return {
        items,
        folders,
        nextCursor: page.nextCursor,
        canWrite: access.level !== "read",
      };
    },

    /**
     * Delete everything under one folder.
     *
     * `write` and above, matching a single file's delete — a folder is not a
     * different kind of thing in an object store, it is a prefix, and someone
     * who may delete each of its files one at a time may delete them together.
     *
     * The empty prefix is REFUSED here: that is the whole app, and wiping the
     * app's storage is `purgeAppFiles`, which is admin-only and asks first.
     */
    async deleteAppFolder(appId: string, prefix: string) {
      const access = await this.resolveAppStorageAccess(appId, "write");
      if (!access) return null;
      const sub = normalizeAppFolderPrefix(prefix);
      if (!sub) {
        throw new ApiError(
          400,
          "validation_failed",
          "a folder prefix is required; use the purge endpoint to empty the whole app",
        );
      }
      const ops = this.requireAppStorage();
      const deleted = await ops.removePrefix(ops.bucketFor(access.app), `${appFilesPrefix(appId)}${sub}`);
      return { deleted };
    },

    async getAppStorageUsage(appId: string) {
      const access = await this.resolveAppStorageAccess(appId, "read");
      if (!access) return null;
      const ops = this.requireAppStorage();
      const quotaBytes = access.app.storage_quota_bytes ?? ops.defaultQuotaBytes;
      return {
        bytes: access.app.storage_bytes ?? null,
        countedAt: access.app.storage_counted_at ?? null,
        quotaBytes,
        overQuota: isOverQuota(access.app.storage_bytes, quotaBytes),
      };
    },

    /**
     * Re-measure and persist. Called by the control panel on demand and by the
     * sweep; both write through the service role because `storage_bytes` is a
     * platform-owned fact and no RLS policy lets a member set it.
     */
    async refreshAppStorageUsage(appId: string) {
      const access = await this.resolveAppStorageAccess(appId, "read");
      if (!access) return null;
      const ops = this.requireAppStorage();
      const usage = await ops.measure(ops.bucketFor(access.app), appFilesPrefix(appId));
      const admin = await serviceRoleClient("record app storage usage");
      const countedAt = new Date().toISOString();
      const { error } = await admin
        .from("apps")
        .update({ storage_bytes: usage.bytes, storage_counted_at: countedAt })
        .eq("id", appId);
      if (error) throw error;
      const quotaBytes = access.app.storage_quota_bytes ?? ops.defaultQuotaBytes;
      return {
        bytes: usage.bytes,
        objects: usage.objects,
        truncated: usage.truncated,
        countedAt,
        quotaBytes,
        overQuota: isOverQuota(usage.bytes, quotaBytes),
      };
    },

    async createAppFileUploadUrl(appId: string, input: { path: string; contentType?: string | null }) {
      const access = await this.resolveAppStorageAccess(appId, "write");
      if (!access) return null;
      const ops = this.requireAppStorage();
      const quotaBytes = access.app.storage_quota_bytes ?? ops.defaultQuotaBytes;
      if (isOverQuota(await usageForQuotaDecision(access.app, ops, quotaBytes), quotaBytes)) {
        throw new ApiError(409, "app_storage_quota_exceeded", "this app is over its storage quota");
      }
      let key: string;
      try {
        key = appFileKey(appId, input.path);
      } catch (e) {
        throw new ApiError(400, "validation_failed", (e as Error).message);
      }
      const bucket = ops.bucketFor(access.app);
      return { url: await ops.signUpload(bucket, key, input.contentType ?? null), path: input.path, expiresIn: 900 };
    },

    async createAppFileDownloadUrl(appId: string, path: string) {
      const access = await this.resolveAppStorageAccess(appId, "read");
      if (!access) return null;
      const ops = this.requireAppStorage();
      let key: string;
      try {
        key = appFileKey(appId, path);
      } catch (e) {
        throw new ApiError(400, "validation_failed", (e as Error).message);
      }
      const bucket = ops.bucketFor(access.app);
      const head = await ops.head(bucket, key);
      if (!head) throw new ApiError(404, "not_found", "no such file");
      return {
        url: await ops.signDownload(bucket, key, path.split("/").pop() ?? null),
        size: head.size,
        contentType: head.contentType,
        expiresIn: 900,
      };
    },

    async deleteAppFile(appId: string, path: string) {
      const access = await this.resolveAppStorageAccess(appId, "write");
      if (!access) return null;
      const ops = this.requireAppStorage();
      let key: string;
      try {
        key = appFileKey(appId, path);
      } catch (e) {
        throw new ApiError(400, "validation_failed", (e as Error).message);
      }
      await ops.remove(ops.bucketFor(access.app), key);
      return { ok: true as const };
    },

    /**
     * Delete everything the app has stored. `admin` only, and it is the one
     * storage operation that is not reversible - the design keeps files when an
     * app is DELETED precisely because we have no backup, so the deliberate
     * version of that action has to sit behind the highest tier.
     */
    async purgeAppFiles(appId: string) {
      const access = await this.resolveAppStorageAccess(appId, "admin");
      if (!access) return null;
      const ops = this.requireAppStorage();
      const deleted = await ops.removePrefix(ops.bucketFor(access.app), appFilesPrefix(appId));
      const admin = await serviceRoleClient("reset app storage usage");
      const { error } = await admin
        .from("apps")
        .update({ storage_bytes: 0, storage_counted_at: new Date().toISOString() })
        .eq("id", appId);
      if (error) throw error;
      return { deleted };
    },

    async setAppStorageQuota(appId: string, quotaBytes: number | null) {
      const access = await this.resolveAppStorageAccess(appId, "admin");
      if (!access) return null;
      if (quotaBytes != null && (!Number.isFinite(quotaBytes) || quotaBytes < 0)) {
        throw new ApiError(400, "validation_failed", "quotaBytes must be a non-negative number or null");
      }
      const admin = await serviceRoleClient("set app storage quota");
      const { error } = await admin
        .from("apps")
        .update({ storage_quota_bytes: quotaBytes == null ? null : Math.floor(quotaBytes) })
        .eq("id", appId);
      if (error) throw error;
      const ops = this.requireAppStorage();
      return { quotaBytes: quotaBytes == null ? ops.defaultQuotaBytes : Math.floor(quotaBytes) };
    },

    /**
     * The app's own path. Runs on a service-role repository behind
     * `auth: "app-token"`, which authenticates NOTHING - this method is the
     * whole gate, so it must stay boring: constant-time compare, one failure
     * shape, no token in any error or log.
     */
    async mintAppStorageCredentials(appId: string, token: string) {
      const ops = this.requireAppStorage();
      const admin = await serviceRoleClient("mint app storage credentials");
      const expected = await getAppSecretSupabase(admin, appId, APP_STORAGE_TOKEN_KIND);
      if (!expected || !constantTimeEquals(expected, token)) return null;
      const { data: app, error } = await admin
        .from("apps")
        .select("id, oss_bucket, storage_bytes, storage_quota_bytes")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!app) return null;
      const quotaBytes = app.storage_quota_bytes ?? ops.defaultQuotaBytes;
      if (isOverQuota(await usageForQuotaDecision(app, ops, quotaBytes), quotaBytes)) {
        // 409 rather than 403: the app is who it says it is, it just has no
        // room. A 403 would send whoever debugs it hunting for a policy bug.
        throw new ApiError(409, "app_storage_quota_exceeded", "this app is over its storage quota");
      }
      const credentials = await ops.assume(app);
      return { credentials };
    },



    // ─── App environment (design 2026-09-10-app-control-panel §9) ───────────
    //
    // Read is the `write` tier: the people who write the app's code are the
    // ones who need to know what its environment contains. Writing is `admin`,
    // like every other app mutation. A secret's value is never returned to
    // anyone, including the person who set it.

    /** The app row plus the caller's level, when it reaches `minLevel`. */
    async resolveAppEnvAccess(appId: string, minLevel: AppPermissionLevel) {
      const { data: app, error } = await supabase
        .from("apps")
        .select("id, team_id, created_by_actor_id")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!app) return null;
      const permission = await this.resolveAppCallerPermissionForApp(app);
      if (!permission) return null;
      if (!appLevelAtLeast(permission.level, minLevel)) return null;
      return { app, level: permission.level, callerMemberId: permission.callerMemberId };
    },

    async listAppEnv(appId: string) {
      const access = await this.resolveAppEnvAccess(appId, "write");
      if (!access) return null;
      // `ciphertext` is deliberately not selected. RLS is row-level, so this
      // reader could ask for it; not asking is what keeps a sealed value from
      // ever being one refactor away from a response body.
      const { data, error } = await supabase
        .from("app_env_vars")
        .select("key, is_secret, value, updated_at")
        .eq("app_id", appId)
        .order("key", { ascending: true });
      if (error) throw error;
      return {
        items: (data ?? []).map(mapAppEnvRow),
        // Carried in the list response the way listAppFiles carries it, so the
        // client learns what it may do without a second request.
        canWrite: access.level === "admin",
      };
    },

    async putAppEnv(appId: string, key: string, input: any) {
      const access = await this.resolveAppEnvAccess(appId, "admin");
      if (!access) return null;
      const name = parseEnvKey(key);
      const value = parseEnvValue(input?.value);
      const isSecret = Boolean(input?.isSecret);

      const admin = await serviceRoleClient("write app env");
      const { count, error: countErr } = await admin
        .from("app_env_vars")
        .select("key", { count: "exact", head: true })
        .eq("app_id", appId);
      if (countErr) throw countErr;
      const { data: existing, error: exErr } = await admin
        .from("app_env_vars")
        .select("key")
        .eq("app_id", appId)
        .eq("key", name)
        .maybeSingle();
      if (exErr) throw exErr;
      if (!existing && (count ?? 0) >= MAX_ENV_VARS_PER_APP) {
        throw new ApiError(
          400,
          "validation_failed",
          `an app can have at most ${MAX_ENV_VARS_PER_APP} environment variables`,
        );
      }

      const now = new Date().toISOString();
      const { data, error } = await admin
        .from("app_env_vars")
        .upsert(
          {
            app_id: appId,
            key: name,
            is_secret: isSecret,
            // Exactly one of the two, matching the table's check constraint.
            value: isSecret ? null : value,
            ciphertext: isSecret ? sealAppSecret(appEnvSecretKind(name), value) : null,
            updated_by_member_id: access.callerMemberId,
            updated_at: now,
          },
          { onConflict: "app_id,key" },
        )
        .select("key, is_secret, value, updated_at")
        .single();
      if (error) throw error;
      await touchAppEnv(admin, appId, now);
      return mapAppEnvRow(data);
    },

    async deleteAppEnv(appId: string, key: string) {
      const access = await this.resolveAppEnvAccess(appId, "admin");
      if (!access) return false;
      const admin = await serviceRoleClient("delete app env");
      const { data, error } = await admin
        .from("app_env_vars")
        .delete()
        .eq("app_id", appId)
        // Not parseEnvKey: a reserved or malformed name cannot be WRITTEN, but a
        // row that already holds one must still be removable.
        .eq("key", key)
        .select("key");
      if (error) throw error;
      if ((data ?? []).length === 0) return false;
      // A delete changes the environment as much as a write does, so it moves
      // the app back into "needs a redeploy" too.
      await touchAppEnv(admin, appId, new Date().toISOString());
      return true;
    },

    // ─── App scheduled tasks (design 2026-09-10-app-control-panel §5) ────────
    //
    // Reads are open to anyone the app has named (RLS lets a `read` grantee
    // select); writes need `admin` and go through the service role, exactly
    // like the member-access grants above — the RLS manage policy is
    // creator-only and an admin grantee is not the creator.

    /** The one place a job's user-supplied fields are validated. */
    normalizeAppCronInput(input: any, existing: any = null) {
      const pick = (key: string, fallback: any) =>
        input[key] === undefined ? fallback : input[key];

      const name = String(pick("name", existing?.name) ?? "").trim();
      if (!name || name.length > 120) {
        throw new ApiError(400, "validation_failed", "name must be 1-120 characters");
      }

      const schedule = String(pick("schedule", existing?.schedule_expr) ?? "").trim();
      const timezone = String(pick("timezone", existing?.timezone) ?? "UTC").trim() || "UTC";
      assertTimeZone(timezone);
      parseCronExpression(schedule); // throws 400 on a bad expression

      const method = String(pick("method", existing?.method) ?? "GET").trim().toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
        throw new ApiError(400, "validation_failed", `method ${method} is not supported`);
      }

      let path = String(pick("path", existing?.path) ?? "/").trim();
      if (!path.startsWith("/")) {
        throw new ApiError(400, "validation_failed", 'path must start with "/"');
      }
      if (path.length > 512) {
        throw new ApiError(400, "validation_failed", "path is too long");
      }

      const rawHeaders = pick("headers", existing?.headers) ?? {};
      if (typeof rawHeaders !== "object" || rawHeaders === null || Array.isArray(rawHeaders)) {
        throw new ApiError(400, "validation_failed", "headers must be an object");
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (typeof v !== "string") {
          throw new ApiError(400, "validation_failed", `header ${k} must be a string`);
        }
        headers[k] = v;
      }
      if (Object.keys(headers).length > 20) {
        throw new ApiError(400, "validation_failed", "at most 20 headers");
      }

      const rawBody = pick("body", existing?.body);
      if (rawBody !== null && rawBody !== undefined && typeof rawBody !== "string") {
        throw new ApiError(400, "validation_failed", "body must be a string or null");
      }
      if (typeof rawBody === "string" && rawBody.length > 64 * 1024) {
        throw new ApiError(400, "validation_failed", "body is larger than 64 KiB");
      }

      const timeoutMs = Number(pick("timeoutMs", existing?.timeout_ms) ?? 30000);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
        throw new ApiError(400, "validation_failed", "timeoutMs must be between 1000 and 60000");
      }

      const enabledRaw = pick("enabled", existing?.enabled ?? true);
      const enabled = enabledRaw === undefined ? true : Boolean(enabledRaw);

      return {
        name,
        enabled,
        schedule_expr: schedule,
        timezone,
        method,
        path,
        headers,
        body: rawBody ?? null,
        timeout_ms: timeoutMs,
        // A disabled job has no next fire. Recomputing it on enable is what
        // keeps a job that was off for a month from firing the instant it comes
        // back for every occurrence it missed.
        next_run_at: enabled ? computeNextRun(schedule, timezone, new Date())?.toISOString() ?? null : null,
      };
    },

    async listAppCronJobs(appId: string) {
      const { data: app, error: appErr } = await supabase
        .from("apps")
        .select("id, team_id, created_by_actor_id")
        .eq("id", appId)
        .maybeSingle();
      if (appErr) throw appErr;
      if (!app) return null;
      if (!(await this.resolveAppCallerPermissionForApp(app))) return null;

      const { data, error } = await supabase
        .from("app_cron_jobs")
        .select("*")
        .eq("app_id", appId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(mapAppCronJobRow);
    },

    /** admin on this app, or null. The gate for every cron write. */
    async resolveAppCronManager(appId: string) {
      const { data: app, error } = await supabase
        .from("apps")
        .select("id, team_id, created_by_actor_id")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!app) return null;
      const permission = await this.resolveAppCallerPermissionForApp(app);
      if (!permission || permission.level !== "admin") return null;
      return { callerMemberId: permission.callerMemberId };
    },

    async createAppCronJob(appId: string, input: any) {
      const manager = await this.resolveAppCronManager(appId);
      if (!manager) return null;
      const fields = this.normalizeAppCronInput(input ?? {});

      const admin = await serviceRoleClient("create app cron job");
      const { count, error: countErr } = await admin
        .from("app_cron_jobs")
        .select("id", { count: "exact", head: true })
        .eq("app_id", appId);
      if (countErr) throw countErr;
      // A ceiling rather than a rate limit: 20 jobs on a one-minute floor is
      // already 20 requests a minute against one function, and anything past
      // that is a workload the app should be scheduling internally.
      if ((count ?? 0) >= 20) {
        throw new ApiError(400, "validation_failed", "an app can have at most 20 scheduled tasks");
      }

      const { data, error } = await admin
        .from("app_cron_jobs")
        .insert({ ...fields, app_id: appId, created_by_member_id: manager.callerMemberId })
        .select("*")
        .single();
      if (error) throw error;
      return mapAppCronJobRow(data);
    },

    async updateAppCronJob(appId: string, jobId: string, patch: any) {
      const manager = await this.resolveAppCronManager(appId);
      if (!manager) return null;

      const admin = await serviceRoleClient("update app cron job");
      const { data: existing, error: selErr } = await admin
        .from("app_cron_jobs")
        .select("*")
        .eq("id", jobId)
        .eq("app_id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing) return null;

      const fields = this.normalizeAppCronInput(patch ?? {}, existing);
      const { data, error } = await admin
        .from("app_cron_jobs")
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("app_id", appId)
        .select("*")
        .single();
      if (error) throw error;
      return mapAppCronJobRow(data);
    },

    async deleteAppCronJob(appId: string, jobId: string) {
      const manager = await this.resolveAppCronManager(appId);
      if (!manager) return false;
      const admin = await serviceRoleClient("delete app cron job");
      const { data, error } = await admin
        .from("app_cron_jobs")
        .delete()
        .eq("id", jobId)
        .eq("app_id", appId)
        .select("id");
      if (error) throw error;
      return (data ?? []).length > 0;
    },

    /**
     * Fire a job right now, without touching its schedule.
     *
     * `next_run_at` is deliberately left alone: "run it now" is a test, and
     * moving the schedule because someone pressed a button would make the next
     * scheduled run happen at a time nobody chose.
     */
    async runAppCronJobNow(appId: string, jobId: string) {
      const manager = await this.resolveAppCronManager(appId);
      if (!manager) return null;
      const admin = await serviceRoleClient("run app cron job");
      const { data: job, error } = await admin
        .from("app_cron_jobs")
        .select(CRON_JOB_COLUMNS)
        .eq("id", jobId)
        .eq("app_id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!job) return null;
      return executeAppCronJob(admin, job, {});
    },

    async listAppCronRuns(appId: string, jobId: string, limit = 20) {
      const { data: app, error: appErr } = await supabase
        .from("apps")
        .select("id, team_id, created_by_actor_id")
        .eq("id", appId)
        .maybeSingle();
      if (appErr) throw appErr;
      if (!app) return null;
      if (!(await this.resolveAppCallerPermissionForApp(app))) return null;

      const { data, error } = await supabase
        .from("app_cron_runs")
        .select("id, job_id, started_at, finished_at, status, response_status, duration_ms, error")
        .eq("app_id", appId)
        .eq("job_id", jobId)
        .order("started_at", { ascending: false })
        .limit(Math.min(Math.max(limit, 1), 100));
      if (error) throw error;
      return (data ?? []).map(mapAppCronRunRow);
    },

    async undeployApp(appId: string) {
      const { data: app, error } = await supabase.from("apps")
        .select("id, slug, app_code, function_naming_mode, team_id, created_by_actor_id, fc_status, fc_endpoint, fc_function_name, env_deployed_at, custom_domain, uses_app_code_domain, deploy_started_at, deploy_token")
        .eq("id", appId).maybeSingle();
      if (error) throw error;
      if (!app) return null;
      const permission = await this.resolveAppCallerPermissionForApp(app);
      if (!permission || permission.level !== "admin") return null;
      validateAllocatedAppIdentity(app, true);
      const originDomain = appDeploymentOriginHost(appFunctionTargetFromRow(app), app.fc_endpoint);
      const admin = await serviceRoleClient("app deployment lifecycle");
      // An abandoned deploy would otherwise hold the lock against uninstall
      // forever. Not stale, or still live: begin_app_lifecycle refuses below.
      await reclaimStaleDeploy(supabaseReclaimStore(admin), appId,
        { fcStatus: app.fc_status, deployStartedAt: app.deploy_started_at, deployToken: app.deploy_token });
      const operation = await lifecycleRpc(admin, "begin_app_lifecycle", { p_app_id: appId, p_kind: "undeploy", p_token: null, p_origin_domain: originDomain });
      if (!operation) throw new ApiError(409, "not_deployed", "app has no deployment to uninstall");
      invalidateAppHosts({ id: appId, slug: app.slug, appCode: app.app_code, usesAppCodeDomain: app.uses_app_code_domain, customDomain: app.custom_domain });
      return { app: await this.getApp(appId), operation: operationView(operation) };
    },

    async deleteApp(appId: string) {
      const { data: existing, error: selErr } = await supabase
        .from("apps")
        .select(
          "id, team_id, workspace_id, slug, name, app_code, function_naming_mode, uses_app_code_domain, fc_status, fc_endpoint, env_deployed_at, start_spec, undeploy_operation, fc_function_name, auth_mode, oauth_client_id, git_auth_kind, git_remote_url, created_by_actor_id, custom_domain",
        )
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing) return false;

      const permission = await this.resolveAppCallerPermissionForApp(existing);
      if (!permission || permission.level !== "admin") return false;
      this.assertNotInheritedFor(permission, "delete_app");

      const assertUninstalled = (app: any) => {
        const neverDeployed = (app.fc_status == null || app.fc_status === "not_deployed")
          && !app.fc_endpoint && !app.env_deployed_at && !app.start_spec;
        const uninstalled = app.fc_status === "uninstalled"
          && app.undeploy_operation?.status === "succeeded";
        if (!neverDeployed && !uninstalled) {
          throw new ApiError(409, "app_uninstall_required", "Uninstall the deployment successfully before deleting this app.");
        }
      };
      validateAllocatedAppIdentity(existing);
      appDeploymentOriginHost(appFunctionTargetFromRow(existing), existing.fc_endpoint);
      assertUninstalled(existing);

      const admin = await serviceRoleClient("delete app and archive workspace");
      const deletion = await lifecycleRpc(admin, "begin_app_lifecycle", { p_app_id: appId, p_kind: "delete", p_token: null });
      const { data: acquired, error: acquireError } = await admin.from("app_lifecycle_operations")
        .update({ status: "running", in_flight: true, updated_at: new Date().toISOString() })
        .eq("id", deletion.id).eq("status", "pending").eq("in_flight", false).select("id").maybeSingle();
      if (acquireError) throw acquireError;
      if (!acquired) throw new ApiError(409, "lifecycle_conflict", "app deletion already running");
      try {
      // Recheck under the lifecycle lock to prevent a concurrent deploy race.
      const { data: lockedApp, error: lockedError } = await admin.from("apps")
        .select("fc_status, fc_endpoint, env_deployed_at, start_spec, undeploy_operation")
        .eq("id", appId).maybeSingle();
      if (lockedError) throw lockedError;
      if (!lockedApp) throw new ApiError(404, "not_found", "app not found");
      assertUninstalled(lockedApp);
      const teardownInput = {
        appId,
        ...appFunctionTargetFromRow(existing),
        fcEndpoint: existing.fc_endpoint,
        fcFunctionName: existing.fc_function_name,
        authMode: existing.auth_mode,
        oauthClientId: existing.oauth_client_id,
        gitRemoteUrl: existing.git_remote_url,
      };
      const teardown: TeardownAppDeps = {
        // Explicit uninstall already removed deployment resources.
        releaseRepo: () => forge.releaseRepo(existing),
        deleteSecret: (kind) => deleteAppSecretSupabase(admin, appId, kind),
      };
      const { archivedRepoUrl } = await teardownAppResources(teardown, teardownInput);

      if (existing.workspace_id) {
        const now = new Date().toISOString();
        const { error: wsErr } = await admin
          .from("workspaces")
          .update({
            archived: true,
            path: archivedRepoUrl ?? existing.git_remote_url,
            updated_at: now,
          })
          .eq("id", existing.workspace_id);
        if (wsErr) throw wsErr;
        await archiveSessionsForWorkspace(admin, existing.workspace_id);
      }

      const { error: delErr } = await admin.from("apps").delete().eq("id", appId);
      if (delErr) throw delErr;
      invalidateAppHosts({ id: appId, slug: existing.slug, appCode: existing.app_code, usesAppCodeDomain: existing.uses_app_code_domain, customDomain: existing.custom_domain });
      return true;
      } catch (error: any) {
        // A known failure can be retried. A transport failure remains fenced.
        const unknown = /timeout|timedout|etimedout|econnreset/i.test(String(error?.code ?? ""));
        await admin.from("app_lifecycle_operations").update({ status: "failed", in_flight: unknown,
          error: unknown ? "Provider outcome unknown; operator reconciliation required." : "App deletion failed; retry deletion.",
          updated_at: new Date().toISOString() }).eq("id", deletion.id);
        throw error;
      }
    },
  };
}
