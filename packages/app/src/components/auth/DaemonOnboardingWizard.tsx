import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle, Check, Copy, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  useDaemonOnboardingStore,
  ONBOARDING_STEPS,
  type OnboardingStep,
} from '@/stores/daemon-onboarding'
import { useSetupStore, type InstallRoute } from '@/stores/setup'
import { useElapsedSeconds } from '@/hooks/use-elapsed-seconds'
import { useShallow } from 'zustand/react/shallow'
import {
  daemonHomeDisplayPath,
  daemonManagedLogDisplayPath,
  installPiLogDisplayPath,
} from '@/lib/daemon/daemon-paths'
import { buildInstallDiagnostics, summarizeInstallFailure } from '@/lib/daemon/install-failure'
import { fetchAppVersion } from '@/lib/config/version'

/**
 * What to call each source amuxd can install the runtime from. The
 * distinction people ask about on a slow first run is official-vs-ours, not
 * the hostname. Keys are spelled out because the i18n guardrail finds keys by
 * literal.
 */
const ROUTE_LABEL: Record<InstallRoute, { key: string; fallback: string }> = {
  official: { key: 'settings.daemonOnboarding.routeOfficial', fallback: 'the official source' },
  'public-mirror': { key: 'settings.daemonOnboarding.routePublicMirror', fallback: 'a public mirror' },
  'self-hosted': { key: 'settings.daemonOnboarding.routeSelfHosted', fallback: 'our own mirror' },
  custom: { key: 'settings.daemonOnboarding.routeCustom', fallback: 'the registry you configured' },
}

/**
 * The runtime install narrated under its step: amuxd's current line, a
 * percentage while a sized download is in flight, and where the bytes are
 * coming from. Without it the `install-runtime` step is a spinner that can
 * legitimately sit for minutes on a cold Windows machine — which is what a
 * hang looks like.
 */
function RuntimeInstallProgress() {
  const { t } = useTranslation()
  const progress = useSetupStore((s) => s.progress.pi)
  const installRoute = useSetupStore((s) => s.installRoute)
  if (!progress && !installRoute) return null
  const determinate = progress?.percent != null
  const label =
    progress?.event === 'probe'
      ? t('settings.daemonOnboarding.probing', 'Checking which download source is fastest…')
      : progress?.message
  return (
    <div className="flex flex-col gap-1.5 pl-[22px]">
      {label && (
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint" title={label}>
            {label}
          </span>
          {determinate && (
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
              {progress?.percent}%
            </span>
          )}
        </div>
      )}
      {progress && (
        <div
          className="h-[3px] w-full overflow-hidden rounded-full bg-selected"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent ?? undefined}
          aria-valuetext={determinate ? undefined : label}
        >
          <div
            className={cn(
              'h-full rounded-full bg-coral',
              determinate ? 'transition-[width] duration-300 ease-out' : 'setup-progress-indeterminate',
            )}
            style={determinate ? { width: `${progress.percent}%` } : undefined}
          />
        </div>
      )}
      {installRoute && (
        <span className="text-[11px] text-muted-foreground">
          {t('settings.daemonOnboarding.routeLine', 'Downloading from {{route}}', {
            route: t(ROUTE_LABEL[installRoute.choice].key, ROUTE_LABEL[installRoute.choice].fallback),
          })}
        </span>
      )}
    </div>
  )
}

/** Show elapsed time and a per-step hint once a run passes this. */
const SLOW_HINT_MS = 8_000
/** Surface the log path and an explicit retry once it passes this. */
const STUCK_HINT_MS = 25_000

/**
 * A step counts as done only when it finished *before* the one that failed.
 *
 * `completedSteps` can still contain a later step: a cloud-auth read started
 * while the daemon looked healthy resolves after a newer run has already
 * died in `await-daemon`. Showing that later check mark is how the failure
 * screen claimed "检查云端连接" succeeded on a service that never answered.
 */
