import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { useUpdaterStore } from "@/stores/updater";
import { useAutoUpdatePreferenceStore } from "@/stores/auto-update-preference-store";
import { getFeatures, subscribeFeatures } from "@/lib/config/remote-features";
import { useAnyStreamActive } from "@/lib/stream/any-stream-active";
import { useAnyTerminalBusy } from "@/stores/terminal-store";
import { publishWindowActivity, isAnyOtherWindowBusy } from "@/lib/updater/window-activity-broadcast";
import { isWindowsPlatform } from "@/lib/platform";
import { appStoragePrefix } from "@/lib/config/build-config";
import { isTauri } from "@/lib/utils";

const POLL_INTERVAL_MS = 60_000;
const ACTIVITY_HEARTBEAT_MS = 10_000;
const COUNTDOWN_SECONDS = 5;
const CEILING_MS = 24 * 60 * 60 * 1000;
/** Bounded retries after a detected restart failure — see `restart()` in
 * `stores/updater.ts` for how a failure is detected (still alive 5s later). */
const RETRY_BACKOFFS_MS = [30_000, 120_000, 600_000];
const ATTEMPTS_KEY = `${appStoragePrefix}-auto-update-restart-attempts`;

interface RestartAttempts {
  version: string;
  count: number;
}

function readAttempts(): RestartAttempts | null {
  try {
    const raw = localStorage.getItem(ATTEMPTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RestartAttempts>;
    if (typeof parsed.version === "string" && typeof parsed.count === "number") {
      return { version: parsed.version, count: parsed.count };
    }
  } catch {
    // ignore
  }
  return null;
}

function writeAttempts(attempts: RestartAttempts | null): void {
  try {
    if (attempts) localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts));
    else localStorage.removeItem(ATTEMPTS_KEY);
  } catch {
    // ignore
  }
}

function getWindowLabelSafe(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

async function sendWindowsRestartNotice(): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    if (!granted) return;
    sendNotification({
      title: "TeamClu",
      body: "Restarting to finish installing an update…",
    });
  } catch {
    // Best-effort only — never block the restart on this.
  }
}

/**
 * Drives the `auto-restart` update mode: polls for a safe window (no active
 * stream/cron/terminal, anywhere — including other windows), then counts down
 * before actually restarting. Only the `"main"` window runs this; every window
 * still publishes its own local activity so `main` can see it.
 *
 * Returns the live countdown (or `null` when not counting down) plus a way to
 * cancel it, for `UpdateDialog` to render.
 */
