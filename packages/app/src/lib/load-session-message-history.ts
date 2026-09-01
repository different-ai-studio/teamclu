import { isChromeExtension } from "@/lib/platform";
import { isTauri } from "@/lib/utils";
import { getBackend } from "@/lib/backend";
import { historyRowsToMessageRows } from "@/lib/message-history-map";
import { messageRowsToProto } from "@/lib/session-export/collect";
import { syncMessagesForSession } from "@/lib/sync/message-sync";
import { logExtMsgDiag, summarizeProtosForExtDiag } from "@/lib/extension-msg-diag";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageSchema, MessageKind } from "@/lib/proto/teamclu_pb";
import { useSessionMessageStore } from "@/stores/session-message-store";

const kindMap: Record<string, MessageKind> = {
  text: MessageKind.TEXT,
  system: MessageKind.SYSTEM,
  agent_thinking: MessageKind.AGENT_THINKING,
  agent_tool_call: MessageKind.AGENT_TOOL_CALL,
  agent_tool_result: MessageKind.AGENT_TOOL_RESULT,
  agent_reply: MessageKind.AGENT_REPLY,
};

export type LoadSessionMessageHistoryOptions = {
  sessionId: string;
  teamId: string;
  workspacePath?: string | null;
  forceFull?: boolean;
  signal?: AbortSignal;
};

/** Hydrate session-message store from local cache + cloud (same paths as main session). */
export async function loadSessionMessageHistory(
  options: LoadSessionMessageHistoryOptions,
): Promise<void> {
  const { sessionId, teamId, workspacePath, forceFull = false, signal } = options;
  if (!sessionId || signal?.aborted) return;

  if (isTauri()) {
    const { loadMessagesForSession } = await import("@/lib/local-cache");
    const localMsgs = await loadMessagesForSession(
      sessionId,
      false,
      workspacePath ?? undefined,
    );
    if (signal?.aborted) return;
    if (localMsgs.length > 0) {
      useSessionMessageStore.getState().setMessages(
        sessionId,
        messageRowsToProto(localMsgs),
      );
    }

    const synced = await syncMessagesForSession(sessionId, teamId, { full: forceFull });
    if (forceFull && teamId) {
      const { syncParticipantsForSession } = await import(
        "@/lib/sync/session-participant-sync"
      );
      await syncParticipantsForSession(sessionId, teamId, { full: true });
    }
    if (signal?.aborted) return;
    if (synced > 0) {
      const fresh = await loadMessagesForSession(
        sessionId,
        false,
        workspacePath ?? undefined,
      );
      if (!signal?.aborted) {
        useSessionMessageStore.getState().setMessages(
          sessionId,
          messageRowsToProto(fresh),
        );
      }
    }
    return;
  }

  if (isChromeExtension()) {
    const { loadMessagesForSession, upsertMessagesBatch } = await import("@/lib/local-cache");
    const localMsgs = await loadMessagesForSession(sessionId, false);
    if (signal?.aborted) return;
    if (localMsgs.length > 0) {
      const localProtos = messageRowsToProto(localMsgs);
      useSessionMessageStore.getState().setMessages(sessionId, localProtos);
      logExtMsgDiag("history.ext.hydrateLocal", {
        sessionId,
        ...summarizeProtosForExtDiag(localProtos),
      });
    }

    let historyRows;
    try {
      historyRows = (await getBackend().messages.listMessages(sessionId)).rows;
    } catch (error) {
      console.warn(
        "[history] load failed:",
        error instanceof Error ? error.message : error,
      );
      if (!signal?.aborted && localMsgs.length === 0) {
        useSessionMessageStore.getState().setMessages(sessionId, []);
      }
      return;
    }
    if (signal?.aborted) return;

    const memoryBeforeCloud = useSessionMessageStore.getState().messages[sessionId] ?? [];
    logExtMsgDiag("history.ext.beforeCloudUpsert", {
      sessionId,
      cloudCount: historyRows.length,
      memory: summarizeProtosForExtDiag(memoryBeforeCloud),
    });
    await upsertMessagesBatch(
      historyRowsToMessageRows(historyRows, {
        teamId,
        origin: getBackend().kind,
      }),
    );
    if (signal?.aborted) return;

    const fresh = await loadMessagesForSession(sessionId, false);
    if (!signal?.aborted) {
      const freshProtos = messageRowsToProto(fresh);
      useSessionMessageStore.getState().setMessages(sessionId, freshProtos);
      logExtMsgDiag("history.ext.afterSetMessages", {
        sessionId,
        note: "whole-replace from cache after cloud upsert — check partsLen / interruptCount",
        ...summarizeProtosForExtDiag(freshProtos),
      });
    }
    return;
  }

  let historyRows;
  try {
    historyRows = (await getBackend().messages.listMessages(sessionId)).rows;
  } catch (error) {
    console.warn("[history] load failed:", error instanceof Error ? error.message : error);
    if (!signal?.aborted) {
      useSessionMessageStore.getState().setMessages(sessionId, []);
    }
    return;
  }
  if (signal?.aborted) return;

  const backendMsgs = historyRows.map((r) => {
    const metadataJson =
      r.metadata == null
        ? ""
        : typeof r.metadata === "string"
          ? r.metadata
          : JSON.stringify(r.metadata);
    return createMessage(MessageSchema, {
      messageId: r.id,
      sessionId: r.session_id,
      senderActorId: r.sender_actor_id ?? "",
      kind: kindMap[r.kind] ?? MessageKind.TEXT,
      content: r.content ?? "",
      model: r.model ?? "",
      turnId: r.turn_id ?? "",
      replyToMessageId: r.reply_to_message_id ?? "",
      metadataJson,
      createdAt: BigInt(Math.floor(new Date(r.created_at).getTime() / 1000)),
    });
  });
  useSessionMessageStore.getState().setMessages(sessionId, backendMsgs);
}
