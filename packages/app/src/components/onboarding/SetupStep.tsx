import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, AlertCircle, Download, Terminal, Cpu, MousePointer2, Bot, RefreshCw, Globe } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { localAgent } from '@/lib/build-config'
import {
  useSetupStore,
  type InstallProgress,
  type InstallRoute,
  type RequirementStatus,
} from '@/stores/setup'
import { useOnboardingStore, type OnboardingRole } from '@/stores/onboarding'
import { useElapsedSeconds } from '@/hooks/use-elapsed-seconds'
import type { DaemonLocalAgent } from '@/lib/daemon-local-client'

/**
 * How long the work on this screen may run before it starts saying how long it
 * has been running. A spinner and a hung app draw the same picture.
 */
const INSTALL_SLOW_MS = 8_000

/**
 * And how long before it explains itself. The honest answer on a cold Windows
 * first run is minutes: two npm installs writing thousands of small files, each
 * one scanned on write. The screen used to promise "this only takes a moment"
 * and then say nothing for all of it.
 */
const INSTALL_STUCK_MS = 45_000

/**
 * What to call each source amuxd can install from. The distinction people
 * actually ask about is official-vs-ours, not the hostname.
 *
 * Keys are spelled out rather than built from the route value: the i18n
 * guardrail finds keys by literal, and `public-mirror` is not a legal key
 * fragment for it anyway.
 */
const ROUTE_LABEL: Record<InstallRoute, { key: string; fallback: string }> = {
  official: { key: 'onboarding.setup.routeOfficial', fallback: 'the official source' },
  'public-mirror': { key: 'onboarding.setup.routePublicMirror', fallback: 'a public mirror' },
  'self-hosted': { key: 'onboarding.setup.routeSelfHosted', fallback: 'our own mirror' },
  custom: { key: 'onboarding.setup.routeCustom', fallback: 'the registry you configured' },
}

/**
 * How long the runtime scan may run before the screen admits it is slow.
 * `setup_list_requirements` spawns `amuxd doctor`, which costs ~4s on a cold
 * first launch (see stores/setup.ts) and longer on Windows.
 */
const SCAN_SLOW_MS = 4000

const RUNTIME_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  opencode: Terminal,
  pi: Cpu,
  cursor: MousePointer2,
  'claude-code': Bot,
}

/**
 * Runtimes this app can fetch. Mirrors `setup_install`'s match arms — Cursor and
 * Claude Code are the user's own tools, so they are offered only when already on
 * the machine and never carry an Install action.
 */
const INSTALLABLE_RUNTIMES = new Set(['opencode', 'pi'])

/**
 * What the picker opens on: the runtime this build targets (`localAgent` in
 * build.config). A brand that ships pi should not open on opencode — before
 * this, every build opened on opencode and a pi brand shipped pi only to
 * anyone who noticed the second card.
 */
const DEFAULT_RUNTIME = localAgent

/**
 * Where the guided path lands. It promises no choices, so it has to land
 * somewhere this app can reach on its own: the build's runtime when we can
 * fetch it, opencode otherwise. Cursor and Claude Code are the user's own
 * tools — `setup_install` has no arm for them — and a guided user has no way
 * to install one from here.
 */
export function resolveGuidedRuntime(build: DaemonLocalAgent): DaemonLocalAgent {
  return INSTALLABLE_RUNTIMES.has(build) ? build : 'opencode'
}

const GUIDED_RUNTIME = resolveGuidedRuntime(localAgent)

/** A runtime is usable if installed, even when a pinned upgrade is pending. */
function usable(r: RequirementStatus | undefined): boolean {
  return !!r && (r.present || r.version != null)
}

