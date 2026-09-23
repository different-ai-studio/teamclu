import { ApiError } from "../http-utils.js";
import { RUNTIME_PROFILES, parseLayerRef, type LayerRef } from "./app-runtime-profiles.js";

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
  /**
   * Short form only, and only before resolution: the script inside the code
   * package. `resolveIntent` replaces it with the profile's command/args, so a
   * resolved spec never carries it.
   */
  entry?: string;
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
  // Alibaba's official catalog marks Go1 and PHP81-Debian10 compatible with
  // custom.debian10, not the newer Debian custom runtimes.
  go: { name: "Go1", version: 1 },
  php: { name: "PHP81-Debian10", version: 1 },
  // Alibaba FC official public-layer catalog (ListLayers --official), Java17
  // version 3. Catalog/docs: https://help.aliyun.com/en/functioncompute/fc/user-guide/configure-common-layers-for-a-function-1
  java: { name: "Java17", version: 3 },
};

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

/**
 * The layer ARNs to send to Function Compute.
 *
 * Two things happen here that cannot happen at parse time, because both need
 * the deploy region and the repo file is written without knowing it: shorthand
 * is expanded, and a full ARN naming another region is refused. FC would refuse
 * it too, a build-and-deploy later, as `cross-region access is not allowed` —
 * which names no region you could have used instead.
 */
export function resolveLayers(
  region: string,
  kind: AppBuildKind,
  layers: string[] | undefined,
): string[] {
  if (layers === undefined) return defaultLayersForKind(region, kind);
  if (layers.length === 0) return [];
  return layers.map((raw) => {
    const ref = requireLayerRef(raw);
    if (ref.kind === "shorthand") return layerArn(region, ref.name, ref.version);
    if (ref.region !== region) {
      const fix =
        ref.kind === "official"
          ? `write "${ref.name}:${ref.version}" and the region is filled in for you, or use ${layerArn(region, ref.name, ref.version)}`
          : `use the ${region} copy of that layer`;
      throw new ApiError(
        400,
        "validation_failed",
        `start.layers names a layer in ${ref.region}, but this app deploys to ${region} — a layer ARN must match the deploy region. To fix: ${fix}.`,
      );
    }
    return raw.trim();
  });
}

/** Shape-check a layer reference without needing to know the region yet. */
function requireLayerRef(raw: string): LayerRef {
  const ref = parseLayerRef(raw);
  if (!ref) {
    throw new ApiError(
      400,
      "validation_failed",
      `start.layers contains an invalid layer reference: ${raw} (expected an FC layer ARN, or "Name:version" for an official layer)`,
    );
  }
  return ref;
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
  const hasRuntime = Object.prototype.hasOwnProperty.call(raw, "runtime");
  const hasEntry = Object.prototype.hasOwnProperty.call(raw, "entry");
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

/** Default listen port. FC's own default, and what every template uses. */
const DEFAULT_PORT = 9000;

/** A path that stays inside the code package. */
function requirePackageRelative(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.split("/").includes("..")) {
    throw new ApiError(
      400,
      "validation_failed",
      `${label} must be a path inside the build output directory (no leading "/", no "..")`,
    );
  }
  return trimmed;
}

/**
 * Expand a declaration of intent into the FC start fields.
 *
 * The author names a language and an entry point; which Debian image, which
 * interpreter, and which layers are the platform's problem — they are values
 * only the platform can know, and asking the repository to guess them is what
 * produced twelve fix commits and four wrong regions.
 */
export function resolveIntent(
  kind: AppBuildKind,
  intent: { entry?: string; port: number; healthCheckPath?: string },
): AppStartSpec {
  if (isContainerKind(kind)) {
    throw new ApiError(
      400,
      "validation_failed",
      "a container app declares its start through its image, not start.entry",
    );
  }
  const profile = RUNTIME_PROFILES[kind as Exclude<AppBuildKind, "container">];
  if (!profile.verified) {
    throw new ApiError(
      400,
      "validation_failed",
      `start.entry is not supported for build.kind "${kind}" yet: its interpreter comes from a layer whose mount path has not been verified, and the platform will not guess one. Declare fcRuntime, command, args and layers explicitly for now.`,
    );
  }
  if (profile.entryRequired && !intent.entry) {
    throw new ApiError(
      400,
      "validation_failed",
      `start.entry is required for build.kind "${kind}" — the path to run inside the build output directory`,
    );
  }
  const entry = intent.entry ? requirePackageRelative(intent.entry, "start.entry") : undefined;
  return {
    fcRuntime: profile.fcRuntime,
    command: [profile.interpreter],
    args: profile.argsFor === "entry" && entry ? [entry] : [],
    port: intent.port,
    layers: [...profile.layers],
    ...(intent.healthCheckPath ? { healthCheckPath: intent.healthCheckPath } : {}),
  };
}

function parsePort(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PORT;
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
    // Shape only. The region check needs the deploy region, which this file is
    // written without, so it waits for `resolveLayers`.
    for (const raw of layers) requireLayerRef(raw);
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
    const args = parseStringArray(s.args, "start.args", { required: false });
    return {
      ...(fcRuntimeRaw ? { fcRuntime: fcRuntimeRaw } : {}),
      ...(command ? { command } : {}),
      ...(args ? { args } : {}),
      port,
      ...(layers !== undefined ? { layers } : {}),
      ...(healthCheckPath ? { healthCheckPath } : {}),
    };
  }

  const entryRaw = typeof s.entry === "string" ? s.entry.trim() : "";
  const passthroughFields = ["fcRuntime", "command", "args", "layers"].filter((k) =>
    Object.prototype.hasOwnProperty.call(s, k),
  );
  if (entryRaw && passthroughFields.length > 0) {
    throw new ApiError(
      400,
      "validation_failed",
      `start declares both forms: "entry" together with ${passthroughFields.join(", ")}. Use start.entry and let the platform choose, or declare the Function Compute fields yourself — not both.`,
    );
  }
  if (entryRaw || (!fcRuntimeRaw && passthroughFields.length === 0)) {
    return resolveIntent(build.kind, {
      entry: entryRaw || undefined,
      port,
      ...(healthCheckPath ? { healthCheckPath } : {}),
    });
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
