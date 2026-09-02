import FcClient, * as $fc from "@alicloud/fc20230330";
import { Config } from "@alicloud/openapi-client";
import { appsRegion, type AppsOssProfile } from "./apps-oss.js";

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
  /** When set, every app function create/update joins this VPC. */
  vpc?: AppsFcVpcConfig;
}
export interface EnsureFunctionArgs { ossObjectName: string; env: Record<string, string>; }

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
 * The custom runtime image ships NO node at all — not merely one that is off
 * PATH. `command: ["node"]` therefore failed EVERY deploy at instance start
 * with `CAFileNotFound: the file node is not exist`, and `/bin/sh -c 'exec
 * node …'` failed the same way with `exec: node: not found` (exit 127). The
 * standard `nodejs20` runtime is not an escape either: it rejects a startup
 * command outright (`customRuntimeConfig not supported for non-custom
 * runtime`), because it is handler-based.
 *
 * What works is the official Node.js layer. It mounts under `/opt/nodejs20`
 * and does NOT extend PATH (verified in a live instance: PATH is still
 * `/usr/local/sbin:…:/bin`), so the start command must name the binary by
 * absolute path.
 *
 * The version is pinned rather than floating: a layer version is immutable, so
 * pinning is what keeps a redeploy of an untouched app from silently changing
 * its Node runtime underneath it.
 */
export const NODE_BIN = "/opt/nodejs20/bin/node";
export function nodejsLayerArn(region: string): string {
  return `acs:fc:${region}:official:layers/Nodejs20/versions/3`;
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
            runtime: "custom.debian10",
            handler: "index.handler",
            memorySize: 512, cpu: 0.5, timeout: 60, diskSize: 512,
            role: cfg.role,
            environmentVariables: args.env,
            layers: [nodejsLayerArn(cfg.region)],
            customRuntimeConfig: new $fc.CustomRuntimeConfig({
              // The daemon zips the CONTENTS of the build's `.output` directory
              // (app_build.rs `zip_dir(workdir.join(".output"))`), so the server
              // entry sits at `server/index.mjs` inside the artifact — a
              // `.output/` prefix here points at a path that is never unpacked
              // and the function never boots.
              command: [NODE_BIN], args: ["server/index.mjs"], port: 9000,
            }),
            code: codeLocation(args.ossObjectName),
            ...functionNetworkInput(cfg.vpc),
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
      // redeploy and time out against an internal RDS host forever.
      await client.updateFunction(functionName, new $fc.UpdateFunctionRequest({
        body: new $fc.UpdateFunctionInput({
          environmentVariables: args.env,
          layers: [nodejsLayerArn(cfg.region)],
          customRuntimeConfig: new $fc.CustomRuntimeConfig({
            command: [NODE_BIN], args: ["server/index.mjs"], port: 9000,
          }),
          code: codeLocation(args.ossObjectName),
          ...functionNetworkInput(cfg.vpc),
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
