import { useSyncExternalStore } from "react";

import { getKnownFeatureFlags, subscribeFeatureFlags } from "../../lib/mqtt/config";

/**
 * Whether the team-apps surface is on for this deployment: the bootstrap
 * `features.apps` flag, fail-open until the server has answered. Re-renders
 * when the root layout's bootstrap fetch lands.
 */
export function useAppsFeatureEnabled(): boolean {
  const flags = useSyncExternalStore(
    subscribeFeatureFlags,
    getKnownFeatureFlags,
    getKnownFeatureFlags,
  );
  return flags.apps;
}
