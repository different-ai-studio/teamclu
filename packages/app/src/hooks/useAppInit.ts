/**
 * useAppInit — initialization logic extracted from App.tsx
 *
 * Handles:
 *  - Tauri body class injection
 *  - Workspace restore
 *  - Channel gateway auto-start / keep-alive
 *  - Git repos auto-sync
 *  - External-link interception (Tauri only)
 *  - Dependency check + setup guide visibility
 *  - Telemetry consent dialog
 */
import { useEffect, useRef, useState } from "react";
import i18n from "@/lib/i18n";
import { capabilities } from "@/lib/platform";
import { isTauri } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabs";
import { urlToLabel } from "@/lib/webview-utils";
import { useWorkspaceStore } from "@/stores/workspace";
import { useChannelsStore } from "@/stores/channels";
import { useUIStore } from "@/stores/ui";
import { useTelemetryStore } from "@/stores/telemetry";
import { useTeamMembersStore } from "@/stores/team-members";
import { useShortcutsStore } from "@/stores/shortcuts";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useCronStore } from "@/stores/cron";
import { probeDaemonHttp, invalidateDaemonConnection } from "@/lib/daemon-local-client";
import { useDaemonOnboardingStore } from "@/stores/daemon-onboarding";
import { useWorkspaceRuntimeRefreshStore } from "@/stores/workspace-runtime-refresh";
import { useOssSyncStore } from "@/stores/oss-sync";
import { getSkillDirectories, loadAllSkills } from "@/lib/skills/loader";
import { DEFAULT_WORKSPACE_PATH } from "@/lib/build-config";
import { WORKSPACE_STORAGE_KEY } from "@/stores/workspace";
import { markStartup } from "@/lib/startup-perf";

export const SKILLS_CHANGED_EVENT = "skills-files-changed";

// ─────────────────────────────────────────────────────────────────────────────
// Workspace restore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse `?workspace=&port=` from window.location for secondary windows opened
 * via `create_workspace_window`. Returns null in the main window.
 */
function readWindowParams(): { workspace: string; port: number } | null {
  if (typeof window === "undefined" || !window.location?.search) return null;
  const params = new URLSearchParams(window.location.search);
  const workspace = params.get("workspace");
  const portStr = params.get("port");
  if (!workspace || !portStr) return null;
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { workspace, port };
}

const windowParams = readWindowParams();

const DAEMON_HTTP_PROBE_ATTEMPTS = 12;
const DAEMON_HTTP_PROBE_INTERVAL_MS = 500;

async function probeDaemonHttpWithRetry(): Promise<Awaited<ReturnType<typeof probeDaemonHttp>>> {
  let last = await probeDaemonHttp();
  if (last.ok) return last;
  for (let i = 1; i < DAEMON_HTTP_PROBE_ATTEMPTS; i++) {
    await new Promise((resolve) => setTimeout(resolve, DAEMON_HTTP_PROBE_INTERVAL_MS));
    invalidateDaemonConnection();
    last = await probeDaemonHttp();
    if (last.ok) return last;
  }
  return last;
}

