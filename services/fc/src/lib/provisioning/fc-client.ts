import { originJwks, ORIGIN_VERSION_HEADER, ORIGIN_VERSION_CLAIM_MAPPING, type OriginAuthConfig, type OriginTarget, type OriginSecuritySummary } from "../apps-origin-auth.js";
import FcClient, * as $fc from "@alicloud/fc20230330";
import { Config } from "@alicloud/openapi-client";
import { appsRegion, type AppsOssProfile } from "./apps-oss.js";
import { imageForPull } from "./apps-registry.js";
import { ApiError } from "../http-utils.js";
import { appPublicLabel } from "../apps-public-host.js";
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
export function resolveFcEndpoint(region = REGION()): string | null {
  const explicit = process.env.APPS_FC_ENDPOINT?.trim();
  if (explicit) {
    const hostname = new URL(explicit.includes("://") ? explicit : `https://${explicit}`).hostname;
    // Alibaba endpoints carry their region. A private proxy has no discoverable
    // region, so it belongs only to the configured apps region, never any region
    // a catalog caller happens to request.
    const endpointRegion = /(?:^|\.)([a-z0-9-]+)\.fc(?:-internal)?\.aliyuncs\.com$/.exec(hostname)?.[1] ?? REGION();
    if (endpointRegion !== region) {
      throw Object.assign(new Error("FC endpoint does not match the requested region"), {
        code: "FcEndpointRegionMismatch",
      });
    }
    return explicit;
  }
  const accountId =
    process.env.ALIYUN_ACCOUNT_ID?.trim() || accountIdFromRoleArn(process.env.ROLE_ARN);
  return accountId ? `${accountId}.${region}.fc.aliyuncs.com` : null;
}