function stepIsDone(
  step: OnboardingStep,
  completed: readonly OnboardingStep[],
  failed: OnboardingStep | null,
): boolean {
  if (!completed.includes(step)) return false
  if (!failed) return true
  return ONBOARDING_STEPS.indexOf(step) < ONBOARDING_STEPS.indexOf(failed)
}

function StepList({
  current,
  completed,
  failed,
}: {
  current: OnboardingStep | null
  completed: OnboardingStep[]
  failed: OnboardingStep | null
}) {
  const { t } = useTranslation()
  const label = (step: OnboardingStep) =>
    t(`settings.daemonOnboarding.steps.${step}`, step)
  return (
    <ul className="flex flex-col gap-1.5">
      {ONBOARDING_STEPS.map((step) => {
        const isFailed = step === failed
        const isDone = stepIsDone(step, completed, failed)
        const isActive = step === current
        return (
          <li key={step} className="flex items-center gap-2 text-[12.5px]">
            {isFailed ? (
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-coral" />
            ) : isDone ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-coral" />
            ) : isActive ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <span className="ml-[5px] mr-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-faint/50" />
            )}
            <span
              className={cn(
                isFailed
                  ? 'text-coral'
                  : isDone
                    ? 'text-muted-foreground'
                    : isActive
                      ? 'text-foreground'
                      : 'text-faint',
              )}
            >
              {label(step)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}


/**
 * This machine's agent: name it the first time, then never think about it again.
 *
 * The agent is resolved by (team, device id) server-side, so there is no
 * visibility to choose, no create-vs-bind fork, and no "belongs to another team"
 * reset. One question survives — what to call a robot that does not exist yet —
 * and it is only asked when the lookup comes back empty. Everything else here is
 * progress and failure.
 *
 * Mounting it is what starts the work: `refresh()` looks the machine up and either
 * binds it or parks the naming prompt.
 */
export function DaemonOnboardingWizard({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const {
    status,
    busy,
    error,
    step,
    completedSteps,
    failedStep,
    daemonOutdated,
    runStartedAt,
    completedAgent,
    pendingName,
    nameDeviceAgent,
    refresh,
    forceReset,
    autoHealCloudSession,
    retryRuntimeInstall,
    runtimeInstallFailures,
  } = useDaemonOnboardingStore(
    useShallow((s) => ({ status: s.status, busy: s.busy, error: s.error, step: s.step, completedSteps: s.completedSteps, failedStep: s.failedStep, daemonOutdated: s.daemonOutdated, runtimeInstallFailures: s.runtimeInstallFailures, runStartedAt: s.runStartedAt, completedAgent: s.completedAgent, pendingName: s.pendingName, nameDeviceAgent: s.nameDeviceAgent, refresh: s.refresh, forceReset: s.forceReset, autoHealCloudSession: s.autoHealCloudSession, retryRuntimeInstall: s.retryRuntimeInstall })),
  )
  const elapsed = useElapsedSeconds(runStartedAt)
  const [name, setName] = React.useState('')

  // Mounting starts the work — unless there is already work to show. AuthGate
  // mounts this wizard whenever the status turns 'starting' or 'error', so on
  // those it is here to report, not to begin. A refresh then would find the
  // daemon healthy and mark the store 'ready' over the failure: AuthGate unmounts
  // the wizard, the post-ready check installs again, fails, remounts it — a
  // loop that re-ran the install every few seconds with its error on screen for
  // an instant (2026-11-04). Retrying is the buttons' job.
  React.useEffect(() => {
    const { status: atMount } = useDaemonOnboardingStore.getState()
    if (atMount === 'starting' || atMount === 'error') return
    void refresh()
  }, [refresh])

  // Prefill with the hostname once the prompt appears, so "just press enter" is a
  // sane default and the field is never empty.
  React.useEffect(() => {
    if (pendingName) setName((current) => current || pendingName.suggested)
  }, [pendingName])

  // On the silent path (nothing the user initiated) hand off immediately — a cold
  // start should gain no latency from a screen nobody asked for. When the user
  // actually named this machine's agent, hold briefly to confirm what was set up
  // instead of just vanishing.
  React.useEffect(() => {
    if (status !== 'ready' || pendingName) return
    if (!completedAgent) {
      onDone()
      return
    }
    const id = setTimeout(onDone, 1500)
    return () => clearTimeout(id)
  }, [status, pendingName, completedAgent, onDone])

  // The only input left in onboarding: this machine has no agent in this team yet.
  if (pendingName) {
    const trimmed = name.trim()
    return (
      <Shell
        title={t('settings.daemonOnboarding.nameTitle', 'Name this machine’s agent')}
        subtitle={t(
          'settings.daemonOnboarding.nameSubtitle',
          'It runs here, on this machine, and only you can see it. You can rename it later in settings.',
        )}
      >
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && trimmed && !busy) void nameDeviceAgent(trimmed)
          }}
          placeholder={pendingName.suggested}
          disabled={busy}
          className="h-10 rounded-[10px] text-[13px]"
        />
        {error && <ErrorLine error={error} />}
        <Button
          className="h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
          disabled={busy || trimmed.length === 0}
          onClick={() => void nameDeviceAgent(trimmed)}
        >
          {busy ? (
            <Spinner label={t('settings.daemonOnboarding.creating', 'Setting up…')} />
          ) : (
            t('settings.daemonOnboarding.nameConfirm', 'Continue')
          )}
        </Button>
      </Shell>
    )
  }

  // Named just now — confirm the name that stuck before handing off.
  if (status === 'ready' && completedAgent) {
    return (
      <Shell title={t('settings.daemonOnboarding.doneTitle', 'This machine is ready')}>
        <p className="flex items-center gap-2 text-[13px] text-foreground">
          <Check className="h-4 w-4 shrink-0 text-coral" />
          {t('settings.daemonOnboarding.doneAs', 'Set up as {{name}}', {
            name: completedAgent.displayName,
          })}
        </p>
        <Button
          className="mt-1 h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
          onClick={onDone}
        >
          {t('settings.daemonOnboarding.continue', 'Continue')}
        </Button>
      </Shell>
    )
  }

  // Binding in flight, or bound already and the daemon is being started.
  if (status === 'starting') {
    return (
      <Shell
        title={t('settings.daemonOnboarding.startingTitle', "Setting up this machine's agent…")}
        subtitle={t(
          'settings.daemonOnboarding.startingSubtitle',
          'Connecting this machine to the current team and starting the local daemon.',
        )}
      >
        <StepList current={step} completed={completedSteps} failed={failedStep} />
        {step === 'install-runtime' && <RuntimeInstallProgress />}
        {elapsed * 1000 >= SLOW_HINT_MS && (
          <div className="flex flex-col gap-1 border-t border-border-soft pt-3">
            <span className="text-[11.5px] text-muted-foreground">
              {t('settings.daemonOnboarding.elapsed', 'Still working — {{seconds}}s', {
                seconds: elapsed,
              })}
            </span>
            {step && (
              <span className="text-[11.5px] leading-4 text-faint">
                {t(`settings.daemonOnboarding.slowHint.${step}`, {
                  path: daemonHomeDisplayPath,
                })}
              </span>
            )}
            {elapsed * 1000 >= STUCK_HINT_MS && (
              <>
                <span className="text-[11.5px] leading-4 text-faint">
                  {t('settings.daemonOnboarding.stuckHint', {
                    path: daemonManagedLogDisplayPath,
                    defaultValue: 'Taking longer than expected. Check {{path}} for details.',
                  })}
                </span>
                <Button
                  variant="outline"
                  className="mt-1 h-9 rounded-[10px]"
                  disabled={busy}
                  onClick={() => void (step === 'install-runtime' ? retryRuntimeInstall() : refresh())}
                >
                  {t('settings.daemonOnboarding.retry', 'Retry')}
                </Button>
              </>
            )}
          </div>
        )}
      </Shell>
    )
  }

  // Binding or auto-recovery failed. Name the step that broke and offer the
  // recovery that fits it, rather than one generic Retry for five different
  // failures. Without a step the copy stays vague on purpose — `error` carries
  // the cause, and it is not always the daemon (see bindErrorMessage).
  if (status === 'error') {
    return (
      <Shell
        title={
          failedStep
            ? t('settings.daemonOnboarding.errorAtStep', 'Setup stopped at: {{step}}', {
                step: t(`settings.daemonOnboarding.steps.${failedStep}`, failedStep),
              })
            : t('settings.daemonOnboarding.errorTitle', "Can't set up this machine's agent")
        }
        subtitle={
          // A stale daemon fails `install-runtime`, but that step's recovery
          // copy is about downloads and networks — the two things that are not
          // wrong here. Retrying against the same binary cannot help either, so
          // say what does.
          // A rejected root token also fails `await-daemon`, whose own copy
          // says the service never answered. It did — healthz passed — so
          // that sentence would contradict the error line under the steps.
          daemonOutdated
            ? t(
                'settings.daemonOnboarding.recovery.daemon-outdated',
                'The daemon on this machine is older than the app and cannot report the runtime. Restarting the app with a matching daemon is the fix — a retry against the same one will not help.',
              )
            : failedStep === 'await-daemon' &&
                error ===
                  t(
                    'settings.daemonOnboarding.tokenRejected',
                    'The local daemon is running, but it rejected the credential for this machine. Retry restarts it; if that keeps failing, reset and re-initialize.',
                  )
              ? t('settings.daemonOnboarding.recovery.await-daemon-token', {
                  path: daemonManagedLogDisplayPath,
                  defaultValue:
                    "The local service is running, but it rejected this machine's credential. Retry restarts it; details are in {{path}}.",
                })
              : failedStep
                ? t(`settings.daemonOnboarding.recovery.${failedStep}`, {
                    path: daemonManagedLogDisplayPath,
                  })
                : t(
                    'settings.daemonOnboarding.errorSubtitle',
                    'Nothing was left half-configured — retrying is safe.',
                  )
        }
      >
        {failedStep && (
          <StepList current={null} completed={completedSteps} failed={failedStep} />
        )}
        {error && (
          <FailureDetails
            error={error}
            failedStep={failedStep}
            attempts={daemonOutdated ? 0 : runtimeInstallFailures}
          />
        )}
        <Button
          className="mt-1 h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
          disabled={busy}
          onClick={() =>
            void (failedStep === 'cloud-auth'
              ? autoHealCloudSession()
              : failedStep === 'install-runtime'
                ? retryRuntimeInstall()
                : refresh())
          }
        >
          {busy ? (
            <Spinner label={t('settings.daemonOnboarding.retrying', 'Retrying…')} />
          ) : failedStep === 'cloud-auth' ? (
            t('settings.daemonOnboarding.reconnect', 'Reconnect')
          ) : (
            t('settings.daemonOnboarding.retry', 'Retry')
          )}
        </Button>
        {/* Credentials may be half-written after these two, so a plain retry can
            keep failing the same way; a reset gives the user a way out. */}
        {(failedStep === 'init-daemon' || failedStep === 'restart-daemon') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void forceReset()}
            className="mx-auto rounded-[6px] text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
          >
            {t('settings.daemonOnboarding.resetReinit', 'Reset and re-initialize')}
          </button>
        )}
      </Shell>
    )
  }

  // Everything else is a moment in transit: 'unknown' before the current team
  // resolves, 'needs-onboard'/'mismatch' in the beat before refresh() promotes
  // them to 'starting', and 'ready' between the status change and onDone.
  return (
    <Shell>
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    </Shell>
  )
}