function RuntimeCard({
  runtime,
  selected,
  busy,
  progress,
  onSelect,
  onInstall,
}: {
  runtime: RequirementStatus
  selected: boolean
  busy: boolean
  /** Set only while this card's own install is running. */
  progress?: InstallProgress
  onSelect: () => void
  onInstall: () => void
}) {
  const { t } = useTranslation()
  const Icon = RUNTIME_ICON[runtime.id] ?? Terminal
  const installed = usable(runtime)
  const selectable = installed && !busy
  // `present` means "no action needed"; an installed-but-outdated runtime comes
  // back as `present: false` with a version (see stores/setup.ts). Cursor and
  // Claude Code are never fetched from here, so they only ever show a version.
  const fetchable = !runtime.present && INSTALLABLE_RUNTIMES.has(runtime.id)
  // Select and Install are siblings, never nested. As a <span role="button">
  // inside the card's own <button>, Install was unreachable the entire time a
  // runtime was missing: an uninstalled card is disabled, and a disabled button
  // swallows pointer events for everything inside it — so the one control that
  // only ever appears on an uninstalled runtime could never be clicked.
  //
  // The card is one hit target: the select button stretches across it via an
  // inset ::before, so a click anywhere — version line, padding, the gap
  // between rows — lands on it. Hitting the title alone was more precision than
  // a card this size should ask for. Install/Upgrade sits above that overlay on
  // `relative` alone: same paint step as the ::before, later in tree order.
  // That matters for an outdated-but-installed runtime, which is selectable
  // (overlay on) and fetchable (button shown) at the same time.
  return (
    <div
      className={cn(
        'relative flex flex-1 flex-col items-start gap-2 rounded-[14px] border p-4 transition-colors',
        selected ? 'border-coral bg-selected/35' : 'border-border bg-paper',
        selectable && !selected && 'hover:bg-selected/20',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={!selectable}
        className={cn(
          'flex w-full items-center justify-between text-left',
          selectable
            ? 'cursor-pointer before:absolute before:inset-0 before:rounded-[14px]'
            : 'cursor-default',
        )}
      >
        <span className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-ink-2" />
          <span className="text-[13px] font-semibold text-foreground">{runtime.title}</span>
        </span>
        {selected && <Check className="h-4 w-4 text-coral" />}
      </button>
      {installed && (
        <span className="font-mono text-[11px] text-faint">
          {runtime.version ?? t('onboarding.setup.installed', 'installed')}
        </span>
      )}
      {/* Cursor is offered on installed-ness alone — the API key is a Settings
          concern, and Settings only exists after onboarding. Say what is still
          missing rather than hiding the card, which is what gating on the key
          amounted to. */}
      {runtime.blocker === 'api_key' && (
        <span className="text-[11px] leading-4 text-faint">
          {t('onboarding.setup.needsApiKey', 'Needs an API key — add it in Settings → LLM later.')}
        </span>
      )}
      {runtime.blocker === 'node' && (
        <span className="text-[11px] leading-4 text-faint">
          {t('onboarding.setup.needsNode', 'Needs Node.js 22.19 or later before Pi can be installed.')}
        </span>
      )}
      {fetchable && runtime.blocker !== 'node' && (
        <button
          type="button"
          disabled={busy}
          onClick={onInstall}
          className="relative inline-flex items-center gap-1.5 rounded-[6px] text-[11.5px] text-coral hover:underline disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          {installed
            ? t('onboarding.setup.upgrade', 'Upgrade')
            : t('onboarding.setup.install', 'Install')}
        </button>
      )}
      {/* The developer path installs from the card, so the card is where its
          progress has to land — the dependency rows below report on amuxd and
          git, never on the runtime being fetched. */}
      {progress && (
        <div className="relative w-full">
          <InstallProgressBar progress={progress} />
        </div>
      )}
    </div>
  )
}

/**
 * What the install is doing right now, under the row that started it.
 *
 * amuxd streams a line per step and the store parses out a percentage when the
 * step is a sized download — which is the slow one, and the whole reason this
 * exists: a bare "installing…" for a multi-minute fetch is indistinguishable
 * from a hang. Steps with no measurable size (unpack, npm) get a sweep instead
 * of a fill, since a bar frozen at 0% would say the opposite of what is true.
 */
function InstallProgressBar({ progress }: { progress: InstallProgress }) {
  const { t } = useTranslation()
  const determinate = progress.percent !== null
  // The route probe is the one step whose raw line says nothing to a user
  // ("checking which download route is fastest"), and it is also the longest
  // silent stretch — up to nine seconds of sampling both registries. Say what it
  // is in their language instead.
  const label =
    progress.event === 'probe'
      ? t('onboarding.setup.probing', 'Checking which download source is fastest…')
      : progress.message
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        {/* The URL lives in this line; `title` keeps the full one reachable when
            the row is too narrow for it. */}
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint" title={label}>
          {label}
        </span>
        {determinate && (
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
            {progress.percent}%
          </span>
        )}
      </div>
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
    </div>
  )
}

