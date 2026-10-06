import { projectOriginSecurity } from "./app-runtime-info.js";
import type { OriginSecuritySummary } from "../apps-origin-auth.js";
import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../http-utils.js";
import { parseAppDeployDeclaration, resolveLayers, type AppDeployDeclaration } from "./app-runtime-spec.js";
import type { RuntimeCandidate } from "./app-runtime-catalog.js";

type Live = { runtime?: string | null; startSpec?: unknown; provider?: unknown; drift?: boolean; driftFields?: string[]; historical?: boolean; serving?: boolean; uninstallOperationId?: string | null } | null;
type Options = { region: string; capabilities: RuntimeCandidate[]; catalogComplete?: boolean; migrationIntent?: boolean; originSecurity?: OriginSecuritySummary };
type Change = { field: string; from: unknown; to: unknown };

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const normalized = (raw: unknown): AppDeployDeclaration => parseAppDeployDeclaration(raw);

function removedByUninstall(live: Live): boolean {
  return live?.historical === true && live.serving === false
    && typeof live.uninstallOperationId === "string" && live.uninstallOperationId.length > 0;
}

function baseline(live: Live): string {
  const provider = live?.provider as Record<string, unknown> | undefined;
  const config = provider && Object.fromEntries(["runtime", "command", "args", "port", "healthCheckPath", "layers"]
    .map(key => [key, provider[key] ?? null]));
  return digest(live && { runtime: live.runtime ?? null, startSpec: live.startSpec ?? null, provider: config ?? null, drift: !!live.drift, uninstallOperationId: live.uninstallOperationId ?? null });
}

export function preflightAppDeploy(appId: string, revision: string, rawDeclaration: unknown, live: Live, options: Options) {
  if (!revision || !/^(?:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/i.test(revision)) {
    throw new ApiError(400, "validation_failed", "revision must be a full git SHA or imported content digest");
  }
  const declaration = normalized(rawDeclaration);
  const layers = resolveLayers(options.region, declaration.build.kind, declaration.start.layers);
  if (live?.drift || (live && ((!live.provider && !removedByUninstall(live)) || !live.startSpec))) {
    throw new ApiError(409, "live_state_drift", `live provider configuration differs from the last successful deploy: ${(live.driftFields ?? []).join(", ") || "provider unavailable"}`);
  }
  const from = live?.startSpec as Record<string, unknown> | undefined;
  const to = declaration.start as unknown as Record<string, unknown>;
  const changes: Change[] = [];
  if (live) {
    for (const field of ["fcRuntime", "command", "args", "layers", "port", "healthCheckPath"]) {
      const oldValue = field === "layers" ? resolveLayers(options.region, declaration.build.kind, from?.layers as string[] | undefined ?? []) : from?.[field] ?? null;
      const newValue = field === "layers" ? layers : to[field] ?? null;
      if (canonical(oldValue) !== canonical(newValue)) changes.push({ field, from: oldValue, to: newValue });
    }
    if (live.runtime !== declaration.build.kind) changes.unshift({ field: "build.kind", from: live.runtime, to: declaration.build.kind });
  }
  const migrationFields = ["build.kind", "fcRuntime", "command", "args", "layers"];
  const migration = changes.some(change => migrationFields.includes(change.field));
  if (migration && !options.migrationIntent) {
    throw new ApiError(409, "runtime_migration_required", `explicit migration intent required for: ${changes.filter(c => migrationFields.includes(c.field)).map(c => c.field).join(", ")}`);
  }
  const runtimeChanged = !live || changes.some(change => change.field === "fcRuntime" || change.field === "build.kind");
  if (runtimeChanged && declaration.build.kind !== "container" && !options.catalogComplete) {
    throw new ApiError(503, "discovery_unavailable", "cannot verify a new runtime while regional discovery is incomplete");
  }
  const pinnedLayers = live?.startSpec ? resolveLayers(options.region, declaration.build.kind, (live.startSpec as { layers?: string[] }).layers ?? []) : [];
  for (const layer of layers) {
    if (pinnedLayers.includes(layer) && (live?.provider || removedByUninstall(live))) continue;
    if (!options.catalogComplete) throw new ApiError(503, "discovery_unavailable", `cannot verify new layer ${layer} while regional discovery is incomplete`);
    const candidate = options.capabilities.find(item => item.arn === layer);
    const runtime = declaration.build.kind === "container" ? "custom-container" : declaration.start.fcRuntime;
    if (!candidate || candidate.region !== options.region ||
        candidate.teamcluDeployable !== "teamcluDeployable" ||
        !candidate.compatibleRuntime.includes(runtime) ||
        (candidate.teamcluVerifiedRuntime && !candidate.teamcluVerifiedRuntime.includes(runtime))) {
      throw new ApiError(409, "unsupported_layer", `layer ${layer} is not deployable with ${runtime} in ${options.region}`);
    }
  }
  const payload = { appId, revision: revision.toLowerCase(), declarationDigest: digest(declaration), baselineDigest: baseline(live), migrationIntent: !!options.migrationIntent, issuedAt: Date.now(), nonce: randomUUID() };
  return {
    token: Buffer.from(JSON.stringify(payload)).toString("base64url"),
    preview: { originSecurity: projectOriginSecurity(options.originSecurity), firstDeploy: !live, changes, requiresMigrationApproval: migration },
  };
}

/** Preflight is a short-lived reservation; an abandoned dialog can be retried after ten minutes. */
export function isAppDeployPreflightExpired(token: string, now = Date.now()): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    return typeof payload.issuedAt !== "number" || payload.issuedAt > now || now - payload.issuedAt >= 10 * 60_000;
  } catch { return true; }
}

export function verifyAppDeployPreflight(token: string, appId: string, revision: string, rawDeclaration: unknown, live: Live): void {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); }
  catch { throw new ApiError(409, "preflight_mismatch", "invalid preflight token"); }
  if (payload.appId !== appId) throw new ApiError(409, "preflight_mismatch", "preflight app mismatch");
  if (payload.revision !== revision.toLowerCase()) throw new ApiError(409, "preflight_mismatch", "preflight revision mismatch");
  if (payload.declarationDigest !== digest(normalized(rawDeclaration))) throw new ApiError(409, "preflight_mismatch", "preflight declaration mismatch");
  if (payload.baselineDigest !== baseline(live)) throw new ApiError(409, "preflight_mismatch", "preflight live baseline changed");
  if (live?.drift || (live && !live.provider && !removedByUninstall(live))) throw new ApiError(409, "live_state_drift", "provider drift after preflight");
}
