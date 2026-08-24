import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted, mutable test state shared with the module mocks below.
const h = vi.hoisted(() => ({
  isTauriVal: true,
  currentTeam: { id: 't1' } as { id: string } | null,
  cloudAuthStatus: 'ok' as 'ok' | 'expired' | 'unknown',
  localActorId: 'actor-1' as string | null,
  deviceId: 'device-1' as string | null,
  foundAgentId: 'actor-1' as string | null,
  invokeCalls: [] as string[],
  ensureCalls: [] as Array<Record<string, unknown>>,
  installServiceShouldThrow: false,
  restartManagedShouldThrow: false,
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => h.isTauriVal }))
vi.mock('@/lib/startup-perf', () => ({ markStartup: vi.fn() }))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: h.currentTeam }) },
}))
vi.mock('@/stores/member-preferences-store', () => ({
  useMemberPreferencesStore: {
    getState: () => ({
      ensureLoaded: vi.fn(async () => {}),
      defaultAgentId: 'someone',
      setDefaultAgent: vi.fn(async () => {}),
    }),
  },
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ workspacePath: '/home/u/.amuxd/teams/t1' }) },
}))
vi.mock('@/lib/daemon-local-client', () => ({
  invalidateDaemonConnection: vi.fn(),
  probeDaemonHttp: vi.fn(async () => ({ ok: true, baseUrl: 'http://127.0.0.1:1' })),
  fetchDaemonCloudAuthStatus: vi.fn(async () => h.cloudAuthStatus),
  fetchDaemonDeviceId: vi.fn(async () => h.deviceId),
}))
vi.mock('@/lib/daemon-agent-admin', () => ({
  getLocalDaemonActorId: vi.fn(async () => h.localActorId),
}))
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    actors: {
      // Heal always runs on a machine that is already bound, so the lookup finds
      // its agent and the rotation is silent.
      findAgentForDevice: vi.fn(async () => ({
        agentId: h.foundAgentId,
        displayName: h.foundAgentId ? 'Build Bot' : null,
      })),
      ensureAgentForDevice: vi.fn(async (input: Record<string, unknown>) => {
        h.ensureCalls.push(input)
        return { agentId: 'actor-1', token: 'tok-123', expiresAt: null, created: false }
      }),
    },
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    h.invokeCalls.push(cmd)
    if (cmd === 'get_daemon_team_id') return 't1'
    if (cmd === 'daemon_init') {
      // Re-onboard rewrites credentials; managed restart reloads backend.toml.
      h.cloudAuthStatus = 'ok'
      return { actorId: 'actor-1', teamId: 't1' }
    }
    if (cmd === 'daemon_restart_managed' && h.restartManagedShouldThrow) {
      throw new Error('managed amuxd restart failed')
    }
    return undefined
  }),
}))

import { useDaemonOnboardingStore } from '../daemon-onboarding'

const reset = () =>
  useDaemonOnboardingStore.setState({
    status: 'ready',
    loaded: true,
    busy: false,
    error: null,
    cloudAuthExpired: false,
    healing: false,
    healError: null,
  })

beforeEach(() => {
  h.isTauriVal = true
  h.currentTeam = { id: 't1' }
  h.cloudAuthStatus = 'ok'
  h.localActorId = 'actor-1'
  h.deviceId = 'device-1'
  h.foundAgentId = 'actor-1'
  h.invokeCalls = []
  h.ensureCalls = []
  h.installServiceShouldThrow = false
  h.restartManagedShouldThrow = false
  reset()
})

describe('daemon-onboarding checkCloudSession + autoHealCloudSession', () => {
  it('healthy session: no banner, no re-onboard', async () => {
    h.cloudAuthStatus = 'ok'
    await useDaemonOnboardingStore.getState().checkCloudSession()
    const s = useDaemonOnboardingStore.getState()
    expect(s.cloudAuthExpired).toBe(false)
    expect(h.invokeCalls).not.toContain('daemon_init')
  })

  it('unknown (older daemon / transient) is treated as healthy', async () => {
    h.cloudAuthStatus = 'unknown'
    await useDaemonOnboardingStore.getState().checkCloudSession()
    expect(useDaemonOnboardingStore.getState().cloudAuthExpired).toBe(false)
    expect(h.invokeCalls).not.toContain('daemon_init')
  })

  it('expired: re-binds this machine by device id and clears the flag', async () => {
    h.cloudAuthStatus = 'expired'
    await useDaemonOnboardingStore.getState().checkCloudSession()
    const s = useDaemonOnboardingStore.getState()
    // Keyed on (team, device), so this lands on the actor the daemon is already
    // running as — a rotation, not a new agent.
    expect(h.ensureCalls).toHaveLength(1)
    expect(h.ensureCalls[0]).toMatchObject({ teamId: 't1', deviceId: 'device-1' })
    // amuxd init + managed restart (reload backend.toml).
    expect(h.invokeCalls).toContain('daemon_init')
    expect(h.invokeCalls).toContain('daemon_restart_managed')
    expect(s.cloudAuthExpired).toBe(false)
    expect(s.healError).toBeNull()
  })

  it('heal fails when managed restart fails (no ensure_running fallback)', async () => {
    // Credentials may be on disk, but the running daemon may still hold the
    // old identity. ensure_running would no-op on a healthy stale daemon and
    // fake success, so restart failure must surface as heal failure directly.
    h.cloudAuthStatus = 'expired'
    h.restartManagedShouldThrow = true
    await useDaemonOnboardingStore.getState().checkCloudSession()
    const s = useDaemonOnboardingStore.getState()
    expect(h.invokeCalls).toContain('daemon_init')
    expect(h.invokeCalls).toContain('daemon_restart_managed')
    expect(h.invokeCalls).not.toContain('daemon_ensure_running')
    expect(s.healError).toBeTruthy()
  })

  it('no ownership pre-check: the old "only the owner can reconnect" dead end is gone', async () => {
    // The client used to list owned agents and refuse to heal when the daemon's
    // actor was not in it — a guess at what create_team_invite enforces, and a
    // dead end for the user. The owner-scoped lookup decides instead.
    h.cloudAuthStatus = 'expired'
    await useDaemonOnboardingStore.getState().checkCloudSession()
    const s = useDaemonOnboardingStore.getState()
    expect(s.healError).toBeNull()
    expect(h.invokeCalls).toContain('daemon_init')
  })

  it('heal on a machine whose agent belongs to another account asks for a name', async () => {
    // Owner-scoped lookup comes back empty. Rather than the old dead-end error,
    // this account names its own agent — and the heal hands off to that screen
    // instead of reporting a failure.
    h.cloudAuthStatus = 'expired'
    h.foundAgentId = null
    await useDaemonOnboardingStore.getState().checkCloudSession()
    const s = useDaemonOnboardingStore.getState()
    expect(s.pendingName).not.toBeNull()
    expect(s.healError).toBeNull()
    expect(h.ensureCalls).toHaveLength(0)
    expect(h.invokeCalls).not.toContain('daemon_init')
  })

  it('does not auto-retry once a heal has failed (healError latched)', async () => {
    h.cloudAuthStatus = 'expired'
    h.deviceId = null // bind cannot start → heal fails
    await useDaemonOnboardingStore.getState().checkCloudSession()
    expect(useDaemonOnboardingStore.getState().healError).toBeTruthy()
    h.ensureCalls = []
    h.invokeCalls = []
    // A second probe must NOT kick off another automatic attempt.
    await useDaemonOnboardingStore.getState().checkCloudSession()
    expect(h.ensureCalls).toHaveLength(0)
    expect(h.invokeCalls).not.toContain('daemon_init')
  })
})
