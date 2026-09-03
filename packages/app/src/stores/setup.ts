import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { markStartup } from '@/lib/telemetry/startup-perf'
import { appStoragePrefix, localAgent } from '@/lib/config/build-config'

// Cache the last-known "all required deps satisfied" verdict so a returning user
// (deps already installed) is never gated behind the cold `setup_list_requirements`
// probe, which spawns `amuxd doctor` and costs ~4s on first launch (macOS
// Gatekeeper). The probe still runs in the background to refresh this flag; the
// daemon-onboarding gate remains the real backstop if a dependency is missing.
const SETUP_OK_KEY = `${appStoragePrefix}-setup-ok`

/**
 * Forget the cached verdict, so the next launch re-runs the wizard instead of
 * skipping it. Used by the "run setup again" entry on the sign-in screen: the
 * gate is `!onboardingDone && (!setupAck || onboardingStarted)`, so clearing
 * the onboarding flags alone leaves this cache holding the door shut.
 */
export function clearSetupSatisfied(): void {
  try {
    localStorage.removeItem(SETUP_OK_KEY)
  } catch {
    // Private mode / disabled storage: nothing was cached to begin with.
  }
}

/** True if a prior probe confirmed all required deps were present. Sync, cheap. */
export function setupPreviouslySatisfied(): boolean {
  try {
    return localStorage.getItem(SETUP_OK_KEY) === '1'
  } catch {
    return false
  }
}

function persistSetupSatisfied(ok: boolean): void {
  try {
    localStorage.setItem(SETUP_OK_KEY, ok ? '1' : '0')
  } catch {
    /* private mode / storage disabled — optimistic skip just won't apply */
  }
}

/**
 * Why a runtime is not usable, when "not installed" would be misleading.
 * Only cursor reports one — its readiness is an AND of four conditions and the
 * usual failure is a missing API key, not a missing install.
 */
type RuntimeBlocker = 'api_key' | 'node' | 'bridge'

export type RequirementStatus = {
  id: string
  title: string
  optional: boolean
  present: boolean
  version: string | null
  blocker?: RuntimeBlocker | null
}

type SetupProgress = {
  id: string
  status: 'started' | 'running' | 'done' | 'failed'
  line: string | null
  error: string | null
}

/**
 * The current step of an install, parsed out of the raw progress line for the
 * wizard to render.
 *
 * amuxd narrates every install on stdout as one JSON object per line
 * (`{"event","message"}`, plus `url`/`downloaded`/`total`/`percent` on a
 * download). Those lines were collected into `output` and never shown, so an
 * install that spends minutes fetching an asset had nothing on screen but
 * "installing…".
 */
export type InstallProgress = {
  /** amuxd's step name: probe | download | unpack | install | mirror | upgrade | output | ok. */
  event: string
  /** One line, already trimmed to something a narrow row can show. */
  message: string
  /** 0–100 while a sized download is in flight; null when the step has no measurable size. */
  percent: number | null
  /** Set on the line where amuxd commits to a source. See [`InstallRoute`]. */
  route?: InstallRoute
}

/**
 * Which source an install is pulling from, as amuxd reports it.
 *
 * The question a user watching a slow first run actually has is "is this going
 * through the official servers or through something of ours?" — so these are
 * named for that rather than for the URL, and the wizard keeps the answer on
 * screen after the progress line carrying it has scrolled away.
 */
export type InstallRoute = 'official' | 'public-mirror' | 'self-hosted' | 'custom'

const INSTALL_ROUTES: readonly InstallRoute[] = [
  'official',
  'public-mirror',
  'self-hosted',
  'custom',
]

function parseRoute(value: unknown): InstallRoute | undefined {
  return typeof value === 'string' && (INSTALL_ROUTES as readonly string[]).includes(value)
    ? (value as InstallRoute)
    : undefined
}

