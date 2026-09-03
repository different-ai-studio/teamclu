import {
  scheduleSessionListRefresh,
} from "@/lib/messages/inbox-handler";
import { MessageKind} from "@/lib/proto/teamclu_pb";
import { agentStreamKey, isToolOnlyTurnAnchor} from "@/lib/stream/live-agent-stream";
import { flushAllStreamDeltas } from "@/lib/stream/stream-delta-buffer";
import { bumpSessionListLastMessage, messageKindUpdatesSessionPreview } from "@/lib/session/session-list-preview";
import { resolveStreamEntryForPersist} from "@/lib/stream/streaming-persist";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { logExtMsgDiag, summarizeProtoForExtDiag, summarizeProtosForExtDiag } from "@/lib/diagnostics/extension-msg-diag";
import { logInterruptMsgDiag, summarizeFlushDecision} from "@/lib/diagnostics/interrupt-msg-diag";
import { removePendingAgentReplyTo} from "@/lib/messages/pending-agent-reply-to";
import { scheduleMarkActiveSessionRead } from "@/lib/session/active-session-read";
import { unixTimestampSecondsToIso } from "@/lib/messages/message-timestamp";
import { upsertMessagesBatch, type MessageRow } from "@/lib/cache/local-cache";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import type { DecodedLiveEvent } from "@/lib/daemon/teamclu-events";
import type { LiveWiringContext } from "./context";

/**
 * A `message.created` / message row arriving on a session's live topic.
 *
 * Extracted verbatim from the `if (decoded.message)` branch of the live
 * envelope handler in `MqttLiveWiring`; the body is unchanged, only its
 * captured state is now a parameter. It returns unconditionally at the end,
 * which is why the call site returns after it — that branch always ended the
 * envelope callback.
 */
