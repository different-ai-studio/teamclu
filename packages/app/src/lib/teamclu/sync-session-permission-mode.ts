import { runtimeTargetsForSession } from "@/lib/agent/runtime-state-resolve";
import { getKnownLocalDaemonActorId } from "@/lib/daemon/local-daemon-identity";
import { sessionPermissionMode } from "@/lib/daemon/teamclu-rpc";
import {
  getSessionDefaultPermissionMode,
  getSessionPermissionMode,
  hasExplicitSessionPermissionMode,
  isKnownInteractiveSession,
  setSessionPermissionMode,
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

function sessionHasLiveRuntime(sessionId: string): boolean {
  const needle = `::${sessionId}`;
  return Object.keys(useRuntimeStateStore.getState().byRuntimeId).some((key) =>
    key.endsWith(needle),
  );
}

/**
 * The first start of an interactive session keeps the mode it is starting
 * with. Later changes to the device default do not move it.
 */
function pinPermissionModeOnFirstStart(sessionId: string): void {
  const id = sessionId.trim();
  if (!id || sessionHasLiveRuntime(id) || hasExplicitSessionPermissionMode(id)) return;
  if (!isKnownInteractiveSession(id)) return;
  setSessionPermissionMode(id, getSessionPermissionMode(id));
}

/** Fields for a runtimeStart. A session that already has its own mode keeps it. */
export function runtimePermissionStartFields(sessionId: string, targetActorId: string): {
  permissionMode: string
  rememberPermission: boolean
  defaultPermissionMode?: string
} {
  pinPermissionModeOnFirstStart(sessionId);
  const localId = getKnownLocalDaemonActorId();
  const explicit = hasExplicitSessionPermissionMode(sessionId);
  return {
    permissionMode: explicit
      ? sessionPermissionModeToWire(getSessionPermissionMode(sessionId))
      : "",
    rememberPermission: explicit,
    ...(localId && targetActorId === localId
      ? { defaultPermissionMode: sessionPermissionModeToWire(getSessionDefaultPermissionMode()) }
      : {}),
  };
}

/** Tell this machine's daemon the device-wide default, even when no session is running. */
export async function reportDevicePermissionDefault(mode: SessionPermissionMode): Promise<void> {
  const targetActorId = getKnownLocalDaemonActorId()
  if (!targetActorId) return
  try {
    await sessionPermissionMode({
      targetActorId,
      sessionId: "",
      permissionMode: sessionPermissionModeToWire(mode),
      remember: false,
      setDeviceDefault: true,
    })
  } catch (err) {
    console.warn("[permission] device default did not reach the local daemon", { err })
  }
}

export async function syncSessionPermissionModeToDaemon(
  sessionId: string,
  mode: SessionPermissionMode,
  remember = false,
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
          remember,
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

