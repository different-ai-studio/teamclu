//! App-shell effects: the ones that wire the window itself — native menus,
//! daemon live status, and the keyboard shortcuts that belong to no one screen.

import { useEffect } from "react";
import i18n from "@/lib/i18n";
import { syncTrayMenuLabels } from "@/lib/ui/sync-tray-menu";
import { isTauri } from "@/lib/utils";
import { listenForDaemonLiveStatus } from "@/lib/mqtt/mqtt-bridge";
import { setDaemonLiveConnected } from "@/lib/diagnostics/live-dedup-stats";
import { useUIStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useTabsStore } from "@/stores/tabs";
import { useTerminalStore } from "@/stores/terminal-store";
import { urlToLabel } from "@/lib/ui/webview-utils";
import { useWebviewUIStore } from "@/app/webview-ui-store";

export function useTrayMenuLocaleSync() {
  useEffect(() => {
    void syncTrayMenuLabels();
    const onLang = () => {
      void syncTrayMenuLabels();
    };
    i18n.on("languageChanged", onLang);
    return () => {
      i18n.off("languageChanged", onLang);
    };
  }, []);
}

/** Native TeamClu → Settings… (⌘,) opens the in-app Settings dialog. */
export function useAppMenuOpenSettings() {
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("open-app-settings", () => {
        useUIStore.getState().openSettings();
      }))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

/** Track the local-daemon SSE fast-path status (observability only). */
export function useDaemonLiveStatus() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenForDaemonLiveStatus((connected) => {
      setDaemonLiveConnected(connected);
      console.info(`[daemon-live] fast-path ${connected ? "connected" : "down"}`);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

/**
 * Global keyboard shortcuts (Cmd+F, Cmd+/-/0) and context menu listener
 * for webview tabs. Registered once, reads active tab from tabs store.
 */
export function useWebviewShortcuts() {
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      const activeTab = useTabsStore.getState().getActiveTab()
      if (!activeTab || activeTab.type !== "webview") return
      if (!isTauri()) return

      const mod = e.metaKey || e.ctrlKey
      const webviewLabel = urlToLabel(activeTab.target)
      const { setShowFind, setZoomLevel, zoomLevels } =
        useWebviewUIStore.getState()

      if (mod && e.key === "f") {
        e.preventDefault()
        setShowFind(true)
        return
      }

      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault()
        const cur = zoomLevels[webviewLabel] ?? 1.0
        const next = Math.min(Math.round((cur + 0.1) * 10) / 10, 2.0)
        setZoomLevel(webviewLabel, next)
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_set_zoom", { label: webviewLabel, level: next }).catch(
            () => {}
          )
        })
        return
      }

      if (mod && e.key === "-") {
        e.preventDefault()
        const cur = zoomLevels[webviewLabel] ?? 1.0
        const next = Math.max(Math.round((cur - 0.1) * 10) / 10, 0.5)
        setZoomLevel(webviewLabel, next)
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_set_zoom", { label: webviewLabel, level: next }).catch(
            () => {}
          )
        })
        return
      }

      if (mod && e.key === "0") {
        e.preventDefault()
        setZoomLevel(webviewLabel, 1.0)
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_set_zoom", {
            label: webviewLabel,
            level: 1.0,
          }).catch(() => {})
        })
        return
      }
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])
}

export function useTerminalShortcuts() {
  const togglePanel = useTerminalStore(s => s.togglePanel);
  const openTerminal = useTerminalStore(s => s.openTerminal);
  const closeTerminal = useTerminalStore(s => s.closeTerminal);
  const workspacePath = useWorkspaceStore(s => s.workspacePath);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!workspacePath) return;
      const mod = e.metaKey || e.ctrlKey;

      // Ctrl + ` (backtick) — toggle terminal panel
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        togglePanel(workspacePath);
        return;
      }

      // Only act on Cmd+T / Cmd+W when focus is inside a terminal viewport.
      const focused = document.activeElement;
      const inTerminal = focused?.closest?.(".xterm") != null;
      if (!inTerminal) return;

      if (mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        void openTerminal(workspacePath, {
          cwd: workspacePath,
          allowedRoots: [workspacePath],
        });
        return;
      }

      if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const state = useTerminalStore.getState();
        const activeId = state.activeTabByWorkspace[workspacePath];
        if (activeId) void closeTerminal(activeId);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [workspacePath, togglePanel, openTerminal, closeTerminal]);
}
