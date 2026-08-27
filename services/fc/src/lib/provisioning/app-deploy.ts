import { randomBytes } from "node:crypto";
import { ensureAppSchema } from "./app-postgres.js";
import { appPublicUrl } from "../apps-public-host.js";
import { ApiError } from "../http-utils.js";

/** Git commit SHA — 7–40 lowercase/uppercase hex (short or full). */
export const GIT_COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

const DEPLOY_IN_PROGRESS = new Set(["awaiting_build", "building", "deploying"]);
export const STALE_DEPLOY_MS = 30 * 60 * 1000;

export function parseGitCommitSha(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "validation_failed", "gitCommitSha must be a string");
  }
  const sha = raw.trim();
  if (!GIT_COMMIT_SHA_RE.test(sha)) {
    throw new ApiError(400, "validation_failed", "gitCommitSha must be 7–40 hexadecimal characters");
  }
  return sha.toLowerCase();
}

/**
 * {@link parseGitCommitSha} where an absent value is allowed.
 *
 * An app imported from someone else's repo has no Gitea repo and no credential
 * for the origin it came from, so its deploy builds the workdir as it sits and
 * has no forge commit to pin itself to.
 */
export function parseOptionalGitCommitSha(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" && !raw.trim()) return null;
  return parseGitCommitSha(raw);
}

export function parseDeployToken(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ApiError(400, "validation_failed", "deployToken is required");
  }
  return raw.trim();
}

type DeployGateRow = {
  id: string;
  slug: string;
  runtime?: string | null;
  authMode?: string | null;
  auth_mode?: string | null;
};

function authModeOf(row: DeployGateRow): string {
  return row.authMode ?? row.auth_mode ?? "none";
}

function runtimeOf(row: DeployGateRow): string {
  return row.runtime ?? "node";
}

/** Shared deploy/finalize preconditions — runtime and auth mode. */
export function assertDeployAllowed(row: DeployGateRow): void {
  if (runtimeOf(row) !== "node") {
    throw new ApiError(409, "unsupported_runtime", "container runtime deploy is not supported yet");
  }
  const authMode = authModeOf(row);
  if (authMode === "third") {
    throw new ApiError(409, "unsupported_auth_mode", "third-party login is not supported for deploy yet");
  }
  if (authMode === "platform" && !appPublicUrl(row.slug, row.id)) {
    throw new ApiError(409, "vanity_required", "platform auth requires an apps public domain");
  }
}

/**
 * Deliberately NOT `DeployGateRow & {…}`: the progress check reads only the
 * deploy-lifecycle columns, and requiring `id`/`slug` here forced callers to
 * hand over a whole row they had no other use for — the supabase backend
 * passed the two columns it actually selects and failed the build's typecheck.
 */
type DeployProgressRow = {
  fcStatus?: string | null;
  fc_status?: string | null;
  deployStartedAt?: Date | string | null;
  deploy_started_at?: Date | string | null;
};

function fcStatusOf(row: DeployProgressRow): string | null {
  return row.fcStatus ?? row.fc_status ?? null;
}

