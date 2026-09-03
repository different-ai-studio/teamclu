import {
  resolveAgentCatalogModels,
  clientMruProviderFallback,
} from "@/lib/agent/agent-model-fallback";
import type { AgentModelOption } from "@/lib/agent/agent-available-models";
import {
  selectAgentModel,
  resolveRuntimeStateEntryForAgent,
  type SelectedAgentModel,
} from "@/lib/agent/runtime-state-resolve";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useLocalDaemonCatalogStore } from "@/stores/local-daemon-catalog-store";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * Which model an agent runs this session's next prompt on.
 *
 * One message drives two calls that both have to answer this: the send path
 * stamps `message.model`, and `startAgentRuntimes` starts the runtime that
 * actually runs it. They each used to assemble the answer by hand, and the
 * assemblies were not the same — the send path widened the catalog beyond the
 * live retain and looked up this client's MRU, while the runtime-start path did
 * neither. So the message was stamped with the remembered model while the
 * runtime started with none, and they agreed only because the daemon still
 * keeps an MRU of its own to fall back on. ADR-0007 is removing that, and the
 * two would then start disagreeing outright.
 *
 * Both call it now, so there is one place to get it wrong instead of two.
 *
 * `explicitModelId` is the caller's own answer (cron and gateway pass a model
 * chosen when the job or channel was configured) and stays above the MRU: a
 * device's history must not override a model someone chose for this run.
 */
export function resolveAgentSessionModel(args: {
  sessionId: string;
  agentId: string;
  teamId: string | null | undefined;
  backendType: string | null | undefined;
  localDaemonActorId: string | null | undefined;
  /** A model the caller already decided on; outranks the MRU fallback. */
  explicitModelId?: string | null;
  /** Model the session's transcript shows it already ran with, when known. */
  sessionEstablishedModel?: string | null;
}): { selected: SelectedAgentModel; available: AgentModelOption[] } {
  const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId;
  const workspacePath = useWorkspaceStore.getState().workspacePath?.trim() || "";
  const localCatalog = workspacePath
    ? useLocalDaemonCatalogStore.getState().byWorkspacePath[workspacePath]
    : undefined;

  // Wider than the live retain on purpose: on a cold start no runtime has
  // attached, so the retain is empty and this device's persisted catalog is the
  // only list there is. Without it the MRU has nothing to match against and
  // reads as "never picked a model".
  const available = resolveAgentCatalogModels({
    agentId: args.agentId,
    localDaemonActorId: args.localDaemonActorId,
    sessionId: args.sessionId,
    byRuntimeId,
    runtimeInfo: resolveRuntimeStateEntryForAgent(args.agentId, byRuntimeId)?.info,
    localWorkspaceCatalogModels: localCatalog?.models,
    remoteDefaultCatalogModels:
      useRuntimeStateStore.getState().defaultCatalogByActorId[args.agentId]?.models,
  });

  const selected = selectAgentModel({
    sessionId: args.sessionId,
    agentId: args.agentId,
    available,
    byRuntimeId,
    providerFallback:
      args.explicitModelId?.trim() ||
      clientMruProviderFallback({
        agentId: args.agentId,
        localDaemonActorId: args.localDaemonActorId,
        backendType: args.backendType,
        teamId: args.teamId,
        available,
      }) ||
      undefined,
    sessionEstablishedModel: args.sessionEstablishedModel ?? undefined,
  });

  return { selected, available };
}
