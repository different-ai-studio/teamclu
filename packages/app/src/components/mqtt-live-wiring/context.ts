import type { MutableRefObject } from "react";
import type { Message as TeamcluMessage } from "@/lib/proto/teamclu_pb";

/**
 * What the live-envelope handlers need from `MqttLiveWiring`.
 *
 * These handlers used to be branches inside one 1,100-line `useEffect`, where
 * they reached this state through closure capture — which is why the effect
 * could not be read without holding all of it in your head at once. The
 * dependency is the same; it is just written down now.
 *
 * Refs rather than values on purpose: the handlers run from an MQTT callback
 * that outlives any single render, so a captured value would go stale.
 */
export interface LiveWiringContext {
  /** Agent replies parked per stream key until the turn's terminal event. */
  pendingStreamRepliesRef: MutableRefObject<Record<string, TeamcluMessage[]>>;
  /** Stream keys whose terminal flush is already scheduled. */
  terminalFlushPendingRef: MutableRefObject<Record<string, boolean>>;
  /** Stream keys mid follow-up turn, which must not be torn down. */
  followUpActiveRef: MutableRefObject<Record<string, boolean>>;

  clearTerminalFlushPending(streamKey: string): void;
  clearFollowUpActive(streamKey: string): void;
  /** Publish a turn's parked agent reply. Returns whether anything flushed. */
  flushTurnAgentReply(
    sessionId: string,
    actorId: string,
    trigger: string,
    options?: { force?: boolean },
  ): boolean;
  scheduleTerminalDaemonReplyTimeout(sessionId: string, actorId: string): void;
  removeInterruptedStreamPlaceholderForRealReply(
    sessionId: string,
    streamKey: string,
  ): void;
}
