import { describe, it, expect, vi, beforeEach } from 'vitest'

// The local Agent switch (#1678): amuxd is bundled but only started once the
// local Agent is enabled. Same harness shape as daemon-onboarding-steps.test.ts,
// plus the switch itself (`local_agent_*`) and the two defaults.
const h = vi.hoisted(() => ({
  currentTeam: { id: 'team-1' } as { id: string } | null,
  daemonTeam: null as string | null,
  deviceId: 'device-1' as string | null,
  deviceAgents: new Map<string, string>(),
  localAgentEnabled: false,
  effectiveDefault: null as string | null,
  effectiveThrows: false,
  initShouldThrow: false,
  memberDefault: null as string | null,
  setDefaultCalls: [] as Array<string | null>,
  invokeCalls: [] as string[],
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    actors: {
      getEffectiveDefaultAgent: vi.fn(async () => {
        if (h.effectiveThrows) throw new Error('network down')
        return h.effectiveDefault
      }),
      findAgentForDevice: vi.fn(async (input: Record<string, unknown>) => {
        const agentId = h.deviceAgents.get(`${input.teamId}:${input.deviceId}`) ?? null
        return { agentId, displayName: agentId ? 'Existing robot' : null }
      }),
      ensureAgentForDevice: vi.fn(async (input: Record<string, unknown>) => {
        const key = `${input.teamId}:${input.deviceId}`
        const agentId = h.deviceAgents.get(key) ?? `agent-${input.teamId}`
        h.deviceAgents.set(key, agentId)
        return { agentId, token: 'invite-token', expiresAt: null, created: false }
      }),
    },
  }),
}))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: h.currentTeam, currentMember: { id: 'member-1' } }) },
}))
vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  createDaemonWorkspace: vi.fn(async () => ({ id: 'ws-1' })),
  getCurrentDaemonWorkspaceAgent: vi.fn(async () => ({ defaultWorkspaceId: 'ws-already' })),
  setAgentDefaultWorkspace: vi.fn(async () => {}),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ session: { user: { id: 'user-1' } } }) },
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ workspacePath: null, setDaemonHttpReady: () => {} }) },
}))
vi.mock('@/stores/member-preferences-store', () => ({
  useMemberPreferencesStore: {
    getState: () => ({
      ensureLoaded: async () => {},
      get defaultAgentId() {
        return h.memberDefault
      },
      setDefaultAgent: async (_team: string, agentId: string | null) => {
        h.setDefaultCalls.push(agentId)
        h.memberDefault = agentId
      },
      loadEffectiveDefaultAgent: async () => {},
    }),
  },
}))
vi.mock('@/lib/daemon/daemon-local-client', () => ({
  invalidateDaemonConnection: vi.fn(),
  probeDaemonHttp: vi.fn(async () => ({ ok: h.localAgentEnabled && !!h.daemonTeam })),
  fetchDaemonCloudAuthStatus: vi.fn(async () => 'ok'),
  fetchDaemonDeviceId: vi.fn(async () => (h.localAgentEnabled ? h.deviceId : null)),
}))
vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonActorId: vi.fn(async () =>
    h.localAgentEnabled && h.daemonTeam ? h.deviceAgents.get(`${h.daemonTeam}:${h.deviceId}`) ?? null : null,
  ),
}))
vi.mock('@/lib/daemon/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => 'agent-team-1',
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    h.invokeCalls.push(cmd)
    switch (cmd) {
      case 'local_agent_enabled':
        return h.localAgentEnabled
      case 'local_agent_enable':
        h.localAgentEnabled = true
        return undefined
      case 'local_agent_disable':
        h.localAgentEnabled = false
        return undefined
      case 'setup_list_requirements':
        return [
          { id: 'amuxd', title: 'amuxd', optional: false, present: true, version: '1.0.0' },
          { id: 'node', title: 'Node.js', optional: false, present: true, version: '24.20.0' },
          { id: 'pi', title: 'Pi', optional: false, present: true, version: '1.1.0' },
        ]
      case 'get_daemon_team_id':
        return h.daemonTeam
      case 'daemon_init':
        if (h.initShouldThrow) throw new Error('init boom')
        h.daemonTeam = h.currentTeam?.id ?? null
        return { actorId: h.deviceAgents.get(`${h.daemonTeam}:${h.deviceId}`), teamId: h.daemonTeam }
      default:
        return undefined
    }
  }),
}))

import { useDaemonOnboardingStore } from '../daemon-onboarding'

const daemonCommands = ['daemon_ensure_running', 'daemon_restart_managed', 'daemon_init']

beforeEach(() => {
  h.currentTeam = { id: 'team-1' }
  h.daemonTeam = null
  h.deviceId = 'device-1'
  h.deviceAgents = new Map([['team-1:device-1', 'agent-team-1']])
  h.localAgentEnabled = false
  h.effectiveDefault = null
  h.effectiveThrows = false
  h.initShouldThrow = false
  h.memberDefault = null
  h.setDefaultCalls = []
  h.invokeCalls = []
  localStorage.clear()
  useDaemonOnboardingStore.setState({
    status: 'unknown',
    enabled: null,
    retryEnable: null,
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
  })
})