export function handleLiveMessage(
  ctx: LiveWiringContext,
  decoded: DecodedLiveEvent,
  sid: string,
) {
  if (!decoded.message) return;
  const {
    clearTerminalFlushPending,
    flushTurnAgentReply,
    pendingStreamRepliesRef,
    removeInterruptedStreamPlaceholderForRealReply,
    terminalFlushPendingRef,
  } = ctx;

            // This branch reads/finalizes ordered stream state below — drain
            // any buffered text deltas so finalize/persist see all arrived text.
            flushAllStreamDeltas();
            const msg = decoded.message;
            const senderActorId = msg.senderActorId;
            const streamingStore = useV2StreamingStore.getState();
            const streamKey = senderActorId ? agentStreamKey(sid, senderActorId) : "";
            const streamEntry = streamKey
              ? streamingStore.byKey[streamKey]
              : undefined;
            let parkedAgentReply = false;
            if (
              streamEntry &&
              senderActorId &&
              msg.kind === MessageKind.AGENT_REPLY
            ) {
              // Mid-turn daemon AgentReply slices stay parked until terminal
              // statusChange (or a late message.created after terminal).
              parkedAgentReply = true;
              const pendingReplies =
                pendingStreamRepliesRef.current[streamKey] ?? [];
              const nextPendingReplies = pendingReplies.some(
                (message) => message.messageId === msg.messageId,
              )
                ? pendingReplies
                : [...pendingReplies, msg];
              if (nextPendingReplies !== pendingReplies) {
                pendingStreamRepliesRef.current[streamKey] = nextPendingReplies;
              }
              const resolvedStreamEntry = resolveStreamEntryForPersist(
                sid,
                senderActorId,
                streamEntry,
              );
              const terminalPending = Boolean(
                terminalFlushPendingRef.current[streamKey],
              );
              const toolOnlyAnchor = isToolOnlyTurnAnchor(
                nextPendingReplies,
                resolvedStreamEntry,
              );
              const shouldFlush =
                terminalPending || toolOnlyAnchor;
              logInterruptMsgDiag("mqtt.agentReply.parked", {
                sessionId: sid,
                actorId: senderActorId,
                messageId: msg.messageId,
                turnId: msg.turnId,
                contentLength: (msg.content ?? "").trim().length,
                terminalPending,
                toolOnlyAnchor,
                shouldFlush,
                ...summarizeFlushDecision({
                  pending: nextPendingReplies,
                  liveStream: streamEntry,
                  resolvedStream: resolvedStreamEntry,
                }),
              });
              if (shouldFlush) {
                const flushed = flushTurnAgentReply(
                  sid,
                  senderActorId,
                  terminalPending
                    ? "mqtt.message.created.terminalPending"
                    : "mqtt.message.created.toolOnlyAnchor",
                );
                if (flushed && terminalPending) {
                  clearTerminalFlushPending(streamKey);
                }
              }
            } else if (streamEntry && senderActorId) {
              streamingStore.finalize(
                sid,
                senderActorId,
                decoded.message.content,
              );
              useSessionMessageStore.getState().appendMessage(sid, decoded.message);
            } else {
              // Late REAL agent_reply after the live stream was detached by an
              // eager interrupt-flush: purge the synthetic anchor first so the
              // real reply doesn't duplicate it (survives reload otherwise).
              if (senderActorId && msg.kind === MessageKind.AGENT_REPLY) {
                removeInterruptedStreamPlaceholderForRealReply(sid, senderActorId);
                // Direct-append skips flushTurnAgentReply — still drop the
                // stamped parent from the local FIFO so a later flush cannot
                // reuse a stale user message id.
                const stampedReplyTo = msg.replyToMessageId?.trim();
                if (stampedReplyTo) {
                  removePendingAgentReplyTo(sid, senderActorId, stampedReplyTo);
                }
                logExtMsgDiag("mqtt.agentReply.lateAppend.noPartsPersist", {
                  sessionId: sid,
                  actorId: senderActorId,
                  note: "late AGENT_REPLY after stream detach — append without persistStreamingPartsForReply",
                  ...summarizeProtoForExtDiag(msg),
                });
              }
              useSessionMessageStore.getState().appendMessage(sid, decoded.message);
              if (senderActorId && msg.kind === MessageKind.AGENT_REPLY) {
                logExtMsgDiag("mqtt.agentReply.lateAppend.storeSnapshot", {
                  sessionId: sid,
                  ...summarizeProtosForExtDiag(
                    useSessionMessageStore.getState().messages[sid] ?? [],
                  ),
                });
              }
            }

            if (
              msg.kind === MessageKind.TEXT ||
              (msg.kind === MessageKind.AGENT_REPLY && !parkedAgentReply)
            ) {
              useV2StreamingStore.getState().clearStaleStreamErrors(
                sid,
                msg.kind === MessageKind.AGENT_REPLY ? senderActorId : undefined,
              );
            }

            if (
              !parkedAgentReply &&
              messageKindUpdatesSessionPreview(decoded.message.kind)
            ) {
              const listStore = useSessionListStore.getState();
              const sessionInList = listStore.rows.some((r) => r.id === sid);
              if (sessionInList) {
                const createdAtSec = decoded.message.createdAt;
                bumpSessionListLastMessage(sid, decoded.message.content, {
                  at: createdAtSec > 0n
                    ? unixTimestampSecondsToIso(createdAtSec)
                    : undefined,
                });
                scheduleMarkActiveSessionRead(sid, decoded.message.messageId);
              } else {
                // Invited to a new session: bump is a no-op until the row exists.
                scheduleSessionListRefresh(() => listStore.loadFirstPage());
              }
            }

            // Write ALL incoming messages into the unified `message` table
            // (origin="mqtt-live"). This replaces the old agent_runtime_event
            // writes for tool-call/result/thinking kinds.
            // The insertAgentRuntimeEvent table stays alive for backwards compat
            // but is no longer the primary read path.
            // TODO(cleanup): remove insertAgentRuntimeEvent writes once all
            //   clients have upgraded past this version and the old read path
            //   in history loader above is cleaned up.
            if (!parkedAgentReply) {
              const m = decoded.message;
              const kindStr =
                m.kind === MessageKind.AGENT_TOOL_CALL
                  ? "agent_tool_call"
                  : m.kind === MessageKind.AGENT_TOOL_RESULT
                    ? "agent_tool_result"
                    : m.kind === MessageKind.AGENT_THINKING
                      ? "agent_thinking"
                      : m.kind === MessageKind.AGENT_REPLY
                        ? "agent_reply"
                        : m.kind === MessageKind.SYSTEM
                          ? "system"
                          : "text";
              const teamId =
                useSessionListStore.getState().rows.find(
                  (r) => r.id === sid,
                )?.team_id ?? "";
              const now = new Date().toISOString();
              const msgRow: MessageRow = {
                id: m.messageId,
                teamId,
                sessionId: m.sessionId,
                turnId: m.turnId || null,
                senderActorId: m.senderActorId || null,
                replyToMessageId: m.replyToMessageId?.trim() || null,
                kind: kindStr,
                content: m.content,
                metadataJson: m.metadataJson || null,
                model: m.model || null,
                mentionsJson: null,
                origin: "mqtt-live",
                createdAt: unixTimestampSecondsToIso(m.createdAt),
                updatedAt: now,
                deletedAt: null,
                syncedAt: now,
                partsJson: (m as unknown as { partsJson?: string | null }).partsJson ?? null,
              };
              upsertMessagesBatch([msgRow]).catch((e) => {
                console.warn("[cache] message upsert failed:", e);
              });
            }
            return;
}
