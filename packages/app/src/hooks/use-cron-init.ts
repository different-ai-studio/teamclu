/** Bring the cron scheduler up for the current workspace / global scope.
 *
 * STR-11: split out of `hooks/useAppInit.ts`, which exported ten unrelated
 * hooks and one event-name constant from one 647-line file.
 */
import { useEffect } from "react";
import { isTauri } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";
import { useCronStore } from "@/stores/cron";

export function useCronInit() {
  const daemonHttpReady = useWorkspaceStore((s) => s.daemonHttpReady);

  useEffect(() => {
    if (!isTauri() || !daemonHttpReady) return;

    const unlistens: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      // Scheduled sessions are now identified by their persisted `source ===
      // 'cron'`, so a cron-session change just needs the session list re-pulled
      // (the fresh rows carry `source`); no separate id scan.
      unlistens.push(
        await listen("cron:cron-sessions-updated", () => {
          void import("@/stores/session-list-store").then(({ useSessionListStore }) =>
            useSessionListStore.getState().load(),
          ).catch((err: unknown) => {
            console.warn("[App] Session list refresh failed (non-critical):", err);
          });
        }),
      );
      unlistens.push(
        await listen("cron:jobs-updated", () => {
          void useCronStore.getState().loadJobs();
        }),
      );

      try {
        await useCronStore.getState().reinit();
      } catch (err: unknown) {
        console.warn("[App] Cron reinit failed (non-critical):", err);
      }
    })();

    return () => {
      cancelled = true;
      for (const unlisten of unlistens) unlisten();
    };
  }, [daemonHttpReady]);
}
