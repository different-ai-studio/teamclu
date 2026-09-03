import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { appStoragePrefix } from '@/lib/config/build-config'

export interface DependencyInfo {
  name: string
  installed: boolean
  version: string | null
  required: boolean
  description: string
  install_commands: {
    macos: string
    windows: string
    linux: string
  }
  affected_features: string[]
  /** Install priority — lower numbers install first (e.g., Homebrew = 0, others = 1) */
  priority: number
}

/**
 * Installed vs available version of one dependency.
 *
 * "Available" differs per dependency — opencode's comes off the mirror
 * manifest, pi's is the minimum `pi.lock.json` pins — but the question the UI
 * asks is the same either way: is there something to update to.
 */
interface DependencyVersions {
  installed: string | null
  latest: string | null
  /** null = latest unknown (mirror unreachable); keep offering the update. */
  upToDate: boolean | null
  /**
   * At the pinned version and still unusable — pi's MCP SDK is installed beside
   * the extension by amuxd, not by npm, so a pi installed by hand is current
   * and broken at once. "Up to date" must not hide the button that repairs it.
   */
  needsRepair?: boolean
}

interface InstallResult {
  success: boolean
  error?: string
}

/** Event payload from Tauri dep-install-progress */
interface DepInstallProgressEvent {
  name: string
  status: 'started' | 'installing' | 'done' | 'failed'
  outputLine?: string | null
  error?: string | null
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface DepsState {
  dependencies: DependencyInfo[]
  checked: boolean
  loading: boolean

  /** Install state */
  installing: boolean
  currentInstalling: string | null
  installQueue: string[]
  installResults: Record<string, InstallResult>
  installOutput: Record<string, string[]>
  /** Which operation produced the current results — drives the UI wording. */
  lastOperation: 'install' | 'update' | null
  /** Newest opencode available, or null until/unless the check succeeds. */
  /** Keyed by dependency name; absent means "not checked / unknown". */
  versions: Record<string, DependencyVersions>

  /** Check all dependencies via Tauri command */
  checkDependencies: () => Promise<DependencyInfo[]>

  /** Get a specific dependency by name */
  getDep: (name: string) => DependencyInfo | undefined

  /** Check if a specific dependency is installed */
  isInstalled: (name: string) => boolean

  /** Install dependencies serially in priority order */
  installDependencies: (names: string[]) => Promise<void>

  /** Update an already-installed dependency (opencode → `amuxd install-opencode`) */
  updateDependency: (name: string) => Promise<void>

  /** Reset install state for retry */
  resetInstallState: () => void

  /** Ask amuxd what the newest opencode is (network; safe to fail). */
  checkVersions: () => Promise<void>
}


/**
 * Debug: set localStorage.setItem(`${appStoragePrefix}-debug-force-setup`, '1') to force
 * SetupGuide to show in browser dev mode with mock dependency data.
 * Remove the key to disable: localStorage.removeItem(`${appStoragePrefix}-debug-force-setup`)
 */
const isDebugForceSetup = () => {
  try {
    return localStorage.getItem(`${appStoragePrefix}-debug-force-setup`) === '1'
  } catch {
    return false
  }
}

/** Mock dependencies for browser dev mode testing */
function getMockDependencies(): DependencyInfo[] {
  return [
    { name: 'brew', installed: false, version: null, required: false, description: 'Package manager - needed to install other tools on macOS', install_commands: { macos: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', windows: '', linux: '' }, affected_features: ['Package Management'], priority: 0 },
    { name: 'git', installed: true, version: '2.43.0', required: false, description: 'Version control - needed for team Git sync', install_commands: { macos: 'xcode-select --install', windows: 'winget install Git.Git', linux: 'sudo apt install -y git' }, affected_features: ['Team Git Sync', 'Version Control'], priority: 1 },
    { name: 'gh', installed: false, version: null, required: false, description: 'GitHub CLI - needed for spec-plan, spec-pr, and issue management', install_commands: { macos: 'brew install gh', windows: 'winget install GitHub.cli', linux: 'sudo apt install -y gh' }, affected_features: ['spec-plan', 'spec-pr', 'GitHub Issues'], priority: 1 },
    { name: 'node', installed: true, version: '22.1.0', required: false, description: 'Node.js runtime - needed to run some MCP servers (via npx)', install_commands: { macos: 'brew install node', windows: 'winget install OpenJS.NodeJS', linux: 'sudo apt install -y nodejs' }, affected_features: ['MCP Servers (npx-based)'], priority: 1 },
    { name: 'python3', installed: false, version: null, required: false, description: 'Python runtime - needed for uvx-based MCP servers and data analysis', install_commands: { macos: 'brew install python3', windows: 'winget install Python.Python.3', linux: 'sudo apt install -y python3' }, affected_features: ['MCP Servers (uvx-based)', 'Data Analysis'], priority: 1 },
    { name: 'opencode', installed: true, version: '1.17.7', required: true, description: 'Agent runtime - required to run the local AI agent', install_commands: { macos: 'amuxd install-opencode', windows: 'amuxd install-opencode', linux: 'amuxd install-opencode' }, affected_features: ['Local Agent'], priority: 1 },
  ]
}

export const useDepsStore = create<DepsState>((set, get) => ({
  dependencies: [],
  checked: false,
  loading: false,

  // Install state
  installing: false,
  currentInstalling: null,
  installQueue: [],
  installResults: {},
  installOutput: {},
  lastOperation: null,
  versions: {},

  checkDependencies: async () => {
    if (!isTauri()) {
      // Debug mode: return mock data so SetupGuide can be tested in browser
      if (isDebugForceSetup()) {
        const mock = getMockDependencies()
        set({ dependencies: mock, checked: true, loading: false })
        return mock
      }
      set({ checked: true, loading: false })
      return []
    }

    set({ loading: true })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      // Which runtime this machine runs decides which one is *required*, and
      // the daemon owns that answer (`agents.local_agent`). Asking it here
      // rather than in Rust keeps one implementation of the lookup —
      // `getDaemonLocalAgent` already falls back to opencode when the daemon
      // cannot be reached, which is the conservative default the backend uses
      // for `undefined` too.
      const { getDaemonLocalAgent } = await import('@/lib/daemon/daemon-local-client')
      const localAgent = await getDaemonLocalAgent().catch(() => undefined)
      const result = await invoke<DependencyInfo[]>('check_dependencies', { localAgent })
      set({ dependencies: result, checked: true, loading: false })
      return result
    } catch (err) {
      console.error('[DepsStore] Failed to check dependencies:', err)
      set({ checked: true, loading: false })
      return get().dependencies
    }
  },

  getDep: (name: string) => {
    return get().dependencies.find((d) => d.name === name)
  },

  isInstalled: (name: string) => {
    const dep = get().dependencies.find((d) => d.name === name)
    return dep?.installed ?? true // Default to true if not checked yet
  },

  installDependencies: async (names: string[]) => {
    if (!isTauri() || names.length === 0) return

    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')

    // Sort names by priority using current dependency data
    const deps = get().dependencies
    const sorted = [...names].sort((a, b) => {
      const depA = deps.find((d) => d.name === a)
      const depB = deps.find((d) => d.name === b)
      return (depA?.priority ?? 1) - (depB?.priority ?? 1)
    })

    // Reset install state
    const initialOutput: Record<string, string[]> = {}
    const initialResults: Record<string, InstallResult> = {}
    for (const name of sorted) {
      initialOutput[name] = []
      initialResults[name] = { success: false }
    }

    set({
      installing: true,
      installQueue: sorted,
      installResults: initialResults,
      installOutput: initialOutput,
      currentInstalling: null,
      lastOperation: 'install',
    })

    // Listen for progress events
    const unlisten = await listen<DepInstallProgressEvent>('dep-install-progress', (event) => {
      const { name, status, outputLine, error } = event.payload
      const state = get()

      if (status === 'started') {
        set({ currentInstalling: name })
      } else if (status === 'installing' && outputLine) {
        const currentOutput = state.installOutput[name] || []
        set({
          installOutput: {
            ...state.installOutput,
            [name]: [...currentOutput, outputLine],
          },
        })
      } else if (status === 'done') {
        set({
          installResults: {
            ...state.installResults,
            [name]: { success: true },
          },
        })
      } else if (status === 'failed') {
        set({
          installResults: {
            ...state.installResults,
            [name]: { success: false, error: error ?? 'Installation failed' },
          },
        })
      }
    })

    // Install each dependency serially
    try {
      for (const name of sorted) {
        try {
          await invoke<boolean>('install_dependency', { name })
        } catch (err) {
          console.error(`[DepsStore] Failed to install ${name}:`, err)
          const state = get()
          set({
            installResults: {
              ...state.installResults,
              [name]: { success: false, error: String(err) },
            },
          })
        }
      }
    } finally {
      unlisten()
      set({ installing: false, currentInstalling: null })
    }
  },

  updateDependency: async (name: string) => {
    if (!isTauri()) return

    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')

    set({
      installing: true,
      installQueue: [name],
      installResults: { [name]: { success: false } },
      installOutput: { [name]: [] },
      currentInstalling: name,
      lastOperation: 'update',
    })

    const unlisten = await listen<DepInstallProgressEvent>('dep-install-progress', (event) => {
      const { name: evName, status, outputLine, error } = event.payload
      const state = get()
      if (status === 'started') {
        set({ currentInstalling: evName })
      } else if (status === 'installing' && outputLine) {
        const currentOutput = state.installOutput[evName] || []
        set({ installOutput: { ...state.installOutput, [evName]: [...currentOutput, outputLine] } })
      } else if (status === 'done') {
        set({ installResults: { ...state.installResults, [evName]: { success: true } } })
      } else if (status === 'failed') {
        set({ installResults: { ...state.installResults, [evName]: { success: false, error: error ?? 'Update failed' } } })
      }
    })

    try {
      await invoke<boolean>('update_dependency', { name })
    } catch (err) {
      console.error(`[DepsStore] Failed to update ${name}:`, err)
      const state = get()
      set({ installResults: { ...state.installResults, [name]: { success: false, error: String(err) } } })
    } finally {
      unlisten()
      set({ installing: false, currentInstalling: null })
    }
  },

  checkVersions: async () => {
    if (!isTauri()) return
    const { invoke } = await import('@tauri-apps/api/core')
    // Independently, not in one command: opencode asks the mirror over the
    // network and pi runs `amuxd doctor`, so neither is free and a slow one
    // must not blank the other's row. (`doctor` is offline but not cheap — it
    // spawns the sidecar, ~4s on a cold first launch.) Unknown is a valid
    // state; the UI keeps offering the update rather than claiming currency.
    await Promise.all(
      (['opencode', 'pi'] as const).map(async (name) => {
        try {
          const result = await invoke<DependencyVersions>(`${name}_versions`)
          set((s) => ({ versions: { ...s.versions, [name]: result } }))
        } catch (err) {
          console.warn(`[DepsStore] ${name} version check failed:`, err)
          set((s) => {
            const { [name]: _dropped, ...rest } = s.versions
            return { versions: rest }
          })
        }
      }),
    )
  },

  resetInstallState: () => {
    set({
      installing: false,
      currentInstalling: null,
      installQueue: [],
      installResults: {},
      installOutput: {},
      lastOperation: null,
    })
  },
}))
