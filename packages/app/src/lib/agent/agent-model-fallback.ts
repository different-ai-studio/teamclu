import {
  dedupeAgentModelOptions,
  resolveAgentAvailableModels,
  type AgentModelOption,
} from "@/lib/agent/agent-available-models";
import {
  clientMruModels,
  firstAvailableMruModel,
  useClientModelMruStore,
} from "@/stores/client-model-mru";
import type { RuntimeInfo } from "@/lib/proto/amux_pb";
import {
  resolveSessionAttachmentEntry,
  type RuntimeStateEntry,
} from "@/stores/runtime-state-store";

export function isLocalDaemonAgent(
  agentId: string,
  localDaemonActorId: string | null | undefined,
): boolean {
  const id = agentId.trim();
  const localId = localDaemonActorId?.trim() || "";
  return !!id && !!localId && id === localId;
}

/** Draft / pre-attachment: no session yet, or session exists but no attachment retain. */
function usesDraftCatalogContext(
  agentId: string,
  sessionId: string | null | undefined,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): boolean {
  const trimmedAgent = agentId.trim();
  const sid = sessionId?.trim() ?? "";
  if (!trimmedAgent) return true;
  if (!sid) return true;
  return !resolveSessionAttachmentEntry(trimmedAgent, sid, byRuntimeId);
}

/**
 * Model catalog for the agent pill and send path.
 *
 * Draft (no attachment): local agent → selected workspace loopback catalog;
 * remote agent → daemon-published default workspace catalog on `{actor}/state`.
 *
 * Attached session: retain first, loopback supplement for the local agent only.
 */
export function resolveAgentCatalogModels(args: {
  agentId: string;
  localDaemonActorId: string | null | undefined;
  sessionId: string | null | undefined;
  byRuntimeId: Record<string, RuntimeStateEntry>;
  runtimeInfo: RuntimeInfo | undefined;
  localWorkspaceCatalogModels: readonly AgentModelOption[] | undefined;
  remoteDefaultCatalogModels: readonly AgentModelOption[] | undefined;
}): AgentModelOption[] {
  if (
    usesDraftCatalogContext(args.agentId, args.sessionId, args.byRuntimeId)
  ) {
    if (isLocalDaemonAgent(args.agentId, args.localDaemonActorId)) {
      return dedupeAgentModelOptions(args.localWorkspaceCatalogModels);
    }
    return dedupeAgentModelOptions(args.remoteDefaultCatalogModels);
  }
  return agentAvailableModelsWithLocalCatalog({
    agentId: args.agentId,
    localDaemonActorId: args.localDaemonActorId,
    runtimeInfo: args.runtimeInfo,
    catalogModels: args.localWorkspaceCatalogModels,
    remoteDefaultCatalogModels: args.remoteDefaultCatalogModels,
  });
}

/**
 * The model catalog to resolve an agent against once a session attachment exists.
 *
 * The daemon retain is authoritative but may not have landed (or may not exist
 * at all, right after a restart). For the local agent the loopback catalog
 * answers the same question in one hop.
 */
export function agentAvailableModelsWithLocalCatalog(args: {
  agentId: string;
  localDaemonActorId: string | null | undefined;
  runtimeInfo: RuntimeInfo | undefined;
  catalogModels: readonly AgentModelOption[] | undefined;
  remoteDefaultCatalogModels?: readonly AgentModelOption[] | undefined;
}): AgentModelOption[] {
  const fromRetain = resolveAgentAvailableModels(args.runtimeInfo);
  if (fromRetain.length > 0) return fromRetain;
  if (isLocalDaemonAgent(args.agentId, args.localDaemonActorId)) {
    return dedupeAgentModelOptions(args.catalogModels);
  }
  return dedupeAgentModelOptions(args.remoteDefaultCatalogModels);
}

/**
 * The `providerFallback` slot for `selectAgentModel` — this client's MRU.
 *
 * The list now comes from `stores/client-model-mru` rather than the daemon's
 * `model-catalog.recent_models`: ADR-0007 moves the MRU out of amuxd, because a
 * preference the daemon owns is one a mis-picking client can poison for every
 * later session (see `agent-model-auto-persist.ts`). Callers pass
 * `useClientModelMruStore().recentFor(backend, teamId)`.
 *
 * Local agent only, unchanged: this client's history is about the backend and
 * team it has been running, which says nothing about a remote agent's catalog.
 */
export function localRecentModelFallback(args: {
  agentId: string;
  localDaemonActorId: string | null | undefined;
  recentModels: string[] | undefined;
  available: AgentModelOption[];
}): string {
  if (!isLocalDaemonAgent(args.agentId, args.localDaemonActorId)) return "";
  return firstAvailableMruModel(args.recentModels, args.available);
}

/**
 * The whole `providerFallback` slot in one call: look the MRU up and match it
 * against the live catalog.
 *
 * Exists because the send path and the runtime-start path each built this by
 * hand and drifted. `use-chat-send` looked the MRU up; `session-create` never
 * did, so one message produced two runtime starts that disagreed about the
 * model — the message was stamped with the remembered one while the runtime
 * started with none. They happened to agree only because the daemon still keeps
 * an MRU of its own to fall back on, and ADR-0007 is in the middle of removing
 * that. Two call sites deriving the same answer separately is what this
 * removes; there is now one place to key the lookup wrong.
 */
export function clientMruProviderFallback(args: {
  agentId: string;
  localDaemonActorId: string | null | undefined;
  backendType: string | null | undefined;
  teamId: string | null | undefined;
  available: AgentModelOption[];
}): string {
  return localRecentModelFallback({
    agentId: args.agentId,
    localDaemonActorId: args.localDaemonActorId,
    recentModels: clientMruModels(args.backendType, args.teamId),
    available: args.available,
  });
}

/**
 * Record a model the user actually chose.
 *
 * Only **explicit** picks land here. An auto-selection must not: writing a
 * cold-start guess down and reading it back as a preference is the loop
 * ADR-0007 breaks — every restart re-confirmed the wrong answer.
 */
export function recordClientModelPick(args: {
  agentId: string;
  localDaemonActorId: string | null | undefined;
  backendType: string | null | undefined;
  teamId: string | null | undefined;
  modelId: string;
}): void {
  if (!isLocalDaemonAgent(args.agentId, args.localDaemonActorId)) return;
  const backend = args.backendType?.trim();
  const team = args.teamId?.trim();
  const model = args.modelId.trim();
  if (!backend || !team || !model) return;
  useClientModelMruStore.getState().record(backend, team, model);
}
