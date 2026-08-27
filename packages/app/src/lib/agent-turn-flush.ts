import type { Message as TeamcluMessage } from "@/lib/proto/teamclu_pb";
import { scheduleMarkActiveSessionRead } from "@/lib/active-session-read";
import { logInterruptMsgDiag } from "@/lib/interrupt-msg-diag-core";
import { summarizePersistRelease } from "@/lib/interrupt-msg-diag";
import { bumpSessionListLastMessage } from "@/lib/session-list-preview";
import { persistStreamingPartsForReply, resolveStreamEntryForPersist } from "@/lib/streaming-persist";
import { upsertMessagesBatch, type MessageRow } from "@/lib/local-cache";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useV2StreamingStore, type AgentStreamEntry } from "@/stores/v2-streaming-store";
import { flushStreamDeltasFor } from "@/lib/stream-delta-buffer";
import {
  registerFlushedTurn,
} from "@/lib/flushed-turn-registry";
import { normalizeUnixTimestampSeconds, unixTimestampSecondsToIso } from "@/lib/message-timestamp";

export function buildAgentReplyMessageRow(
  teamId: string,
  reply: TeamcluMessage,
): MessageRow {
  const now = new Date().toISOString();
  const createdAtSec = normalizeUnixTimestampSeconds(reply.createdAt);
  return {
    id: reply.messageId,
    teamId,
    sessionId: reply.sessionId,
    turnId: reply.turnId || null,
    senderActorId: reply.senderActorId || null,
    replyToMessageId: reply.replyToMessageId?.trim() || null,
    kind: "agent_reply",
    content: reply.content,
    metadataJson: reply.metadataJson || null,
    model: reply.model || null,
    mentionsJson: null,
    origin: "mqtt-live",
    createdAt: unixTimestampSecondsToIso(createdAtSec, now),
    updatedAt: now,
    deletedAt: null,
    syncedAt: now,
    partsJson:
      (reply as unknown as { partsJson?: string | null }).partsJson ?? null,
  };
}

export function upsertAgentReplyToCache(
  teamId: string,
  reply: TeamcluMessage,
  logLabel = "flush agent_reply",
): void {
  upsertMessagesBatch([buildAgentReplyMessageRow(teamId, reply)]).catch((e) => {
    console.warn(`[cache] ${logLabel} upsert failed:`, e);
  });
}

export function releaseStreamAfterAgentReplyPersist(
  sessionId: string,
  actorId: string,
  enrichedReply: TeamcluMessage,
  opts: {
    trigger: string;
    persistedPartsJson?: string;
    streamEntrySnapshot?: AgentStreamEntry;
  },
): void {
  useV2StreamingStore.getState().finishSessionActor(sessionId, actorId, {
    reason: "flushTurnAgentReply",
  });
  useV2StreamingStore.getState().releaseActorAfterPersist(sessionId, actorId, {
    persistedPartsJson: opts.persistedPartsJson,
    persistedSourceStreamId: opts.streamEntrySnapshot?.streamId,
  });
  useV2StreamingStore.getState().clearStaleStreamErrors(sessionId, actorId);
  const archivedAfter = useV2StreamingStore.getState().archived.filter(
    (entry) => entry.sessionId === sessionId && entry.actorId === actorId,
  ).length;
  logInterruptMsgDiag("flush.done", {
    sessionId,
    actorId,
    trigger: opts.trigger,
    messageId: enrichedReply.messageId,
    archivedCountAfter: archivedAfter,
    storeMessageCount:
      useSessionMessageStore.getState().messages[sessionId]?.length ?? 0,
  });
}

export function bumpPreviewFromAgentReply(
  sessionId: string,
  reply: TeamcluMessage,
): void {
  let preview = reply.content;
  try {
    const md = reply.metadataJson
      ? (JSON.parse(reply.metadataJson) as Record<string, unknown>)
      : null;
    if (
      md?.turn_status === "interrupted" &&
      preview.trimStart().startsWith("[Turn interrupted by user]")
    ) {
      // Hide English agent-facing notice from session list; keep real prose.
      preview = "";
    }
  } catch {
    // keep raw content
  }
  const createdAtSec = normalizeUnixTimestampSeconds(reply.createdAt);
  bumpSessionListLastMessage(sessionId, preview, {
    at: createdAtSec > 0n ? unixTimestampSecondsToIso(createdAtSec) : undefined,
  });
  scheduleMarkActiveSessionRead(sessionId, reply.messageId);
}

