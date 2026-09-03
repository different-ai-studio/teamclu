/**
 * Observability for the dual-path live-event delivery (local daemon SSE
 * fast-path + MQTT). Every session/live event arrives up to twice with the
 * same eventId; `rememberLiveEventId` keeps the first copy and App.tsx calls
 * `bumpLiveDuplicateDropped()` for the second. A healthy fast-path shows
 * `duplicatesDropped` climbing during streaming (SSE won, MQTT copy dropped).
 *
 * Inspect from devtools: `__liveDedupStats`.
 */

const stats = {
  duplicatesDropped: 0,
  /** True after the Rust bridge reports the daemon SSE stream is connected. */
  daemonLiveConnected: false,
};

export function bumpLiveDuplicateDropped(): void {
  stats.duplicatesDropped += 1;
}

export function setDaemonLiveConnected(connected: boolean): void {
  stats.daemonLiveConnected = connected;
}

export function getDaemonLiveConnected(): boolean {
  return stats.daemonLiveConnected;
}

declare global {
  interface Window {
    __liveDedupStats?: typeof stats;
  }
}

if (typeof window !== "undefined") {
  window.__liveDedupStats = stats;
}
