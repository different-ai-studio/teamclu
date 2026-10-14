import { useEffect } from "react";
import { AppState } from "react-native";

/** How often to retry while entered offline. */
const RETRY_INTERVAL_MS = 15_000;

type OfflineAwareController = {
  isOfflineLaunch: () => boolean;
  revalidateAfterOfflineLaunch: () => Promise<void>;
};

/**
 * Entered on the cached team without network (iOS #1606): recheck
 * memberships once the network is back, without leaving the app.
 *
 * iOS listens to `NWPathMonitor`; Expo ships no network-state module, so this
 * retries on a timer and whenever the app comes forward. Each attempt is one
 * `GET /v1/teams`, and it stops as soon as one gets through.
 */
export function useOfflineLaunchRevalidation(
  controller: OfflineAwareController,
  routeKey: string,
): void {
  const offline = controller.isOfflineLaunch();
  useEffect(() => {
    if (!offline) return;
    let stopped = false;
    const stop = () => {
      stopped = true;
      clearInterval(interval);
      subscription.remove();
    };
    const attempt = () => {
      if (stopped) return;
      if (!controller.isOfflineLaunch()) {
        stop();
        return;
      }
      void controller.revalidateAfterOfflineLaunch().then(() => {
        if (!controller.isOfflineLaunch()) stop();
      });
    };
    const interval = setInterval(attempt, RETRY_INTERVAL_MS);
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") attempt();
    });
    return stop;
  }, [controller, offline, routeKey]);
}
