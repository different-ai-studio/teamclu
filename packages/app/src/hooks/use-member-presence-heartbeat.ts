import { useEffect } from "react";
import { getBackend } from "@/lib/backend";
import { patchMemberLastActive } from "@/stores/actor-directory-store";

const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Keep the signed-in member actor marked online while the desktop app is open.
 * Mirrors amuxd's /v1/heartbeat loop; without this, member rows only flip online
 * when some other client (daemon/iOS) happens to refresh last_active_at.
 */
export function useMemberPresenceHeartbeat(
  teamId: string | null,
  memberActorId: string | null,
) {
  useEffect(() => {
    if (!teamId || !memberActorId) return;

    let cancelled = false;

    const tick = async () => {
      try {
        await getBackend().system.heartbeat();
        if (cancelled) return;
        const now = new Date().toISOString();
        patchMemberLastActive(teamId, memberActorId, now);
      } catch (error) {
        console.warn("[presence] member heartbeat failed", error);
      }
    };

    void tick();
    const timer = setInterval(() => { void tick(); }, HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [teamId, memberActorId]);
}