function DependencyRow({
  req,
  installing,
  progress,
}: {
  req: RequirementStatus
  installing: boolean
  progress?: InstallProgress
}) {
  const { t } = useTranslation()
  const ok = usable(req)
  return (
    <div className="flex flex-col gap-2 rounded-[12px] border border-border bg-paper px-4 py-2.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          {ok ? (
            <Check className="h-4 w-4 text-coral" />
          ) : installing ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <AlertCircle className="h-4 w-4 text-faint" />
          )}
          <span className="text-[13px] text-foreground">{req.title}</span>
        </span>
        <span className="font-mono text-[11px] text-faint">
          {req.blocker === 'node'
            ? t('onboarding.setup.needsNode', 'Needs Node.js 22.19 or later before Pi can be installed.')
            : req.version ??
            (ok
              ? t('onboarding.setup.ready', 'ready')
              : installing
                ? t('onboarding.setup.installing', 'installing…')
                : t('onboarding.setup.missing', 'not found'))}
        </span>
      </div>
      {installing && progress && <InstallProgressBar progress={progress} />}
    </div>
  )
}

/**
 * Second screen of first-run setup (#881). What it shows depends on the role
 * picked on the previous screen:
 *
 * - `developer` sees every runtime with its install state and the optional git
 *   row (missing git is surfaced but never blocks), opened on this build's own
 *   runtime.
 * - `guided` gets that runtime preselected and no dependency detail at all,
 *   falling back to opencode when the build targets one we cannot install.
 *
 * amuxd installs silently in both, since there is no meaningful choice to make
 * about it.
 */
