import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mirrors the harness in daemon-onboarding-refresh.test.ts, trimmed to what the
// step model needs. Binding is silent now, so the step trail is driven through
// `refresh` (machine already known to the team) and `nameDeviceAgent` (the one
// path that still asks the user something) rather than a wizard action.
const h = vi.hoisted(() => ({
  currentTeam: { id: 'team-1' } as { id: string } | null,
  daemonTeam: null as string | null,
  deviceId: 'device-1' as string | null,
  // (team, device) → agent. Seeded means "the team already knows this machine",
  // which is what makes `refresh` bind without prompting.
  deviceAgents: new Map<string, string>(),
  probeOk: true,
  ensureShouldThrow: false,
  initShouldThrow: false,
  registerShouldThrow: false,
  invokeCalls: [] as string[],
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    actors: {
      findAgentForDevice: vi.fn(async (input: Record<string, unknown>) => {
        const agentId = h.deviceAgents.get(`${input.teamId}:${input.deviceId}`) ?? null
        return { agentId, displayName: agentId ? 'Existing robot' : null }
      }),
      ensureAgentForDevice: vi.fn(async (input: Record<string, unknown>) => {
        if (h.ensureShouldThrow) throw new Error('ensure boom')
        const key = `${input.teamId}:${input.deviceId}`
        const existing = h.deviceAgents.get(key)
        const agentId = existing ?? `agent-for-${input.deviceId}-in-${input.teamId}`
        if (!existing) h.deviceAgents.set(key, agentId)
        return { agentId, token: 'invite-token', expiresAt: null, created: !existing }
      }),
    },
  }),
}))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: h.currentTeam, currentMember: { id: 'member-1' } }) },
}))
vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  createDaemonWorkspace: vi.fn(async (input: { path: string; name: string }) => ({
    id: 'ws-1',
    teamId: 'team-1',
    agentId: 'actor-1',
    createdByMemberId: 'member-1',
    name: input.name,
    path: input.path,
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  })),
  getCurrentDaemonWorkspaceAgent: vi.fn(async () => ({
    id: 'actor-1',
    displayName: 'Local',
    agentTypes: [],
    defaultAgentType: null,
    defaultWorkspaceId: 'ws-already',
    status: 'online',
    lastActiveAt: null,
  })),
  setAgentDefaultWorkspace: vi.fn(async () => {}),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ session: { user: { id: 'user-1' } } }) },
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ workspacePath: '/home/u/app' }) },
}))
vi.mock('@/stores/member-preferences-store', () => ({
  useMemberPreferencesStore: {
    getState: () => ({
      ensureLoaded: async () => {},
      defaultAgentId: 'already-set',
      setDefaultAgent: async () => {},
    }),
  },
}))
vi.mock('@/lib/daemon/daemon-local-client', () => ({
  invalidateDaemonConnection: vi.fn(),
  probeDaemonHttp: vi.fn(async () => ({ ok: h.probeOk, reason: 'not_running' })),
  fetchDaemonCloudAuthStatus: vi.fn(async () => 'ok'),
  fetchDaemonDeviceId: vi.fn(async () => h.deviceId),
}))
vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonActorId: vi.fn(async () => 'actor-1'),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    h.invokeCalls.push(cmd)
    if (cmd === 'get_daemon_team_id') return h.daemonTeam
    if (cmd === 'get_device_hostname') return 'test-host'
    if (cmd === 'daemon_init') {
      if (h.initShouldThrow) throw new Error('init boom')
      h.daemonTeam = h.currentTeam?.id ?? null
      return { actorId: h.deviceAgents.get(`${h.daemonTeam}:${h.deviceId}`), teamId: h.daemonTeam }
    }
    if (cmd === 'register_daemon_workspace' && h.registerShouldThrow) {
      throw new Error('register boom')
    }
    return undefined
  }),
}))

import { useDaemonOnboardingStore } from '../daemon-onboarding'

beforeEach(() => {
  h.currentTeam = { id: 'team-1' }
  h.daemonTeam = null
  h.deviceId = 'device-1'
  h.deviceAgents = new Map([['team-1:device-1', 'agent-1']])
  h.probeOk = true
  h.ensureShouldThrow = false
  h.initShouldThrow = false
  h.registerShouldThrow = false
  h.invokeCalls = []
  localStorage.clear()
  useDaemonOnboardingStore.setState({
    status: 'unknown',
    loaded: false,
    busy: false,
    error: null,
    cloudAuthExpired: false,
    healing: false,
    healError: null,
    step: null,
    completedSteps: [],
    failedStep: null,
    runStartedAt: null,
    completedAgent: null,
    pendingName: null,
    workspaceSyncEpoch: 0,
  })
})

describe('daemon-onboarding step model', () => {
  it('records the steps a silent bind walks through', async () => {
    await useDaemonOnboardingStore.getState().refresh()
    const { completedSteps, step, failedStep } = useDaemonOnboardingStore.getState()
    expect(completedSteps.slice(0, 3)).toEqual(['mint-invite', 'init-daemon', 'restart-daemon'])
    // Nothing left in flight, and nothing blamed.
    expect(step).toBeNull()
    expect(failedStep).toBeNull()
  })

  it('names the step that failed', async () => {
    h.initShouldThrow = true
    await useDaemonOnboardingStore.getState().refresh()
    const s = useDaemonOnboardingStore.getState()
    expect(s.failedStep).toBe('init-daemon')
    expect(s.completedSteps).toEqual(['mint-invite'])
    expect(s.error).toContain('init boom')
  })

  it('blames the first failing step, not a later one', async () => {
    h.ensureShouldThrow = true
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().failedStep).toBe('mint-invite')
    expect(useDaemonOnboardingStore.getState().completedSteps).toEqual([])
    // It never got as far as touching the daemon.
    expect(h.invokeCalls).not.toContain('daemon_init')
  })

  it('clears the previous run before starting another', async () => {
    h.initShouldThrow = true
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().failedStep).toBe('init-daemon')

    h.initShouldThrow = false
    await useDaemonOnboardingStore.getState().refresh()
    const s = useDaemonOnboardingStore.getState()
    expect(s.failedStep).toBeNull()
    expect(s.completedSteps.filter((x) => x === 'mint-invite')).toHaveLength(1)
  })

  it('remembers which agent was named so the wizard can confirm it', async () => {
    // A machine the team has never seen: the lookup comes back empty, so the
    // name the user types is the one thing binding waits for.
    h.deviceAgents = new Map()
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().pendingName).toMatchObject({
      teamId: 'team-1',
      deviceId: 'device-1',
    })

    await useDaemonOnboardingStore.getState().nameDeviceAgent('Mac mini')
    expect(useDaemonOnboardingStore.getState().completedAgent).toEqual({
      agentId: 'agent-for-device-1-in-team-1',
      displayName: 'Mac mini',
    })
  })

  // A rebind is silent, so there is no screen to confirm anything to — leaving
  // completedAgent set would make the wizard pause on a machine nobody touched.
  it('does not claim a silent rebind as something the user set up', async () => {
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().completedAgent).toBeNull()
  })

  // Workspace registration is best-effort; a failure there must not present as
  // a failed onboard.
  it('does not blame a step for the best-effort workspace registration', async () => {
    h.registerShouldThrow = true
    await useDaemonOnboardingStore.getState().refresh()
    const s = useDaemonOnboardingStore.getState()
    expect(s.failedStep).toBeNull()
    expect(s.status).toBe('ready')
  })
})
