import type { RuntimeRpcClient } from "../../lib/teamclu/runtime-rpc";
import type { createCloudSessionsApi } from "./cloud-api";
import type { RuntimeStartPlan } from "./runtime-start";

/**
 * Title for a new session: the first line of its first message, clipped. The
 * fallback covers a session opened with no message at all.
 */
export function deriveSessionTitle(firstMessage: string, fallback: string): string {
  const trimmed = firstMessage.trim();
  if (!trimmed) return fallback;
  const firstLine = trimmed.split(/\n/)[0] ?? trimmed;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

type SessionsApi = ReturnType<typeof createCloudSessionsApi>;

export type StartSessionDeps = {
  sessionsApi: Pick<SessionsApi, "createSession" | "addParticipants" | "insertOutgoingMessage">;
  /** Null when there is nothing to start; plans are then skipped. */
  runtimeRpc: Pick<RuntimeRpcClient, "runtimeStart"> | null;
  newMessageId: () => string;
  /**
   * `runtime_start` is fire-and-forget — the session exists and the user is
   * sent into it whether or not the agent comes up — so a failure is reported
   * here rather than thrown.
   */
  onRuntimeStartError: (plan: RuntimeStartPlan, error: unknown) => void;
};

export type StartSessionInput = {
  teamId: string;
  memberActorId: string;
  title: string;
  /** Sent as the first message when non-blank (trimmed). */
  message: string;
  primaryAgentActorId: string | null;
  ideaId?: string | null;
  /** Everyone picked for the session, the caller and primary agent included or not. */
  collaboratorActorIds: ReadonlyArray<string>;
  mentionActorIds: ReadonlyArray<string>;
  runtimePlans: ReadonlyArray<RuntimeStartPlan>;
};

/**
 * The shared tail of every "new session" flow — the New Session sheet and the
 * voice tab: create the session, add the extra participants, send the first
 * message, then ask each agent's daemon to start a runtime for it. Resolves
 * with the new session id.
 *
 * Runtime plans are resolved by the caller *before* this runs, so an offline
 * agent or a missing workspace fails the flow before a session is created.
 */
export async function startSessionWithAgents(
  deps: StartSessionDeps,
  input: StartSessionInput,
): Promise<string> {
  const { sessionsApi } = deps;
  const sessionId = await sessionsApi.createSession({
    teamId: input.teamId,
    title: input.title,
    mode: "collab",
    primaryAgentId: input.primaryAgentActorId,
    ideaId: input.ideaId,
  });

  // create_session seeds session_participants with the caller and the
  // primary agent. Add any other picked collaborators (extra agents,
  // humans) on top.
  const extras = input.collaboratorActorIds.filter(
    (id) => id !== input.primaryAgentActorId && id !== input.memberActorId,
  );
  if (extras.length > 0) {
    await sessionsApi.addParticipants(sessionId, extras);
  }

  const content = input.message.trim();
  if (content.length > 0) {
    await sessionsApi.insertOutgoingMessage({
      id: deps.newMessageId(),
      teamId: input.teamId,
      sessionId,
      senderActorId: input.memberActorId,
      content,
      metadata: { mention_actor_ids: [...input.mentionActorIds] },
    });
  }

  if (deps.runtimeRpc) {
    for (const plan of input.runtimePlans) {
      void deps.runtimeRpc
        .runtimeStart({
          targetActorId: plan.targetActorId,
          workspaceId: plan.workspaceId,
          worktree: plan.worktree,
          sessionId,
          agentType: plan.agentType,
          initialPrompt: "",
        })
        .catch((error: unknown) => deps.onRuntimeStartError(plan, error));
    }
  }

  return sessionId;
}
