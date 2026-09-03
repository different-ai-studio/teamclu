import type { Question, QuestionOption } from "@/stores/session-types";
import { agentStreamKey, isTerminalAgentStatus, isTurnOpeningStatusChange, normalizeToolResultEvent, normalizeToolUseEvent, shouldPatchFlushedToolEvent, streamEntryHasVisibleContent } from "@/lib/stream/live-agent-stream";
import { bufferStreamDelta, flushStreamDeltasFor} from "@/lib/stream/stream-delta-buffer";
import { classifyAgentTurnErrorName, formatAgentTurnErrorDisplayMessage, isAgentTurnAbortError, localizeAgentTurnErrorMessage } from "@/lib/agent/agent-turn-error";
import { patchPersistedToolResult, patchPersistedToolUse, syncStreamingToolOutputsFromLocalCache } from "@/lib/stream/streaming-persist";
import { streamActorIdFromLiveEvent } from "@/lib/daemon/teamclu-events";
import { getFlushedTurn } from "@/lib/stream/flushed-turn-registry";
import { handleAcpPermissionRequest } from "@/lib/teamclu/handle-acp-permission-request";
import { isStreamInterruptible, useV2StreamingStore } from "@/stores/v2-streaming-store";
import { logInterruptMsgDiag, summarizePendingReplies, summarizeStreamEntry } from "@/lib/diagnostics/interrupt-msg-diag";
import { logStreamToolDiag } from "@/lib/diagnostics/stream-tool-diag";
import { mapAcpPlanEntries, syncPlanFromTodoTool, syncPlanFromTodoToolResult } from "@/lib/stream/sync-plan-from-todowrite";
import { recordLatencyProbe } from "@/lib/diagnostics/latency-probe";
import { reportSkillUsage } from "@/lib/telemetry/skill-usage";
import { resolveOrphanSubagentParentToolId, shouldBufferUnboundChildAcpEvent, shouldRouteOrphanSubagentEvent } from "@/lib/teamclu/subagent-acp-routing";
import { routeSubagentAcpEvent } from "@/lib/teamclu/subagent-acp-route";
import { tryBindChildFromPermission } from "@/lib/teamclu/subagent-acp-binding";
import { useSessionStore } from "@/stores/session-store";
import type { TFunction } from "i18next";
import type { DecodedLiveEvent } from "@/lib/daemon/teamclu-events";
import type { LiveWiringContext } from "./context";

/**
 * A streaming `acp.event` — the agent's own output: deltas, tool use and
 * results, plan updates, and the terminal status that ends a turn.
 *
 * Extracted verbatim from the `if (decoded.acpEvent)` branch of the live
 * envelope handler in `MqttLiveWiring`; the body is unchanged, only its
 * captured state is now a parameter. This was the largest single branch of
 * that effect at 490 lines.
 */
