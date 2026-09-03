import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
// Derived from `buildConfig.app.name`, so it is brand- and config-dependent —
// a local run bakes in build.config.dev.json and gets `~/TeamClu Dev`. These
// tests are about "falls back to the default workspace", not about which brand
// is being built, so they assert the constant rather than a literal.
import { DEFAULT_WORKSPACE_PATH } from '@/lib/build-config'

// --- Hoist mocks ---
const {
  mockSetWorkspace,
  mockSetWorkspaceBootstrapped,
  mockSetWorkspaceReady,
  mockIsTauri,
  mockExists,
  mockInvoke,
  mockListen,
  mockLoadCurrentNodeId,
  mockLoadMembers,
  mockHydrateFromCache,
  mockLoadPersonal,
  mockLoadTeamForCurrentTeam,
  mockTelemetryInit,
  mockWorkspaceCapable,
} = vi.hoisted(() => ({
  mockSetWorkspace: vi.fn(),
  mockSetWorkspaceBootstrapped: vi.fn(),
  mockSetWorkspaceReady: vi.fn(),
  mockIsTauri: vi.fn(() => false),
  mockExists: vi.fn(),
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
  mockLoadCurrentNodeId: vi.fn(),
  mockLoadMembers: vi.fn(),
  mockHydrateFromCache: vi.fn(),
  mockLoadPersonal: vi.fn(),
  mockLoadTeamForCurrentTeam: vi.fn(),
  mockTelemetryInit: vi.fn(),
  mockWorkspaceCapable: { value: true },
}))

vi.mock('@/lib/utils', () => ({
  isTauri: mockIsTauri,
  openExternalUrl: vi.fn(),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/platform', () => ({
  capabilities: {
    get workspace() {
      return mockWorkspaceCapable.value
    },
  },
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mockExists,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}))

const workspaceState = {
  workspacePath: null as string | null,
  setWorkspace: mockSetWorkspace,
  setWorkspaceBootstrapped: mockSetWorkspaceBootstrapped,
  setWorkspaceReady: mockSetWorkspaceReady,
  // useAppInit selects these runtime-readiness actions; the daemon-control
  // migration replaced OpenCode lifecycle selectors with these.
  setOpenCodeBootstrapped: vi.fn(),
  setOpenCodeReady: vi.fn(),
  setDaemonHttpReady: vi.fn(),
  daemonHttpReady: false,
  workspaceBootstrapped: false,
  workspaceReady: false,
  openPanel: vi.fn(),
  closePanel: vi.fn(),
}

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector(workspaceState as unknown as Record<string, unknown>),
    { getState: () => workspaceState },
  ),
  // Mirrors the real export; the restore path reads/clears localStorage
  // through it, and omitting it made every restore throw and silently fall
  // back to the default workspace.
  WORKSPACE_STORAGE_KEY: 'teamclu-workspace-path',
}))

const teamModeState = {
  teamModeType: null as string | null,
  setState: vi.fn(),
}

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector(teamModeState as unknown as Record<string, unknown>),
    {
      getState: () => teamModeState,
      setState: teamModeState.setState,
    },
  ),
}))

vi.mock('@/stores/daemon-onboarding', () => ({
  useDaemonOnboardingStore: (selector: (s: { status: string }) => unknown) =>
    selector({ status: 'ready' }),
}))

vi.mock('@/lib/daemon-local-client', () => ({
  probeDaemonHttp: vi.fn(async () => ({ ok: true, baseUrl: 'http://127.0.0.1:1' })),
  invalidateDaemonConnection: vi.fn(),
}))

vi.mock('@/stores/channels-store', () => ({
  useChannelsStore: () => ({
    autoStartEnabledGateways: vi.fn(),
    loadConfig: vi.fn().mockResolvedValue(undefined),
    stopAllAndReset: vi.fn().mockResolvedValue(undefined),
    keepAliveCheck: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/stores/git-repos', () => ({
  useGitReposStore: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    syncAll: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/stores/team-members', () => ({
  useTeamMembersStore: {
    getState: () => ({
      loadCurrentNodeId: mockLoadCurrentNodeId,
      loadMembers: mockLoadMembers,
    }),
  },
}))

vi.mock('@/stores/shortcuts', () => ({
  useShortcutsStore: {
    getState: () => ({
      hydrateFromCache: mockHydrateFromCache,
      loadPersonal: mockLoadPersonal,
      loadTeamForCurrentTeam: mockLoadTeamForCurrentTeam,
    }),
  },
}))

const currentTeamState = {
  team: null as { id: string } | null,
}

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => currentTeamState,
  },
}))

const uiState = {
  layoutMode: 'task' as const,
  embedMode: false,
  toggleLayoutMode: vi.fn(),
}

const telemetryState = {
  consent: 'undecided' as 'undecided' | 'granted' | 'denied',
  init: mockTelemetryInit,
  isInitialized: false,
}

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(uiState as unknown as Record<string, unknown>),
}))

vi.mock('@/stores/deps', () => ({
  useDepsStore: () => ({
    dependencies: [],
    checked: false,
    checkDependencies: vi.fn().mockResolvedValue([]),
  }),
}))

vi.mock('@/stores/telemetry', () => ({
  useTelemetryStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(telemetryState as unknown as Record<string, unknown>),
}))



beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  mockIsTauri.mockReturnValue(false)
  mockWorkspaceCapable.value = true
  mockExists.mockResolvedValue(true)
  mockInvoke.mockResolvedValue(null)
  mockListen.mockResolvedValue(vi.fn())
  mockLoadCurrentNodeId.mockResolvedValue(undefined)
  mockLoadMembers.mockResolvedValue(undefined)
  mockHydrateFromCache.mockResolvedValue(undefined)
  mockLoadPersonal.mockResolvedValue(undefined)
  mockLoadTeamForCurrentTeam.mockResolvedValue(undefined)
  workspaceState.workspacePath = null
  workspaceState.workspaceBootstrapped = false
  workspaceState.workspaceReady = false
  teamModeState.teamModeType = null
  teamModeState.setState.mockClear()
  currentTeamState.team = null
  uiState.embedMode = false
  telemetryState.consent = 'undecided'
  telemetryState.isInitialized = false
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useWorkspaceInit', () => {
  it('skips workspace restore on extension/web (no local workspace)', async () => {
    mockWorkspaceCapable.value = false

    const { useWorkspaceInit } = await import('@/hooks/use-workspace-init')
    const { result } = renderHook(() => useWorkspaceInit())

    await waitFor(() => {
      expect(result.current.initialWorkspaceResolved).toBe(true)
    })
    expect(mockSetWorkspace).not.toHaveBeenCalled()
  })

  it('restores the last workspace when one is saved', async () => {
    localStorage.setItem('teamclu-workspace-path', '/tmp/teamclu-last')

    const { useWorkspaceInit } = await import('@/hooks/use-workspace-init')
    const { result } = renderHook(() => useWorkspaceInit())

    await waitFor(() => {
      expect(mockSetWorkspace).toHaveBeenCalledWith('/tmp/teamclu-last')
      expect(result.current.initialWorkspaceResolved).toBe(true)
    })
  })

  it('clears a saved workspace when it no longer exists in Tauri and falls back to default', async () => {
    mockIsTauri.mockReturnValue(true)
    mockExists.mockResolvedValue(false)
    localStorage.setItem('teamclu-workspace-path', '/tmp/missing-workspace')

    const { useWorkspaceInit } = await import('@/hooks/use-workspace-init')
    const { result } = renderHook(() => useWorkspaceInit())

    await waitFor(() => {
      expect(localStorage.getItem('teamclu-workspace-path')).toBeNull()
      expect(result.current.initialWorkspaceResolved).toBe(true)
    })
    expect(mockSetWorkspace).toHaveBeenCalledWith(DEFAULT_WORKSPACE_PATH)
  })

  it('uses the default workspace when nothing is saved', async () => {
    const { useWorkspaceInit } = await import('@/hooks/use-workspace-init')
    const { result } = renderHook(() => useWorkspaceInit())

    await waitFor(() => {
      expect(result.current.initialWorkspaceResolved).toBe(true)
    })
    expect(mockSetWorkspace).toHaveBeenCalledWith(DEFAULT_WORKSPACE_PATH)
  })

  it('uses the default workspace on first launch even when a team is known', async () => {
    mockIsTauri.mockReturnValue(true)
    currentTeamState.team = { id: 'team-xyz' }

    const { useWorkspaceInit } = await import('@/hooks/use-workspace-init')
    const { result } = renderHook(() => useWorkspaceInit())

    await waitFor(() => {
      expect(result.current.initialWorkspaceResolved).toBe(true)
    })
    expect(mockSetWorkspace).toHaveBeenCalledWith(DEFAULT_WORKSPACE_PATH)
  })

  it('uses the default workspace on first launch in Tauri when no team is known', async () => {
    mockIsTauri.mockReturnValue(true)
    currentTeamState.team = null

    const { useWorkspaceInit } = await import('@/hooks/use-workspace-init')
    const { result } = renderHook(() => useWorkspaceInit())

    await waitFor(() => {
      expect(result.current.initialWorkspaceResolved).toBe(true)
    })
    expect(mockSetWorkspace).toHaveBeenCalledWith(DEFAULT_WORKSPACE_PATH)
  })
})

describe('useTauriBodyClass', () => {
  it('does not add tauri class in non-Tauri environment', async () => {
    const { useTauriBodyClass } = await import('@/hooks/use-tauri-body-class')
    renderHook(() => useTauriBodyClass())
    expect(document.documentElement.classList.contains('tauri')).toBe(false)
  })
})

describe('useTelemetryConsent', () => {
  it('initializes telemetry on mount', async () => {
    const { useTelemetryConsent } = await import('@/hooks/use-telemetry-consent')
    renderHook(() => useTelemetryConsent(false))
    expect(mockTelemetryInit).toHaveBeenCalled()
  })

  it('opens consent dialog on desktop when setup is done and consent is undecided', async () => {
    telemetryState.isInitialized = true
    const { useTelemetryConsent } = await import('@/hooks/use-telemetry-consent')
    const { result } = renderHook(() => useTelemetryConsent(false))
    await waitFor(() => {
      expect(result.current.showConsentDialog).toBe(true)
    })
  })

  it('skips consent dialog in embed mode', async () => {
    uiState.embedMode = true
    telemetryState.isInitialized = true
    const { useTelemetryConsent } = await import('@/hooks/use-telemetry-consent')
    const { result } = renderHook(() => useTelemetryConsent(false))
    await waitFor(() => {
      expect(result.current.showConsentDialog).toBe(false)
    })
  })
})

describe('useGitReposInit', () => {
  it('loads current node id at startup', async () => {
    mockIsTauri.mockReturnValue(true)
    workspaceState.workspacePath = '/workspace-team'
    workspaceState.workspaceReady = true

    const { useGitReposInit } = await import('@/hooks/use-git-repos-init')
    renderHook(() => useGitReposInit())

    await waitFor(() => {
      expect(mockLoadCurrentNodeId).toHaveBeenCalled()
    })
  })
})
