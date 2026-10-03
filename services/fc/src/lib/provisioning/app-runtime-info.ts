import * as $fc from "@alicloud/fc20230330";
import { getFcClient } from "./fc-client.js";
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
