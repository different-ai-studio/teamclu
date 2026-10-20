import { appPublicLabel } from "../apps-public-host.js";
import { classifyOriginEndpoint, originJwks, readAppsOriginAuthConfig, type OriginAuthConfig, type OriginSecuritySummary, type OriginTarget } from "../apps-origin-auth.js";
import { ApiError } from "../http-utils.js";
import * as $fc from "@alicloud/fc20230330";
import { getFcClient, makeFcOps } from "./fc-client.js";
import { resolveAppsOss } from "./apps-oss.js";

/** Only the fields required to compare a deployment may cross the API boundary. */
export function projectFunction(raw: any) {
  const body = raw?.body ?? raw;
  const config = body?.runtime === "custom-container" ? body?.customContainerConfig : body?.customRuntimeConfig;
  return {
    runtime: body?.runtime ?? null,
    command: config?.command ?? null,
    args: config?.args ?? null,
    port: config?.port ?? null,
    healthCheckPath: config?.healthCheckConfig?.httpGetUrl ?? null,
    // GetFunction returns FunctionLayer objects; create/update inputs use ARN strings.
    layers: Array.isArray(body?.layers) ? body.layers
      .map((layer: unknown) => typeof layer === "string" ? layer
        : layer && typeof layer === "object" ? (layer as { arn?: unknown }).arn : undefined)
      .filter((arn: unknown): arn is string => typeof arn === "string") : [],
    status: body?.status ?? null,
  };
}

export async function readAppFunction(functionName: string, region: string) {
  const resolved = resolveAppsOss();
  if (!resolved.profile) throw Object.assign(new Error("FC credentials unavailable"), { code: "provider_unavailable" });
  const client = getFcClient({ ...resolved.profile, region });
  return (await client.getFunction(functionName, new $fc.GetFunctionRequest({}))).body;
}

export function providerErrorCode(error: unknown): string {
  if ((error as { statusCode?: unknown })?.statusCode === 404) return "function_missing";
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /(?:FunctionNotFound|ResourceNotFound|NotFound)/i.test(code)) return "function_missing";
  return "provider_unavailable";
}

export function driftFields(start: any, provider: ReturnType<typeof projectFunction>, region: string, buildKind?: string): string[] {
  const expectedLayers = (start?.layers ?? []).map((layer: string) => {
    const match = /^([^:]+):(\d+)$/.exec(layer);
    return match ? `acs:fc:${region}:official:layers/${match[1]}/versions/${match[2]}` : layer;
  });
  const fields: string[] = [];
  if ((buildKind === "container" ? "custom-container" : start?.fcRuntime ?? null) !== provider.runtime) fields.push("fcRuntime");
  if (JSON.stringify(start?.command ?? null) !== JSON.stringify(provider.command)) fields.push("command");
  if (JSON.stringify(start?.args ?? []) !== JSON.stringify(provider.args ?? [])) fields.push("args");
  if ((start?.port ?? null) !== provider.port) fields.push("port");
  if ((start?.healthCheckPath?.trim() || null) !== provider.healthCheckPath) fields.push("healthCheckPath");
  if (JSON.stringify(expectedLayers) !== JSON.stringify(provider.layers)) fields.push("layers");
  return fields;
}


const ORIGIN_FIELDS = new Set([
  "originAuth", "originEndpoint", "originHost", "providerFunction", "disableURLInternet", "protocol", "routeConfig",
  "authConfig.authType", "authConfig.authInfo", "authConfig.TokenLookup", "authConfig.ClaimPassBy", "authConfig.JWKS",
  "extraHttpTriggers", "customDomainAliases",
  "getTrigger", "getCustomDomain", "listTriggers", "listCustomDomains",
]);
/** Whitelist at every response boundary, even for injected provider readers. */
export function projectOriginSecurity(raw?: any): OriginSecuritySummary {
  return {
    status: ["protected", "legacy_unverified", "drift", "unavailable"].includes(raw?.status) ? raw.status : "unavailable",
    internetUrlDisabled: typeof raw?.internetUrlDisabled === "boolean" ? raw.internetUrlDisabled : null,
    customDomainAuth: ["jwt", "none", "unknown"].includes(raw?.customDomainAuth) ? raw.customDomainAuth : "unknown",
    httpsOnly: typeof raw?.httpsOnly === "boolean" ? raw.httpsOnly : null,
    driftFields: Array.isArray(raw?.driftFields) ? [...new Set<string>(raw.driftFields.filter((field: unknown) => typeof field === "string" && ORIGIN_FIELDS.has(field)))] : [],
  };
}

/** Strict and lazy: callers invoke this only after deploy authorization. */
export function validateAppOrigin(target: OriginTarget, readConfig = () => readAppsOriginAuthConfig(process.env)): { config: OriginAuthConfig; host: string } {
  try {
    const config = readConfig();
    const publicDomain = process.env.APPS_PUBLIC_DOMAIN?.trim().toLowerCase().replace(/\.$/, "");
    if (publicDomain && config.routeDomain === publicDomain) throw new Error("route domain");
    const label = appPublicLabel(target.slug, target.appId);
    if (!label) throw new Error("origin hostname");
    const host = `${label}.${config.routeDomain}`;
    originJwks(config, target.appId);
    return { config, host };
  } catch {
    // Parser/provider messages and their causes can contain supplied secrets.
    throw new ApiError(503, "origin_security_unavailable", "origin security unavailable: originAuth");
  }
}

type OriginRow = { id: string; slug: string; fc_endpoint?: string | null; fc_function_name?: string | null; fc_region?: string | null };
type OriginReader = (functionName: string, host: string, target: OriginTarget, config: OriginAuthConfig, region?: string | null) => Promise<OriginSecuritySummary>;
const readProviderOrigin: OriginReader = async (functionName, host, target, config, region) => {
  const resolved = resolveAppsOss();
  if (!resolved.profile) throw new Error("provider unavailable");
  const profile = { ...resolved.profile, ...(region ? { region } : {}) };
  return makeFcOps(getFcClient(profile), { bucket: profile.bucket, role: process.env.ROLE_ARN, region: profile.region, originAuth: config })
    .readOriginSecurity(functionName, host, target);
};

/** No writes and no migration: existing HTTP/default endpoints retain their path. */
export async function readAppOriginSecurity(row: OriginRow, reader: OriginReader = readProviderOrigin): Promise<OriginSecuritySummary> {
  const summary = projectOriginSecurity();
  let legacy = false;
  try {
    if (!row.fc_endpoint) return summary;
    const target = { appId: row.id, slug: row.slug };
    legacy = classifyOriginEndpoint(row.fc_endpoint, target, process.env.APPS_FC_ROUTE_DOMAIN ?? "") === "legacy";
    const { config, host } = validateAppOrigin(target);
    if (!row.fc_function_name) return { ...summary, status: legacy ? "legacy_unverified" : "unavailable", driftFields: ["providerFunction"] };
    const actual = projectOriginSecurity(await reader(row.fc_function_name, host, target, config, row.fc_region));
    return { ...actual, status: legacy ? "legacy_unverified" : actual.status };
  } catch {
    return { ...summary, status: legacy ? "legacy_unverified" : "unavailable", driftFields: ["originAuth"] };
  }
}
