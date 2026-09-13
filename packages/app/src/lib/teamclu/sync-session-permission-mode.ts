import { getLocalDaemonActorId } from "@/lib/daemon/daemon-agent-admin";
import { sessionPermissionMode } from "@/lib/daemon/teamclu-rpc";
import type { SessionPermissionMode } from "@/lib/session/session-permission-mode";
import { sessionPermissionModeToWire } from "@/lib/session/session-permission-mode-wire";

export async function syncSessionPermissionModeToDaemon(
  sessionId: string,
  mode: SessionPermissionMode,
): Promise<{ accepted: boolean; effectiveMode?: string }> {
  const id = sessionId.trim();
  if (!id) return { accepted: false };

  const targetActorId = (await getLocalDaemonActorId())?.trim();
  if (!targetActorId) return { accepted: false };

  try {
    const result = await sessionPermissionMode({
      targetActorId,
      sessionId: id,
      permissionMode: sessionPermissionModeToWire(mode),
    });
    return {
      accepted: result.accepted,
      effectiveMode: result.effectiveMode?.trim() || undefined,
    };
  } catch (err) {
    console.warn("[permission] syncSessionPermissionModeToDaemon failed", {
      sessionId: id,
      err,
    });
    return { accepted: false };
  }
}