export function useWorkspaceInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const setOpenCodeBootstrapped = useWorkspaceStore((s) => s.setOpenCodeBootstrapped);
  const setOpenCodeReady = useWorkspaceStore((s) => s.setOpenCodeReady);
  const setDaemonHttpReady = useWorkspaceStore((s) => s.setDaemonHttpReady);
  const daemonOnboardingStatus = useDaemonOnboardingStore((s) => s.status);
  const [openCodeError, setOpenCodeError] = useState<string | null>(null);
  const [initialWorkspaceResolved, setInitialWorkspaceResolved] = useState(false);

  // Auto-restore last workspace on launch (runs once on mount).
  // Secondary windows opened via create_workspace_window skip the localStorage
  // path and use the URL-provided workspace so they don't clobber main's saved value.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Extension / plain web have no local workspace — skip restore to avoid
      // Tauri-only knowledge/RAG init (invoke, plugin-fs) in chrome-extension://.
      if (!capabilities.workspace) {
        if (!cancelled) {
          setInitialWorkspaceResolved(true);
          markStartup("workspace-restored");
        }
        return;
      }

      if (!workspacePath) {
        if (windowParams) {
          console.log(
            "[App] Secondary window detected; using URL workspace:",
            windowParams.workspace,
          );
          await setWorkspace(windowParams.workspace);
        } else {
          try {
            const savedPath = localStorage.getItem(WORKSPACE_STORAGE_KEY);
            let restored = false;
            if (savedPath) {
              let canRestore = true;

              if (isTauri()) {
                try {
                  const { exists } = await import("@tauri-apps/plugin-fs");
                  canRestore = await exists(savedPath);
                } catch (error) {
                  console.warn("[App] Failed to validate saved workspace:", error);
                }
              }

              if (canRestore) {
                console.log("[App] Restoring workspace from last session:", savedPath);
                await setWorkspace(savedPath);
                restored = true;
              } else {
                console.log("[App] Saved workspace no longer exists, clearing restore path:", savedPath);
                localStorage.removeItem(WORKSPACE_STORAGE_KEY);
              }
            }

            if (!restored) {
              console.log("[App] No saved workspace — using default:", DEFAULT_WORKSPACE_PATH);
              await setWorkspace(DEFAULT_WORKSPACE_PATH);
            }
          } catch (error) {
            console.warn("[App] Workspace restore failed; using default workspace:", error);
            await setWorkspace(DEFAULT_WORKSPACE_PATH);
          }
        }
      }

      if (!cancelled) {
        setInitialWorkspaceResolved(true);
        markStartup('workspace-restored');
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Probe daemon HTTP — required on desktop; no OpenCode sidecar fallback.
  useEffect(() => {
    if (!workspacePath) {
      setDaemonHttpReady(false);
      return;
    }

    setOpenCodeError(null);

    if (!isTauri()) {
      setOpenCodeBootstrapped(true);
      setOpenCodeReady(true);
      setDaemonHttpReady(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      const probe = await probeDaemonHttpWithRetry();
      if (cancelled) return;
      const ready = probe.ok;
      setDaemonHttpReady(ready);
      if (ready) {
        setOpenCodeBootstrapped(true);
        setOpenCodeReady(true);
        setOpenCodeError(null);
        markStartup("daemon-ready");
      } else {
        setOpenCodeBootstrapped(false);
        setOpenCodeReady(false);
        const message =
          probe.reason === "port_file_missing"
            ? i18n.t("daemon.connection.portFileMissing")
            : probe.reason === "token_invalid"
              ? i18n.t("daemon.connection.tokenExchangeFailed")
              : probe.reason === "not_running"
                ? i18n.t("daemon.connection.healthCheckFailed")
                : i18n.t("daemon.connection.notConnected");
        setOpenCodeError(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspacePath, setOpenCodeBootstrapped, setOpenCodeReady, setDaemonHttpReady]);

  // daemon-onboarding may finish recovering after the first workspace probe;
  // re-probe once it reports ready so the shell clears the stale error toast.
  useEffect(() => {
    if (!workspacePath || !isTauri() || daemonOnboardingStatus !== "ready") return;

    let cancelled = false;
    void (async () => {
      const probe = await probeDaemonHttp();
      if (cancelled || !probe.ok) return;
      setDaemonHttpReady(true);
      setOpenCodeBootstrapped(true);
      setOpenCodeReady(true);
      setOpenCodeError(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    workspacePath,
    daemonOnboardingStatus,
    setDaemonHttpReady,
    setOpenCodeBootstrapped,
    setOpenCodeReady,
  ]);

  useEffect(() => {
    if (!workspacePath || !isTauri()) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let watchedDirs: string[] = [];
    let skillDirs: string[] = [];
    let lastSkillSignature = "";
    let hasObservedSkillChange = false;
    let changeVersion = 0;

    const QUIET_WINDOW_MS = 3000;
    const SIGNATURE_CONFIRM_MS = 1200;

    const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/$/, "");
    const isSkillFileChange = (path: string) => {
      const normalizedPath = normalizePath(path);
      return skillDirs.some((dir) => {
        const normalizedDir = normalizePath(dir);
        return normalizedPath === normalizedDir || normalizedPath.startsWith(`${normalizedDir}/`);
      });
    };

    const buildSkillSignature = async () => {
      const { skills } = await loadAllSkills(workspacePath);
      return JSON.stringify(
        skills
          .map((skill) => ({
            filename: skill.filename,
            source: skill.source,
            dirPath: skill.dirPath,
            content: skill.content,
          }))
          .sort((a, b) => `${a.dirPath}/${a.filename}`.localeCompare(`${b.dirPath}/${b.filename}`)),
      );
    };

    const refreshSkillState = async (versionAtSchedule: number) => {
      if (versionAtSchedule !== changeVersion || cancelled) return;

      const firstSignature = await buildSkillSignature();
      await new Promise((resolve) => setTimeout(resolve, SIGNATURE_CONFIRM_MS));
      if (versionAtSchedule !== changeVersion || cancelled) return;

      const secondSignature = await buildSkillSignature();
      if (firstSignature !== secondSignature) return;

      if (secondSignature !== lastSkillSignature) {
        const isFirstObservedChange = !hasObservedSkillChange;
        hasObservedSkillChange = true;
        lastSkillSignature = secondSignature;
        // Suppress restart prompts caused by startup-time churn while the
        // initial watcher baseline is stabilizing.
        if (isFirstObservedChange) return;
        window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT));
      }
    };

    void (async () => {
      try {
        const [{ invoke }, { listen }, { exists }] = await Promise.all([
          import("@tauri-apps/api/core"),
          import("@tauri-apps/api/event"),
          import("@tauri-apps/plugin-fs"),
        ]);

        skillDirs = await getSkillDirectories(workspacePath);
        lastSkillSignature = await buildSkillSignature();
        const watchableDirs = new Set<string>();

        for (const dir of skillDirs) {
          if (await exists(dir)) {
            watchableDirs.add(dir);
            continue;
          }

          const parentDir = dir.replace(/\/[^/]+$/, "");
          if (parentDir && await exists(parentDir)) {
            watchableDirs.add(parentDir);
          }
        }

        watchedDirs = Array.from(watchableDirs);
        await Promise.all(
          watchedDirs.map((path) =>
            invoke("watch_directory", { path }).catch((error) => {
              console.warn("[SkillsWatch] Failed to watch directory:", path, error);
            }),
          ),
        );

        if (cancelled) return;

        unlisten = await listen<{ path: string; kind: string }>("file-change", (event) => {
          if (!isSkillFileChange(event.payload.path)) return;

          changeVersion += 1;
          const versionAtSchedule = changeVersion;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            void refreshSkillState(versionAtSchedule);
          }, QUIET_WINDOW_MS);
        });
      } catch (error) {
        console.warn("[SkillsWatch] Failed to initialize skill watcher:", error);
      }
    })();

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      unlisten?.();

      void (async () => {
        if (watchedDirs.length === 0) return;
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await Promise.all(
            watchedDirs.map((path) =>
              invoke("unwatch_directory", { path }).catch((error) => {
                console.warn("[SkillsWatch] Failed to unwatch directory:", path, error);
              }),
            ),
          );
        } catch (error) {
          console.warn("[SkillsWatch] Failed to cleanup skill watchers:", error);
        }
      })();
    };
  }, [workspacePath]);

  return { initialWorkspaceResolved, openCodeError, setOpenCodeError };
}