export function handleAcpEvent(
  ctx: LiveWiringContext,
  decoded: DecodedLiveEvent,
  sid: string,
  t: TFunction,
) {
  // Re-narrows what the enclosing `if (decoded.acpEvent)` used to narrow at the
  // call site. The caller still only calls this when the field is set.
  if (!decoded.acpEvent) return;
  const {
    clearFollowUpActive,
    clearTerminalFlushPending,
    flushTurnAgentReply,
    followUpActiveRef,
    pendingStreamRepliesRef,
    scheduleTerminalDaemonReplyTimeout,
    terminalFlushPendingRef,
  } = ctx;

            // Dev-only one-way latency probe (no-op unless the local daemon
            // runs with AMUX_LATENCY_PROBE=1). See lib/latency-probe.ts.
            recordLatencyProbe(decoded.amuxEnvelope?.sourcePeerId);
            const actorId = streamActorIdFromLiveEvent(decoded);
            if (!actorId) return;
            const acpSid = decoded.amuxEnvelope?.acpSessionId?.trim() ?? "";
            if (acpSid) {
              const streamStore = useV2StreamingStore.getState();
              const eventCase = decoded.acpEvent.event?.case;
              const parentToolId = streamStore.childAcpSessionToToolId[acpSid];
              if (eventCase === "permissionRequest") {
                // Subagent permission must surface on the parent actor immediately.
                // Do NOT buffer waiting for task→child bind: opencode often asks
                // before task rawOutput carries sessionId, and a buffered ask
                // never renders a card (agent hangs forever).
                // Do NOT bind via params.toolCallId — that is the child tool
                // (e.g. bash), not the parent task tool id.
                const pr2 = decoded.acpEvent.event?.value as {
                  requestId?: string;
                  toolName?: string;
                  description?: string;
                  params?: Record<string, string>;
                  options?: Array<{ optionId?: string; kind?: string; name?: string }>;
                };
                const childSid =
                  pr2.params?.childSessionId?.trim() || acpSid;
                const bindTo =
                  parentToolId ??
                  resolveOrphanSubagentParentToolId(sid, actorId, streamStore);
                if (bindTo && childSid) {
                  tryBindChildFromPermission(sid, actorId, childSid, bindTo);
                }
                void handleAcpPermissionRequest({
                  sessionId: sid,
                  agentActorId: actorId,
                  request: {
                    requestId: pr2.requestId ?? "",
                    toolName: pr2.toolName ?? "",
                    description: pr2.description ?? "",
                    params: {
                      ...(pr2.params ?? {}),
                      childSessionId: childSid,
                      ...(bindTo ? {} : { _subagent_unbound_task: "1" }),
                    },
                    requesterActorId:
                      pr2.params?.requester_actor_id?.trim() || undefined,
                    options: (pr2.options ?? []).map((o) => ({
                      optionId: o.optionId ?? "",
                      kind: o.kind ?? "",
                      name: o.name ?? "",
                    })),
                  },
                });
                return;
              } else {
                if (parentToolId) {
                  routeSubagentAcpEvent(sid, actorId, parentToolId, decoded.acpEvent);
                  return;
                }
                if (shouldBufferUnboundChildAcpEvent(sid, actorId, acpSid, streamStore)) {
                  streamStore.bufferPendingSubagentEvent(acpSid, decoded.acpEvent);
                  return;
                }
              }
            } else {
              const streamStoreForOrphan = useV2StreamingStore.getState();
              const orphanTaskToolId = resolveOrphanSubagentParentToolId(
                sid,
                actorId,
                streamStoreForOrphan,
              );
              if (orphanTaskToolId) {
                const orphanEventCase = decoded.acpEvent.event?.case;
                if (orphanEventCase === "permissionRequest") {
                  // Orphan subagent permission (no acpSid on envelope): route
                  // to the single unbound calling task tool.
                  const prO = decoded.acpEvent.event?.value as {
                    requestId?: string;
                    toolName?: string;
                    description?: string;
                    params?: Record<string, string>;
                    options?: Array<{ optionId?: string; kind?: string; name?: string }>;
                  };
                  const childSid = prO.params?.childSessionId?.trim() ?? "";
                  if (childSid) {
                    tryBindChildFromPermission(
                      sid,
                      actorId,
                      childSid,
                      orphanTaskToolId,
                    );
                  }
                  void handleAcpPermissionRequest({
                    sessionId: sid,
                    agentActorId: actorId,
                    request: {
                      requestId: prO.requestId ?? "",
                      toolName: prO.toolName ?? "",
                      description: prO.description ?? "",
                      params: prO.params ?? {},
                      requesterActorId:
                        prO.params?.requester_actor_id?.trim() || undefined,
                      options: (prO.options ?? []).map((o) => ({
                        optionId: o.optionId ?? "",
                        kind: o.kind ?? "",
                        name: o.name ?? "",
                      })),
                    },
                  });
                  return;
                }
                if (shouldRouteOrphanSubagentEvent(decoded.acpEvent, orphanTaskToolId)) {
                  routeSubagentAcpEvent(
                    sid,
                    actorId,
                    orphanTaskToolId,
                    decoded.acpEvent,
                  );
                  return;
                }
              }
            }

            const event = decoded.acpEvent.event;

            // Non-text events read/mutate ordered stream state — drain any
            // buffered text deltas for this stream first so parts ordering
            // matches arrival order.
            if (event?.case !== "output" && event?.case !== "thinking") {
              flushStreamDeltasFor(sid, actorId);
            }

            // acp.event detail already logged in the live:* line above.
            if (event?.case === "output") {
              const text = (event.value as { text?: string })?.text ?? "";
              const liveEntry =
                useV2StreamingStore.getState().byKey[agentStreamKey(sid, actorId)];
              if (
                !(
                  getFlushedTurn(sid, actorId) &&
                  (!liveEntry || !isStreamInterruptible(liveEntry))
                )
              ) {
                bufferStreamDelta("output", sid, actorId, text);
              }
            } else if (event?.case === "thinking") {
              const text = (event.value as { text?: string })?.text ?? "";
              const liveEntry =
                useV2StreamingStore.getState().byKey[agentStreamKey(sid, actorId)];
              if (
                !(
                  getFlushedTurn(sid, actorId) &&
                  (!liveEntry || !isStreamInterruptible(liveEntry))
                )
              ) {
                bufferStreamDelta("thinking", sid, actorId, text);
              }
            } else if (event?.case === "toolUse") {
              const tu = normalizeToolUseEvent(event.value);
              const liveEntry =
                useV2StreamingStore.getState().byKey[agentStreamKey(sid, actorId)];
              if (shouldPatchFlushedToolEvent(sid, actorId, tu.toolId, liveEntry)) {
                logStreamToolDiag("mqtt.toolUse.skipAfterFlush", {
                  sessionId: sid,
                  actorId,
                  toolId: tu.toolId,
                });
                void patchPersistedToolUse({
                  sessionId: sid,
                  actorId,
                  toolId: tu.toolId,
                  toolName: tu.toolName,
                  description: tu.description,
                  params: tu.params,
                  toolKind: tu.toolKind,
                  content: tu.content,
                  locations: tu.locations,
                  acpStatus: tu.acpStatus,
                  rawInput: tu.rawInput,
                });
              } else {
                useV2StreamingStore.getState().pushToolUse(sid, actorId, {
                  toolId: tu.toolId,
                  toolName: tu.toolName,
                  description: tu.description,
                  params: tu.params,
                  toolKind: tu.toolKind,
                  content: tu.content,
                  locations: tu.locations,
                  acpStatus: tu.acpStatus,
                  rawInput: tu.rawInput,
                  rawOutput: tu.rawOutput,
                });
                // Capture skill invocations for the cloud leaderboard's skill
                // dimension. tu.toolName is "skill" for Skill tool calls;
                // tu.params.name is the skill slug (e.g. "sentry-fix").
                if (
                  (tu.toolName === "skill" || tu.params?.description === "skill") &&
                  tu.params?.name
                ) {
                  void reportSkillUsage(tu.params.name);
                }
                syncPlanFromTodoTool(sid, actorId, {
                  toolName: tu.toolName,
                  params: tu.params,
                  description: tu.description,
                });
              }
            } else if (event?.case === "toolResult") {
              const tr = normalizeToolResultEvent(event.value);
              const liveEntry =
                useV2StreamingStore.getState().byKey[agentStreamKey(sid, actorId)];
              logStreamToolDiag("mqtt.toolResult", {
                sessionId: sid,
                actorId,
                eventId: decoded.envelope.eventId,
                toolId: tr.toolId,
                success: tr.success,
              });
              if (shouldPatchFlushedToolEvent(sid, actorId, tr.toolId, liveEntry)) {
                void patchPersistedToolResult({
                  sessionId: sid,
                  actorId,
                  toolId: tr.toolId,
                  success: tr.success,
                  summary: tr.summary,
                  content: tr.content,
                  rawOutput: tr.rawOutput,
                });
              } else {
                useV2StreamingStore.getState().completeToolUse(sid, actorId, {
                  toolId: tr.toolId,
                  success: tr.success,
                  summary: tr.summary,
                  content: tr.content,
                  rawOutput: tr.rawOutput,
                });
                void patchPersistedToolResult({
                  sessionId: sid,
                  actorId,
                  toolId: tr.toolId,
                  success: tr.success,
                  summary: tr.summary,
                  content: tr.content,
                  rawOutput: tr.rawOutput,
                });
                void syncStreamingToolOutputsFromLocalCache(sid, actorId);
                window.setTimeout(() => {
                  void syncStreamingToolOutputsFromLocalCache(sid, actorId);
                }, 500);
              }
              syncPlanFromTodoToolResult(sid, actorId, {
                toolId: tr.toolId,
                success: tr.success,
                summary: tr.summary,
              });
            } else if (event?.case === "statusChange") {
              const sc = event.value as { oldStatus?: number; newStatus?: number };
              logStreamToolDiag("mqtt.statusChange", {
                sessionId: sid,
                actorId,
                eventId: decoded.envelope.eventId,
                oldStatus: sc.oldStatus,
                newStatus: sc.newStatus,
              });
              if (isTurnOpeningStatusChange(sc.oldStatus, sc.newStatus)) {
                const streamKey = agentStreamKey(sid, actorId);
                followUpActiveRef.current[streamKey] = true;
                const flushed = flushTurnAgentReply(
                  sid,
                  actorId,
                  "mqtt.statusChange.active",
                );
                logInterruptMsgDiag("mqtt.statusChange.active", {
                  sessionId: sid,
                  actorId,
                  oldStatus: sc.oldStatus,
                  newStatus: sc.newStatus,
                  flushedPreviousTurn: flushed,
                  ...summarizePendingReplies(
                    pendingStreamRepliesRef.current[agentStreamKey(sid, actorId)],
                  ),
                });
                clearTerminalFlushPending(agentStreamKey(sid, actorId));
                useV2StreamingStore.getState().beginPlanningPlaceholder(sid, actorId);
              } else if (isTerminalAgentStatus(sc.newStatus)) {
                const streamKey = agentStreamKey(sid, actorId);
                clearFollowUpActive(streamKey);
                terminalFlushPendingRef.current[streamKey] = true;
                const flushed = flushTurnAgentReply(
                  sid,
                  actorId,
                  "mqtt.statusChange.terminal",
                );
                logInterruptMsgDiag("mqtt.statusChange.terminal", {
                  sessionId: sid,
                  actorId,
                  oldStatus: sc.oldStatus,
                  newStatus: sc.newStatus,
                  flushed,
                  ...summarizePendingReplies(
                    pendingStreamRepliesRef.current[streamKey],
                  ),
                  ...summarizeStreamEntry(
                    useV2StreamingStore.getState().byKey[streamKey],
                    "live",
                  ),
                });
                if (flushed) {
                  clearTerminalFlushPending(streamKey);
                } else {
                  const streamEntry =
                    useV2StreamingStore.getState().byKey[streamKey];
                  if (streamEntryHasVisibleContent(streamEntry)) {
                    // Wait for daemon AGENT_REPLY (incl. interrupted). Do not
                    // invent interrupt-* placeholders — those bypass cloud
                    // persist and break catchup after restart.
                    logInterruptMsgDiag(
                      "mqtt.statusChange.terminal.awaitDaemonReply",
                      {
                        sessionId: sid,
                        actorId,
                        ...summarizeStreamEntry(streamEntry, "live"),
                      },
                    );
                    scheduleTerminalDaemonReplyTimeout(sid, actorId);
                  } else {
                    useV2StreamingStore.getState().setError(
                      sid,
                      actorId,
                      t(
                        "daemon.agentRuntime.emptyReply",
                        "Agent returned no output. The selected model may be unavailable or misconfigured.",
                      ),
                      "",
                    );
                  }
                }
              }
            } else if (event?.case === "error") {
              const er = event.value as { message?: string; details?: string };
              // User interrupt (opencode MessageAbortedError) is not a fault.
              // SSE turn order: tool cleanup → session.error → session.idle.
              // Defer flush/detach until statusChange.terminal (idle) so late
              // tool results land on the live stream instead of spawning a
              // phantom active entry (Unknown tool / stuck running card).
              // Stop UI comes from daemon interrupted AGENT_REPLY, not SessionErrorAlert.
              if (isAgentTurnAbortError(er.message, er.details)) {
                // Interrupted AGENT_REPLY (daemon metadata.turn_status) owns
                // the user-facing stop UI — do not also raise SessionErrorAlert.
                const streamKey = agentStreamKey(sid, actorId);
                terminalFlushPendingRef.current[streamKey] = true;
                logInterruptMsgDiag("mqtt.error.abort.deferToIdle", {
                  sessionId: sid,
                  actorId,
                  ...summarizeStreamEntry(
                    useV2StreamingStore.getState().byKey[streamKey],
                    "live",
                  ),
                });
              } else {
                terminalFlushPendingRef.current[agentStreamKey(sid, actorId)] = true;
                flushTurnAgentReply(sid, actorId, "mqtt.error");
                // Localize known daemon-emitted errors (the daemon is
                // locale-agnostic and emits English for iOS/logs). Keep the raw
                // message for anything we don't recognize.
                const localizedMessage = localizeAgentTurnErrorMessage(er.message, t);
                useV2StreamingStore.getState().setError(
                  sid,
                  actorId,
                  localizedMessage,
                  er.details ?? "",
                );
                // The live dock unmounts as soon as a turn errors
                // (isStreamInterruptible excludes errored entries), so the dock's
                // ErrorCard is never seen. Surface every turn error as a durable
                // SessionErrorAlert bubble in the thread instead.
                {
                  const detail = (er.details ?? "").trim();
                  const errorName = classifyAgentTurnErrorName(er.message);
                  useSessionStore.getState().setSessionErrorEvent({
                    sessionId: sid,
                    error: {
                      name: errorName,
                      data: {
                        message: formatAgentTurnErrorDisplayMessage(localizedMessage, detail),
                      },
                    },
                  });
                }
              }
            } else if (event?.case === "raw") {
              const raw = event.value as { method?: string; jsonPayload?: Uint8Array };
              const method = raw.method ?? "";
              if (
                method === "question_asked" ||
                method === "question_replied" ||
                method === "question_rejected"
              ) {
                try {
                  const payload = JSON.parse(
                    new TextDecoder().decode(raw.jsonPayload ?? new Uint8Array()),
                  ) as Record<string, unknown>;
                  const store = useSessionStore.getState();
                  if (method === "question_asked") {
                    const tool = (payload.tool ?? {}) as { messageID?: string; callID?: string };
                    const questions: Question[] = Array.isArray(payload.questions)
                      ? (payload.questions as Array<Record<string, unknown>>).map((q, i) => ({
                          id: String(i),
                          header: typeof q.header === "string" ? q.header : "",
                          question: typeof q.question === "string" ? q.question : "",
                          options: Array.isArray(q.options) ? (q.options as QuestionOption[]) : [],
                          multiple: !!q.multiple,
                        }))
                      : [];
                    store.addPendingQuestion({
                      questionId: String(payload.id ?? ""),
                      toolCallId: tool.callID ?? "",
                      messageId: tool.messageID ?? "",
                      questions,
                      sessionId: sid,
                      agentActorId: actorId,
                      source: "agent",
                    });
                  } else {
                    store.resolveQuestion(String(payload.requestID ?? payload.id ?? ""));
                  }
                } catch (e) {
                  console.warn("[question] raw event parse failed", e);
                }
              }
            } else if (event?.case === "permissionRequest") {
              const pr = event.value as {
                requestId?: string;
                toolName?: string;
                description?: string;
                params?: Record<string, string>;
                options?: Array<{ optionId?: string; kind?: string; name?: string }>;
              };
              logStreamToolDiag("mqtt.permissionRequest", {
                sessionId: sid,
                actorId,
                eventId: decoded.envelope.eventId,
                requestId: pr.requestId,
                toolName: pr.toolName,
                description: pr.description,
                isDoomLoop: pr.toolName === "doom_loop",
              });
              // params.toolCallId is the tool that asked (bash/…), not the parent
              // task tool — only bind when we can resolve the parent task id.
              const childSid = pr.params?.childSessionId?.trim() ?? "";
              if (childSid) {
                const orphanTask = resolveOrphanSubagentParentToolId(
                  sid,
                  actorId,
                  useV2StreamingStore.getState(),
                );
                if (orphanTask) {
                  tryBindChildFromPermission(sid, actorId, childSid, orphanTask);
                }
              }
              void handleAcpPermissionRequest({
                sessionId: sid,
                agentActorId: actorId,
                request: {
                  requestId: pr.requestId ?? "",
                  toolName: pr.toolName ?? "",
                  description: pr.description ?? "",
                  params: pr.params ?? {},
                  requesterActorId:
                    pr.params?.requester_actor_id?.trim() || undefined,
                  options: (pr.options ?? []).map((o) => ({
                    optionId: o.optionId ?? "",
                    kind: o.kind ?? "",
                    name: o.name ?? "",
                  })),
                },
              });
            } else if (event?.case === "planUpdate") {
              const pu = event.value as { entries?: Array<{ content?: string; priority?: string; status?: string }> };
              useV2StreamingStore.getState().setPlan(
                sid,
                actorId,
                mapAcpPlanEntries(pu.entries ?? []),
              );
            }
            // statusChange / availableCommands / raw: MVP no-op (RuntimeInfo retain
            // already surfaces agent status; commands TBD; raw is catch-all).
}
