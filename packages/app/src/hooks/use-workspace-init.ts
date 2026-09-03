/**
 * Restore the last workspace on launch, wait for the daemon's local HTTP to
 * come up, and load the skill set once it has.
 *
 * STR-11: split out of `hooks/useAppInit.ts`, which exported ten unrelated
 * hooks and one event-name constant from one 647-line file.
 */
import { useEffect, useState } from "react";
import i18n from "@/lib/i18n";
import { capabilities } from "@/lib/config/platform";
import { isTauri } from "@/lib/utils";
import { useWorkspaceStore, WORKSPACE_STORAGE_KEY } from "@/stores/workspace";
import { probeDaemonHttp, invalidateDaemonConnection } from "@/lib/daemon/daemon-local-client";
import { useDaemonOnboardingStore } from "@/stores/daemon-onboarding";
import { getSkillDirectories, loadAllSkills } from "@/lib/skills/loader";
import { DEFAULT_WORKSPACE_PATH } from "@/lib/config/build-config";
import { markStartup } from "@/lib/telemetry/startup-perf";
import { SKILLS_CHANGED_EVENT } from "@/lib/skills/changed-event";

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

        unlisten = await listen<{ paths: string[]; directories: string[] }>("file-change-batch", (event) => {
          if (!event.payload.paths.some(isSkillFileChange)) return;

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