function Shell({
  title,
  subtitle,
  children,
}: {
  title?: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6" data-tauri-drag-region>
      <div className="w-full max-w-[440px] rounded-[16px] border border-border bg-paper p-6 shadow-sm">
        {title && <h1 className="text-[16px] font-semibold text-foreground">{title}</h1>}
        {subtitle && <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">{subtitle}</p>}
        <div className="mt-5 flex flex-col gap-4">{children}</div>
      </div>
    </div>
  )
}

function Spinner({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </span>
  )
}

/** After this many runtime installs fail in a row, Retry has stopped helping. */
const RESTART_HINT_AFTER = 2

/**
 * The failure screen's error: the line that names the cause, the rest behind a
 * toggle, where the full log is, and one button that copies everything we
 * would ask for. Users stuck here are usually somewhere we cannot reach, so
 * what they can paste to us is the whole diagnosis.
 *
 * A runtime install that keeps failing also offers a restart: on 2026-11-04 a
 * fresh machine failed every Retry and was fixed by quitting and reopening,
 * which stops whatever install was left running.
 */
function FailureDetails({
  error,
  failedStep,
  attempts,
}: {
  error: string
  failedStep: OnboardingStep | null
  attempts: number
}) {
  const { t } = useTranslation()
  const isInstall = failedStep === 'install-runtime'
  const { headline, detail } = React.useMemo(() => {
    if (isInstall) return summarizeInstallFailure(error)
    const lines = error.split('\n').filter((l) => l.trim())
    return { headline: lines[0] ?? error, detail: lines.length > 1 ? error : null }
  }, [error, isInstall])
  const logPath = isInstall ? installPiLogDisplayPath : daemonManagedLogDisplayPath
  const [expanded, setExpanded] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [restarting, setRestarting] = React.useState(false)

  const copy = async () => {
    const report = buildInstallDiagnostics({
      error,
      output: isInstall ? (useSetupStore.getState().output.pi ?? []) : [],
      appVersion: await fetchAppVersion().catch(() => null),
      platform: navigator.userAgent,
      logPath,
      attempts,
    })
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      console.error('[DaemonOnboardingWizard] copy failed:', e)
    }
  }

  const restart = async () => {
    setRestarting(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('restart_app')
    } catch (e) {
      console.error('[DaemonOnboardingWizard] restart failed:', e)
      setRestarting(false)
    }
  }

  const linkButton =
    'flex items-center gap-1 rounded-[6px] text-[11.5px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline'
  return (
    <div className="flex flex-col gap-2">
      <ErrorLine error={headline} />
      <div className="flex items-center gap-3 pl-5">
        {detail && (
          <button type="button" className={linkButton} onClick={() => setExpanded((v) => !v)}>
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {expanded
              ? t('settings.daemonOnboarding.hideDetails', 'Hide details')
              : t('settings.daemonOnboarding.showDetails', 'Show details')}
          </button>
        )}
        <button type="button" className={linkButton} onClick={() => void copy()}>
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied
            ? t('settings.daemonOnboarding.detailsCopied', 'Copied')
            : t('settings.daemonOnboarding.copyDetails', 'Copy details')}
        </button>
      </div>
      {expanded && detail && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-border-soft bg-background p-2 font-mono text-[10.5px] leading-4 text-muted-foreground">
          {detail}
        </pre>
      )}
      <span className="pl-5 text-[11px] leading-4 text-faint">
        {t('settings.daemonOnboarding.fullLog', {
          path: logPath,
          defaultValue: 'Full log: {{path}}',
        })}
      </span>
      {isInstall && attempts >= RESTART_HINT_AFTER && (
        <div className="flex flex-col gap-2 rounded-[10px] border border-border-soft bg-background p-3">
          <span className="text-[11.5px] leading-4 text-muted-foreground">
            {t('settings.daemonOnboarding.restartHint', {
              count: attempts,
              defaultValue:
                'This has failed {{count}} times in a row. Restarting the app usually fixes it: it stops any install left running and starts a clean one.',
            })}
          </span>
          <Button
            variant="outline"
            className="h-9 rounded-[10px]"
            disabled={restarting}
            onClick={() => void restart()}
          >
            {restarting ? (
              <Spinner label={t('settings.daemonOnboarding.restarting', 'Restarting…')} />
            ) : (
              t('settings.daemonOnboarding.restartApp', 'Restart the app')
            )}
          </Button>
        </div>
      )}
    </div>
  )
}

function ErrorLine({ error }: { error: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[11.5px] leading-4 text-coral">
      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
    </p>
  )
}