export function useAutoRestartOrchestration(): {
  restartCountdown: number | null;
  cancelAutoRestart: () => void;
} {
  const mode = useAutoUpdatePreferenceStore((s) => s.mode);
  const update = useUpdaterStore((s) => s.update);
  const restart = useUpdaterStore((s) => s.restart);
  const isStreamActive = useAnyStreamActive();
  const isTerminalBusy = useAnyTerminalBusy();

  const [restartCountdown, setRestartCountdown] = React.useState<number | null>(null);
  const countdownTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowsNoticeSentRef = React.useRef(false);

  const disarmRestartImminent = React.useCallback(() => {
    if (!isTauri()) return;
    void invoke("cron_set_restart_imminent", { imminent: false }).catch(() => {
      // Best-effort: worst case a job is refused for a few extra seconds.
    });
  }, []);

  const clearCountdown = React.useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    windowsNoticeSentRef.current = false;
    setRestartCountdown(null);
    disarmRestartImminent();
  }, [disarmRestartImminent]);

  const startCountdown = React.useCallback(() => {
    if (countdownTimerRef.current) return;
    if (isTauri()) {
      void invoke("cron_set_restart_imminent", { imminent: true }).catch(() => {});
    }
    setRestartCountdown(COUNTDOWN_SECONDS);
    countdownTimerRef.current = setInterval(() => {
      setRestartCountdown((prev) => {
        if (prev === null) return prev;
        if (prev <= 1) {
          if (countdownTimerRef.current) {
            clearInterval(countdownTimerRef.current);
            countdownTimerRef.current = null;
          }
          disarmRestartImminent();
          void restart();
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  }, [disarmRestartImminent, restart]);

  const cancelAutoRestart = React.useCallback(() => {
    clearCountdown();
  }, [clearCountdown]);

  // A native heads-up right before the restart syscall on Windows: a fully
  // silent close followed by a UAC-style installer prompt with zero on-screen
  // context alarms users. macOS needs nothing — the bundle already swapped.
  React.useEffect(() => {
    if (restartCountdown === null) return;
    if (windowsNoticeSentRef.current) return;
    if (restartCountdown > 2 || !isWindowsPlatform()) return;
    windowsNoticeSentRef.current = true;
    void sendWindowsRestartNotice();
  }, [restartCountdown]);

  // Kill switch: cancel a countdown already in flight the instant the remote
  // flag flips, not just on the next poll tick.
  React.useEffect(() => {
    return subscribeFeatures((features) => {
      if (features.autoRestartPaused && countdownTimerRef.current) {
        clearCountdown();
      }
    });
  }, [clearCountdown]);

  // Every window publishes its own local activity so `main` can aggregate
  // across windows — including windows where `mode` is not auto-restart.
  React.useEffect(() => {
    if (!isTauri()) return;
    const label = getWindowLabelSafe();
    const publish = () => publishWindowActivity(label, isStreamActive || isTerminalBusy);
    publish();
    const heartbeat = setInterval(publish, ACTIVITY_HEARTBEAT_MS);
    return () => clearInterval(heartbeat);
  }, [isStreamActive, isTerminalBusy]);

  // The poll loop: only the `main` window drives the actual restart decision.
  React.useEffect(() => {
    const shouldPoll =
      isTauri() && mode === "auto-restart" && update.state === "ready" && getWindowLabelSafe() === "main";

    if (!shouldPoll) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (countdownTimerRef.current) clearCountdown();
      return;
    }

    const checkSafeWindow = async () => {
      if (countdownTimerRef.current) return; // already counting down
      if (getFeatures().autoRestartPaused) return;

      const readySince = update.readySince ?? Date.now();
      const ceilingReached = Date.now() - readySince >= CEILING_MS;

      if (!ceilingReached) {
        if (isStreamActive || isTerminalBusy) return;
        if (isAnyOtherWindowBusy("main")) return;
        try {
          const cronBusy = await invoke<boolean>("cron_any_job_running");
          if (cronBusy) return;
        } catch {
          // Fail open: an unreachable check must not strand updates forever —
          // the other two signals still gate the decision.
        }
      }

      startCountdown();
    };

    void checkSafeWindow();
    pollTimerRef.current = setInterval(() => void checkSafeWindow(), POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [mode, update.state, update.readySince, isStreamActive, isTerminalBusy, startCountdown, clearCountdown]);

  // Bounded retry after a detected restart failure (see `restart()` in
  // `stores/updater.ts`: it flips to "error" if the process is still alive 5s
  // after asking to relaunch). Only in auto-restart mode — a human is expected
  // to be looking at the dialog in every other mode.
  React.useEffect(() => {
    if (mode !== "auto-restart" || update.state !== "error" || !update.version) return;
    const attempts = readAttempts();
    const count = attempts?.version === update.version ? attempts.count : 0;
    if (count >= RETRY_BACKOFFS_MS.length) return; // exhausted; leave for a human
    const delay = RETRY_BACKOFFS_MS[count];
    writeAttempts({ version: update.version, count: count + 1 });
    retryTimerRef.current = setTimeout(() => {
      void restart();
    }, delay);
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [mode, update.state, update.version, restart]);

  // A successful relaunch never re-renders this hook (the process exits), so
  // the only place attempt bookkeeping needs clearing is a fresh check cycle.
  React.useEffect(() => {
    if (update.state === "idle" || update.state === "up-to-date") writeAttempts(null);
  }, [update.state]);

  return { restartCountdown, cancelAutoRestart };
}
