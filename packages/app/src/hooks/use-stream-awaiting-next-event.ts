import * as React from "react";

/** After this gap without a new transcript revision, show the planning hint. */
export const STREAM_AWAITING_NEXT_EVENT_MS = 500;

/** True when a live stream is active but no content envelope has arrived recently. */
export function useStreamAwaitingNextEvent(
  active: boolean,
  contentRevision: number | string,
  idleMs: number = STREAM_AWAITING_NEXT_EVENT_MS,
): boolean {
  const [awaiting, setAwaiting] = React.useState(false);

  React.useEffect(() => {
    if (!active) {
      setAwaiting(false);
      return;
    }
    setAwaiting(false);
    const timer = window.setTimeout(() => setAwaiting(true), idleMs);
    return () => window.clearTimeout(timer);
  }, [active, contentRevision, idleMs]);

  return awaiting;
}
