import { runtimeTargetsForSession } from "@/lib/agent/runtime-state-resolve";
import { sessionPermissionMode } from "@/lib/daemon/teamclu-rpc";
import type { SessionPermissionMode } from "@/lib/session/session-permission-mode";
import { sessionPermissionModeToWire } from "@/lib/session/session-permission-mode-wire";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";

/**
 * Daemons that may host this session's pi attachment. Same routing idea as
 * interrupt / ACP permission replies — never assume the local daemon owns the
 * session.
 */
export function resolveSessionPermissionModeTargetActorIds(sessionId: string): string[] {
  const id = sessionId.trim();
  if (!id) return [];

  const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId;
  const fromRetain = runtimeTargetsForSession(id, byRuntimeId)
    .map((row) => row.agent_id?.trim())
    .filter((agentId): agentId is string => Boolean(agentId));

  const uniqueFromRetain = [...new Set(fromRetain)];
  if (uniqueFromRetain.length > 0) return uniqueFromRetain;

  const participants =
    useSessionParticipantStore.getState().participantsBySession[id] ?? [];
  const fromParticipants = participants
    .filter((p) => p.isAgent)
    .map((p) => p.actorId.trim())
    .filter(Boolean);

  return [...new Set(fromParticipants)];
}

export async function syncSessionPermissionModeToDaemon(
  sessionId: string,
  mode: SessionPermissionMode,
): Promise<{ accepted: boolean; effectiveMode?: string }> {
  const id = sessionId.trim();
  if (!id) return { accepted: false };

  const targetActorIds = resolveSessionPermissionModeTargetActorIds(id);
  if (targetActorIds.length === 0) return { accepted: false };

  const permissionMode = sessionPermissionModeToWire(mode);

  try {
    const results = await Promise.all(
      targetActorIds.map((targetActorId) =>
        sessionPermissionMode({
          targetActorId,
          sessionId: id,
          permissionMode,
        }),
      ),
    );
    const accepted = results.every((result) => result.accepted);
    const effectiveMode =
      results.map((r) => r.effectiveMode?.trim()).find(Boolean) || undefined;
    return { accepted, effectiveMode };
  } catch (err) {
    console.warn("[permission] syncSessionPermissionModeToDaemon failed", {
      sessionId: id,
      targetActorIds,
      err,
    });
    return { accepted: false };
  }
}
