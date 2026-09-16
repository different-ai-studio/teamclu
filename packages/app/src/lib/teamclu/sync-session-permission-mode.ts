import { runtimeTargetsForSession } from "@/lib/agent/runtime-state-resolve";
import { sessionPermissionMode } from "@/lib/daemon/teamclu-rpc";
import {
  getSessionPermissionMode,
  hasExplicitSessionPermissionMode,
  type SessionPermissionMode,
} from "@/lib/session/session-permission-mode";
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

/**
 * Push the (just-changed) global default to every session with a live runtime
 * that has no explicit per-session mode. Without this the composer pill would
 * show the new default while the daemon still runs the old policy until the
 * next runtimeStart. Sessions the user picked a mode for keep their pick.
 */
export async function syncDefaultPermissionModeToLiveSessions(): Promise<void> {
  const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId;
  const sessionIds = new Set<string>();
  for (const key of Object.keys(byRuntimeId)) {
    // Keys are `{actorId}::{sessionId}`; split from the right so an actor id
    // containing `::` cannot eat the session id.
    const sep = key.lastIndexOf("::");
    if (sep < 0) continue;
    const sessionId = key.slice(sep + 2).trim();
    if (sessionId) sessionIds.add(sessionId);
  }

  for (const sessionId of sessionIds) {
    if (hasExplicitSessionPermissionMode(sessionId)) continue;
    const mode = getSessionPermissionMode(sessionId);
    const { accepted } = await syncSessionPermissionModeToDaemon(sessionId, mode);
    if (!accepted) {
      console.warn("[permission] global default did not reach a live session", {
        sessionId,
        mode,
      });
    }
  }
}
