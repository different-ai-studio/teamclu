/**
 * The app platform's dependencies for the business repository: deploy,
 * teardown, the data browser, the file store and logs.
 *
 * Moved out of `src/index.ts` unchanged except that each factory now gets the
 * cloud from {@link resolveAppPlatform} instead of constructing SDK clients,
 * which is what lets `test/app-platform/deploy-contract.test.ts` drive the real
 * wiring against a fake provider.
 *
 * Deploy provisioning deps (FC function + optionally a Postgres schema).
 * Returns a bare `deployUnavailableReason` when FC is unconfigured so
 * deployApp/finalizeDeploy surface a 503 that NAMES the missing variable rather
 * than crashing at import — or, as before, answering with an opaque
 * "deploy provisioning not configured" that costs an SSH session to decode.
 *
 * Two things must be configured, and they are not the same thing:
 *   * the artifact profile (aliyun/oss.ts) — which OSS bucket and credentials the
 *     code zip is staged under. NOT automatically the deployment's default S3
 *     config, which on self-host is a box-local MinIO that FC cannot read.
 *   * APPS_FC_ENDPOINT / ALIYUN_ACCOUNT_ID / ROLE_ARN — without one of them
 *     every FC call fails deep inside the SDK.
 *
 * The apps database is a SEPARATE, softer requirement — only `data_app` needs
 * it. Static apps deploy fine without APPS_DB_ADMIN_URL; asking for one is what
 * raises the error, not merely having the module loaded.
 */
import { readAppsOriginAuthConfig } from "../apps-origin-auth.js";
import { readAppOriginSecurity } from "../provisioning/app-runtime-info.js";
import { startDeploy as startDeployImpl, finalizeDeploy as finalizeDeployImpl } from "../provisioning/app-deploy.js";
import type { AppMigration } from "../provisioning/app-migrations.js";
import { readAppsAdminUrl } from "../provisioning/app-postgres.js";
import { makeAppDataOps, type AppDataOps } from "../provisioning/app-data-db.js";
import { makeTeardownAppDeps, type TeardownAppDeps } from "../provisioning/app-delete.js";
import type { AppStorageOps } from "../provisioning/app-storage.js";
import {
  appImageReference,
  appImageTag,
  imageBelongsToApp,
  resolveAppsRegistry,
} from "../provisioning/apps-registry.js";
import { makeAppLogsReader } from "../provisioning/app-logs.js";
import { resolveAppPlatform, type LogsOps } from "./index.js";

const FC_ENDPOINT_MISSING =
  "FC endpoint is not configured: set APPS_FC_ENDPOINT, ALIYUN_ACCOUNT_ID, or a ROLE_ARN to derive it from";

/**
 * The app-log destination, and whether it is usable yet.
 *
 * One object shared by the deploy path (which points functions at it) and the
 * read path (which queries it), because those two must never disagree about
 * which logstore an app's logs are in.
 *
 * `ensure` is memoized and remembers a failure: an account whose key cannot
 * create an SLS project would otherwise retry on every deploy and — worse —
 * keep handing the FC API a `logConfig` naming a project that does not exist,
 * which fails the whole deploy. After a failed ensure, `config()` reads as
 * undefined and functions are created with no log config at all.
 */
interface AppLogsProvisioner {
  unavailableReason?: string;
  ops?: LogsOps;
  config: () => { project: string; logstore: string } | undefined;
  ensure: () => Promise<void>;
}

function buildAppLogsProvisioner(): AppLogsProvisioner {
  const resolved = resolveAppPlatform();
  const logs = resolved.platform?.logs;
  if (!logs?.ops) {
    return {
      unavailableReason: resolved.error ?? logs?.unavailableReason ?? "app logs are not configured",
      config: () => undefined,
      ensure: async () => {},
    };
  }
  const { ops, destination } = logs;
  let state: "unknown" | "ready" | "failed" = "unknown";
  return {
    ops,
    config: () =>
      state === "failed" ? undefined : { project: destination.project, logstore: destination.logstore },
    ensure: async () => {
      if (state !== "unknown") return;
      try {
        await ops.ensureLogStore();
        state = "ready";
      } catch (e) {
        state = "failed";
        throw e;
      }
    },
  };
}

// Built on first use, not at import: this module is imported by tooling that
// has no environment at all, and the memo is only worth anything if the object
// outlives one request.
let appLogsProvisionerMemo: AppLogsProvisioner | null = null;
function appLogsProvisioner(): AppLogsProvisioner {
  appLogsProvisionerMemo ??= buildAppLogsProvisioner();
  return appLogsProvisionerMemo;
}

/** Tests only: forget the memoized log destination after swapping the provider. */
export function resetAppPlatformDepsForTests(): void {
  appLogsProvisionerMemo = null;
}

/** Read side of the same destination — see {@link buildAppLogsProvisioner}. */
export function makeAppLogsDeps() {
  const provisioner = appLogsProvisioner();
  if (!provisioner.ops) {
    return { appLogsUnavailableReason: provisioner.unavailableReason };
  }
  return { appLogs: makeAppLogsReader(provisioner.ops) };
}

