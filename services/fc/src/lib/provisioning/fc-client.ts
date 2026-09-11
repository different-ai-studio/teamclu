import FcClient, * as $fc from "@alicloud/fc20230330";
import { Config } from "@alicloud/openapi-client";
import { appsRegion, type AppsOssProfile } from "./apps-oss.js";
import { imageForPull } from "./apps-registry.js";
import { ApiError } from "../http-utils.js";
import {
  isContainerKind,
  resolveLayers,
  type AppDeployDeclaration,
  type AppStartSpec,
} from "./app-runtime-spec.js";

type FcClientInstance = InstanceType<typeof FcClient.default>;

// The function's region, which is the apps region — NOT necessarily the
// deployment's default `REGION`. On self-host that one labels a MinIO client
// and has nothing to do with where the app function runs.
const REGION = () => appsRegion();

/** Pull the account id out of a RAM role ARN: `acs:ram::<accountId>:role/<name>`. */
export function accountIdFromRoleArn(arn: string | undefined): string | null {
  const m = /^acs:ram::(\d+):/.exec((arn ?? "").trim());
  return m ? m[1] : null;
}

/**
 * FC 3.0 data-plane host, which is ACCOUNT-scoped:
 * `<accountId>.<region>.fc.aliyuncs.com`. The OSS `ENDPOINT` env (oss.ts) is a
 * different host and is NOT reusable.
 *
 * Resolution order: an explicit `APPS_FC_ENDPOINT`, then `ALIYUN_ACCOUNT_ID`,
 * then the account id embedded in `ROLE_ARN` — which every deployment that can
 * talk to OSS already has, so app deploys need no new configuration at all.
 *
 * The override is NOT called `FC_ENDPOINT`: that name is reserved by Alibaba
 * Function Compute, which rejects the whole deploy with
 * `InvalidArgument: The environment variable name 'FC_ENDPOINT' is reserved`.
 */
export function resolveFcEndpoint(): string | null {
  const explicit = process.env.APPS_FC_ENDPOINT?.trim();
  if (explicit) return explicit;
  const accountId =
    process.env.ALIYUN_ACCOUNT_ID?.trim() || accountIdFromRoleArn(process.env.ROLE_ARN);
  return accountId ? `${accountId}.${REGION()}.fc.aliyuncs.com` : null;
}

export function fcEndpoint(): string {
  const endpoint = resolveFcEndpoint();
  // Without any of them the composed host used to come out as the literal
  // "undefined.<region>.fc.aliyuncs.com" and every call failed with a DNS
  // error that named no variable at all. Fail with the config problem instead.
  if (!endpoint) {
    throw new Error(
      "FC endpoint is not configured: set APPS_FC_ENDPOINT, ALIYUN_ACCOUNT_ID, or a ROLE_ARN to derive it from",
    );
  }
  return endpoint;
}

/**
 * `profile` carries the Alibaba credentials the app artifacts live under. It is
 * optional only so tests and any legacy caller keep working; production passes
 * the resolved profile, because on a deployment whose default `ACCESS_KEY_ID`
 * is MinIO's, those credentials do not authenticate against the FC API at all.
 */
export function getFcClient(profile?: AppsOssProfile): FcClientInstance {
  const endpoint = fcEndpoint();
  return new FcClient.default(new Config({
    accessKeyId: profile?.accessKeyId ?? process.env.ACCESS_KEY_ID,
    accessKeySecret: profile?.accessKeySecret ?? process.env.ACCESS_KEY_SECRET,
    regionId: profile?.region ?? REGION(),
    endpoint,
  }) as any);
}

/** VPC attachment for deployed app functions (required when APPS_DB_APP_URL is set). */
export interface AppsFcVpcConfig {
  vpcId: string;
  vSwitchIds: string[];
  securityGroupId: string;
}

/**
 * Read APPS_FC_VPC_ID / APPS_FC_VSWITCH_ID / APPS_FC_SECURITY_GROUP_ID.
 *
 * Deployed data_app functions run on external FC and reach App Postgres via
 * APPS_DB_APP_URL (typically an RDS internal endpoint). Without VPC attachment
 * the function cannot route to that host even when DATABASE_URL is correct.
 */