/** Clamp to the 0–100 a progress bar can actually draw. */
function clampPercent(value: number): number | null {
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

/**
 * Parse one progress line. amuxd's lines are JSON; anything else (a stray
 * stderr line from the sidecar, npm noise) is still worth showing verbatim —
 * during a slow install the only thing worse than a raw line is a blank row.
 */
export function parseProgressLine(line: string): InstallProgress | null {
  const text = line.trim()
  if (!text) return null

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const event = typeof parsed.event === 'string' ? parsed.event : 'output'
      const message = typeof parsed.message === 'string' ? parsed.message : event
      const total = typeof parsed.total === 'number' ? parsed.total : null
      const downloaded = typeof parsed.downloaded === 'number' ? parsed.downloaded : null
      const percent =
        typeof parsed.percent === 'number'
          ? clampPercent(parsed.percent)
          : total !== null && total > 0 && downloaded !== null
            ? clampPercent((downloaded / total) * 100)
            : null
      const route = parseRoute(parsed.route)
      return { event, message: lastLine(message), percent, ...(route ? { route } : {}) }
    } catch {
      // Not amuxd's shape after all — fall through and show it as text.
    }
  }
  return { event: 'output', message: lastLine(text), percent: null }
}

/**
 * The last non-empty line of a possibly multi-line message. npm's output can
 * arrive as one blob, and the row shows a single line — the tail is the part
 * that says where the command got to.
 */
function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? text.trim()
}

type SetupState = {
  requirements: RequirementStatus[]
  /** Install status of every selectable runtime — populated by [`listAgentRuntimes`]. */
  agentRuntimes: RequirementStatus[]
  installing: string | null
  output: Record<string, string[]>
  /** Latest parsed step per requirement id, for the install row's progress bar. */
  progress: Record<string, InstallProgress>
  /**
   * The source the current (or last) install settled on.
   *
   * Kept apart from `progress` on purpose: `progress` is cleared the moment the
   * install finishes, and the whole point of this is to still be on screen
   * afterwards. Replaced when the next install picks its own source.
   */
  installRoute: { id: string; choice: InstallRoute } | null
  errors: Record<string, string>
  loaded: boolean
  /** Set when the requirement probe itself failed, so the UI can say so. */
  probeError: string | null
  /** Set when the runtime scan failed, so the picker stops pretending to scan. */
  runtimeScanFailed: boolean
  /**
   * `agent` overrides which runtime the requirement list reports on. Onboarding
   * passes the user's pick (#881). Without it — the background probe that
   * refreshes the setup-ok cache — the backend counts any installed runtime as
   * satisfying, so a pi machine is not failed against the build default.
   */
  listRequirements: (agent?: string) => Promise<void>
  listAgentRuntimes: () => Promise<void>
  install: (id: string) => Promise<void>
  requiredSatisfied: () => boolean
}

