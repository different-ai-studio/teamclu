import { ApiError } from "../http-utils.js";
import {
  LAYER_MOUNTS,
  RUNTIME_PROFILES,
  layerRootOf,
  parseLayerRef,
  pathLookup,
  providedMounts,
  startProgram,
  type LayerRef,
} from "./app-runtime-profiles.js";

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

/**
 * The layers a passthrough declaration ends up with, named without a region.
 *
 * Omitting `layers` resolves to the kind's default, so the rules below have to
 * account for it — otherwise a config that works would look like it attaches
 * nothing.
 */
function effectiveLayerRefs(kind: AppBuildKind, layers: string[] | undefined): LayerRef[] {
  if (layers === undefined) {
    if (isContainerKind(kind)) return [];
    const pin = LAYER_VERSIONS[kind as Exclude<AppBuildKind, "container">];
    return [{ kind: "shorthand", name: pin.name, version: pin.version }];
  }
  return layers.map(requireLayerRef);
}

/**
 * Refuse a start command the chosen image and layers cannot run, and name the
 * one that would work.
 *
 * Throws for what the environment table proves impossible; returns advisories
 * for what merely looks wrong. A layer whose mount path is unverified makes a
 * rule step aside rather than guess — blocking a working deploy on our own
 * ignorance is worse than the round-trip it saves.
 */
export function checkStartEnvironment(build: AppBuildSpec, start: AppStartSpec): string[] {
  if (isContainerKind(build.kind)) return [];
  const program = startProgram(start.command, start.args);
  if (!program) return [];
  const fcRuntime = start.fcRuntime ?? "";
  const refs = effectiveLayerRefs(build.kind, start.layers);
  const profile = RUNTIME_PROFILES[build.kind as Exclude<AppBuildKind, "container">];
  const where = program.viaShell ? "the shell script in start.args" : "start.command";

  // The command reaches into a layer's mount point. If every attached layer is
  // one we know, we can say for certain whether that path will be there.
  if (program.form === "absolute") {
    const root = layerRootOf(program.token);
    if (root) {
      const { mounts, hasUnknown } = providedMounts(refs);
      if (!hasUnknown && !mounts.includes(root)) {
        const attached = refs.length
          ? refs.map((r) => `${r.name}:${r.version}`).join(", ")
          : "none";
        const provider = Object.entries(LAYER_MOUNTS).find(([, m]) => m === root)?.[0];
        const fix = provider
          ? `attach it with "layers": ["${provider}:<version>"]`
          : `attach the layer that provides ${root}`;
        const instead = profile?.verified
          ? profile.interpreter
          : "an interpreter the image already ships";
        throw new ApiError(
          400,
          "validation_failed",
          `${where} runs ${program.token}, but nothing mounts ${root} — layers attached: ${attached}. To fix: ${fix}, or run ${instead}.`,
        );
      }
    }
  }

  // A bare name resolves through PATH to the image's own interpreter, never a
  // layer's. On debian10 `node` is not there at all; on Debian 9 everything is
  // there but too old to run code written today.
  const warnings: string[] = [];
  if (program.form === "bare") {
    const found = pathLookup(fcRuntime, program.basename);
    const alternative = profile?.verified
      ? profile.interpreter
      : "an absolute path to the interpreter you mean";
    if (found.kind === "absent") {
      throw new ApiError(
        400,
        "validation_failed",
        `${where} runs "${program.basename}", which is not on PATH in the ${fcRuntime} image. To fix: run ${alternative}.`,
      );
    }
    // Stale, not absent: Debian 9's interpreters are old enough to be a trap,
    // but apps are serving traffic on them right now. Refusing would block a
    // working deploy to protect it from a hazard it has already survived, which
    // is the same overreach as silently re-profiling a live app. Say so loudly
    // and let the author decide.
    if (found.kind === "resolves" && fcRuntime === "custom") {
      warnings.push(
        `${where} runs "${program.basename}", which on fcRuntime "custom" (Debian 9) is ${program.basename} ${found.version} — old enough that modern syntax and packages will fail. Consider fcRuntime "custom.debian10" and ${alternative}.`,
      );
    } else if (
      found.kind === "resolves" &&
      profile?.verified &&
      found.path !== profile.interpreter
    ) {
      // The name resolves, but to a different interpreter than this kind wants,
      // and nothing anywhere says so.
      warnings.push(
        `${where} runs "${program.basename}", which resolves to ${found.path} on ${fcRuntime} — not ${profile.interpreter}. The function will run ${found.version}.`,
      );
    }
  }
  return warnings;
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
  for (const warning of checkStartEnvironment(build, start)) {
    console.warn(`[apps] teamclu.app.json: ${warning}`);
  }
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