describe('local Agent switch', () => {
  it('enters a team that has a default without touching the daemon', async () => {
    h.effectiveDefault = 'agent-remote'
    await useDaemonOnboardingStore.getState().refresh()
    const s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('disabled')
    expect(s.enabled).toBe(false)
    for (const cmd of [...daemonCommands, 'local_agent_enable', 'setup_list_requirements']) {
      expect(h.invokeCalls).not.toContain(cmd)
    }
  })

  it('never reads a failed defaults lookup as "no default"', async () => {
    h.effectiveThrows = true
    await useDaemonOnboardingStore.getState().refresh()
    const s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('defaults-error')
    expect(s.error).toContain('network down')
    expect(h.invokeCalls).not.toContain('local_agent_enable')
    // Retrying once the network is back decides normally.
    h.effectiveThrows = false
    h.effectiveDefault = 'agent-remote'
    await useDaemonOnboardingStore.getState().retry()
    expect(useDaemonOnboardingStore.getState().status).toBe('disabled')
  })

  it('enables, binds and adopts the member default when neither default exists', async () => {
    await useDaemonOnboardingStore.getState().refresh()
    const s = useDaemonOnboardingStore.getState()
    expect(h.invokeCalls).toContain('local_agent_enable')
    expect(h.invokeCalls).toContain('daemon_init')
    expect(s.status).toBe('ready')
    expect(s.enabled).toBe(true)
    expect(h.setDefaultCalls).toEqual(['agent-team-1'])
  })

  it('leaves the member default alone when a feature enables the local Agent', async () => {
    h.effectiveDefault = 'agent-remote'
    h.memberDefault = 'agent-remote'
    await useDaemonOnboardingStore.getState().refresh()
    await useDaemonOnboardingStore.getState().enable()
    expect(useDaemonOnboardingStore.getState().status).toBe('ready')
    expect(h.invokeCalls).toContain('daemon_init')
    expect(h.setDefaultCalls).toEqual([])
    expect(h.memberDefault).toBe('agent-remote')
  })

  it('does not rewrite the member default when an enabled machine rebinds', async () => {
    h.localAgentEnabled = true
    h.daemonTeam = 'team-0'
    h.memberDefault = 'agent-remote'
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().status).toBe('ready')
    expect(h.invokeCalls).toContain('daemon_init')
    expect(h.setDefaultCalls).toEqual([])
  })

  it('switches a failed enable back off and retries it as an enable', async () => {
    h.initShouldThrow = true
    await useDaemonOnboardingStore.getState().refresh()
    let s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('error')
    expect(h.invokeCalls).toContain('local_agent_disable')
    expect(s.enabled).toBe(false)
    expect(s.retryEnable).toEqual({ adopt: true })

    h.initShouldThrow = false
    await useDaemonOnboardingStore.getState().retry()
    s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('ready')
    expect(s.retryEnable).toBeNull()
    expect(h.setDefaultCalls).toEqual(['agent-team-1'])
  })

  it('does not switch off a machine that was enabled before a failed rebind', async () => {
    h.localAgentEnabled = true
    h.daemonTeam = 'team-0'
    h.initShouldThrow = true
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().status).toBe('error')
    expect(h.invokeCalls).not.toContain('local_agent_disable')
    expect(h.localAgentEnabled).toBe(true)
  })

  it('binds once when the gate and the wizard refresh at the same time', async () => {
    await Promise.all([
      useDaemonOnboardingStore.getState().refresh(),
      useDaemonOnboardingStore.getState().refresh(),
    ])
    expect(h.invokeCalls.filter((c) => c === 'daemon_init')).toHaveLength(1)
    expect(h.invokeCalls.filter((c) => c === 'local_agent_enable')).toHaveLength(1)
  })

  it('disable stops the daemon and clears a member default pointing at it', async () => {
    h.localAgentEnabled = true
    h.daemonTeam = 'team-1'
    h.memberDefault = 'agent-team-1'
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().status).toBe('ready')

    await useDaemonOnboardingStore.getState().disable()
    const s = useDaemonOnboardingStore.getState()
    expect(h.invokeCalls).toContain('local_agent_disable')
    expect(s.status).toBe('disabled')
    expect(s.enabled).toBe(false)
    expect(h.setDefaultCalls).toEqual([null])
  })

  it('disable keeps a member default that points elsewhere', async () => {
    h.localAgentEnabled = true
    h.daemonTeam = 'team-1'
    h.memberDefault = 'agent-remote'
    await useDaemonOnboardingStore.getState().disable()
    expect(h.setDefaultCalls).toEqual([])
  })
})
