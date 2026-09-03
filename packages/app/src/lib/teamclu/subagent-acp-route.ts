import type { AcpEvent } from "@/lib/proto/amux_pb";
import {
  isAgentActiveStatus,
  isTerminalAgentStatus,
  normalizeToolResultEvent,
  normalizeToolUseEvent,
} from "@/lib/stream/live-agent-stream";
import { handleAcpPermissionRequest } from "@/lib/teamclu/handle-acp-permission-request";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

/** Route a child-session ACP event into nested subagent stream state. */
export function routeSubagentAcpEvent(
  sessionId: string,
  actorId: string,
  parentToolId: string,
  acpEvent: AcpEvent,
): void {
  const store = useV2StreamingStore.getState();
  const event = acpEvent.event;

  if (event?.case === "output") {
    const text = (event.value as { text?: string })?.text ?? "";
    if (text) store.subAppendOutput(parentToolId, sessionId, actorId, text);
    return;
  }
  if (event?.case === "thinking") {
    const text = (event.value as { text?: string })?.text ?? "";
    if (text) store.subAppendThinking(parentToolId, sessionId, actorId, text);
    return;
  }
  if (event?.case === "toolUse") {
    const tu = normalizeToolUseEvent(event.value);
    if (tu.toolName === "task") return;
    store.subPushToolUse(parentToolId, sessionId, actorId, {
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
    return;
  }
  if (event?.case === "toolResult") {
    const tr = normalizeToolResultEvent(event.value);
    store.subCompleteToolUse(parentToolId, sessionId, actorId, {
      toolId: tr.toolId,
      success: tr.success,
      summary: tr.summary,
      content: tr.content,
      rawOutput: tr.rawOutput,
    });
    return;
  }
  if (event?.case === "permissionRequest") {
    const pr = event.value as {
      requestId?: string;
      toolName?: string;
      description?: string;
      params?: Record<string, string>;
      options?: Array<{ optionId?: string; kind?: string; name?: string }>;
    };
    void handleAcpPermissionRequest({
      sessionId,
      agentActorId: actorId,
      request: {
        requestId: pr.requestId ?? "",
        toolName: pr.toolName ?? "",
        description: pr.description ?? "",
        params: pr.params ?? {},
        requesterActorId: pr.params?.requester_actor_id?.trim() || undefined,
        options: (pr.options ?? []).map((o) => ({
          optionId: o.optionId ?? "",
          kind: o.kind ?? "",
          name: o.name ?? "",
        })),
      },
    });
    return;
  }
  if (event?.case === "error") {
    const err = event.value as { message?: string; details?: string };
    store.subSetError(
      parentToolId,
      sessionId,
      actorId,
      err.message || "Subagent error",
      err.details || err.message || "",
    );
    return;
  }
  if (event?.case === "statusChange") {
    const sc = event.value as { newStatus?: number };
    if (isTerminalAgentStatus(sc.newStatus)) {
      store.subFinish(parentToolId);
    } else if (isAgentActiveStatus(sc.newStatus)) {
      store.subMarkActive(parentToolId, sessionId, actorId);
    }
  }
}
