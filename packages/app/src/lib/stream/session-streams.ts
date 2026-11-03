import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import {
  selectStreamsForSession,
  streamEntryKey,
  useV2StreamingStore,
  type AgentStreamEntry,
} from "@/stores/v2-streaming-store";

const EMPTY_STREAMS: AgentStreamEntry[] = [];
const EMPTY_OUTLINE: unknown[] = [];

/**
 * The parts of a session's streams that the chat column derives from: which
 * entries exist and in what order, whether each is live, its plan and its
 * pending permissions. Text deltas only touch `outputText`/`thinkingText`/
 * `parts`/`lastUpdate` and keep these references, so they leave the outline
 * shallow-equal.
 */
export function selectSessionStreamOutline(
  state: ReturnType<typeof useV2StreamingStore.getState>,
  sessionId: string,
): unknown[] {
  const out: unknown[] = [];
  for (const e of selectStreamsForSession(state, sessionId)) {
    out.push(
      "archiveId" in e ? e.archiveId : null,
      e.streamId,
      e.actorId,
      e.active,
      e.errorMessage,
      e.planEntries,
      e.pendingPermissionsByRequestId,
    );
  }
  return out;
}

/**
 * Every stream entry for a session (archived + current), re-rendering the
 * caller only when the outline changes — not on every text delta.
 *
 * The returned entries are snapshots: their text is stale between outline
 * changes. Live text is read where it is drawn, through `useLiveStreamEntry`.
 * Subscribing a whole chat column to `revisionBySession` re-rendered it, and
 * the composer below it, on every frame of a reply.
 */
export function useSessionStreams(sessionId: string | null): AgentStreamEntry[] {
  // Revision is the store's coalesced per-session change signal; reuse the last
  // outline until it moves so a delta does not re-sort the session's entries.
  const cache = React.useRef<{
    sessionId: string | null;
    revision: number;
    outline: unknown[];
  } | null>(null);
  const outline = useV2StreamingStore(
    useShallow((s) => {
      if (!sessionId) return EMPTY_OUTLINE;
      const revision = s.revisionBySession[sessionId] ?? 0;
      const hit = cache.current;
      if (hit && hit.sessionId === sessionId && hit.revision === revision) {
        return hit.outline;
      }
      const next = selectSessionStreamOutline(s, sessionId);
      cache.current = { sessionId, revision, outline: next };
      return next;
    }),
  );
  return React.useMemo(
    () =>
      sessionId
        ? selectStreamsForSession(useV2StreamingStore.getState(), sessionId)
        : EMPTY_STREAMS,
    // outline is the change signal for the getState() read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outline, sessionId],
  );
}

/** One actor's current live entry, re-rendering on each of its deltas. */
export function useLiveStreamEntry(
  sessionId: string | null | undefined,
  actorId: string | null | undefined,
): AgentStreamEntry | undefined {
  return useV2StreamingStore((s) =>
    sessionId && actorId ? s.byKey[streamEntryKey(sessionId, actorId)] : undefined,
  );
}
