import { create as createMessage } from "@bufbuild/protobuf";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclu_pb";
import { resolveCurrentMemberActorId } from "@/lib/current-actor";
import { notePendingAgentReplyTo } from "@/lib/pending-agent-reply-to";
import { bumpSessionListLastMessage } from "@/lib/session-list-preview";
import { resolveSessionMentionActorIds } from "@/lib/resolve-session-mention-ids";
import { resolveAgentRuntimeIdsForSend } from "@/lib/send-path-resolve";
import { resolveSessionEstablishedModel } from "@/lib/session-established-model";
import { resolveAgentSessionModel } from "@/lib/resolve-agent-session-model";
import { resolveAgentBackendType } from "@/lib/agent-backend-type";
import { getKnownLocalDaemonActorId } from "@/lib/local-daemon-identity";
import { useAuthStore } from "@/stores/auth-store";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import { useOutboxStore } from "@/stores/outbox-store";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useSessionStore } from "@/stores/session-store";

/**
 * Send a plain-text agent prompt into the active session through the same
 * outbox path the chat composer uses (optimistic bubble, durable enqueue with
 * retries, agent-reply tracking). Used by the file editor's "ask the agent".
 *
 * Returns the message id, or null when there is no active session or no
 * signed-in team context to send from. It never creates a session: the
 * composer owns that flow.
 */
export async function sendAgentPromptInActiveSession(prompt: string): Promise<string | null> {
  const content = prompt.trim();
  if (!content) return null;

  const sessionId = useSessionSelectionStore.getState().activeSessionId;
  if (!sessionId) {
    console.warn("[session-send-agent] no active session to send into");
    return null;
  }

  const authSession = useAuthStore.getState().session;
  const currentTeam = useCurrentTeamStore.getState().team;
  const currentMember = useCurrentTeamStore.getState().currentMember;
  // The session's own row if the list has it, else the team we are in: a
  // composer only ever exists inside the current team.
  const teamId =
    useSessionListStore.getState().rows.find((row) => row.id === sessionId)?.team_id ??
    currentTeam?.id ??
    null;
  if (!authSession || !teamId) {
    console.warn("[session-send-agent] missing auth or team context", { sessionId });
    return null;
  }

  const senderActorId = await resolveCurrentMemberActorId(teamId, authSession.user.id, {
    currentTeamId: currentTeam?.id ?? null,
    currentMemberId: currentMember?.id ?? null,
  });
  if (!senderActorId) {
    throw new Error(`No actor found for user in team ${teamId}`);
  }

  // WYSIWYG: the engaged pill (if any) is who the prompt is addressed to.
  const engagedAgent = useEngagedAgentStore.getState().get(sessionId);
  const mentionActorIds = await resolveSessionMentionActorIds(
    sessionId,
    [],
    engagedAgent ? [engagedAgent.id] : [],
  );
  const agentRuntimeIds = resolveAgentRuntimeIdsForSend(
    sessionId,
    engagedAgent?.id ?? null,
    mentionActorIds,
  );

  // Same resolver the composer uses, so the model stamped here is the one
  // the session actually runs on. No agent means no model to stamp.
  const sendAgentId = agentRuntimeIds[0] ?? "";
  const resolvedModel = sendAgentId
    ? resolveAgentSessionModel({
        sessionId,
        agentId: sendAgentId,
        teamId,
        backendType: resolveAgentBackendType({
          agentId: sendAgentId,
          teamId,
          byRuntimeId: useRuntimeStateStore.getState().byRuntimeId,
        }),
        localDaemonActorId: getKnownLocalDaemonActorId(),
        sessionEstablishedModel: resolveSessionEstablishedModel(
          useSessionMessageStore.getState().messages[sessionId],
          sendAgentId,
        ),
      })
    : null;
  const model = resolvedModel?.selected?.modelId || "";

  const messageId = crypto.randomUUID();
  const createdAt = BigInt(Math.floor(Date.now() / 1000));
  const message = createMessage(MessageSchema, {
    messageId,
    sessionId,
    senderActorId,
    kind: MessageKind.TEXT,
    content,
    metadataJson: JSON.stringify({ mention_actor_ids: mentionActorIds }),
    createdAt,
    model,
  });

  // 1. Optimistic bubble; dedup-by-id makes the live echo a no-op.
  useSessionMessageStore.getState().appendMessage(sessionId, message);
  if (useSessionStore.getState().errorSessionId === sessionId) {
    useSessionStore.getState().clearSessionError();
  }

  // 2. Durable enqueue; outbox-sender persists, publishes and retries.
  await useOutboxStore.getState().enqueue({
    messageId,
    teamId,
    sessionId,
    senderActorId,
    content,
    model: model || null,
    mentionActorIds,
    displayMentionActorIds: engagedAgent ? [engagedAgent.id] : [],
    attachmentUrls: [],
    workspaceIdHint: null,
  });
  if (agentRuntimeIds.length > 0) {
    notePendingAgentReplyTo(sessionId, agentRuntimeIds, messageId);
  }
  bumpSessionListLastMessage(sessionId, content, {
    at: new Date().toISOString(),
    markUnread: false,
  });
  return messageId;
}