export function fcEndpoint(region = REGION()): string {
  const endpoint = resolveFcEndpoint(region);
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
  const endpoint = fcEndpoint(profile?.region);
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
  /** Server-only origin credentials. Required only for entrypoint operations. */
  originAuth?: OriginAuthConfig;
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

function isTriggerNotFound(e: any): boolean {
  return (e?.code ?? e?.data?.Code) === "TriggerNotFound";
}

async function retryTriggerNotFound<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (e) {
      if (!isTriggerNotFound(e) || attempt === 3) throw e;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

// FC removes the prefix verbatim; include the gateway's separating space.
const ORIGIN_TOKEN_LOOKUP = "header:X-Teamclu-Origin-Authorization:Bearer ";
const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"];
class OriginProviderError extends Error {
  constructor(readonly operation: string, error?: any) {
    const code = error?.code ?? error?.data?.Code;
    // An arbitrary provider error message/request can include submitted JWKS or PEM.
    const known = ["AccessDenied", "Forbidden", "Unauthorized", "TriggerNotFound", "CustomDomainNotFound", "InvalidArgument", "Throttling", "InternalError"];
    super(`FC origin ${operation}: ${known.includes(code) ? code : "ProviderError"}`);
  }
}
async function originCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (error) {
    if (error instanceof OriginSecurityDrift) throw error;
    throw new OriginProviderError(operation, error);
  }
}
function jsonObject(value: unknown): any {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}
function jwtInfo(config: OriginAuthConfig, target: OriginTarget) {
  // FC rejects omitted/empty mappings in the deployed region. Forward only
  // the signed key version into an isolated metadata header, never identity.
  return { jwks: originJwks(config, target.appId), tokenLookup: ORIGIN_TOKEN_LOOKUP, claimPassBy: ORIGIN_VERSION_CLAIM_MAPPING };
}
function jwtDrift(authType: unknown, raw: unknown, config: OriginAuthConfig, target: OriginTarget): string[] {
  const fields: string[] = [];
  if (authType !== "jwt") fields.push("authConfig.authType");
  const info = jsonObject(raw);
  if (!info) return [...fields, "authConfig.authInfo"];
  // Header names are case insensitive. Prefix, source count and source type are not.
  const lookup = typeof info.tokenLookup === "string" ? info.tokenLookup.split(":") : [];
  if (lookup.length !== 3 || lookup[0] !== "header" || lookup[1].toLowerCase() !== "x-teamclu-origin-authorization" || lookup[2] !== "Bearer ") fields.push("authConfig.TokenLookup");
  const mapping = typeof info.claimPassBy === "string" ? info.claimPassBy.split(":") : [];
  if (mapping.length !== 3 || mapping[0] !== "header" || mapping[1] !== "version" || mapping[2].toLowerCase() !== ORIGIN_VERSION_HEADER.toLowerCase()) fields.push("authConfig.ClaimPassBy");
  const keys = jsonObject(info.jwks)?.keys;
  const normalize = (items: any[]) => items.map(key => {
    if (!jsonObject(key)) return "invalid";
    return JSON.stringify([key.kty, key.alg, key.use, key.kid, key.k]);
  }).sort();
  if (!Array.isArray(keys) || JSON.stringify(normalize(keys)) !== JSON.stringify(normalize(originJwks(config, target.appId).keys))) fields.push("authConfig.JWKS");
  return fields;
}
function domainDrift(domain: any, functionName: string, config: OriginAuthConfig, target: OriginTarget, alias = false): string[] {
  const fields: string[] = [];
  if (domain?.protocol !== "HTTP") fields.push("protocol");
  const routes = domain?.routeConfig?.routes;
  if (!Array.isArray(routes) || !routes.length || routes.some((route: any) => route?.functionName !== functionName || (!alias && (route.path !== "/*" || (route.qualifier ?? "LATEST") !== "LATEST"))) || (!alias && routes.length !== 1)) fields.push("routeConfig");
  fields.push(...jwtDrift(domain?.authConfig?.authType, domain?.authConfig?.authInfo, config, target));
  return fields;
}
function requireOriginConfig(cfg: FcOpsConfig): OriginAuthConfig {
  if (!cfg.originAuth) throw new Error("FC origin configuration missing: originAuth");
  return cfg.originAuth;
}
function assertOriginTarget(config: OriginAuthConfig, domainName: string, target: OriginTarget) {
  const label = target && appPublicLabel(target.slug, target.appId);
  if (!label || domainName !== `${label}.${config.routeDomain}`) throw new Error("FC origin configuration mismatch: domainName");
  originJwks(config, target.appId);
}
class OriginSecurityDrift extends Error {}
function driftError(fields: string[]): Error {
  return new OriginSecurityDrift(`FC origin security drift: ${[...new Set(fields)].join(", ")}`);
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
    async ensureHttpTrigger(functionName: string): Promise<{ internetUrlDisabled: true }> {
      requireOriginConfig(cfg);
      const triggerConfig = JSON.stringify({ authType: "anonymous", disableURLInternet: true, methods: HTTP_METHODS });
      // Keep the HTTP trigger for domain routing, but never publish its default URL.
      await originCall("ensureHttpTrigger", () => retryTriggerNotFound(async () => {
        try {
          await client.createTrigger(functionName, new $fc.CreateTriggerRequest({
            body: new $fc.CreateTriggerInput({ triggerName: "http", triggerType: "http", triggerConfig }),
          }));
        } catch (e) {
          if (!isAlreadyExists(e)) throw e;
          await client.updateTrigger(functionName, "http", new $fc.UpdateTriggerRequest({ body: new $fc.UpdateTriggerInput({ triggerConfig }) }));
        }
        const trigger = await client.getTrigger(functionName, "http");
        if (jsonObject(trigger?.body?.triggerConfig)?.disableURLInternet !== true) throw driftError(["disableURLInternet"]);
      }));
      return { internetUrlDisabled: true };
    },

    /** Configure only the current app's controlled domain, then verify all target mappings. */
    async ensureCustomDomain(functionName: string, domainName: string, target: OriginTarget): Promise<string> {
      const config = requireOriginConfig(cfg);
      assertOriginTarget(config, domainName, target);
      const body = {
        protocol: "HTTP",
        routeConfig: new $fc.RouteConfig({ routes: [new $fc.PathConfig({ path: "/*", functionName, qualifier: "LATEST" })] }),
        authConfig: new $fc.AuthConfig({ authType: "jwt", authInfo: JSON.stringify(jwtInfo(config, target)) }),
      };
      await originCall("ensureCustomDomain", () => retryTriggerNotFound(async () => {
        try {
          await client.createCustomDomain(new $fc.CreateCustomDomainRequest({ body: new $fc.CreateCustomDomainInput({ domainName, ...body }) }));
        } catch (e) {
          if (!isAlreadyExists(e)) throw e;
          await client.updateCustomDomain(domainName, new $fc.UpdateCustomDomainRequest({ body: new $fc.UpdateCustomDomainInput(body) }));
        }
      }));
      const summary = await this.readOriginSecurity(functionName, domainName, target);
      if (summary.status !== "protected") throw driftError(summary.driftFields);
      return `http://${domainName}`;
    },

    /** Read-only; never return provider config, symmetric JWKS, request objects or PEM. */
    async readOriginSecurity(functionName: string, domainName: string, target: OriginTarget): Promise<OriginSecuritySummary> {
      const summary: OriginSecuritySummary = { status: "unavailable", internetUrlDisabled: null, customDomainAuth: "unknown", httpsOnly: null, driftFields: [] };
      try {
        const config = requireOriginConfig(cfg);
        assertOriginTarget(config, domainName, target);
        const trigger: any = await originCall("getTrigger", () => client.getTrigger(functionName, "http"));
        const disabled = jsonObject(trigger?.body?.triggerConfig)?.disableURLInternet;
        summary.internetUrlDisabled = typeof disabled === "boolean" ? disabled : null;
        if (disabled !== true) summary.driftFields.push("disableURLInternet");
        const domain: any = await originCall("getCustomDomain", () => client.getCustomDomain(domainName));
        const auth = domain?.body?.authConfig?.authType;
        summary.customDomainAuth = auth === "jwt" ? "jwt" : auth === "anonymous" ? "none" : "unknown";
        summary.httpsOnly = domain?.body?.protocol ? domain.body.protocol === "HTTPS" : null;
        summary.driftFields.push(...domainDrift(domain?.body, functionName, config, target));

        // Lists are account scoped: scan every page, match routes, and never mutate aliases.
        async function pages(operation: string, field: string, request: (token?: string) => Promise<any>, visit: (item: any) => Promise<void>) {
          let token: string | undefined;
          const seen = new Set<string>();
          do {
            const response = await originCall(operation, () => request(token));
            const items = response?.body?.[field], next = response?.body?.nextToken;
            if (!Array.isArray(items) || (next !== undefined && next !== null && typeof next !== "string")) throw new OriginProviderError(operation);
            for (const item of items) await visit(item);
            token = next || undefined;
            if (token && seen.has(token)) throw new OriginProviderError(operation);
            if (token) seen.add(token);
          } while (token);
        }
        // Temporary workaround for cn-shenzhen signed list timeouts with limit > 1.
        // Keep full nextToken traversal; see docs/testing/2026-10-05-fc-list-timeout.md.
        await pages("listTriggers", "triggers", token => client.listTriggers(functionName, new $fc.ListTriggersRequest({ limit: 1, nextToken: token })), async item => {
          if (!item || typeof item.triggerType !== "string" || typeof item.triggerName !== "string") throw new OriginProviderError("listTriggers");
          if (item.triggerType !== "http" || item.triggerName === "http") return;
          // The normal deploy owns only the standard HTTP trigger; every extra
          // HTTP entrypoint is drift, even when it appears independently protected.
          summary.driftFields.push("extraHttpTriggers");
        });
        await pages("listCustomDomains", "customDomains", token => client.listCustomDomains(new $fc.ListCustomDomainsRequest({ limit: 1, nextToken: token })), async item => {
          const routes = item?.routeConfig?.routes;
          if (typeof item?.domainName !== "string" || !Array.isArray(routes) || routes.some((route: any) => typeof route?.functionName !== "string")) throw new OriginProviderError("listCustomDomains");
          if (item.domainName === domainName || !routes.some((route: any) => route.functionName === functionName)) return;
          const alias: any = await originCall("getCustomDomain", () => client.getCustomDomain(item.domainName));
          if (domainDrift(alias?.body, functionName, config, target, true).length) summary.driftFields.push("customDomainAliases");
        });
        summary.driftFields = [...new Set(summary.driftFields)];
        summary.status = summary.driftFields.length ? "drift" : "protected";
      } catch (error) {
        summary.status = "unavailable";
        summary.driftFields.push(error instanceof OriginProviderError ? error.operation : "originAuth");
        summary.driftFields = [...new Set(summary.driftFields)];
      }
      return summary;
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
