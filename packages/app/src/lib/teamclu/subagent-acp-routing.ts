import type { AcpEvent } from "@/lib/proto/amux_pb";
import {
  normalizeToolResultEvent,
  normalizeToolUseEvent,
} from "@/lib/stream/live-agent-stream";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";
import { isTaskToolCall } from "@/lib/teamclu/subagent-acp-binding";

type SubagentRoutingSlice = {
  byKey: Record<string, AgentStreamEntry>;
  childAcpSessionToToolId: Record<string, string>;
  pendingSubagentEvents: Record<string, AcpEvent[]>;
};

function streamKey(sessionId: string, actorId: string): string {
  return `${sessionId}::${actorId}`;
}

function boundParentToolIds(slice: SubagentRoutingSlice): Set<string> {
  return new Set(Object.values(slice.childAcpSessionToToolId));
}

/** Calling task tools whose child ACP session is not bound yet. */
function listUnboundCallingTaskToolIds(
  sessionId: string,
  actorId: string,
  slice: SubagentRoutingSlice,
): string[] {
  const entry = slice.byKey[streamKey(sessionId, actorId)];
  if (!entry) return [];
  const bound = boundParentToolIds(slice);
  return entry.toolCalls
    .filter((tc) => tc.status === "calling" && isTaskToolCall(tc) && !bound.has(tc.id))
    .map((tc) => tc.id);
}

export function countUnboundCallingTasks(
  sessionId: string,
  actorId: string,
  slice: SubagentRoutingSlice,
): number {
  return listUnboundCallingTaskToolIds(sessionId, actorId, slice).length;
}

/** Buffer when this childSid is not bound yet (per-child, not global). */
export function shouldBufferUnboundChildAcpEvent(
  _sessionId: string,
  _actorId: string,
  acpSid: string,
  slice: SubagentRoutingSlice,
): boolean {
  const trimmed = acpSid.trim();
  if (!trimmed) return false;
  if (slice.childAcpSessionToToolId[trimmed]) return false;
  return true;
}

/**
 * Orphan fallback: only when exactly one unbound calling task exists and
 * envelope carries no acp_session_id.
 */
export function resolveOrphanSubagentParentToolId(
  sessionId: string,
  actorId: string,
  slice: SubagentRoutingSlice,
): string | undefined {
  const unbound = listUnboundCallingTaskToolIds(sessionId, actorId, slice);
  return unbound.length === 1 ? unbound[0] : undefined;
}

/** Child-like events eligible for narrow orphan routing (no parent output). */
export function shouldRouteOrphanSubagentEvent(
  acpEvent: AcpEvent | undefined,
  parentTaskToolId: string,
): boolean {
  const event = acpEvent?.event;
  if (!event) return false;
  if (event.case === "permissionRequest") return false;
  if (event.case === "planUpdate" || event.case === "availableCommands") {
    return false;
  }
  if (event.case === "toolUse") {
    const tu = normalizeToolUseEvent(event.value);
    if (tu.toolId === parentTaskToolId) return false;
    if (tu.toolName === "task") return false;
    if (isTaskToolCall({ name: tu.toolName, arguments: tu.params })) return false;
    return true;
  }
  if (event.case === "toolResult") {
    const tr = normalizeToolResultEvent(event.value);
    return tr.toolId !== parentTaskToolId;
  }
  return event.case === "thinking";
}
