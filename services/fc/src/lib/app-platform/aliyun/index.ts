/**
 * Alibaba Cloud implementation of {@link AppPlatform}: Function Compute,
 * OSS (through the S3 API) + STS, and SLS.
 *
 * The one module that constructs vendor SDK clients for the app platform.
 * Each client is built lazily, on first use, and per resolution — the same
 * lifetime the call sites gave them before this seam existed, so a request
 * that never touches logs never builds an SLS client, and an endpoint that
 * cannot be resolved still fails where the caller uses it.
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as $fc from "@alicloud/fc20230330";
import { getAppsS3Client, resolveAppsOss, type AppsOssProfile } from "./oss.js";
import type { AppStorageOps } from "../../provisioning/app-storage.js";
import { aliyunRuntimeDiscovery } from "./runtimes.js";
import { makeAppStorageOps } from "./storage.js";
import { getFcClient, makeFcOps, readAppsFcVpcConfig, resolveFcEndpoint } from "./fc.js";
import { getSlsClient, makeSlsOps, resolveAppsSls } from "./sls.js";
import type {
  AppPlatform,
  AppPlatformResolution,
  ComputeDriver,
  LogsDriver,
  ObjectStoreDriver,
} from "../provider.js";

function inRegion(profile: AppsOssProfile, region: string): AppsOssProfile {
  return region === profile.region ? profile : { ...profile, region };
}

function aliyunCompute(profile: AppsOssProfile): ComputeDriver {
  return {
    configured: () => !!resolveFcEndpoint(),
    joinsPrivateNetwork: () => !!readAppsFcVpcConfig(),
    ops: (options = {}) => {
      const region = options.region ?? profile.region;
      return makeFcOps(getFcClient(inRegion(profile, region)), {
        ...options,
        bucket: profile.bucket,
        role: process.env.ROLE_ARN,
        region,
        // Read when a function is created or updated, the only calls that send
        // it: a half-set APPS_FC_VPC_* then fails the deploy that needs it,
        // naming the variables, and not every status read or teardown.
        get vpc() {
          return readAppsFcVpcConfig();
        },
      });
    },
    getFunction: async (functionName, region) => {
      const client = getFcClient(inRegion(profile, region));
      return (await client.getFunction(functionName, new $fc.GetFunctionRequest({}))).body;
    },
    runtimes: aliyunRuntimeDiscovery(region => getFcClient(inRegion(profile, region))),
  };
}

function aliyunObjectStore(profile: AppsOssProfile): ObjectStoreDriver {
  let s3: S3Client | undefined;
  const client = () => (s3 ??= getAppsS3Client(profile));
  return {
    presignPut: (key, expiresInSeconds) =>
      getSignedUrl(client() as any, new PutObjectCommand({ Bucket: profile.bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      }),
    get client() {
      return client();
    },
    storage: (): AppStorageOps =>
      makeAppStorageOps(profile, client(), {
        getSignedUrl: (c, command, opts) => getSignedUrl(c as any, command, opts),
        commands: {
          GetObjectCommand,
          PutObjectCommand,
          HeadObjectCommand,
          DeleteObjectCommand,
          DeleteObjectsCommand,
          ListObjectsV2Command,
        },
      }),
  };
}

function aliyunLogs(profile: AppsOssProfile): LogsDriver {
  const resolved = resolveAppsSls();
  if (resolved.error || !resolved.config) {
    return { unavailableReason: resolved.error ?? "app logs are not configured" };
  }
  const cfg = resolved.config;
  return {
    ops: makeSlsOps(getSlsClient(profile), cfg),
    destination: { project: cfg.project, logstore: cfg.logstore },
  };
}

export function resolveAliyunAppPlatform(): AppPlatformResolution {
  const resolved = resolveAppsOss();
  if (resolved.error) return { error: resolved.error };
  const profile = resolved.profile;
  let compute: ComputeDriver | undefined;
  let objectStore: ObjectStoreDriver | undefined;
  let logs: LogsDriver | undefined;
  const platform: AppPlatform = {
    region: profile.region,
    bucket: profile.bucket,
    get compute() {
      return (compute ??= aliyunCompute(profile));
    },
    get objectStore() {
      return (objectStore ??= aliyunObjectStore(profile));
    },
    get logs() {
      return (logs ??= aliyunLogs(profile));
    },
  };
  return { platform };
}
