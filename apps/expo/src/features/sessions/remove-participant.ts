import type { RuntimeRpcClient } from "../../lib/teamclu/runtime-rpc";

/**
 * Removing a participant from a session — iOS
 * `SessionDetailViewModel.removeAgent` / `removeHuman` (#1600).
 *
 * Order matters:
 *   1. Delete the participant row in the cloud. It goes first because it is
 *      also the permission gate: the server refuses a caller who neither
 *      created the session nor speaks for the agent, and a refused removal
 *      must not already have stopped the agent's runtime. A failure here
 *      rejects and nothing else runs.
 *   2. Agents only: stop the agent's runtime for this session, purging its
 *      binding, so the pi host lets go of the worktree. Best-effort, and
 *      skipped when no runtime id is known (daemon offline, nothing attached).
 *   3. Agents only: tell the agent's daemon to drop the participant from its
 *      in-memory roster and fan a notify event to other clients.
 *      Best-effort.
 */
export type RemoveSessionParticipantDeps = {
  removeFromCloud: (sessionId: string, actorId: string) => Promise<void>;
  /** Null when MQTT is down; the daemon steps are then skipped. */
  runtimeRpc: Pick<RuntimeRpcClient, "runtimeStop" | "removeParticipant"> | null;
  /** Failures of the best-effort daemon steps, for logging. */
  onDaemonStepError?: (step: "runtimeStop" | "removeParticipant", error: unknown) => void;
};

export type RemoveSessionParticipantInput = {
  sessionId: string;
  actorId: string;
  isAgent: boolean;
  /** The agent's live runtime for this session, when one is known. */
  runtimeId?: string | null;
  /** The seat's workspace, so the daemon purges the right binding. */
  workspaceId?: string | null;
};

export async function removeSessionParticipant(
  deps: RemoveSessionParticipantDeps,
  input: RemoveSessionParticipantInput,
): Promise<void> {
  await deps.removeFromCloud(input.sessionId, input.actorId);

  if (!input.isAgent || !deps.runtimeRpc) return;
  const rpc = deps.runtimeRpc;
  // An agent's routing actor is the agent actor itself.
  const targetActorId = input.actorId;

  const runtimeId = input.runtimeId?.trim() ?? "";
  if (runtimeId) {
    await rpc
      .runtimeStop({
        targetActorId,
        runtimeId,
        purgeBinding: true,
        workspaceId: input.workspaceId?.trim() ?? "",
      })
      .catch((error: unknown) => deps.onDaemonStepError?.("runtimeStop", error));
  }

  await rpc
    .removeParticipant({ targetActorId, sessionId: input.sessionId, actorId: input.actorId })
    .catch((error: unknown) => deps.onDaemonStepError?.("removeParticipant", error));
}
