/** Channel gateway auto-start on workspace change, plus the keep-alive poll.
 *
 * STR-11: split out of `hooks/useAppInit.ts`, which exported ten unrelated
 * hooks and one event-name constant from one 647-line file.
 */
import { useEffect, useRef } from "react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useChannelsStore } from "@/stores/channels-store";
import { useShallow } from "zustand/react/shallow";

export function useChannelGatewayInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const workspaceReady = useWorkspaceStore((s) => s.daemonHttpReady);
  const {
    autoStartEnabledGateways,
    loadConfig: loadChannelsConfig,
    stopAllAndReset,
    keepAliveCheck,
  } = useChannelsStore(
    useShallow((s) => ({ autoStartEnabledGateways: s.autoStartEnabledGateways, loadConfig: s.loadConfig, stopAllAndReset: s.stopAllAndReset, keepAliveCheck: s.keepAliveCheck })),
  );
  const hasAutoStarted = useRef(false);
  const prevWorkspaceRef = useRef<string | null>(null);

  // When workspace changes: stop all gateways, reset state, allow re-auto-start
  useEffect(() => {
    if (prevWorkspaceRef.current === null) {
      prevWorkspaceRef.current = workspacePath;
      return;
    }

    if (workspacePath !== prevWorkspaceRef.current) {
      console.log(
        "[App] Workspace changed from",
        prevWorkspaceRef.current,
        "to",
        workspacePath,
      );
      prevWorkspaceRef.current = workspacePath;
      hasAutoStarted.current = false;

      stopAllAndReset().catch((err: unknown) => {
        console.warn("[App] Failed to stop gateways on workspace change:", err);
      });
    }
  }, [workspacePath, stopAllAndReset]);

  // When workspace becomes ready: load channel configs and auto-start enabled gateways
  useEffect(() => {
    if (workspaceReady && !hasAutoStarted.current) {
      hasAutoStarted.current = true;
      console.log("[App] Workspace ready, loading channel configs and auto-starting...");
      loadChannelsConfig()
        .then(() => {
          autoStartEnabledGateways();
        })
        .catch((err: unknown) => {
          console.error("[App] Failed to load channel configs for auto-start:", err);
        });
    }
  }, [workspaceReady, autoStartEnabledGateways, loadChannelsConfig]);

  // Keep-alive: periodically check enabled channels and restart if disconnected/errored
  useEffect(() => {
    if (!workspaceReady) return;
    const keepAliveInterval = setInterval(() => {
      keepAliveCheck().catch((err: unknown) => {
        console.warn("[App] Keep-alive check failed:", err);
      });
    }, 30_000);
    return () => clearInterval(keepAliveInterval);
  }, [workspaceReady, keepAliveCheck]);
}