export const useSetupStore = create<SetupState>((set, get) => ({
  requirements: [],
  agentRuntimes: [],
  installing: null,
  output: {},
  progress: {},
  installRoute: null,
  errors: {},
  loaded: false,
  probeError: null,
  runtimeScanFailed: false,

  // A required dep blocks continuing only when truly absent (no `version`
  // detected at all). If it's installed but outdated/upgrade-failed
  // (`present: false` with a `version`), the wizard still offers the upgrade
  // but no longer blocks entry — the user already has a working runtime.
  requiredSatisfied: () =>
    get()
      .requirements.filter((r) => !r.optional)
      .every((r) => r.present || r.version != null),

  listRequirements: async (agent?: string) => {
    if (!isTauri()) {
      set({ loaded: true })
      return
    }
    markStartup('setup-list:start')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const requirements = await invoke<RequirementStatus[]>('setup_list_requirements', {
        localAgent: agent ?? null,
      })
      markStartup('setup-list:end')
      set({ requirements, loaded: true, probeError: null })
      // Refresh the optimistic-skip cache for the next launch.
      persistSetupSatisfied(get().requiredSatisfied())
    } catch (e) {
      // `loaded` still flips. Without it the wizard sits on "scanning…" forever
      // — a spinner that has stopped meaning anything is worse than an error,
      // because it offers the user nothing to do. Same failure shape as the
      // session list's never-resetting loader.
      console.error('[SetupStore] requirement probe failed:', e)
      set({ loaded: true, probeError: String(e) })
    }
  },

  listAgentRuntimes: async () => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const agentRuntimes = await invoke<RequirementStatus[]>('setup_list_agent_runtimes')
      set({ agentRuntimes, runtimeScanFailed: false })
    } catch (e) {
      // Distinct from "still scanning": an empty list and a failed probe look
      // identical to the picker, and only one of them is worth waiting on.
      console.error('[SetupStore] runtime scan failed:', e)
      set({ agentRuntimes: [], runtimeScanFailed: true })
    }
  },

  install: async (id: string) => {
    if (!isTauri()) return
    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')
    // Clear any prior error, log, and progress for this id so a retry starts
    // clean rather than resuming on the previous attempt's last line.
    set((s) => ({
      installing: id,
      errors: { ...s.errors, [id]: '' },
      output: without(s.output, id),
      progress: without(s.progress, id),
      // The previous install's source is not this one's answer.
      installRoute: null,
    }))
    // Listener lives only for this install and is removed in finally. The wizard
    // is modal/non-dismissible during install, so unmount-mid-install is not a
    // concern; applyProgress writes to the singleton store regardless.
    const unlisten = await listen<SetupProgress>('setup-progress', (event) => {
      applyProgress(event.payload)
    })
    try {
      await invoke('setup_install', { id })
      // Re-probe against the runtime just installed, not the build default —
      // otherwise installing pi refreshes opencode's row and pi still reads
      // as missing.
      const probeAgent = id === 'pi' || id === 'opencode' ? id : localAgent
      const requirements = await invoke<RequirementStatus[]>('setup_list_requirements', {
        localAgent: probeAgent,
      })
      set({ requirements })
      if (id === 'pi' || id === 'opencode') await get().listAgentRuntimes()
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [id]: String(e) } }))
    } finally {
      unlisten()
      set((s) => ({ installing: null, progress: without(s.progress, id) }))
    }
  },
}))

/** A copy of `record` without `key`. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _dropped, ...rest } = record
  return rest
}

/** Pure reducer applied to each setup-progress event (exported for tests). */
export function applyProgress(p: SetupProgress) {
  useSetupStore.setState((s) => {
    const output = { ...s.output }
    let progress = s.progress
    let installRoute = s.installRoute
    const errors = { ...s.errors }
    let requirements = s.requirements

    // 'started' is intentionally a no-op: `installing` is already set client-side
    // by install() before the backend runs.
    if (p.status === 'running' && p.line) {
      output[p.id] = [...(output[p.id] ?? []), p.line]
      const step = parseProgressLine(p.line)
      if (step) {
        // A step with no size of its own (unpacking, an npm line) must not wipe
        // the bar the download just filled — it would read as a reset. Carry the
        // last known percent until a differently-named step takes over.
        const previous = progress[p.id]
        const percent =
          step.percent ?? (previous && previous.event === step.event ? previous.percent : null)
        progress = { ...progress, [p.id]: { ...step, percent } }
        // Sticky: amuxd names the source once, on the line where it commits to
        // it, and then goes back to narrating bytes. Survives `done`, which
        // clears `progress`.
        if (step.route) installRoute = { id: p.id, choice: step.route }
      }
    }
    if (p.status === 'failed' && p.error) {
      errors[p.id] = p.error
    }
    if (p.status === 'done') {
      requirements = requirements.map((r) => (r.id === p.id ? { ...r, present: true } : r))
      progress = without(progress, p.id)
    }
    return { output, progress, installRoute, errors, requirements }
  })
}