export function makeDeployDeps() {
  const resolved = resolveAppPlatform();
  if (resolved.error) return { deployUnavailableReason: resolved.error };
  const platform = resolved.platform;
  // Same resolution the client uses, so "configured" here and "usable" there
  // cannot drift — including the ROLE_ARN fallback.
  if (!platform.compute.configured()) {
    return { deployUnavailableReason: FC_ENDPOINT_MISSING };
  }
  // Container apps push an image instead of uploading an archive. A deployment
  // with no registry configured keeps working for every other app: only a
  // container deploy is refused, and it is refused naming the variable.
  const registry = resolveAppsRegistry();
  const registryConfig = registry.config;
  const mintImagePush = registry.config
    ? async (appId: string, gitCommitSha: string | null | undefined) => {
        const cfg = registry.config;
        return {
          // Pushed to the host the developer's machine can reach, pulled from
          // whichever host the function can — the same image either way.
          reference: appImageReference(cfg, appId, appImageTag(gitCommitSha)),
          registry: cfg.host,
          ...cfg.push,
        };
      }
    : undefined;

  const computeOptions = {
    // What the deployed function logs into the registry with. Deployment-level
    // rather than per-deploy: it is a property of where images live, and the
    // function keeps it after the deploy that set it is long over.
    registryAuth: registry.config
      ? {
          ...registry.config.pull,
          host: registry.config.pullHost,
          network: registry.config.pullNetwork,
          rootCaCertBase64: registry.config.pullCaCertBase64,
        }
      : undefined,
    logs: () => appLogsProvisioner().config(),
  };
  const secureFcOps = () =>
    platform.compute.ops({ ...computeOptions, originAuth: readAppsOriginAuthConfig(process.env) });
  const appsAdminUrl = process.env.APPS_DB_ADMIN_URL?.trim() || undefined;
  const appsAppUrl = process.env.APPS_DB_APP_URL?.trim() || undefined;
  // 30 min: the daemon runs `pnpm install && pnpm build` between minting this
  // URL and using it, and a cold install on a modest laptop outlasts 15.
  const mintUploadUrl = (ossObjectName: string) => platform.objectStore.presignPut(ossObjectName, 1800);

  return {
    // The caller's `region` is ignored: `fc_region` must record where the
    // function actually went, which is the apps region, not the deployment's
    // default REGION.
    readAppOriginSecurity,
    startDeploy: (a: {
      appId: string;
      region: string;
      buildKind?: string;
      gitCommitSha?: string | null;
    }) =>
      startDeployImpl(
        { mintUploadUrl, mintImagePush, imagePushUnavailable: registry.error },
        { ...a, region: platform.region },
      ),
    finalizeDeploy: (a: {
      appId: string;
      slug: string;
      orgId?: string | null;
      appType: string;
      fcFunctionName: string;
      ossObjectName: string;
      platformAuthEnv?: Record<string, string>;
      migrations?: AppMigration[];
      gitCommitSha?: string | null;
    }) =>
      finalizeDeployImpl(
        {
          appsAdminUrl,
          appsAppUrl,
          fcOps: {
            ensureFunction: (name, args) => secureFcOps().ensureFunction(name, args),
            waitUntilReady: name => secureFcOps().waitUntilReady(name),
            ensurePrivateOrigin: (name, target) => secureFcOps().ensurePrivateOrigin(name, target),
            ensureHttpTrigger: name => secureFcOps().ensureHttpTrigger(name),
            ensureCustomDomain: (name, domain, target) => secureFcOps().ensureCustomDomain(name, domain, target),
            setMinInstances: (name, min) => secureFcOps().setMinInstances(name, min),
          },
          ensureLogStore: () => appLogsProvisioner().ensure(),
          joinsPrivateNetwork: () => platform.compute.joinsPrivateNetwork(),
          // Bound to this deployment's registry, so finalize can tell an image
          // this app's build pushed from any other the registry holds.
          ownsImage: registryConfig
            ? (appId: string, image: string) => imageBelongsToApp(registryConfig, appId, image)
            : undefined,
        },
        a,
      ),
  };
}

/**
 * Deps for browsing an app's own Postgres from the control panel.
 *
 * Separate from makeDeployDeps even though both need APPS_DB_ADMIN_URL: deploy
 * is unavailable without OSS *and* FC, while browsing needs neither. Folding
 * this into that function would make a missing FC endpoint hide the data
 * browser too.
 */
export function makeAppDataDeps(): { appData?: AppDataOps; appDataUnavailableReason?: string } {
  const adminUrl = readAppsAdminUrl();
  if (!adminUrl) return { appDataUnavailableReason: "APPS_DB_ADMIN_URL is not set" };
  return { appData: makeAppDataOps(adminUrl) };
}

/**
 * Deps for the app file store.
 *
 * Needs only the OSS profile, deliberately not FC: browsing and uploading an
 * app's files has nothing to do with whether the function can be deployed, and
 * folding this into makeDeployDeps would make a missing FC endpoint hide the
 * file browser - the same mistake makeAppDataDeps exists to avoid.
 */
export function makeAppStorageDeps(): { appStorage?: AppStorageOps; appStorageUnavailableReason?: string } {
  const resolved = resolveAppPlatform();
  if (resolved.error) return { appStorageUnavailableReason: resolved.error };
  return { appStorage: resolved.platform.objectStore.storage() };
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
export function makeTeardownDeps(): { teardownDeps?: TeardownAppDeps } {
  const resolved = resolveAppPlatform();
  if (resolved.error) return {};
  const platform = resolved.platform;
  if (!platform.compute.configured()) return {};
  const fcOps = platform.compute.ops();
  return {
    teardownDeps: makeTeardownAppDeps({ bucket: platform.bucket, s3: platform.objectStore.client, fcOps }),
  };
}
