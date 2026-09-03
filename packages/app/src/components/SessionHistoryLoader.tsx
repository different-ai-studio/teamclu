/**
 * Loads message history for whichever session is active.
 *
 * Local-first: Tauri hydrates from the libsql cache first and delta-syncs in
 * the background; the extension reads its chrome.storage cache; everything
 * else pulls straight from the backend.
 *
 * Split out of `AppContent` because it is self-contained wiring — it takes no
 * props, renders nothing, and writes only to the session-message store — and
 * because its subscriptions (active session, refresh trigger) have no business
 * re-rendering the app shell.
 */
import { useEffect, useRef } from "react";
import { isChromeExtension } from "@/lib/config/platform";
import { isV2E2EControlActive } from "@/lib/e2e/v2-control-active";
import { loadSessionMessageHistory } from "@/lib/messages/load-session-message-history";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useWorkspaceStore } from "@/stores/workspace";

export function SessionHistoryLoader() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const currentSessionId = useSessionSelectionStore((s) => s.currentSessionId);
  const messageRefreshTrigger = useSessionMessageStore((s) => s.messageRefreshTrigger);
  const messageRefreshForceFull = useSessionMessageStore((s) => s.messageRefreshForceFull);
  const prevRefreshTriggerRef = useRef(0);

  useEffect(() => {
    if (!isChromeExtension()) return;
    void import("@/lib/extension/message-cache").then(({ pruneExtensionMessageCache }) =>
      pruneExtensionMessageCache(),
    );
  }, []);

  useEffect(() => {
    if (!currentSessionId) return;
    if (isV2E2EControlActive()) return;

    const triggerBumped =
      messageRefreshTrigger !== prevRefreshTriggerRef.current;
    const forceFull =
      messageRefreshForceFull ||
      (triggerBumped && prevRefreshTriggerRef.current !== 0);
    prevRefreshTriggerRef.current = messageRefreshTrigger;
    if (messageRefreshForceFull) {
      useSessionMessageStore.setState({ messageRefreshForceFull: false });
    }

    const teamId =
      useSessionListStore.getState().rows.find((r) => r.id === currentSessionId)
        ?.team_id ?? "";

    const controller = new AbortController();
    void loadSessionMessageHistory({
      sessionId: currentSessionId,
      teamId,
      workspacePath,
      forceFull,
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [currentSessionId, messageRefreshTrigger, messageRefreshForceFull, workspacePath]);

  return null;
}