export function useOpenCodePreload() {
  // OpenCode sidecar preload removed — daemon HTTP is probed in useWorkspaceInit.
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel gateway auto-start / keep-alive
// ─────────────────────────────────────────────────────────────────────────────

export function useChannelGatewayInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const workspaceReady = useWorkspaceStore((s) => s.daemonHttpReady);
  const {
    autoStartEnabledGateways,
    loadConfig: loadChannelsConfig,
    stopAllAndReset,
    keepAliveCheck,
  } = useChannelsStore();
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

// ─────────────────────────────────────────────────────────────────────────────
// Deferred workspace hydration
// ─────────────────────────────────────────────────────────────────────────────

export function useGitReposInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const workspaceReady = !!workspacePath;

  useEffect(() => {
    if (!workspacePath || !workspaceReady || !isTauri()) return;

    // Hydrate shortcuts: first paint from local cache, then refresh from Supabase.
    void (async () => {
      try {
        const store = useShortcutsStore.getState();
        await store.hydrateFromCache();
        await store.loadPersonal();
        const teamId = useCurrentTeamStore.getState().team?.id ?? null;
        if (teamId) await store.loadTeamForCurrentTeam(teamId);
      } catch (err: unknown) {
        console.warn("[App] Failed to load shortcuts (non-critical):", err);
      }
    })();

    void (async () => {
      try {
        await useTeamMembersStore.getState().loadCurrentNodeId();
      } catch (err: unknown) {
        console.warn("[App] Failed to load current team member identity (non-critical):", err);
      }
    })();

  }, [workspacePath, workspaceReady]);

  // Team sync status. Not gated on a workspace (the status is per team), and no
  // longer on a cloud share-mode flag either — nothing in the product sets that
  // flag, so gating on it meant never reading the status at all.
  //
  // What used to be here as well — a `file-change` listener under
  // `<workspace>/teamclu-team/` that re-read this status on every team file
  // write — is gone. It existed to repaint per-file sync badges, which the
  // daemon stopped exposing (`fileSyncStatusMap` has been `{}` since), and it
  // watched a tree sync retired: team content lives in the team's own
  // `shared/knowledge` now, which that path never pointed at.
  useEffect(() => {
    if (!isTauri()) return;
    void useOssSyncStore.getState().refresh(workspacePath);
  }, [workspacePath]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace runtime refresh (daemon GET /runtime polling)
// ─────────────────────────────────────────────────────────────────────────────

export function useWorkspaceRuntimeRefreshPoll() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const daemonHttpReady = useWorkspaceStore((s) => s.daemonHttpReady);
  const startPolling = useWorkspaceRuntimeRefreshStore((s) => s.startPolling);
  const stopPolling = useWorkspaceRuntimeRefreshStore((s) => s.stopPolling);
  const refreshNow = useWorkspaceRuntimeRefreshStore((s) => s.refreshNow);

  useEffect(() => {
    if (!isTauri() || !daemonHttpReady || !workspacePath) {
      stopPolling();
      return;
    }
    startPolling(workspacePath);
    return () => stopPolling();
  }, [workspacePath, daemonHttpReady, startPolling, stopPolling]);

  const noteLocalRefresh = useWorkspaceRuntimeRefreshStore((s) => s.noteLocalRefresh);

  useEffect(() => {
    const bump = () => {
      noteLocalRefresh(["skills"]);
      const path = useWorkspaceStore.getState().workspacePath;
      if (path) void refreshNow(path);
    };
    window.addEventListener(SKILLS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, bump);
  }, [noteLocalRefresh, refreshNow]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron session IDs (for sidebar filtering)
// ─────────────────────────────────────────────────────────────────────────────

export function useCronInit() {
  const daemonHttpReady = useWorkspaceStore((s) => s.daemonHttpReady);

  useEffect(() => {
    if (!isTauri() || !daemonHttpReady) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      // Scheduled sessions are now identified by their persisted `source ===
      // 'cron'`, so a cron-session change just needs the session list re-pulled
      // (the fresh rows carry `source`); no separate id scan.
      unlisten = await listen("cron:cron-sessions-updated", () => {
        void import("@/stores/session-list-store").then(({ useSessionListStore }) =>
          useSessionListStore.getState().load(),
        ).catch((err: unknown) => {
          console.warn("[App] Session list refresh failed (non-critical):", err);
        });
      });

      try {
        await useCronStore.getState().reinit();
      } catch (err: unknown) {
        console.warn("[App] Cron reinit failed (non-critical):", err);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [daemonHttpReady]);
}

// ─────────────────────────────────────────────────────────────────────────────
// External link interception (Tauri only)
// ─────────────────────────────────────────────────────────────────────────────

export function useExternalLinkHandler() {
  useEffect(() => {
    if (!isTauri()) return;

    const handler = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest?.("a");
      if (!anchor) return;
      // SEC-5: the one way a link gets an admin-console tab WITH the user's
      // session injected. Only first-party JSX can set a data attribute —
      // react-markdown drops raw HTML, so content (agent output, teammates'
      // messages, files) can never carry it. Every other https link, wherever
      // it came from, opens as a plain webview tab with no session.
      if (anchor.hasAttribute("data-admin-console-entry")) {
        e.preventDefault();
        e.stopPropagation();
        void import("@/lib/admin-sso-inject").then(({ openAdminConsoleTab }) => {
          openAdminConsoleTab();
        });
        return;
      }
      const href = anchor.getAttribute("href");
      if (href && /^https?:\/\//.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        useTabsStore.getState().openTab({
          type: "webview",
          target: href,
          label: urlToLabel(href),
        });
      }
    };

    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri body class
// ─────────────────────────────────────────────────────────────────────────────

export function useTauriBodyClass() {
  useEffect(() => {
    if (isTauri()) {
      document.documentElement.classList.add("tauri");
      return () => document.documentElement.classList.remove("tauri");
    }
  }, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry consent dialog
// ─────────────────────────────────────────────────────────────────────────────

export function useTelemetryConsent() {
  const [showConsentDialog, setShowConsentDialog] = useState(false);
  const embedMode = useUIStore((s) => s.embedMode);
  const telemetryConsent = useTelemetryStore((s) => s.consent);
  const telemetryInit = useTelemetryStore((s) => s.init);
  const telemetryInitialized = useTelemetryStore((s) => s.isInitialized);

  useEffect(() => {
    void telemetryInit();
  }, [telemetryInit]);

  // Extension embed skips the consent dialog; desktop keeps the first-run prompt.
  // No setup-guide gate any more: first-run onboarding now finishes in AuthGate
  // before this component mounts (#881), so nothing is left covering the screen.
  useEffect(() => {
    if (embedMode) return;
    if (telemetryInitialized && telemetryConsent === "undecided") {
      setShowConsentDialog(true);
    }
  }, [embedMode, telemetryInitialized, telemetryConsent]);

  return { showConsentDialog, setShowConsentDialog };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout mode keyboard shortcut + panel auto-open
// ─────────────────────────────────────────────────────────────────────────────

export function useLayoutModeShortcut() {
  const toggleLayoutMode = useUIStore((s) => s.toggleLayoutMode);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggleLayoutMode();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleLayoutMode]);
}
