import { appFcRouteHost, appPublicLabel, appsFcRouteDomain, normalizeAppCode } from "./apps-public-host.js";
import { ApiError } from "./http-utils.js";

export type FunctionNamingMode = "legacy" | "app_code";
export interface AppFunctionTarget {
  appId: string;
  slug: string | null;
  appCode?: string | null;
  functionNamingMode?: FunctionNamingMode;
}

function invalidIdentity(): never {
  throw new ApiError(409, "invalid_app_function_identity", "invalid app function identity");
}

export function readFunctionNamingMode(value: unknown): FunctionNamingMode {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "app_code") return "app_code";
  return invalidIdentity();
}

function canonicalCode(target: AppFunctionTarget): string {
  const code = normalizeAppCode(target.appCode);
  if (!code || code !== target.appCode) return invalidIdentity();
  return code;
}

export function resolveAppFunctionName(
  target: AppFunctionTarget & { fcFunctionName?: string | null; legacyFallback?: "slug" | "uuid" },
): string {
  if (readFunctionNamingMode(target.functionNamingMode) === "app_code") {
    const code = canonicalCode(target);
    if (target.fcFunctionName && target.fcFunctionName !== code) return invalidIdentity();
    return code;
  }
  if (target.fcFunctionName) return target.fcFunctionName;
  const label = target.legacyFallback !== "uuid" && target.slug
    ? appPublicLabel(target.slug, target.appId) : null;
  if (label && /^[A-Za-z_]/.test(label)) return label;
  return `tc-app-${target.appId}`;
}

export function appManagedOriginHost(target: AppFunctionTarget, env: NodeJS.ProcessEnv = process.env): string | null {
  if (readFunctionNamingMode(target.functionNamingMode) === "legacy") {
    return appFcRouteHost(target.slug, target.appId, env);
  }
  const code = canonicalCode(target);
  const domain = appsFcRouteDomain(env);
  return domain ? `${code}.${domain}` : null;
}
