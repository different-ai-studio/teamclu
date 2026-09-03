/**
 * Lightweight fan-out so imperative actions (the "Retry connection" button, a
 * `window 'online'` event) can ask every live daemon-status probe to run *now*
 * instead of waiting for its next 20s poll tick. The status hooks
 * (`useLocalDaemonHttpStatus` / `useLocalDaemonRuntimeStatus`) register their
 * probe callback here for as long as they're mounted; callers fire
 * `requestDaemonProbe()` to trigger a one-shot re-probe without recreating the
 * hooks' intervals.
 */

type Listener = () => void

const listeners = new Set<Listener>()

/** Register a probe callback; returns an unsubscribe. Used by status hooks. */
export function onDaemonProbeRequested(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Ask all mounted daemon-status probes to run immediately (best-effort). */
export function requestDaemonProbe(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A single misbehaving probe must not block the others.
    }
  }
}
