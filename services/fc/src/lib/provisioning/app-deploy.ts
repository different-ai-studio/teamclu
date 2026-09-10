import { appFcRouteHost, appPublicLabel, appPublicUrl } from "../apps-public-host.js";
import { randomBytes } from "node:crypto";
import {
  provisionAppPostgres,
  readAppsAdminUrl,
  readAppsAppUrl,
  resolveAppConnectionString,
} from "./app-postgres.js";
import {
  readAppsFcVpcConfig,
} from "./fc-client.js";
import {
  BUILD_KINDS,
  isContainerKind,
  type AppDeployDeclaration,
} from "./app-runtime-spec.js";
import { ApiError } from "../http-utils.js";
import { needsDatabase } from "../validation/app-type.js";

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

/**
 * The image reference a container deploy finished with.
 *
 * Required for a container app and refused for any other: an archive deploy
 * that carried an image would be a client sending the result of a different
 * build, and pointing a function at it is how the wrong code goes live.
 */
export function parseDeployedImage(
  raw: unknown,
  declaration: AppDeployDeclaration,
): string | undefined {
  const image = typeof raw === "string" ? raw.trim() : "";
  if (!isContainerKind(declaration.build.kind)) {
    if (image) {
      throw new ApiError(400, "validation_failed", "image is only accepted for a container runtime");
    }
    return undefined;
  }
  if (!image) {
    throw new ApiError(400, "validation_failed", "a container deploy must finalize with its image");
  }
  return image;
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

/**
 * Shared deploy/finalize preconditions — runtime and auth mode.
 *
 * The runtime check used to refuse anything but `node` outright. It no longer
 * can: a container app is a supported shape, and whether THIS deployment can
 * build one depends on a registry config that is not in the row. That question
 * is answered where the deploy handle is minted (`startDeploy`), which is also
 * the only place that can name the missing variable.
 */
export function assertDeployAllowed(row: DeployGateRow): void {
  const runtime = runtimeOf(row);
  if (!(BUILD_KINDS as readonly string[]).includes(runtime)) {
    throw new ApiError(
      409,
      "unsupported_runtime",
      `runtime "${runtime}" is not available on this deployment (have: ${BUILD_KINDS.join(", ")})`,
    );
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

/**
 * The Function Compute function backing one app.
 *
 * With a slug, this is the SAME label the app is served on
 * (`<slug>-<id8>`, e.g. `python-test-5c714425`), so the function and the
 * hostname can be matched by eye. Reading `tc-app-ed76a811-a3c8-4207-…` in the
 * FC console and `python-test-5c714425.apps.example.com` in a browser gave no
 * way to tell which was which without a database lookup.
 *
 * WITHOUT a slug it returns the original `tc-app-<uuid>`, and that fallback is
 * load-bearing rather than legacy: every already-deployed app stores its name in
 * `apps.fc_function_name`, and the paths that fall back to computing one
 * (delete, logs) must keep computing the name that app is actually running
 * under. A slug is passed only where a NEW function is being minted.
 *
 * The label is reused for a second reason: it is already punycode-encoded and
 * length-checked for DNS, which is strictly stricter than FC's own rule. The
 * one thing DNS allows and FC does not is a leading digit, so a slug starting
 * with one falls back too.
 */
export function appFunctionName(appId: string, slug?: string | null): string {
  const label = slug ? appPublicLabel(slug, appId) : null;
  if (label && /^[A-Za-z_]/.test(label)) return label;
  return `tc-app-${appId}`;
}
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
  /**
   * Registry handle for a container app. Absent on a deployment with no
   * registry configured — a node app deploys there exactly as before, and a
   * container app is refused with the variable to set.
   */
  mintImagePush?: (
    appId: string,
    gitCommitSha: string | null | undefined,
  ) => Promise<ImagePushHandle>;
  /** Why `mintImagePush` is absent, for the error a container app gets. */
  imagePushUnavailable?: string;
}

/** What the daemon needs to push this deploy's image, and nothing more. */
export interface ImagePushHandle {
  /** Full reference to push: `<registry>/<namespace>/<repo>:<tag>`. */
  reference: string;
  registry: string;
  username: string;
  password: string;
  expiresAt?: string;
}

export interface StartDeployInput {
  appId: string;
  region: string;
  /** Names the function after the app's own hostname label. Absent on a client
   *  that predates this, which then gets the `tc-app-<uuid>` shape. */
  slug?: string | null;
  /**
   * Build kind read by the daemon before the deploy is minted. It determines
   * whether the build receives an archive upload or image-push handle.
   */
  buildKind?: string;
  gitCommitSha?: string | null;
}
export interface StartDeployResult {
  fcFunctionName: string;
  fcRegion: string;
  /** Archive deploys only. */
  ossObjectName?: string;
  presignedPut?: string;
  /** Container deploys only. */
  image?: ImagePushHandle;
}

/**
 * Mint the handle this deploy's build will put its result into.
 *
 * Which one it is has to be decided here, before the build runs: an archive
 * travels through a presigned OSS upload and an image is pushed straight to the
 * registry, and the daemon cannot be handed both without having to guess which
 * deploy it is finishing.
 */
export async function startDeploy(deps: StartDeployDeps, input: StartDeployInput): Promise<StartDeployResult> {
  // The slug is what makes the function's name match the app's hostname. It is
  // only consulted here, where a function is first minted; everything later
  // reads `apps.fc_function_name` off the row.
  const base = {
    fcFunctionName: appFunctionName(input.appId, input.slug),
    fcRegion: input.region,
  };
  if (isContainerKind(input.buildKind ?? "")) {
    if (!deps.mintImagePush) {
      throw new ApiError(
        503,
        "deploy_unavailable",
        deps.imagePushUnavailable
          ? `container deploys are not configured: ${deps.imagePushUnavailable}`
          : "container deploys are not configured on this deployment",
      );
    }
    return { ...base, image: await deps.mintImagePush(input.appId, input.gitCommitSha) };
  }
  const ossObjectName = appOssObjectName(input.appId);
  const presignedPut = await deps.mintUploadUrl(ossObjectName);
  return { ...base, ossObjectName, presignedPut };
}

export interface FinalizeDeps {
  /**
   * Superuser / CREATEDB connection URL (typically `…/postgres` on self-host).
   * Absent → only static apps can finalize; data apps fail naming APPS_DB_ADMIN_URL.
   */
  appsAdminUrl?: string;
  /** Reachable Postgres base URL for rewriting app DATABASE_URL host. */
  appsAppUrl?: string;
  /** Optional override of {@link provisionAppPostgres} for tests. */
  provisionDb?: typeof provisionAppPostgres;
  /**
   * Whether a finalized image is one this app's own build could have pushed —
   * `imageBelongsToApp`, bound to this deployment's registry.
   *
   * Absent leaves the image unchecked, which is what a deployment with no
   * registry configured gets. That deployment has no container app to finalize
   * either: `startDeploy` refuses one before a build ever runs.
   */
  ownsImage?: (appId: string, image: string) => boolean;
  fcOps: {
    ensureFunction: (
      name: string,
      a: {
        ossObjectName: string;
        env: Record<string, string>;
        declaration?: AppDeployDeclaration;
        image?: string;
      },
    ) => Promise<void>;
    ensureHttpTrigger: (name: string) => Promise<string>;
    /** Absent on a deployment that has no route domain configured. */
    ensureCustomDomain?: (functionName: string, domainName: string) => Promise<string>;
  };
  genPassword?: () => string;
  extraEnv?: (input: FinalizeInput) => Record<string, string>;
  /**
   * Create the SLS project and logstore the function's `logConfig` points at.
   *
   * Called before the function is created, because Function Compute rejects a
   * `logConfig` naming a project that does not exist. Best-effort by contract:
   * see the call site.
   */
  ensureLogStore?: () => Promise<void>;
}
export interface FinalizeInput {
  appId: string;
  slug: string;
  /** `public.orgs.id` — required when the app needs a database. */
  orgId?: string | null;
  /** `static_web` / `slides` / `data_app`. Unknown values mean `data_app` —
   *  that is what every app created before types existed actually is. */
  appType: string;
  fcFunctionName: string;
  ossObjectName: string;
  /**
   * Injected by the repo when auth_mode=platform. Convenience for the app's own
   * code only — the login wall itself lives in the proxy. Never a service role.
   */
  platformAuthEnv?: Record<string, string>;
  /**
   * File-storage wiring for the app, built by the repo because minting the
   * token needs the service role (app_secrets). Same division of labour as
   * platformAuthEnv: this module composes the function's env, it does not own
   * any credential.
   */
  storageEnv?: Record<string, string>;
  /**
   * The operator's own variables (amux.app_env_vars), secrets already opened.
   * Applied UNDER everything the platform sets, never over it — see the merge
   * in finalizeDeploy.
   */
  userEnv?: Record<string, string>;
  /**
   * The daemon-validated build and start declaration. The FC client rejects an
   * absent value rather than inventing a Node start command.
   */
  declaration?: AppDeployDeclaration;
  /**
   * The image the build pushed, for a `container` app. Required for one:
   * there is no code object for that deploy, so a finalize without it would
   * point the function at whatever the previous deploy left in OSS.
   */
  image?: string;
}

// Lives with the rest of what a type means; re-exported for the callers that
// have always imported it from here.
export { needsDatabase };

// build+start declaration parsers — call sites migrate here before Task 2/3.
export {
  BUILD_KINDS,
  CONTAINER_RUNTIME_FC,
  FC_CODE_RUNTIMES,
  defaultLayersForKind,
  isContainerKind,
  layerArn,
  parseAppDeployDeclaration,
  parseDeclaredBuildKind,
  resolveLayers,
  type AppBuildKind,
  type AppBuildSpec,
  type AppDeployDeclaration,
  type AppStartSpec,
} from "./app-runtime-spec.js";

export async function finalizeDeploy(deps: FinalizeDeps, input: FinalizeInput): Promise<{ fcEndpoint: string }> {
  // First, before anything is provisioned. `parseDeployedImage` has already
  // checked that an image is present iff the runtime is `container`, but not
  // *which* image — and this value is what the function is pointed at. An
  // image the app's own build could not have pushed makes this a rejected
  // deploy, so it must not also be a half-provisioned one: past here a
  // Postgres schema is created and a log store ensured.
  if (input.image && deps.ownsImage && !deps.ownsImage(input.appId, input.image)) {
    throw new ApiError(
      400,
      "validation_failed",
      "image must name this app's own repository in this deployment's registry — finalize with the reference the build reported",
    );
  }

  const env: Record<string, string> = { NODE_ENV: "production" };
  if (input.declaration) {
    env.PORT = String(input.declaration.start.port);
  }

  if (needsDatabase(input.appType)) {
    const appsAdminUrl = deps.appsAdminUrl ?? readAppsAdminUrl();
    if (!appsAdminUrl) {
      throw new Error("apps database is not configured (APPS_DB_ADMIN_URL)");
    }
    const appsAppUrl = deps.appsAppUrl ?? readAppsAppUrl();
    if (appsAppUrl && !readAppsFcVpcConfig()) {
      throw new Error(
        "APPS_FC_VPC_ID, APPS_FC_VSWITCH_ID, and APPS_FC_SECURITY_GROUP_ID are required when APPS_DB_APP_URL is set — deployed app functions must join the App Postgres VPC",
      );
    }
    const orgId = input.orgId?.trim();
    if (!orgId) {
      throw new Error("data_app deploy requires the team's org (public.orgs.id)");
    }
    // provisionAppPostgres creates tc_org_<orgId> if needed, then a schema +
    // login role inside it. The password is only valid if we write it into the
    // function env in the same breath — which is what ensureFunction does.
    const password = (deps.genPassword ?? (() => randomBytes(18).toString("base64url")))();
    const provision = deps.provisionDb ?? provisionAppPostgres;
    const conn = await provision(appsAdminUrl, {
      orgId,
      appId: input.appId,
      slug: input.slug,
      password,
    });
    env.DATABASE_URL = resolveAppConnectionString(
      conn.connectionString,
      appsAdminUrl,
      appsAppUrl,
    );
  }

  // The operator's own variables go UNDER everything the platform sets, so a
  // user key can never take DATABASE_URL or the storage token away from the
  // app. The write endpoint also refuses the reserved names (app-env.ts), but
  // that only guards rows written through it — this guards the rest.
  const platform: Record<string, string> = {};
  if (input.platformAuthEnv) Object.assign(platform, input.platformAuthEnv);
  if (input.storageEnv) Object.assign(platform, input.storageEnv);
  if (deps.extraEnv) Object.assign(platform, deps.extraEnv(input));

  if (input.userEnv) {
    for (const [k, v] of Object.entries(input.userEnv)) {
      if (k in env || k in platform) continue; // platform wins, silently and always
      env[k] = v;
    }
  }
  Object.assign(env, platform);

  // Best-effort, and deliberately not fatal. An app deployed without logs is
  // worse off than one with them; an app that cannot deploy at all because the
  // deployment's key lacks an SLS permission is worse off than both. The
  // provisioner remembers the failure and stops offering the log config, so the
  // function is created without one rather than with a dangling project.
  if (deps.ensureLogStore) {
    try {
      await deps.ensureLogStore();
    } catch (e) {
      console.warn(`[apps] deploying without logs — log store not ready: ${e}`);
    }
  }

  await deps.fcOps.ensureFunction(input.fcFunctionName, {
    ossObjectName: input.ossObjectName,
    env,
    declaration: input.declaration,
    image: input.image,
  });
  // The trigger URL is still created: it is what the function is reachable on
  // before a custom domain exists, and the only address a deployment without a
  // route domain has.
  const triggerUrl = await deps.fcOps.ensureHttpTrigger(input.fcFunctionName);

  // Prefer the custom domain. `*.fcapp.run` refuses to forward any 3xx
  // (`ExternalRedirectForbidden`), so an app that merely normalises a trailing
  // slash is broken on it — see `ensureCustomDomain`.
  const routeHost = appFcRouteHost(input.slug, input.appId);
  if (routeHost && deps.fcOps.ensureCustomDomain) {
    return { fcEndpoint: await deps.fcOps.ensureCustomDomain(input.fcFunctionName, routeHost) };
  }
  return { fcEndpoint: triggerUrl };
}

/**
 * Where a deployed app calls back to mint its storage credentials.
 *
 * A dedicated variable rather than a reuse of AUTH_BASE_URL (GoTrue's) or of
 * the request origin (finalize has no request): the app dials this from
 * Function Compute, outside our network, so it has to be the public Cloud API
 * host and nothing internal. Unset means the app simply gets no storage env -
 * the control panel's file browser keeps working, the app just cannot write
 * files of its own.
 */
export function readAppsCloudApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APPS_CLOUD_API_URL ?? "").trim().replace(/\/+$/, "");
}

/** The env an app needs to fetch and use its own STS credentials. */
export function buildAppStorageEnv(input: {
  appId: string;
  token: string;
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string;
  cloudApiUrl: string;
}): Record<string, string> {
  return {
    TEAMCLU_APP_ID: input.appId,
    TEAMCLU_STORAGE_TOKEN: input.token,
    TEAMCLU_STORAGE_STS_URL: `${input.cloudApiUrl}/v1/apps/${input.appId}/storage/sts`,
    TEAMCLU_STORAGE_BUCKET: input.bucket,
    TEAMCLU_STORAGE_PREFIX: input.prefix,
    TEAMCLU_STORAGE_REGION: input.region,
    TEAMCLU_STORAGE_ENDPOINT: input.endpoint,
  };
}
