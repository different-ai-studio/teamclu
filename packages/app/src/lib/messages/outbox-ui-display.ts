import { AgentStatus } from "@/lib/proto/amux_pb";
import { resolveRuntimeStateEntryForAgent } from "@/lib/agent/runtime-state-resolve";
import type { AgentStreamEntry, ArchivedEntry } from "@/stores/v2-streaming-store";
import type { RuntimeStateEntry } from "@/stores/runtime-state-store";

/** UI-only: true when the v2 live stream shows agent activity for this session
 * at or after the outbox row was created. Used to stop the send spinner once
 * the daemon has started the turn (statusChange ACTIVE / thinking / output)
 * while the outbox sender may still be awaiting ensure + MQTT. Does not
 * mutate outbox state. */
export function sessionHasAgentStreamActivitySince(
  sessionId: string,
  sinceIso: string,
  streams: {
    byKey: Record<string, AgentStreamEntry>;
    archived: readonly ArchivedEntry[];
  },
): boolean {
  const sinceMs = new Date(sinceIso).getTime();
  if (Number.isNaN(sinceMs)) return false;

  for (const entry of Object.values(streams.byKey)) {
    if (entry.sessionId === sessionId && entry.lastUpdate >= sinceMs) {
      return true;
    }
  }
  for (const entry of streams.archived) {
    if (entry.sessionId === sessionId && entry.lastUpdate >= sinceMs) {
      return true;
    }
  }
  return false;
}

/** UI-only: mentioned agent runtime reported ACTIVE on MQTT retain after send. */
export function sessionHasMentionedRuntimeActiveSince(
  mentionActorIds: readonly string[],
  sinceIso: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): boolean {
  const sinceMs = new Date(sinceIso).getTime();
  if (Number.isNaN(sinceMs) || mentionActorIds.length === 0) return false;

  for (const agentId of mentionActorIds) {
    const entry = resolveRuntimeStateEntryForAgent(agentId, byRuntimeId);
    if (!entry || entry.lastUpdated < sinceMs) continue;
    if (entry.info.status === AgentStatus.ACTIVE) return true;
  }
  return false;
}
