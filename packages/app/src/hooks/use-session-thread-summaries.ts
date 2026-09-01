import * as React from "react";
import { useThreadSummariesStore } from "@/stores/thread-summaries-store";
import { useThreadPanelStore } from "@/stores/thread-panel-store";
import { useSessionMessageStore } from "@/stores/session-message-store";

export function useSessionThreadSummaries(sessionId: string | null | undefined) {
  const entry = useThreadSummariesStore((s) =>
    sessionId ? s.byParent[sessionId] : undefined,
  );
  const load = useThreadSummariesStore((s) => s.load);
  const invalidate = useThreadSummariesStore((s) => s.invalidate);

  const threadSessionId = useThreadPanelStore((s) =>
    sessionId && s.parentSessionId === sessionId ? s.threadSessionId : null,
  );

  React.useEffect(() => {
    if (!sessionId) return;
    void load(sessionId);
  }, [sessionId, load]);

  React.useEffect(() => {
    if (!sessionId || !threadSessionId) return;
    invalidate(sessionId);
  }, [sessionId, threadSessionId, invalidate]);

  const refresh = React.useCallback(() => {
    if (!sessionId) return;
    invalidate(sessionId);
  }, [sessionId, invalidate]);

  return {
    summaries: entry?.summaries ?? [],
    loading: entry?.loading ?? false,
    hasThreads: (entry?.summaries?.length ?? 0) > 0,
    refresh,
  };
}

/** Per-message thread badge: reads shared cache, never fetches independently. */
export function useThreadSummaryForMessage(
  parentSessionId: string,
  rootMessageId: string,
  enabled: boolean,
) {
  const summary = useThreadSummariesStore((s) => {
    const entry = s.byParent[parentSessionId];
    return entry?.summaries.find((item) => item.rootMessageId === rootMessageId) ?? null;
  });
  const load = useThreadSummariesStore((s) => s.load);
  const invalidate = useThreadSummariesStore((s) => s.invalidate);

  const panelThreadSessionId = useThreadPanelStore((s) =>
    s.rootMessageId === rootMessageId && s.parentSessionId === parentSessionId
      ? s.threadSessionId
      : null,
  );
  const threadSessionId = summary?.threadSessionId ?? panelThreadSessionId;
  const threadMessageCount = useSessionMessageStore((s) =>
    threadSessionId ? (s.messages[threadSessionId]?.length ?? 0) : 0,
  );

  React.useEffect(() => {
    if (!enabled) return;
    void load(parentSessionId);
  }, [enabled, parentSessionId, load]);

  React.useEffect(() => {
    if (!panelThreadSessionId) return;
    invalidate(parentSessionId);
  }, [panelThreadSessionId, parentSessionId, invalidate]);

  React.useEffect(() => {
    if (!threadSessionId || threadMessageCount === 0) return;
    invalidate(parentSessionId);
  }, [threadSessionId, threadMessageCount, parentSessionId, invalidate]);

  return summary;
}