export function readAppsFcVpcConfig(env: NodeJS.ProcessEnv = process.env): AppsFcVpcConfig | undefined {
  const vpcId = env.APPS_FC_VPC_ID?.trim();
  const vSwitchId = env.APPS_FC_VSWITCH_ID?.trim();
  const securityGroupId = env.APPS_FC_SECURITY_GROUP_ID?.trim();
  const set = [vpcId, vSwitchId, securityGroupId].filter(Boolean);
  if (set.length === 0) return undefined;
  if (set.length < 3) {
    throw new Error(
      "APPS_FC_VPC_ID, APPS_FC_VSWITCH_ID, and APPS_FC_SECURITY_GROUP_ID must all be set together",
    );
  }
  return { vpcId: vpcId!, vSwitchIds: [vSwitchId!], securityGroupId: securityGroupId! };
}

export interface FcOpsConfig {
  bucket: string;
  role: string | undefined;
  region: string;
  /**
   * How a deployed container function logs into the image registry, and the
   * host it reaches it on. Absent on a deployment with no registry — which is
   * every deployment that has no container apps.
   */
  registryAuth?: { username: string; password: string; host?: string };
  /** When set, every app function create/update joins this VPC. */
  vpc?: AppsFcVpcConfig;
  /**
   * Where the function's own output goes. Omitted (the state every app was in
   * until 2026-09) means Function Compute keeps NO logs at all: not in the
   * console, not through any API, so "why does my app 500" has no answer.
   *
   * A getter, not a value: the destination has to exist before a function may
   * point at it, and the caller only learns whether it does when it tries to
   * create it. Returning undefined after that failed is what keeps a missing
   * SLS permission from turning every deploy into a hard failure.
   */
  logs?: () => { project: string; logstore: string } | undefined;
}
export interface EnsureFunctionArgs {
  ossObjectName: string;
  env: Record<string, string>;
  /** The daemon-validated build and start declaration. Required at runtime. */
  declaration?: AppDeployDeclaration;
  /**
   * The image to run, for a `container` app. Already in the registry: the
   * daemon pushed it before finalize was called, so there is no code object
   * for this deploy and `ossObjectName` is not read.
   */
  image?: string;
}

/**
 * Log delivery for an app function.
 *
 * `enableRequestMetrics` is what produces the one-row-per-request stream with
 * status code and duration — the half of "logs" that answers whether a request
 * arrived at all, which the app's own output cannot.
 *
 * Delivery does NOT need the function to carry a role: the live function that
 * had logs on before this existed has `role: ""`, and the account's
 * `AliyunServiceRoleForFC` is what writes. So this stays safe on a deployment
 * whose `ROLE_ARN` is empty, which is the documented shape.
 */
function functionLogInput(logs: { project: string; logstore: string } | undefined) {
  if (!logs) return {};
  return {
    logConfig: new $fc.LogConfig({
      project: logs.project,
      logstore: logs.logstore,
      enableRequestMetrics: true,
      enableInstanceMetrics: true,
      // How FC decides where one multi-line log entry ends. `DefaultRegex` is
      // what the console configures; `None` makes every line its own entry and
      // shreds stack traces.
      logBeginRule: "DefaultRegex",
    }),
  };
}

function functionNetworkInput(vpc: AppsFcVpcConfig | undefined) {
  if (!vpc) return { internetAccess: true };
  return {
    internetAccess: true,
    vpcConfig: new $fc.VPCConfig({
      vpcId: vpc.vpcId,
      vSwitchIds: vpc.vSwitchIds,
      securityGroupId: vpc.securityGroupId,
    }),
  };
}

/**
 * The container half of the same question: what starts this app.
 *
 * Nothing about the process is named here — the image's own `ENTRYPOINT` and
 * `CMD` are its start command, which is the whole reason an app reaches for a
 * container. What the deployment must state is the port, because FC has to
 * know where to send a request and `EXPOSE` is documentation that nothing
 * reads.
 */