/** Shared post-persist commit: store, cache, release stream, session preview.
 * UI handoff order: put AGENT_REPLY (with partsJson) into the message store
 * before releasing the live stream, so ChatMessage can show「处理过程」
 * without a blank gap after the Composer dock closes. */
export function commitFlushedAgentReply(
  sessionId: string,
  actorId: string,
  enrichedReply: TeamcluMessage,
  opts: {
    trigger: string;
    teamId: string;
    streamEntrySnapshot?: AgentStreamEntry;
    persistedStage: string;
    persistedExtras?: Record<string, unknown>;
  },
): void {
  useSessionMessageStore
    .getState()
    .replaceTurnAgentRepliesInStore(sessionId, enrichedReply);
  upsertAgentReplyToCache(opts.teamId, enrichedReply);
  const persistedPartsJson = (enrichedReply as { partsJson?: string }).partsJson;
  registerFlushedTurn(sessionId, actorId, {
    messageId: enrichedReply.messageId,
    streamId: opts.streamEntrySnapshot?.streamId ?? "",
    turnId: enrichedReply.turnId ?? "",
  });
  logInterruptMsgDiag(opts.persistedStage, {
    sessionId,
    actorId,
    trigger: opts.trigger,
    messageId: enrichedReply.messageId,
    turnId: enrichedReply.turnId,
    contentLength: (enrichedReply.content ?? "").trim().length,
    ...summarizePersistRelease({ persistedPartsJson }),
    ...opts.persistedExtras,
  });
  releaseStreamAfterAgentReplyPersist(sessionId, actorId, enrichedReply, {
    trigger: opts.trigger,
    persistedPartsJson,
    streamEntrySnapshot: opts.streamEntrySnapshot,
  });
  bumpPreviewFromAgentReply(sessionId, enrichedReply);
}

export async function executeAgentTurnFlush(args: {
  sessionId: string;
  actorId: string;
  trigger: string;
  teamId: string;
  reply: TeamcluMessage;
  pendingReplies: TeamcluMessage[];
  streamEntrySnapshot?: AgentStreamEntry;
  beforePersist?: () => void;
  afterEnriched?: (enriched: TeamcluMessage) => void;
  /** When false, release the stream but do not insert the reply (eager flush superseded). */
  shouldCommit?: () => boolean;
  persistedStage: string;
}): Promise<void> {
  // Drain any buffered text deltas so persisted parts include all arrived text.
  flushStreamDeltasFor(args.sessionId, args.actorId);
  args.beforePersist?.();
  const live = useV2StreamingStore.getState().byKey[`${args.sessionId}::${args.actorId}`];
  const streamEntryForPersist = resolveStreamEntryForPersist(
    args.sessionId,
    args.actorId,
    live ?? args.streamEntrySnapshot,
  );
  const enrichedReply = await persistStreamingPartsForReply(
    args.sessionId,
    args.actorId,
    args.reply,
    args.pendingReplies,
    { streamEntrySnapshot: streamEntryForPersist },
  );
  args.afterEnriched?.(enrichedReply);
  if (args.shouldCommit && !args.shouldCommit()) {
    logInterruptMsgDiag("flush.skipCommit.superseded", {
      sessionId: args.sessionId,
      actorId: args.actorId,
      trigger: args.trigger,
      messageId: enrichedReply.messageId,
      turnId: enrichedReply.turnId,
    });
    // Stream was already detached for interrupt flushes; still release so the
    // dock/archive handoff completes without inserting the synthetic reply.
    releaseStreamAfterAgentReplyPersist(
      args.sessionId,
      args.actorId,
      enrichedReply,
      {
        trigger: args.trigger,
        persistedPartsJson: (enrichedReply as { partsJson?: string }).partsJson,
        streamEntrySnapshot: streamEntryForPersist,
      },
    );
    return;
  }
  commitFlushedAgentReply(args.sessionId, args.actorId, enrichedReply, {
    trigger: args.trigger,
    teamId: args.teamId,
    streamEntrySnapshot: streamEntryForPersist,
    persistedStage: args.persistedStage,
  });
}
