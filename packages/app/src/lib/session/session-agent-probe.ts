/** How often to re-probe a local daemon agent that still looks ready via MQTT retain. */
export const LOCAL_AGENT_READY_PROBE_INTERVAL_MS = 20_000

/** Retry interval after a reachability probe fails (connecting/offline/ready paths). */
export const AGENT_REACHABILITY_PROBE_RETRY_MS = 30_000

/** Positive RPC evidence expires; MQTT presence remains the preferred live signal. */
export const AGENT_REACHABILITY_REACHABLE_TTL_MS = 30_000

/** Transport-not-ready/publish failures are local uncertainty, so retry quickly. */
export const AGENT_REACHABILITY_INDETERMINATE_RETRY_MS = 2_000

/** Quick-chat readiness HTTP probe interval when onboarding reports daemon ready. */
export const QUICK_CHAT_DAEMON_PROBE_INTERVAL_MS = 20_000

/**
 * How often to poll `ensureLocalDaemonCatalog` while a local agent is engaged.
 * The store rate-limits itself, so this only sets how quickly a due refresh is
 * noticed — short enough that a provider configured on first install shows up
 * without a restart.
 */
export const LOCAL_CATALOG_POLL_INTERVAL_MS = 5_000
