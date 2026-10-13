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
  /**
   * The app the session belongs to (`sessions.app_id`, settable only at
   * create). It links the session to the app and does not move any agent into
   * the app's code: each plan must already point at that agent's checkout
   * (`applyAppCheckouts`), and the seats are bound to those workspaces here.
   */
  appId?: string | null;
  /** Everyone picked for the session, the caller and primary agent included or not. */
  collaboratorActorIds: ReadonlyArray<string>;
  mentionActorIds: ReadonlyArray<string>;
  /**
   * Display names for the mentioned agents. When given, the first message is
   * sent as `@<name> <message>` (see `firstMessageWithMentions`) so the chat
   * shows who it was addressed to.
   */
  mentionDisplayNameById?: Readonly<Record<string, string>>;
  runtimePlans: ReadonlyArray<RuntimeStartPlan>;
};

/**
 * Who the first message of a new session mentions — iOS
 * `SessionCreationInput.autoMentionAgentIDs` (#1601). Exactly one agent that
 * the viewer can reach (the connected-agents roster) is mentioned
 * automatically; several agents, or one the viewer has no grant on, mention
 * nobody and the user picks with @ in the session.
 *
 * Without a mention the daemon silent-queues the message, so a spawned
 * runtime would look like it was starting and then never reply.
 */
export function autoMentionAgentIds(
  agentActorIds: ReadonlyArray<string>,
  accessibleAgentIds: ReadonlyArray<string> | ReadonlySet<string>,
): string[] {
  const unique = Array.from(new Set(agentActorIds.filter((id) => id.length > 0)));
  if (unique.length !== 1) return [];
  const accessible =
    accessibleAgentIds instanceof Set ? accessibleAgentIds : new Set(accessibleAgentIds);
  return accessible.has(unique[0]) ? [unique[0]] : [];
}

/**
 * First-message body with `@<displayName> ` prepended for each mentioned agent
 * not already named inline — iOS `SessionCreationInput.firstMessageContent`.
 */
export function firstMessageWithMentions(
  message: string,
  mentionActorIds: ReadonlyArray<string>,
  displayNameById: Readonly<Record<string, string>>,
): string {
  let body = message;
  for (const actorId of mentionActorIds) {
    const name = displayNameById[actorId]?.trim();
    if (!name) continue;
    const token = `@${name}`;
    if (body.toLocaleLowerCase().includes(token.toLocaleLowerCase())) continue;
    body = body ? `${token} ${body}` : token;
  }
  return body;
}

/**
 * Seat bindings sent with the create — iOS `seatWorkspaceByActorID`. Only app
 * sessions bind seats explicitly; a plain session leaves each agent on its
 * default workspace, which the server fills in itself (and which may have no
 * path, which an explicit binding would be refused for).
 */
export function seatWorkspaceByActorId(
  appId: string | null | undefined,
  plans: ReadonlyArray<Pick<RuntimeStartPlan, "agentActorId" | "workspaceId">>,
): Record<string, string> {
  if (!appId) return {};
  const out: Record<string, string> = {};
  for (const plan of plans) {
    if (!(plan.agentActorId in out)) out[plan.agentActorId] = plan.workspaceId;
  }
  return out;
}

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
  // FC seeds `session_participants` with the caller plus
  // `participantActorIds` — not the primary agent on its own — so every picked
  // collaborator goes in that list, the primary agent first.
  const participantActorIds = Array.from(
    new Set(
      [input.primaryAgentActorId, ...input.collaboratorActorIds].filter(
        (id): id is string => typeof id === "string" && id.length > 0 && id !== input.memberActorId,
      ),
    ),
  );
  const appId = input.appId?.trim() || null;
  const workspaceByActorId = seatWorkspaceByActorId(appId, input.runtimePlans);
  const sessionId = await sessionsApi.createSession({
    teamId: input.teamId,
    title: input.title,
    mode: "collab",
    primaryAgentId: input.primaryAgentActorId,
    ideaId: input.ideaId,
    participantActorIds,
    ...(appId ? { appId } : {}),
    ...(Object.keys(workspaceByActorId).length > 0 ? { workspaceByActorId } : {}),
  });

  const trimmed = input.message.trim();
  const content =
    trimmed.length > 0 && input.mentionDisplayNameById
      ? firstMessageWithMentions(trimmed, input.mentionActorIds, input.mentionDisplayNameById)
      : trimmed;
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
