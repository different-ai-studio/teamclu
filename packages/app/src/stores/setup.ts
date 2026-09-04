import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { markStartup } from '@/lib/telemetry/startup-perf'

/**
 * The managed runtime's install state (#1250): what `amuxd doctor` reports
 * for the daemon, the managed Node, pi and git, and the progress of an
 * `amuxd install-pi` run. Consumed by the post-login daemon wizard
 * (`stores/daemon-onboarding`) and the settings Dependencies page.
 *
 * There is deliberately no cached "setup ok" verdict any more: the daemon's
 * doctor is the truth, and it is cheap now (no runtime `--version` spawns).
 */

/**
 * Why a runtime is not usable, when "not installed" would be misleading.
 * Cursor and pi both report one: their readiness is an AND of several
 * conditions, and the usual failure is not a missing install — it is a missing
 * API key, a Node too old, or an npm package amuxd installs beside the pi
 * extension.
 *
 * `node` and `node_outdated` are separate because the fix is: "there is no Node
 * here" sends the user to install one, while "the Node we can see is 20.20.2"
 * sends them to a version manager they already have.
 */
export type RuntimeBlocker = 'api_key' | 'node' | 'node_outdated' | 'bridge' | 'mcp_sdk'

export type RequirementStatus = {
  id: string
  title: string
  optional: boolean
  present: boolean
  version: string | null
  blocker?: RuntimeBlocker | null
  /** What the blocker found, e.g. `20.20.2 (/usr/local/bin/node)`. */
  blockerFound?: string | null
  /** What it needs, e.g. `22.19.0`. */
  blockerRequired?: string | null
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
  listRequirements: () => Promise<void>
  install: (id: string) => Promise<void>
  /** True when every required row is present. Only meaningful after `loaded`. */
  requiredSatisfied: () => boolean
}

export const useSetupStore = create<SetupState>((set, get) => ({
  requirements: [],
  installing: null,
  output: {},
  progress: {},
  installRoute: null,
  errors: {},
  loaded: false,
  probeError: null,

  // `present` is the daemon's own "satisfied": for the managed runtime that
  // means the pinned version is installed and runnable, not merely that some
  // version exists — an older pi on the wrong Node is exactly what the wizard
  // must repair, not wave through.
  requiredSatisfied: () =>
    get()
      .requirements.filter((r) => !r.optional)
      .every((r) => r.present),

  listRequirements: async () => {
    if (!isTauri()) {
      set({ loaded: true })
      return
    }
    markStartup('setup-list:start')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const requirements = await invoke<RequirementStatus[]>('setup_list_requirements')
      markStartup('setup-list:end')
      if (!Array.isArray(requirements)) {
        throw new Error('setup_list_requirements answered without rows')
      }
      set({ requirements, loaded: true, probeError: null })
    } catch (e) {
      // `loaded` still flips. Without it the wizard sits on "scanning…" forever
      // — a spinner that has stopped meaning anything is worse than an error,
      // because it offers the user nothing to do. Same failure shape as the
      // session list's never-resetting loader.
      console.error('[SetupStore] requirement probe failed:', e)
      set({ loaded: true, probeError: String(e) })
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
      const requirements = await invoke<RequirementStatus[]>('setup_list_requirements')
      set({ requirements })
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