function deployStartedAtOf(row: DeployProgressRow): Date | null {
  const v = row.deployStartedAt ?? row.deploy_started_at;
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

/**
 * An in-progress deploy old enough to be abandoned.
 *
 * Every in-progress status counts, not just `awaiting_build`. `finalizeDeploy`
 * writes `deploying` before calling the FC provisioner, so a process killed at
 * that point left a row no later deploy could ever get past: the staleness
 * escape did not apply to `deploying`, `checkDeployInProgress` answered
 * "blocked" for all time, and every subsequent deploy 409'd with no admin path
 * to reset it.
 */
export function isStaleDeploy(
  fcStatus: string | null | undefined,
  deployStartedAt: Date | null,
  now = Date.now(),
): boolean {
  if (!fcStatus || !DEPLOY_IN_PROGRESS.has(fcStatus) || !deployStartedAt) return false;
  return now - deployStartedAt.getTime() > STALE_DEPLOY_MS;
}

/** @deprecated Use {@link isStaleDeploy}; kept for the narrower original name. */
export function isStaleAwaitingBuild(
  fcStatus: string | null | undefined,
  deployStartedAt: Date | null,
  now = Date.now(),
): boolean {
  if (fcStatus !== "awaiting_build") return false;
  return isStaleDeploy(fcStatus, deployStartedAt, now);
}

/** Whether a new deploy may start, must reclaim a stale attempt, or is blocked. */
export function checkDeployInProgress(row: DeployProgressRow): "ok" | "stale" | "blocked" {
  const fcStatus = fcStatusOf(row);
  if (!fcStatus || !DEPLOY_IN_PROGRESS.has(fcStatus)) return "ok";
  if (isStaleDeploy(fcStatus, deployStartedAtOf(row))) return "stale";
  return "blocked";
}

export function appFunctionName(appId: string): string { return `tc-app-${appId}`; }
export function appOssObjectName(appId: string): string { return `apps/${appId}/code.zip`; }

/**
 * 503 for a deploy attempt on a deployment that cannot provision.
 *
 * `reason` comes from makeDeployDeps and names the empty variable. Without it
 * this answered a bare "deploy provisioning not configured", which is what the
 * user saw in a toast and what got written into `apps.provision_error` — true,
 * and useless for finding out which of APPS_ACCESS_KEY_ID / APPS_OSS_BUCKET /
 * APPS_FC_ENDPOINT was the empty one.
 */
export function deployUnavailable(reason?: string): ApiError {
  return new ApiError(
    503,
    "deploy_unavailable",
    reason ? `deploy provisioning not configured: ${reason}` : "deploy provisioning not configured",
  );
}

// --- Deploy is two calls with a daemon build in between:
//
//   startDeploy  → mint the OSS upload handle; the daemon builds and PUTs there
//   finalizeDeploy → provision the schema, point the function at the uploaded
//                    code with a matching DATABASE_URL, ensure the HTTP trigger
//
// The FC function is created in finalize, NOT in startDeploy. Creating it first
// meant CreateFunction referenced an OSS object the daemon had not uploaded yet,
// and it also forced finalize into a code-only update that had to assume FC
// preserved the environment it could no longer see. Doing both in one step at
// finalize means the code object always exists and the env is always written
// alongside the password that was just set.

export interface StartDeployDeps {
  mintUploadUrl: (ossObjectName: string) => Promise<string>;
}
export interface StartDeployInput { appId: string; region: string; }
export interface StartDeployResult {
  fcFunctionName: string; fcRegion: string; ossObjectName: string; presignedPut: string;
}

export async function startDeploy(deps: StartDeployDeps, input: StartDeployInput): Promise<StartDeployResult> {
  const ossObjectName = appOssObjectName(input.appId);
  const presignedPut = await deps.mintUploadUrl(ossObjectName);
  return {
    fcFunctionName: appFunctionName(input.appId),
    fcRegion: input.region,
    ossObjectName,
    presignedPut,
  };
}

export interface FinalizeDeps {
  /** Absent when apps Postgres is unconfigured — only `data_app` needs it. */
  adminExec?: (sql: string) => Promise<void>;
  fcOps: {
    ensureFunction: (name: string, a: { ossObjectName: string; env: Record<string, string> }) => Promise<void>;
    ensureHttpTrigger: (name: string) => Promise<string>;
  };
  appsBaseUrl?: string;
  genPassword?: () => string;
  extraEnv?: (input: FinalizeInput) => Record<string, string>;
}
export interface FinalizeInput {
  appId: string;
  slug: string;
  /** `static_web` / `slides` / `data_app`. Unknown values mean `data_app` —
   *  that is what every app created before types existed actually is. */
  appType: string;
  fcFunctionName: string;
  ossObjectName: string;
  /** Injected by the repo when auth_mode=platform (§6.5). No service role. */
  platformOAuthEnv?: Record<string, string>;
}

/** Only data apps get a Postgres schema; the other types are static files. */
export function needsDatabase(appType: string): boolean {
  const t = appType.trim();
  return t !== "static_web" && t !== "slides";
}

export async function finalizeDeploy(deps: FinalizeDeps, input: FinalizeInput): Promise<{ fcEndpoint: string }> {
  const env: Record<string, string> = { PORT: "9000", NODE_ENV: "production" };

  if (needsDatabase(input.appType)) {
    if (!deps.adminExec || !deps.appsBaseUrl) {
      throw new Error("apps database is not configured (APPS_DB_ADMIN_URL)");
    }
    // ensureAppSchema rotates the role password on every call, so the
    // connection string it returns is only valid if we write it into the
    // function env in the same breath — which is what ensureFunction does.
    const password = (deps.genPassword ?? (() => randomBytes(18).toString("base64url")))();
    const conn = await ensureAppSchema(deps.adminExec, {
      appId: input.appId, slug: input.slug, password, baseUrl: deps.appsBaseUrl,
    });
    env.DATABASE_URL = conn.connectionString;
  }

  if (input.platformOAuthEnv) Object.assign(env, input.platformOAuthEnv);
  if (deps.extraEnv) Object.assign(env, deps.extraEnv(input));

  await deps.fcOps.ensureFunction(input.fcFunctionName, {
    ossObjectName: input.ossObjectName,
    env,
  });
  const fcEndpoint = await deps.fcOps.ensureHttpTrigger(input.fcFunctionName);
  return { fcEndpoint };
}
