import { ApiError } from "../http-utils.js";

export type AppBuildKind =
  | "node"
  | "python"
  | "go"
  | "php"
  | "java"
  | "container";

export const BUILD_KINDS: readonly AppBuildKind[] = [
  "node",
  "python",
  "go",
  "php",
  "java",
  "container",
];

export interface AppBuildSpec {
  kind: AppBuildKind;
  output: string;
  command?: string;
  dockerfile?: string;
  context?: string;
}

export interface AppStartSpec {
  /** FC `runtime`. Required unless kind is container (then forced to custom-container). */
  fcRuntime?: string;
  command?: string[];
  args?: string[];
  port: number;
  /**
   * `undefined` = apply kind defaults.
   * `[]` = attach no layers.
   * non-empty = exactly these ARNs.
   */
  layers?: string[];
  healthCheckPath?: string;
}

export interface AppDeployDeclaration {
  build: AppBuildSpec;
  start: AppStartSpec;
}

export const FC_CODE_RUNTIMES: readonly string[] = [
  "custom",
  "custom.debian10",
  "custom.debian11",
  "custom.debian12",
];

export const CONTAINER_RUNTIME_FC = "custom-container";

const LAYER_VERSIONS: Record<Exclude<AppBuildKind, "container">, { name: string; version: number }> = {
  node: { name: "Nodejs20", version: 3 },
  python: { name: "Python310", version: 3 },
  go: { name: "Go1", version: 1 },
  php: { name: "PHP81-Debian10", version: 1 },
  java: { name: "Java17", version: 1 },
};

const OFFICIAL_LAYER_ARN =
  /^acs:fc:[a-z0-9-]+:official:layers\/[A-Za-z0-9._-]+\/versions\/\d+$/;
const ACCOUNT_LAYER_ARN =
  /^acs:fc:[a-z0-9-]+:\d+:layers\/[A-Za-z0-9._-]+\/versions\/\d+$/;

export function isContainerKind(kind: string): boolean {
  return kind === "container";
}

export function layerArn(region: string, name: string, version: number): string {
  return `acs:fc:${region}:official:layers/${name}/versions/${version}`;
}

export function defaultLayersForKind(region: string, kind: AppBuildKind): string[] {
  if (isContainerKind(kind)) return [];
  const pin = LAYER_VERSIONS[kind];
  return [layerArn(region, pin.name, pin.version)];
}

export function resolveLayers(
  region: string,
  kind: AppBuildKind,
  layers: string[] | undefined,
): string[] {
  if (layers === undefined) return defaultLayersForKind(region, kind);
  if (layers.length === 0) return [];
  for (const arn of layers) {
    if (!isValidLayerArn(arn)) {
      throw new ApiError(400, "validation_failed", `start.layers contains an invalid layer ARN: ${arn}`);
    }
  }
  return [...layers];
}

function isValidLayerArn(arn: string): boolean {
  const trimmed = arn.trim();
  return OFFICIAL_LAYER_ARN.test(trimmed) || ACCOUNT_LAYER_ARN.test(trimmed);
}

function isBuildKind(raw: string): raw is AppBuildKind {
  return (BUILD_KINDS as readonly string[]).includes(raw);
}