export function SetupStep({ role, onDone }: { role: OnboardingRole; onDone: () => void }) {
  const { t } = useTranslation()
  const {
    requirements,
    agentRuntimes,
    installing,
    errors,
    loaded,
    probeError,
    runtimeScanFailed,
    progress,
    installRoute,
    listRequirements,
    listAgentRuntimes,
    install,
  } = useSetupStore()
  const setRuntime = useOnboardingStore((s) => s.setRuntime)
  const [selected, setSelected] = React.useState<DaemonLocalAgent>(DEFAULT_RUNTIME)
  const [rechecking, setRechecking] = React.useState(false)

  React.useEffect(() => {
    void listAgentRuntimes()
  }, [listAgentRuntimes])

  React.useEffect(() => {
    void listRequirements(selected)
  }, [listRequirements, selected])

  // Cursor and Claude Code are the user's own tools: worth offering when they
  // are already here, but there is nothing to show for them when they are not —
  // no version, and no Install this app could perform.
  const visibleRuntimes = React.useMemo(
    () => agentRuntimes.filter((r) => INSTALLABLE_RUNTIMES.has(r.id) || usable(r)),
    [agentRuntimes],
  )

  // Guided is always this build's runtime, installed if absent.
  //
  // It used to adopt whichever runtime happened to be on the machine ("a working
  // install beats a fresh download"), which made the outcome depend on the
  // machine's history: anyone who had ever installed Pi silently got Pi. The
  // guided path promises no choices, so it has to land somewhere predictable —
  // which the build config is, and the machine's install history is not.
  React.useEffect(() => {
    if (role !== 'guided') return
    setSelected(GUIDED_RUNTIME)
    // Mirror into the store right away rather than waiting for Continue — the
    // next step branches on this value, and leaving it stale until the last
    // moment is one more window for the two to disagree.
    setRuntime(GUIDED_RUNTIME)
  }, [role, setRuntime])

  const amuxd = requirements.find((r) => r.id === 'amuxd')
  const amuxdMissing = !!amuxd && !usable(amuxd)
  const amuxdTriggered = React.useRef(false)
  React.useEffect(() => {
    if (!loaded || !amuxdMissing || amuxdTriggered.current) return
    amuxdTriggered.current = true
    void install('amuxd')
  }, [loaded, amuxdMissing, install])

  // Same treatment for the runtime on the guided path: promising "no choices" and
  // then stopping at a runtime the user has to install by hand is the same dead
  // end twice over — they were never offered the choice that would have avoided
  // it. Safe to install unconditionally: GUIDED_RUNTIME is only ever one this
  // app can fetch.
  const guidedRuntime = agentRuntimes.find((r) => r.id === GUIDED_RUNTIME)
  const guidedRuntimeMissing = role === 'guided' && !!guidedRuntime && !usable(guidedRuntime)
  const guidedRuntimeNeedsNode = guidedRuntime?.blocker === 'node'
  const guidedInstallTriggered = React.useRef(false)
  React.useEffect(() => {
    if (!guidedRuntimeMissing || guidedRuntimeNeedsNode || guidedInstallTriggered.current) return
    guidedInstallTriggered.current = true
    void install(GUIDED_RUNTIME)
  }, [guidedRuntimeMissing, guidedRuntimeNeedsNode, install])

  const selectedRuntime = agentRuntimes.find((r) => r.id === selected)
  const nodeBlocked = selectedRuntime?.blocker === 'node'
  const runtimeReady = usable(selectedRuntime)
  const canContinue = loaded && !installing && !amuxdMissing && runtimeReady
  /**
   * Work is in flight and Continue is waiting on it.
   *
   * Wider than `installing` on purpose: the auto-install of amuxd is triggered
   * from an effect, so between "deps probed" and "install started" the button is
   * disabled with nothing running under it — and the guided screen offers no
   * other moving part, so the whole window reads as hung. Anything that greys
   * the button out while the machine is still working spins.
   */
  const busy =
    !!installing ||
    amuxdMissing ||
    (guidedRuntimeMissing && !guidedRuntimeNeedsNode) ||
    (!runtimeReady && visibleRuntimes.length > 0 && selectedRuntime?.blocker !== 'node')

  // Elapsed time for whatever `busy` is covering. Kept in state rather than read
  // during render so the clock starts at the moment work does, and stops dead
  // when it ends.
  const [busySince, setBusySince] = React.useState<number | null>(null)
  React.useEffect(() => {
    setBusySince(busy ? Date.now() : null)
  }, [busy])
  const elapsed = useElapsedSeconds(busySince)

  const pick = (id: DaemonLocalAgent) => {
    setSelected(id)
    setRuntime(id)
  }

  const proceed = () => {
    setRuntime(selected)
    onDone()
  }

  // The probe behind `loaded` shells out to `amuxd doctor`; until it answers the
  // screen has nothing to render. It used to render that as a bare spinner, which
  // is the same picture a hung app draws — say what the machine is doing, and
  // admit when it is taking a while.
  const [scanSlow, setScanSlow] = React.useState(false)
  React.useEffect(() => {
    if (loaded) return
    const timer = setTimeout(() => setScanSlow(true), SCAN_SLOW_MS)
    return () => clearTimeout(timer)
  }, [loaded])

  const recheck = async () => {
    setRechecking(true)
    try {
      // Node may have been installed while onboarding stayed open. Re-probe both
      // views: the selected-runtime row controls Continue, and the picker must
      // also restore Pi's Install action for the self-select path.
      await Promise.all([listRequirements(selected), listAgentRuntimes()])
    } finally {
      setRechecking(false)
    }
  }

  if (!loaded) {
    return (
      <div
        className="flex h-screen flex-col items-center justify-center gap-3 bg-background"
        data-tauri-drag-region
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-[12.5px] text-muted-foreground">
          {t('onboarding.setup.scanning', 'Looking for agent runtimes on this machine…')}
        </p>
        {scanSlow && (
          <p className="text-[11.5px] text-faint">
            {t('onboarding.setup.scanningSlow', 'First run — this can take a few seconds.')}
          </p>
        )}
        {/* `loaded` now flips even on failure, so this screen is a moment rather
            than a destination — but a probe that fails fast would otherwise
            flash past with no trace. */}
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background px-6 py-8" data-tauri-drag-region>
      <div className="absolute inset-x-0 top-0 h-12" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[520px] flex-1 flex-col justify-center gap-5">
        <div>
          <h1 className="text-[18px] font-semibold text-foreground">
            {t('onboarding.setup.title', 'Setting up your agent')}
          </h1>
          <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
            {role === 'developer'
              ? t('onboarding.setup.developerSubtitle', 'Pick the runtime this machine should use.')
              : busy
                ? // Says what is happening rather than how long it will take. The
                  // old copy ("this only takes a moment") was a promise this path
                  // cannot keep on a cold Windows first run.
                  t(
                    'onboarding.setup.guidedSubtitle',
                    'Downloading and installing the agent runtime for this machine.',
                  )
                : t(
                    'onboarding.setup.guidedReadySubtitle',
                    'Everything this machine needs is already here.',
                  )}
          </p>
        </div>

        {role === 'developer' ? (
          <div className="flex flex-col gap-2">
            <span className="text-[11.5px] font-medium uppercase tracking-wide text-faint">
              {t('onboarding.setup.runtime', 'Agent runtime')}
            </span>
            {/* `loaded` tracks the requirements probe only; the runtime scan is a
                second call, and rendering its empty result as an empty grid is
                the same "nothing is happening" the screen above just fixed. */}
            {visibleRuntimes.length === 0 ? (
              <div className="flex items-center gap-2 rounded-[12px] border border-border bg-paper px-4 py-3">
                {runtimeScanFailed ? (
                  <>
                    <AlertCircle className="h-4 w-4 shrink-0 text-coral" />
                    <span className="min-w-0 text-[12.5px] text-muted-foreground">
                      {t(
                        'onboarding.setup.scanFailed',
                        'Could not check this machine for agent runtimes. Retry, or continue and install one from Settings.',
                      )}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      className="ml-auto h-7 shrink-0 rounded-[6px] border-border bg-paper text-[11.5px]"
                      disabled={rechecking}
                      onClick={() => void recheck()}
                    >
                      {rechecking
                        ? t('onboarding.setup.rechecking', 'Checking…')
                        : t('onboarding.setup.retryScan', 'Retry')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-[12.5px] text-muted-foreground">
                      {t('onboarding.setup.scanning', 'Looking for agent runtimes on this machine…')}
                    </span>
                  </>
                )}
              </div>
            ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {visibleRuntimes.map((r) => (
                <RuntimeCard
                  key={r.id}
                  runtime={r}
                  selected={r.id === selected}
                  busy={installing !== null}
                  progress={installing === r.id ? progress[r.id] : undefined}
                  onSelect={() => pick(r.id as DaemonLocalAgent)}
                  onInstall={() => void install(r.id)}
                />
              ))}
            </div>
            )}
            {visibleRuntimes.map((r) =>
              errors[r.id] ? (
                <p key={`${r.id}-err`} className="flex items-start gap-1.5 text-[11.5px] text-coral">
                  <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{errors[r.id]}</span>
                </p>
              ) : null,
            )}
          </div>
        ) : (
          selectedRuntime && (
            // `|| guidedRuntimeMissing` covers the gap between "we know it is missing" and
            // "the install effect has fired": without it the row sits on a red
            // "not found" for a beat, which reads as a failure rather than as
            // the work this screen just promised.
            <DependencyRow
              req={selectedRuntime}
              installing={installing === selectedRuntime.id || guidedRuntimeMissing}
              progress={progress[selectedRuntime.id]}
            />
          )
        )}

        <div className="flex flex-col gap-2">
          {amuxd && (
            <DependencyRow
              req={amuxd}
              installing={installing === 'amuxd' || amuxdMissing}
              progress={progress.amuxd}
            />
          )}
          {/* git is `optional: true` from the backend; only developers need to
              know it is missing, and even for them it never blocks. */}
          {role === 'developer' &&
            requirements
              .filter((r) => r.id === 'git')
              .map((r) => <DependencyRow key={r.id} req={r} installing={installing === r.id} />)}
        </div>

        {nodeBlocked && (
          <Button
            type="button"
            variant="outline"
            className="h-9 w-full rounded-[8px] border-border bg-paper text-[12px] text-ink-2 hover:bg-selected/30"
            disabled={rechecking}
            onClick={() => void recheck()}
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', rechecking && 'animate-spin')} />
            {rechecking
              ? t('onboarding.setup.rechecking', 'Checking…')
              : t('onboarding.setup.recheck', 'I installed Node.js — check again')}
          </Button>
        )}

        {/* Where the bytes are coming from, kept on screen after the line that
            said so has scrolled past. On a slow first run "is this even using
            the mirror?" is the first thing anyone asks, and until now the
            answer went by in one throwaway progress line. */}
        {installRoute && (
          <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <Globe className="h-3.5 w-3.5 shrink-0 text-faint" />
            <span className="min-w-0">
              {t('onboarding.setup.routeLine', 'Downloading from {{route}}', {
                route: t(
                  ROUTE_LABEL[installRoute.choice].key,
                  ROUTE_LABEL[installRoute.choice].fallback,
                ),
              })}
            </span>
          </p>
        )}

        {/* Elapsed time, then an explanation. Neither is decoration: this screen
            can legitimately run for minutes on Windows, and a spinner alone
            makes that indistinguishable from a hang. */}
        {busy && elapsed * 1000 >= INSTALL_SLOW_MS && (
          <div className="flex flex-col gap-1">
            <span className="text-[11.5px] text-muted-foreground">
              {t('onboarding.setup.elapsed', 'Still working — {{seconds}}s', { seconds: elapsed })}
            </span>
            {elapsed * 1000 >= INSTALL_STUCK_MS && (
              <span className="text-[11.5px] leading-4 text-faint">
                {t(
                  'onboarding.setup.slowHint',
                  'First run downloads and installs the agent runtime. On Windows this can take several minutes — antivirus scans every file as it is written.',
                )}
              </span>
            )}
          </div>
        )}

        {/* The runtime error matters most on the guided path: nothing there is
            user-initiated, so a failed auto-install has no other way to surface
            (the developer screen already prints per-runtime errors above). */}
        {[probeError, errors.amuxd, role === 'guided' ? errors[selected] : null]
          .filter(Boolean)
          .map((message, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11.5px] text-coral">
              <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{message}</span>
            </p>
          ))}

        <Button
          className="h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
          disabled={!canContinue}
          onClick={proceed}
        >
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('onboarding.setup.working', 'Setting up…')}
            </span>
          ) : (
            t('onboarding.setup.continue', 'Continue')
          )}
        </Button>

        {/* Picking the simpler path should never be a one-way door. */}
        {role === 'guided' && (
          <button
            type="button"
            onClick={() => useOnboardingStore.getState().setRole('developer')}
            className="mx-auto rounded-[6px] text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            {t('onboarding.setup.switchToDeveloper', 'Let me choose the runtime instead')}
          </button>
        )}
      </div>
    </div>
  )
}
