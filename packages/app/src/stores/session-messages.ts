import { create as createProtoMessage, toBinary } from "@bufbuild/protobuf";
import { mqttPublish } from "@/lib/mqtt-bridge";
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
} from "@/lib/proto/teamclu_pb";
import { getBackend } from "@/lib/backend";
import { resolveCurrentMemberActorId } from "@/lib/current-actor";
import { useAuthStore } from "@/stores/auth-store";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import { useSessionListStore } from "@/stores/session-list-store";
import type { SendMessageFilePart } from "./session-types";
import type {
  Message,
  QueuedMessage,
  SessionState,
} from "./session-types";
import { updateSessionCache } from "./session-cache";
import { clearMessageTimeout } from "./session-internals";
import {
  useStreamingStore,
  cleanupAllChildSessions,
} from "@/stores/streaming";
import { trackEvent } from "@/lib/analytics";
import { insertMessageSorted } from "@/lib/insert-message-sorted";
import {
  resolvePendingPermissionActivityOwner,
  resolvePendingQuestionActivityOwner,
} from "@/lib/session-list-activity";
import { resolveSessionMentionActorIds } from "@/lib/resolve-session-mention-ids";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

export function createMessageActions(set: SessionSet, get: SessionGet) {
  async function ensureDaemonSessionForSend(content: string): Promise<string | null> {
    const existing = get().activeSessionId;
    if (existing) return existing;

    const authSession = useAuthStore.getState().session;
    const currentTeam = useCurrentTeamStore.getState().team;
    const currentMember = useCurrentTeamStore.getState().currentMember;
    if (!authSession || !currentTeam?.id) return null;

    const creatorActorId = await resolveCurrentMemberActorId(
      currentTeam.id,
      authSession.user.id,
      {
        currentTeamId: currentTeam.id,
        currentMemberId: currentMember?.id ?? null,
      },
    );
    if (!creatorActorId) {
      throw new Error(`No member actor found for team ${currentTeam.id}`);
    }

    const agentRows = (await getBackend().actors.listActorDirectory(currentTeam.id))
      .filter((row) => row.actor_type === "agent")
      .slice(0, 2);

    const soleAgent =
      (agentRows ?? []).length === 1
        ? agentRows[0]
        : null;

    const { createSessionShell } = await import("@/lib/session-create");
    const { promoteCreatedSessionToUi } = await import("@/lib/promote-created-session");
    const title = content.trim().slice(0, 80) || "New chat";
    const { sessionId } = await createSessionShell({
      teamId: currentTeam.id,
      creatorActorId,
      title,
      additionalActorIds: soleAgent ? [soleAgent.id] : [],
    });

    await promoteCreatedSessionToUi({
      sessionId,
      teamId: currentTeam.id,
      title,
      lastMessagePreview: content.trim().slice(0, 120) || null,
    });
    set({
      activeSessionId: sessionId,
      currentSessionId: sessionId,
      isLoading: false,
    } as Partial<SessionState>);

    if (soleAgent) {
      useEngagedAgentStore.getState().setAgents(sessionId, [{
        id: soleAgent.id,
        displayName: soleAgent.display_name || "AI",
      }]);
    }

    return sessionId;
  }

  async function sendViaDaemon(
    sessionId: string,
    content: string,
    userMessage: Message,
  ): Promise<void> {
    const authSession = useAuthStore.getState().session;
    if (!authSession) throw new Error("No authenticated user session");

    // The session's own row if the list has it, else the team we are in — a
    // composer only ever exists inside the current team. (This used to resolve
    // the team from a bare session id, which session reads no longer support.)
    const teamId =
      useSessionListStore.getState().rows.find((row) => row.id === sessionId)?.team_id ??
      useCurrentTeamStore.getState().team?.id ??
      null;
    if (!teamId) throw new Error(`No team_id found for session ${sessionId}`);

    const currentTeam = useCurrentTeamStore.getState().team;
    const currentMember = useCurrentTeamStore.getState().currentMember;
    const senderActorId = await resolveCurrentMemberActorId(
      teamId,
      authSession.user.id,
      {
        currentTeamId: currentTeam?.id ?? null,
        currentMemberId: currentMember?.id ?? null,
      },
    );
    if (!senderActorId) {
      throw new Error(`No actor found for user in team ${teamId}`);
    }

    const engagedAgent = useEngagedAgentStore.getState().get(sessionId);
    const mentionActorIds = await resolveSessionMentionActorIds(
      sessionId,
      [],
      engagedAgent ? [engagedAgent.id] : [],
    );
    const messageId = crypto.randomUUID();
    const createdAt = BigInt(Math.floor(Date.now() / 1000));
    const selectedModel = get().selectedModel;
    const messageModel = selectedModel?.modelID ?? "";

    const protoMessage = createProtoMessage(MessageSchema, {
      messageId,
      sessionId,
      senderActorId,
      kind: MessageKind.TEXT,
      content,
      createdAt,
      model: messageModel,
    });
    const sessionEnvelope = createProtoMessage(SessionMessageEnvelopeSchema, {
      message: protoMessage,
      mentionActorIds,
    });
    const liveEnvelope = createProtoMessage(LiveEventEnvelopeSchema, {
      eventId: crypto.randomUUID(),
      eventType: "message.created",
      sessionId,
      actorId: senderActorId,
      sentAt: createdAt,
      body: toBinary(SessionMessageEnvelopeSchema, sessionEnvelope),
    });

    await getBackend().messages.insertOutgoingMessage({
      id: messageId,
      teamId,
      sessionId,
      senderActorId,
      kind: "text",
      content,
      model: messageModel || null,
      metadata: { mention_actor_ids: mentionActorIds },
    });

    await mqttPublish(
      `amux/${teamId}/session/${sessionId}/live`,
      toBinary(LiveEventEnvelopeSchema, liveEnvelope),
      false,
    );

    (get() as any).appendMessage(sessionId, protoMessage);
    set((state) => {
      const newSessions = state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              messages: insertMessageSorted(session.messages, userMessage),
              title:
                session.messages.length === 0
                  ? content.slice(0, 50) + (content.length > 50 ? "..." : "")
                  : session.title,
              updatedAt: new Date(),
            }
          : session,
      );
      updateSessionCache(newSessions);
      return {
        sessions: newSessions,
        sessionError: null,
      };
    });
  }

  return {
    // Send a message to the active session (auto-creates Cloud session if needed)
    sendMessage: async (content: string, _agent?: string, imageParts?: SendMessageFilePart[]) => {
      if (!content.trim() && (!imageParts || imageParts.length === 0)) return;

      const activeSessionId = await ensureDaemonSessionForSend(content);
      if (!activeSessionId) {
        console.error("[Session] No active session and could not create Cloud session");
        return;
      }

      const { streamingMessageId } = useStreamingStore.getState();
      const { messageQueue: currentQueue } = get();
      console.log("[SendMessage] entry:", {
        streamingMessageId,
        queueLength: currentQueue.length,
        content: content.trim().slice(0, 30),
      });

      if (streamingMessageId) {
        console.log("[SendMessage] QUEUED (streamingMessageId is set):", streamingMessageId);
        const queuedMessage: QueuedMessage = {
          id: `queue-${Date.now()}`,
          content: content.trim(),
          timestamp: new Date(),
        };
        set((state) => ({
          messageQueue: [...state.messageQueue, queuedMessage],
        }));
        return;
      }

      if (imageParts && imageParts.length > 0) {
        console.warn("[SendMessage] Image attachments require ChatPanel outbox path; skipping legacy send");
        return;
      }

      trackEvent("message_sent");

      const now = Date.now();
      const userMessage: Message = {
        id: `temp-user-${now}`,
        sessionId: activeSessionId,
        role: "user",
        content: content.trim(),
        parts: [{ id: `part-${now}`, type: "text", content: content.trim() }],
        timestamp: new Date(now),
      };

      try {
        await sendViaDaemon(activeSessionId, content.trim(), userMessage);
      } catch (error) {
        set({
          error:
            error instanceof Error ? error.message : "Failed to send message",
          errorSessionId: activeSessionId,
        });
      }
    },

    // Abort the current session's operation
    abortSession: async () => {
      const { activeSessionId } = get();
      if (!activeSessionId) return;
      const { streamingMessageId, childSessionStreaming } = useStreamingStore.getState();
      const childSessionIds = Object.entries(childSessionStreaming || {})
        .filter(([, state]) => state.isStreaming)
        .map(([sessionId]) => sessionId);
      const abortedSessionIds = new Set([activeSessionId, ...childSessionIds]);
      const removeAbortedPendingInteractions = (state: SessionState) => ({
        pendingQuestions: state.pendingQuestions.filter((question) => {
          const owner = resolvePendingQuestionActivityOwner(question, state.sessions, activeSessionId);
          return !owner || !abortedSessionIds.has(owner);
        }),
        pendingPermissions: state.pendingPermissions.filter((entry) => {
          const owner = resolvePendingPermissionActivityOwner(entry, state.sessions, activeSessionId);
          return (
            (!owner || !abortedSessionIds.has(owner)) &&
            (!entry.childSessionId || !abortedSessionIds.has(entry.childSessionId)) &&
            (!entry.permission.sessionID || !abortedSessionIds.has(entry.permission.sessionID))
          );
        }),
      });

      try {
        clearMessageTimeout();
        const { interruptAllActiveAgents } = await import("@/lib/teamclu/interrupt-agent");
        await interruptAllActiveAgents(activeSessionId);

        useStreamingStore.getState().clearStreaming();
        cleanupAllChildSessions();
        set((state) => ({
          ...removeAbortedPendingInteractions(state),
          sessionError: null,
          sessions: state.sessions.map((s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.isStreaming || m.id === streamingMessageId
                ? { ...m, isStreaming: false }
                : m,
            ),
          })),
        }));

        setTimeout(() => {
          const { messageQueue, sendMessage: send } = get();
          if (messageQueue.length > 0) {
            const nextMessage = messageQueue[0];
            set((state) => ({
              messageQueue: state.messageQueue.slice(1),
            }));
            send(nextMessage.content);
          }
        }, 500);
      } catch (error) {
        useStreamingStore.getState().clearStreaming();
        cleanupAllChildSessions();
        set({
          error:
            error instanceof Error ? error.message : "Failed to abort session",
        });
      }
    },

    // Remove a message from the queue
    removeFromQueue: (id: string) => {
      set((state) => ({
        messageQueue: state.messageQueue.filter((m) => m.id !== id),
      }));
    },

    // Reload messages for the active session from the v2 message store
    reloadActiveSessionMessages: async () => {
      const { useSessionMessageStore } = await import("./session-message-store");
      await useSessionMessageStore.getState().reloadActiveSessionMessages();
    },
  };
}