function requireObject(raw: unknown, label: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "validation_failed", `${label} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function rejectLegacyShape(raw: Record<string, unknown>): void {
  const hasRuntime = typeof raw.runtime === "string";
  const hasEntry = typeof raw.entry === "string";
  if (hasRuntime || hasEntry) {
    throw new ApiError(
      400,
      "validation_failed",
      "teamclu.app.json uses the legacy runtime/entry shape — replace with build + start (see FC runtime passthrough contract)",
    );
  }
}

function parseStringArray(raw: unknown, label: string, { required }: { required: boolean }): string[] | undefined {
  if (raw === undefined) {
    if (required) {
      throw new ApiError(400, "validation_failed", `${label} is required`);
    }
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "validation_failed", `${label} must be an array of strings`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      throw new ApiError(400, "validation_failed", `${label} must be an array of non-empty strings`);
    }
    out.push(item);
  }
  return out;
}

function parsePort(raw: unknown): number {
  const port = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(400, "validation_failed", "start.port must be a TCP port between 1 and 65535");
  }
  return port;
}

function parseBuild(raw: unknown): AppBuildSpec {
  const b = requireObject(raw, "build");
  const kindRaw = typeof b.kind === "string" ? b.kind.trim() : "";
  if (!kindRaw || !isBuildKind(kindRaw)) {
    throw new ApiError(
      400,
      "validation_failed",
      `build.kind must be one of: ${BUILD_KINDS.join(", ")}`,
    );
  }
  const container = isContainerKind(kindRaw);
  const outputDefault = kindRaw === "node" ? ".output" : ".";
  const output =
    typeof b.output === "string" && b.output.trim()
      ? b.output.trim()
      : outputDefault;
  const command =
    typeof b.command === "string" && b.command.trim() ? b.command.trim() : undefined;
  if (container) {
    const dockerfile =
      typeof b.dockerfile === "string" && b.dockerfile.trim()
        ? b.dockerfile.trim()
        : "Dockerfile";
    const context =
      typeof b.context === "string" && b.context.trim() ? b.context.trim() : ".";
    return { kind: kindRaw, output, command, dockerfile, context };
  }
  return { kind: kindRaw, output, command };
}

function parseStart(build: AppBuildSpec, raw: unknown): AppStartSpec {
  const s = requireObject(raw, "start");
  const port = parsePort(s.port);
  const healthCheckPath =
    typeof s.healthCheckPath === "string" ? s.healthCheckPath.trim() : "";
  if (healthCheckPath && !healthCheckPath.startsWith("/")) {
    throw new ApiError(400, "validation_failed", "start.healthCheckPath must start with /");
  }

  let layers: string[] | undefined;
  if (s.layers !== undefined) {
    layers = parseStringArray(s.layers, "start.layers", { required: true }) ?? [];
    resolveLayers("", build.kind, layers);
  }

  const container = isContainerKind(build.kind);
  const fcRuntimeRaw = typeof s.fcRuntime === "string" ? s.fcRuntime.trim() : "";

  if (container) {
    if (fcRuntimeRaw && fcRuntimeRaw !== CONTAINER_RUNTIME_FC) {
      throw new ApiError(
        400,
        "validation_failed",
        `start.fcRuntime for container must be "${CONTAINER_RUNTIME_FC}" when set`,
      );
    }
    const command = parseStringArray(s.command, "start.command", { required: false });
    const args = parseStringArray(s.args, "start.args", { required: false }) ?? [];
    return {
      ...(fcRuntimeRaw ? { fcRuntime: fcRuntimeRaw } : {}),
      ...(command ? { command } : {}),
      args,
      port,
      ...(layers !== undefined ? { layers } : {}),
      ...(healthCheckPath ? { healthCheckPath } : {}),
    };
  }

  if (!fcRuntimeRaw) {
    throw new ApiError(400, "validation_failed", "start.fcRuntime is required for non-container apps");
  }
  if (!(FC_CODE_RUNTIMES as readonly string[]).includes(fcRuntimeRaw)) {
    throw new ApiError(
      400,
      "validation_failed",
      `start.fcRuntime must be one of: ${FC_CODE_RUNTIMES.join(", ")}`,
    );
  }
  const command = parseStringArray(s.command, "start.command", { required: true }) ?? [];
  if (command.length === 0) {
    throw new ApiError(400, "validation_failed", "start.command must be a non-empty array for non-container apps");
  }
  const args = parseStringArray(s.args, "start.args", { required: false }) ?? [];
  return {
    fcRuntime: fcRuntimeRaw,
    command,
    args,
    port,
    ...(layers !== undefined ? { layers } : {}),
    ...(healthCheckPath ? { healthCheckPath } : {}),
  };
}

export function parseAppDeployDeclaration(raw: unknown): AppDeployDeclaration {
  const root = requireObject(raw, "teamclu.app.json");
  rejectLegacyShape(root);
  if (root.build === undefined) {
    throw new ApiError(400, "validation_failed", "build is required in teamclu.app.json");
  }
  if (root.start === undefined) {
    throw new ApiError(400, "validation_failed", "start is required in teamclu.app.json");
  }
  const build = parseBuild(root.build);
  const start = parseStart(build, root.start);
  return { build, start };
}

export function parseDeclaredBuildKind(raw: unknown): AppBuildKind | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new ApiError(400, "validation_failed", "build.kind must be a string");
  }
  const kind = raw.trim();
  if (!kind) return undefined;
  if (!isBuildKind(kind)) {
    throw new ApiError(
      400,
      "validation_failed",
      `build.kind must be one of: ${BUILD_KINDS.join(", ")}`,
    );
  }
  return kind;
}