function containerConfig(
  image: string,
  start: AppStartSpec,
  auth: FcOpsConfig["registryAuth"],
) {
  const healthCheckPath = start.healthCheckPath?.trim();
  return new $fc.CustomContainerConfig({
    image: imageForPull(image, auth?.host),
    port: start.port,
    ...(start.command ? { command: start.command } : {}),
    ...(start.args ? { args: start.args } : {}),
    // A private registry that is not ACR is reached with a plain login, which
    // is what `registryConfig` exists for. Read-only where the deployment
    // configured a separate pull user: this credential lives in the function's
    // config, and a writable one there means anyone who can read that config
    // can replace what the app runs.
    ...(auth
      ? {
          registryConfig: new $fc.RegistryConfig({
            authConfig: new $fc.RegistryAuthConfig({
              userName: auth.username,
              password: auth.password,
            }),
          }),
        }
      : {}),
    ...(healthCheckPath
      ? {
          healthCheckConfig: new $fc.CustomHealthCheckConfig({
            httpGetUrl: healthCheckPath,
            // An emulated-build image is big and its first pull is slow, so the
            // check has to allow a real cold start before it calls the instance
            // dead — the defaults are tuned for a code package that is already
            // on the machine.
            initialDelaySeconds: 10,
            periodSeconds: 5,
            timeoutSeconds: 3,
            failureThreshold: 6,
            successThreshold: 1,
          }),
        }
      : {}),
  });
}

/**
 * The create/update fields that differ between a code app and a container app.
 *
 * Split out because both calls need exactly the same answer: `updateFunction`
 * re-sends the whole runtime shape on every deploy (see `updateFunctionCode`),
 * and a container app that only got its image on create would keep running the
 * first image it was ever given.
 */
function runtimeInput(cfg: FcOpsConfig, args: EnsureFunctionArgs, codeLocation: (n: string) => any) {
  const declaration = args.declaration;
  if (!declaration) {
    throw new ApiError(400, "validation_failed", "declaration (build+start) is required");
  }
  if (isContainerKind(declaration.build.kind)) {
    if (!args.image) {
      throw new ApiError(
        400,
        "validation_failed",
        'a "container" app must be finalized with the image the build pushed',
      );
    }
    // No layers and no code: the image is both. Sending either alongside
    // `customContainerConfig` is how a function ends up with a Node layer
    // mounted into someone's Python image.
    return {
      runtime: "custom-container",
      customContainerConfig: containerConfig(args.image, declaration.start, cfg.registryAuth),
    };
  }
  const healthCheckPath = declaration.start.healthCheckPath?.trim();
  return {
    runtime: declaration.start.fcRuntime,
    layers: resolveLayers(cfg.region, declaration.build.kind, declaration.start.layers),
    customRuntimeConfig: new $fc.CustomRuntimeConfig({
      command: declaration.start.command,
      args: declaration.start.args ?? [],
      port: declaration.start.port,
      ...(healthCheckPath
        ? {
            healthCheckConfig: new $fc.CustomHealthCheckConfig({
              httpGetUrl: healthCheckPath,
              initialDelaySeconds: 10,
              periodSeconds: 5,
              timeoutSeconds: 3,
              failureThreshold: 6,
              successThreshold: 1,
            }),
          }
        : {}),
    }),
    code: codeLocation(args.ossObjectName),
  };
}

