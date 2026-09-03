import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  useDaemonOnboardingStore,
  ONBOARDING_STEPS,
  type OnboardingStep,
} from '@/stores/daemon-onboarding'
import { useElapsedSeconds } from '@/hooks/use-elapsed-seconds'
import { useShallow } from 'zustand/react/shallow'

/** Show elapsed time and a per-step hint once a run passes this. */
const SLOW_HINT_MS = 8_000
/** Surface the log path and an explicit retry once it passes this. */
const STUCK_HINT_MS = 25_000

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
        const isDone = completed.includes(step)
        const isFailed = step === failed
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
    runStartedAt,
    completedAgent,
    pendingName,
    nameDeviceAgent,
    refresh,
    forceReset,
    autoHealCloudSession,
  } = useDaemonOnboardingStore(
    useShallow((s) => ({ status: s.status, busy: s.busy, error: s.error, step: s.step, completedSteps: s.completedSteps, failedStep: s.failedStep, runStartedAt: s.runStartedAt, completedAgent: s.completedAgent, pendingName: s.pendingName, nameDeviceAgent: s.nameDeviceAgent, refresh: s.refresh, forceReset: s.forceReset, autoHealCloudSession: s.autoHealCloudSession })),
  )
  const elapsed = useElapsedSeconds(runStartedAt)
  const [name, setName] = React.useState('')

  React.useEffect(() => {
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
        {elapsed * 1000 >= SLOW_HINT_MS && (
          <div className="flex flex-col gap-1 border-t border-border-soft pt-3">
            <span className="text-[11.5px] text-muted-foreground">
              {t('settings.daemonOnboarding.elapsed', 'Still working — {{seconds}}s', {
                seconds: elapsed,
              })}
            </span>
            {step && (
              <span className="text-[11.5px] leading-4 text-faint">
                {t(`settings.daemonOnboarding.slowHint.${step}`, '')}
              </span>
            )}
            {elapsed * 1000 >= STUCK_HINT_MS && (
              <>
                <span className="text-[11.5px] leading-4 text-faint">
                  {t(
                    'settings.daemonOnboarding.stuckHint',
                    'Taking longer than expected. Check ~/.amuxd/amuxd.managed.log for details.',
                  )}
                </span>
                <Button
                  variant="outline"
                  className="mt-1 h-9 rounded-[10px]"
                  disabled={busy}
                  onClick={() => void refresh()}
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
          failedStep
            ? t(`settings.daemonOnboarding.recovery.${failedStep}`, '')
            : t(
                'settings.daemonOnboarding.errorSubtitle',
                'Nothing was left half-configured — retrying is safe.',
              )
        }
      >
        {failedStep && (
          <StepList current={null} completed={completedSteps} failed={failedStep} />
        )}
        {error && <ErrorLine error={error} />}
        <Button
          className="mt-1 h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
          disabled={busy}
          onClick={() =>
            void (failedStep === 'cloud-auth' ? autoHealCloudSession() : refresh())
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

function ErrorLine({ error }: { error: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[11.5px] leading-4 text-coral">
      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
    </p>
  )
}
