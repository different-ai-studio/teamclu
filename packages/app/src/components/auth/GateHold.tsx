import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDaemonOnboardingStore, type OnboardingStep } from "@/stores/daemon-onboarding";

/** Steps that rebind or restart the local daemon — the slow part of a sign-in as a different account. */
const DAEMON_STEPS: ReadonlySet<OnboardingStep> = new Set<OnboardingStep>([
  "start-daemon",
  "init-daemon",
  "restart-daemon",
  "await-daemon",
]);

function startupSkeletonShowing(): boolean {
  return typeof document !== "undefined" && !!document.getElementById("skeleton");
}

/**
 * What AuthGate renders while a gate is still loading.
 *
 * On cold start that is nothing: the static #skeleton covers an empty #root
 * and App hands off from it to real content, so rendering here would only add
 * a flash. After a sign-out the skeleton is long gone, and the same gates
 * (session restore, team bootstrap, the saved-team restore, which waits for
 * the daemon to be rebound and restarted for the new account) used to leave
 * the window blank white for as long as they took. Show where things are
 * instead.
 *
 * Reading the DOM in render is safe here: the skeleton is only ever removed by
 * a branch that renders real UI, so a gate that saw it present is replaced
 * before it could go stale.
 */
export function GateHold() {
  const { t } = useTranslation();
  const step = useDaemonOnboardingStore((s) => s.step);
  if (startupSkeletonShowing()) return null;
  const daemonBusy = step !== null && DAEMON_STEPS.has(step);
  return (
    <div
      className="flex h-svh w-full flex-col items-center justify-center gap-3 bg-background text-muted-foreground"
      data-tauri-drag-region
      role="status"
      aria-live="polite"
      data-testid="auth-gate-hold"
    >
      <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
      <p className="text-sm">
        {daemonBusy
          ? t("auth.gateHold.daemon", "Starting this machine's service for this account…")
          : t("auth.gateHold.loading", "Opening your workspace…")}
      </p>
    </div>
  );
}