function isNotFound(e: any): boolean {
  return e?.statusCode === 404 || e?.code === "FunctionNotFound" || e?.data?.Code === "FunctionNotFound";
}
function isAlreadyExists(e: any): boolean {
  return e?.statusCode === 409 || /AlreadyExists/i.test(e?.code ?? e?.data?.Code ?? "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeFcOps(client: any, cfg: FcOpsConfig) {
  function codeLocation(ossObjectName: string) {
    return new $fc.InputCodeLocation({ ossBucketName: cfg.bucket, ossObjectName });
  }
  return {
    async ensureFunction(functionName: string, args: EnsureFunctionArgs): Promise<void> {
      let exists = true;
      try { await client.getFunction(functionName, new $fc.GetFunctionRequest({})); }
      catch (e) { if (isNotFound(e)) exists = false; else throw e; }
      if (!exists) {
        await client.createFunction(new $fc.CreateFunctionRequest({
          body: new $fc.CreateFunctionInput({
            functionName,
            handler: "index.handler",
            memorySize: 512, cpu: 0.5, timeout: 60, diskSize: 512,
            role: cfg.role,
            environmentVariables: args.env,
            // Runtime, and what it needs to start: the Node layer plus a start
            // command over the uploaded code, or the app's own image.
            //
            // The daemon zips the CONTENTS of the build's output directory, so
            // the entry is relative to that directory — a `.output/` prefix
            // here points at a path that is never unpacked and the function
            // never boots.
            ...runtimeInput(cfg, args, codeLocation),
            ...functionNetworkInput(cfg.vpc),
            ...functionLogInput(cfg.logs?.()),
          }),
        }));
      } else {
        await this.updateFunctionCode(functionName, args);
      }
    },
    async updateFunctionCode(functionName: string, args: EnsureFunctionArgs): Promise<void> {
      // The layer and the start command are re-sent on every update, not just
      // at create. Functions created before the Node layer existed boot with
      // `command: ["node"]` against an image that has no node, and a code-only
      // update leaves them broken forever — the redeploy the user reaches for
      // would report success and change nothing about why the page 500s.
      //
      // VPC config is re-sent for the same reason: a function created before
      // APPS_FC_VPC_* was wired would keep an empty vpcConfig through every
      // redeploy and time out against an internal RDS host forever. And the log
      // config for the same reason again — the nine functions deployed before
      // it existed have no logs, and a code-only update would leave them with
      // none no matter how many times their owner redeployed.
      await client.updateFunction(functionName, new $fc.UpdateFunctionRequest({
        body: new $fc.UpdateFunctionInput({
          environmentVariables: args.env,
          ...runtimeInput(cfg, args, codeLocation),
          ...functionNetworkInput(cfg.vpc),
          ...functionLogInput(cfg.logs?.()),
        }),
      }));
    },
    async deleteFunction(functionName: string): Promise<void> {
      try {
        await client.deleteFunction(functionName);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
    async deleteHttpTrigger(functionName: string): Promise<void> {
      try {
        await client.deleteTrigger(functionName, "http");
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
    async ensureHttpTrigger(functionName: string): Promise<string> {
      // A method missing from this list is refused by the trigger with a 403
      // that never reaches the app. The original four left OPTIONS out, which
      // fails every CORS preflight a browser sends, and HEAD out, which is what
      // link previews and health checks use.
      const triggerConfig = JSON.stringify({
        authType: "anonymous",
        methods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"],
      });
      try {
        await client.createTrigger(functionName, new $fc.CreateTriggerRequest({
          body: new $fc.CreateTriggerInput({
            triggerName: "http", triggerType: "http", triggerConfig,
          }),
        }));
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
        // Triggers created earlier keep whatever method list they were made
        // with — creating is a no-op for them, so repair it explicitly rather
        // than leaving already-deployed apps refusing OPTIONS forever.
        await client.updateTrigger(functionName, "http", new $fc.UpdateTriggerRequest({
          body: new $fc.UpdateTriggerInput({ triggerConfig }),
        }));
      }
      const t = await client.getTrigger(functionName, "http");
      const url = t?.body?.httpTrigger?.urlInternet;
      if (!url) throw new Error("http trigger has no urlInternet");
      return url;
    },

    /**
     * Bind `domainName` to `functionName`, so requests carrying that Host reach
     * this app.
     *
     * The default `*.fcapp.run` hostname refuses to forward **any** 3xx with
     * `ExternalRedirectForbidden` (Alibaba product change, 2025-04-01) and is
     * documented as test-only. A trailing-slash normalisation or a login
     * redirect is enough to break an app on it, so every deployed app gets a
     * custom domain instead.
     *
     * `HTTP`, not HTTPS: the only client is our own proxy, reaching FC over
     * Alibaba's internal network. Serving HTTPS here would mean uploading a
     * certificate to FC, which is a manual PEM snapshot that CAS never renews.
     *
     * Idempotent — a redeploy re-points the same domain at the same function.
     */
    async ensureCustomDomain(functionName: string, domainName: string): Promise<string> {
      const routeConfig = new $fc.RouteConfig({
        routes: [
          new $fc.PathConfig({ path: "/*", functionName, qualifier: "LATEST" }),
        ],
      });
      const body = { protocol: "HTTP", routeConfig };
      try {
        await client.createCustomDomain(new $fc.CreateCustomDomainRequest({
          body: new $fc.CreateCustomDomainInput({ domainName, ...body }),
        }));
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
        await client.updateCustomDomain(domainName, new $fc.UpdateCustomDomainRequest({
          body: new $fc.UpdateCustomDomainInput(body),
        }));
      }
      return `http://${domainName}`;
    },

    /** Drop an app's custom domain. Best-effort: a missing one is done. */
    async deleteCustomDomain(domainName: string): Promise<void> {
      try {
        await client.deleteCustomDomain(domainName);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
  };
}
