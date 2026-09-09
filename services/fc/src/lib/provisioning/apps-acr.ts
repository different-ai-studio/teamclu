import OpenApi, { Config, OpenApiRequest } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";
import type { AppsOssProfile } from "./apps-oss.js";

type Env = NodeJS.ProcessEnv;

const trimmed = (v: string | undefined) => v?.trim() || "";

/**
 * Where a container app's image lives, and under which account.
 *
 * Credentials and region come from the resolved apps profile rather than from
 * their own variables: the registry is in the same account as the code bucket
 * and the function, and a second copy of that credential-fallback rule is a
 * second thing that can drift out of step with it.
 */
export interface AppsAcrConfig {
  region: string;
  namespace: string;
  /** Host the daemon pushes to, from a developer's own machine. */
  pushRegistry: string;
  /**
   * Host the function pulls from. Defaults to the push host: the VPC endpoint
   * is only reachable from a function attached to a VPC with ACR access, and a
   * default that silently requires that would fail at instance start rather
   * than at deploy.
   */
  pullRegistry: string;
  accessKeyId: string;
  accessKeySecret: string;
}

export type AppsAcrResolution =
  | { config: AppsAcrConfig; error?: undefined }
  | { config?: undefined; error: string };

/**
 * Resolve the registry config, or explain what is missing.
 *
 * The error is a sentence naming a variable, matching `resolveAppsOss`: it
 * reaches the user as the reason their deploy did not start, and "not
 * configured" costs an SSH session to turn into an action.
 */
export function resolveAppsAcr(
  profile: AppsOssProfile,
  env: Env = process.env,
): AppsAcrResolution {
  const namespace = trimmed(env.APPS_ACR_NAMESPACE);
  if (!namespace) {
    return {
      error:
        "APPS_ACR_NAMESPACE is not set — a container app's image needs a Container Registry namespace to push to",
    };
  }
  const region = profile.region;
  const pushRegistry =
    trimmed(env.APPS_ACR_REGISTRY) || `registry.${region}.aliyuncs.com`;
  return {
    config: {
      region,
      namespace,
      pushRegistry,
      pullRegistry: trimmed(env.APPS_ACR_PULL_REGISTRY) || pushRegistry,
      accessKeyId: profile.accessKeyId,
      accessKeySecret: profile.accessKeySecret,
    },
  };
}

/** The repository one app pushes to. Named for the function, so a person
 *  looking at either console sees the same app twice rather than two things. */
export function appImageRepository(appId: string): string {
  return `tc-app-${appId}`;
}

/** Full image reference: what the daemon pushes and what the function pulls. */
export function appImageReference(
  cfg: AppsAcrConfig,
  appId: string,
  tag: string,
  registry = cfg.pushRegistry,
): string {
  return `${registry}/${cfg.namespace}/${appImageRepository(appId)}:${tag}`;
}

/**
 * The image tag for one deploy.
 *
 * The commit is the tag when there is one, so an image can be traced back to
 * the code in it and a redeploy of an unchanged commit reuses the same layer.
 * An imported app deploying its working directory has no commit of ours, so it
 * falls back to the time — unique, and the only fact available.
 */
export function appImageTag(gitCommitSha: string | null | undefined, now = new Date()): string {
  const sha = (gitCommitSha ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{7,40}$/.test(sha)) return sha;
  return `d${Math.floor(now.getTime() / 1000)}`;
}

/** Short-lived docker credentials for one deploy. */
export interface RegistryCredentials {
  username: string;
  password: string;
  /** ISO-8601, as the registry reported it. Informational. */
  expiresAt?: string;
}

/**
 * Mint a temporary registry login.
 *
 * Called through the generic OpenAPI client rather than `@alicloud/cr20160607`:
 * that SDK's generated response models carry only headers, so the token — which
 * is the entire point of the call — is not in what it hands back.
 *
 * The token lasts an hour and is scoped to the account, exactly like the fixed
 * registry password would be, except that it expires. Nothing durable is
 * handed to a developer's machine.
 */
export async function mintRegistryCredentials(
  cfg: AppsAcrConfig,
  client = acrClient(cfg),
): Promise<RegistryCredentials> {
  const res = await client.doROARequest(
    "GetAuthorizationToken",
    "2016-06-07",
    "HTTPS",
    "GET",
    "AK",
    "/tokens",
    "json",
    new OpenApiRequest({}),
    new RuntimeOptions({}),
  );
  const data = (res as any)?.body?.data ?? (res as any)?.data ?? {};
  const password = String(data.authorizationToken ?? "");
  const username = String(data.tempUserName ?? "");
  if (!password || !username) {
    throw new Error("Container Registry returned no authorization token");
  }
  return {
    username,
    password,
    expiresAt: data.expireDate ? new Date(Number(data.expireDate)).toISOString() : undefined,
  };
}

export function acrClient(cfg: AppsAcrConfig): OpenApi.default {
  return new OpenApi.default(
    new Config({
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      regionId: cfg.region,
      endpoint: `cr.${cfg.region}.aliyuncs.com`,
    }) as any,
  );
}
