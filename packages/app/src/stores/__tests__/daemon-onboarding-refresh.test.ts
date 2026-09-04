import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import i18n from '@/lib/i18n'

// Hoisted, mutable test state shared with the module mocks below.
const h = vi.hoisted(() => ({
  isTauriVal: true,
  currentTeam: null as { id: string } | null,
  daemonTeam: null as string | null,
  // Successive probe results; the last entry persists once the queue drains.
  probeQueue: [] as Array<{ ok: boolean; reason?: string; baseUrl?: string }>,
  invokeCalls: [] as string[],
  registerArgs: null as { workspacePath?: string } | null,
  installServiceShouldThrow: false,
  currentUserId: 'user-1' as string | null,
  localActorId: 'actor-1' as string | null,
  // This machine's id as the local daemon reports it. null simulates an
  // unreachable/older daemon, which must fail loudly rather than mint a new id.
  deviceId: 'device-1' as string | null,
  ensureCalls: [] as Array<Record<string, unknown>>,
  // (team, device) → agent, mirroring what the server's unique index guarantees.
  deviceAgents: new Map<string, string>(),
  // `agents.local_agent` as the daemon reports it, plus every write to it.
  daemonLocalAgent: 'opencode' as string,
  localAgentWrites: [] as string[],
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => h.isTauriVal }))
vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/home/u',
  join: async (...parts: string[]) => parts.join('/'),
}))
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    actors: {
      // GET .../agents/for-device — the lookup that decides silent-bind vs prompt.
      findAgentForDevice: vi.fn(async (input: Record<string, unknown>) => {
        const agentId = h.deviceAgents.get(`${input.teamId}:${input.deviceId}`) ?? null
        return { agentId, displayName: agentId ? 'Existing robot' : null }
      }),
      // Stands in for POST /v1/teams/:id/agents/ensure-for-device: idempotent per
      // (team, device), so a second call returns the same agent with created:false.
      ensureAgentForDevice: vi.fn(async (input: Record<string, unknown>) => {
        h.ensureCalls.push(input)
        const key = `${input.teamId}:${input.deviceId}`
        const existing = h.deviceAgents.get(key)
        const agentId = existing ?? `agent-for-${input.deviceId}-in-${input.teamId}`
        if (!existing) h.deviceAgents.set(key, agentId)
        return {
          agentId,
          token: `invite-${h.ensureCalls.length}`,
          expiresAt: null,
          created: !existing,
        }
      }),
    },
  }),
}))
vi.mock('@/stores/member-preferences-store', () => ({
  useMemberPreferencesStore: {
    getState: () => ({
      ensureLoaded: vi.fn(async () => {}),
      defaultAgentId: null,
      setDefaultAgent: vi.fn(async () => {}),
    }),
  },
}))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: h.currentTeam, currentMember: { id: 'member-1' } }) },
}))
vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  createDaemonWorkspace: vi.fn(async (input: { path: string; name: string }) => ({
    id: 'ws-cloud-1',
    teamId: 't1',
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
    defaultWorkspaceId: null,
    status: 'online',
    lastActiveAt: null,
  })),
  setAgentDefaultWorkspace: vi.fn(async () => {}),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ session: h.currentUserId ? { user: { id: h.currentUserId } } : null }) },
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/home/u/projects/app' }),
  },
}))
vi.mock('@/lib/daemon/daemon-local-client', () => ({
  invalidateDaemonConnection: vi.fn(),
  probeDaemonHttp: vi.fn(async () =>
    h.probeQueue.length > 1
      ? h.probeQueue.shift()!
      : (h.probeQueue[0] ?? { ok: false, reason: 'not_running' }),
  ),
  // Default to 'unknown' so the ready path's cloud-session probe is a no-op in
  // these orchestration tests (auto-heal is covered separately).
  fetchDaemonCloudAuthStatus: vi.fn(async () => 'unknown'),
  fetchDaemonDeviceId: vi.fn(async () => h.deviceId),
  getDaemonLocalAgent: vi.fn(async () => h.daemonLocalAgent),
  setDaemonLocalAgent: vi.fn(async (agent: string) => {
    h.daemonLocalAgent = agent
    h.localAgentWrites.push(agent)
    return { requiresRestart: true }
  }),
}))
vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonActorId: vi.fn(async () => h.localActorId),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    h.invokeCalls.push(cmd)
    if (cmd === 'get_daemon_team_id') return h.daemonTeam
    if (cmd === 'get_device_hostname') return 'test-host'
    if (cmd === 'daemon_init') {
      h.daemonTeam = h.currentTeam?.id ?? null
      return { actorId: 'actor-1', teamId: h.daemonTeam }
    }
    if (cmd === 'daemon_ensure_running' || cmd === 'daemon_restart_managed') {
      if (h.installServiceShouldThrow) throw new Error('managed amuxd start boom')
      return undefined
    }
    if (cmd === 'register_daemon_workspace') {
      h.registerArgs = (args ?? null) as { workspacePath?: string } | null
      return { workspace_id: 'ws1', path: (args as { workspacePath?: string })?.workspacePath ?? '', display_name: 't1' }
    }
    return undefined
  }),
}))

import { useDaemonOnboardingStore } from '../daemon-onboarding'
import { useOnboardingStore } from '../onboarding'

const reset = () =>
  useDaemonOnboardingStore.setState({
    status: 'unknown',
    loaded: false,
    busy: false,
    error: null,
    cloudAuthExpired: false,
    healing: false,
    healError: null,
  })

beforeEach(() => {
  h.isTauriVal = true
  h.currentTeam = null
  h.daemonTeam = null
  h.probeQueue = []
  h.invokeCalls = []
  h.registerArgs = null
  h.installServiceShouldThrow = false
  h.currentUserId = 'user-1'
  h.localActorId = 'actor-1'
  h.deviceId = 'device-1'
  h.ensureCalls = []
  h.deviceAgents = new Map()
  h.daemonLocalAgent = 'opencode'
  h.localAgentWrites = []
  localStorage.clear()
  useOnboardingStore.getState().reset()
  reset()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('daemon-onboarding refresh() orchestration', () => {
  it('web (non-tauri) short-circuits to ready', async () => {
    h.isTauriVal = false
    await useDaemonOnboardingStore.getState().refresh()
    const s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('ready')
    expect(s.loaded).toBe(true)
    // No daemon IPC on web.
    expect(h.invokeCalls).toEqual([])
  })

  it('unknown when there is no current team yet (does not block)', async () => {
    h.currentTeam = null
    h.daemonTeam = 't1'
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().status).toBe('unknown')
  })

  it('a machine new to the team asks for a name and writes nothing yet', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = null
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]

    await useDaemonOnboardingStore.getState().refresh()

    const s = useDaemonOnboardingStore.getState()
    expect(s.pendingName).toMatchObject({ teamId: 't1', deviceId: 'device-1', suggested: 'test-host' })
    // Nothing is created until the user answers: abandoning the screen must not
    // leave a half-named agent behind.
    expect(h.ensureCalls).toHaveLength(0)
    expect(h.invokeCalls).not.toContain('daemon_init')
  })

  it('naming the agent creates it under that name and finishes binding', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = null
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]
    await useDaemonOnboardingStore.getState().refresh()

    await useDaemonOnboardingStore.getState().nameDeviceAgent('小助手')

    const s = useDaemonOnboardingStore.getState()
    expect(s.pendingName).toBeNull()
    expect(s.status).toBe('ready')
    expect(h.ensureCalls).toHaveLength(1)
    expect(h.ensureCalls[0]).toMatchObject({ teamId: 't1', deviceId: 'device-1', displayName: '小助手' })
    expect(h.invokeCalls).toContain('daemon_init')
    expect(h.invokeCalls).toContain('daemon_restart_managed')
  })

  // The wizard asks which runtime to use before sign-in, when there is no team
  // to write `agents.local_agent` to. Nothing outside Settings ever wrote that
  // key, so the answer used to be dropped: picking pi still landed on the
  // daemon default.
  // Re-running the wizard on a machine that is already bound is the case most
  // likely to change the runtime, and it never binds again — so hanging this
  // off the bind left exactly that case unapplied.
  it('writes the runtime picked in onboarding without needing a re-bind', async () => {
    useOnboardingStore.getState().setRuntime('pi')
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]

    await useDaemonOnboardingStore.getState().refresh()

    expect(useDaemonOnboardingStore.getState().status).toBe('ready')
    expect(h.invokeCalls).not.toContain('daemon_init')
    expect(h.localAgentWrites).toEqual(['pi'])
    expect(useOnboardingStore.getState().runtime).toBeNull()
  })

  it('writes the runtime picked in onboarding into the team it just bound', async () => {
    useOnboardingStore.getState().setRuntime('pi')
    h.currentTeam = { id: 't1' }
    h.daemonTeam = null
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]
    await useDaemonOnboardingStore.getState().refresh()
    await useDaemonOnboardingStore.getState().nameDeviceAgent('小助手')

    expect(h.localAgentWrites).toEqual(['pi'])
    // Restart-required key: the backend is built once, at daemon start.
    expect(h.invokeCalls.filter((c) => c === 'daemon_restart_managed').length).toBeGreaterThan(1)
    // One shot — a stale pick must never overrule a later choice in Settings.
    expect(useOnboardingStore.getState().runtime).toBeNull()
  })

  it('leaves the runtime alone when the daemon already runs the picked one', async () => {
    useOnboardingStore.getState().setRuntime('opencode')
    h.currentTeam = { id: 't1' }
    h.daemonTeam = null
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]
    await useDaemonOnboardingStore.getState().refresh()
    await useDaemonOnboardingStore.getState().nameDeviceAgent('小助手')

    expect(h.localAgentWrites).toEqual([])
    expect(useOnboardingStore.getState().runtime).toBeNull()
  })

  it('a machine the team already knows binds silently, with no prompt', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't2'
    h.deviceAgents.set('t1:device-1', 'agent-existing')
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]

    await useDaemonOnboardingStore.getState().refresh()

    const s = useDaemonOnboardingStore.getState()
    expect(s.pendingName).toBeNull()
    expect(s.status).toBe('ready')
    expect(h.ensureCalls).toHaveLength(1)
    // Re-binding must not re-send the hostname as a rename — the API treats
    // displayName as create-only, and the client passes the stored name through.
    expect(h.ensureCalls[0]).toMatchObject({ displayName: 'Existing robot' })
    // The old team's agent is left alone — no daemon_clear anywhere.
    expect(h.invokeCalls).not.toContain('daemon_clear')
  })

  it('switching back to a team re-binds that team’s existing agent, not a new one', async () => {
    // Name it in t1, go to t2, come back: the return trip must find the same
    // agent, or every round trip leaves a duplicate and another naming prompt.
    h.currentTeam = { id: 't1' }
    h.daemonTeam = null
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]
    await useDaemonOnboardingStore.getState().refresh()
    await useDaemonOnboardingStore.getState().nameDeviceAgent('t1-robot')
    const firstAgent = h.deviceAgents.get('t1:device-1')

    h.currentTeam = { id: 't2' }
    await useDaemonOnboardingStore.getState().refresh()
    await useDaemonOnboardingStore.getState().nameDeviceAgent('t2-robot')

    h.ensureCalls = []
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't2'
    await useDaemonOnboardingStore.getState().refresh()

    expect(useDaemonOnboardingStore.getState().pendingName).toBeNull()
    expect(h.deviceAgents.get('t1:device-1')).toBe(firstAgent)
    expect(h.deviceAgents.size).toBe(2)
    expect(h.ensureCalls).toHaveLength(1)
  })

  it('waits for a still-booting daemon instead of failing the bind', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = null
    h.deviceId = null // amuxd has not bound its HTTP port yet

    vi.useFakeTimers()
    const p = useDaemonOnboardingStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(600) // one poll tick, still booting
    h.deviceId = 'device-1' // …and now it answers
    await vi.advanceTimersByTimeAsync(600)
    await p

    const s = useDaemonOnboardingStore.getState()
    // Started it rather than assuming it was up, then carried on to the prompt.
    expect(h.invokeCalls).toContain('daemon_ensure_running')
    expect(s.error).toBeNull()
    expect(s.pendingName?.deviceId).toBe('device-1')
  })

  it('fails loudly when the daemon never reports this machine’s id', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = null
    h.deviceId = null

    vi.useFakeTimers()
    const p = useDaemonOnboardingStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(12 * 500 + 100) // drain the start-daemon poll
    await p

    const s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('error')
    // The wait is a named step, so the failure screen can say what broke instead
    // of showing a stepless "can't read this machine's id".
    expect(s.failedStep).toBe('start-daemon')
    expect(h.invokeCalls).toContain('daemon_ensure_running')
    // Never fall back to a locally minted id: that provisions a second agent for
    // a machine that already has one.
    expect(h.ensureCalls).toHaveLength(0)
    expect(s.error).toContain(i18n.t('settings.daemonOnboarding.deviceIdUnavailable'))
  })

  it('ready when team matches and the daemon is already healthy', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().status).toBe('ready')
    // Healthy on first probe → no recovery attempt.
    expect(h.invokeCalls).not.toContain('daemon_ensure_running')
    expect(h.invokeCalls).not.toContain('daemon_restart_managed')
    expect(h.invokeCalls).not.toContain('daemon_install_service')
  })

  it('rebinds when the same team is entered under a different linked user', async () => {
    const { writeDaemonOnboardingIdentity } = await import('@/lib/daemon/daemon-onboarding-identity')
    writeDaemonOnboardingIdentity({ teamId: 't1', userId: 'previous-user' })
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    h.currentUserId = 'linked-user'
    // The lookup is owner-scoped server-side; this account owns one here.
    h.deviceAgents.set('t1:device-1', 'agent-existing')
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]

    await useDaemonOnboardingStore.getState().refresh()

    // Same team, different authority: the daemon must not keep publishing under
    // credentials the previous account minted.
    expect(h.ensureCalls).toHaveLength(1)
    expect(h.invokeCalls).toContain('daemon_init')
    expect(h.invokeCalls).toContain('daemon_restart_managed')
  })

  it('a linked-account switch onto a machine with no agent of its own asks for a name', async () => {
    const { writeDaemonOnboardingIdentity } = await import('@/lib/daemon/daemon-onboarding-identity')
    writeDaemonOnboardingIdentity({ teamId: 't1', userId: 'previous-user' })
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    h.currentUserId = 'linked-user'
    // Owner-scoped lookup finds nothing: the agent on this machine belongs to the
    // other account, and this one names its own rather than taking it over.
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]

    await useDaemonOnboardingStore.getState().refresh()

    expect(useDaemonOnboardingStore.getState().pendingName).not.toBeNull()
    expect(h.ensureCalls).toHaveLength(0)
  })

  it('does not rebind a matching team under the same user', async () => {
    const { writeDaemonOnboardingIdentity } = await import('@/lib/daemon/daemon-onboarding-identity')
    writeDaemonOnboardingIdentity({ teamId: 't1', userId: 'user-1' })
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]

    await useDaemonOnboardingStore.getState().refresh()

    // The common startup path: already bound, already this user. Re-binding here
    // would rotate the daemon's credentials (and restart it) on every launch.
    expect(h.ensureCalls).toHaveLength(0)
    expect(h.invokeCalls).not.toContain('daemon_init')
  })

  it('ready registers the active workspace when it is a real project dir', async () => {
    const { fetchDaemonCloudAuthStatus } = await import('@/lib/daemon/daemon-local-client')
    const { createDaemonWorkspace, setAgentDefaultWorkspace } = await import('@/lib/daemon/daemon-workspaces')
    vi.mocked(fetchDaemonCloudAuthStatus).mockResolvedValue('ok')
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().status).toBe('ready')
    expect(createDaemonWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 't1',
        agentId: 'actor-1',
        path: '/home/u/projects/app',
        name: 'app',
      }),
    )
    expect(setAgentDefaultWorkspace).toHaveBeenCalledWith('actor-1', 'ws-cloud-1')
    expect(h.invokeCalls).toContain('register_daemon_workspace')
    expect(h.registerArgs?.workspacePath).toBe('/home/u/projects/app')
  })

  it('skips local daemon mirror while cloud auth is expired but still registers cloud workspace', async () => {
    const { fetchDaemonCloudAuthStatus } = await import('@/lib/daemon/daemon-local-client')
    const { createDaemonWorkspace } = await import('@/lib/daemon/daemon-workspaces')
    vi.mocked(fetchDaemonCloudAuthStatus).mockResolvedValue('expired')
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().status).toBe('ready')
    // Cloud row is written with the app JWT, so Settings and the advanced
    // new-session dialog can list it.
    expect(createDaemonWorkspace).toHaveBeenCalled()
    // Local amuxd mirror needs daemon cloud auth — skipped while expired.
    expect(h.invokeCalls).not.toContain('register_daemon_workspace')
  })

  it('does not register a workspace while the bind is still failing', async () => {
    const { fetchDaemonCloudAuthStatus } = await import('@/lib/daemon/daemon-local-client')
    vi.mocked(fetchDaemonCloudAuthStatus).mockResolvedValue('ok')
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't2'
    h.deviceId = null // bind fails before it reaches the server

    vi.useFakeTimers()
    const p = useDaemonOnboardingStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(12 * 500 + 100) // drain the start-daemon poll
    await p
    await Promise.resolve()

    // Registration is team-scoped; it must never run while the daemon is still
    // pointing at the previous team.
    expect(useDaemonOnboardingStore.getState().status).toBe('error')
    expect(h.invokeCalls).not.toContain('register_daemon_workspace')
  })

  it('matched-but-down → starting → auto-recovers to ready', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    // refresh first probe (down), ensureHealthy probe (still down → ensure_running),
    // then the first poll iteration succeeds.
    h.probeQueue = [
      { ok: false, reason: 'not_running' },
      { ok: false, reason: 'not_running' },
      { ok: true, baseUrl: 'http://127.0.0.1:1' },
    ]
    vi.useFakeTimers()
    const p = useDaemonOnboardingStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(600) // one sleep(500) poll tick
    await p
    const s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('ready')
    expect(s.error).toBeNull()
    expect(h.invokeCalls).toContain('daemon_ensure_running')
  })

  it('matched-but-token-invalid that never heals → error with retry hint', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    // Every probe stays unhealthy; recovery exhausts two ensureHealthy rounds.
    h.probeQueue = [{ ok: false, reason: 'token_invalid' }]
    vi.useFakeTimers()
    const p = useDaemonOnboardingStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(2 * 12 * 500 + 100) // drain both poll rounds
    await p
    const s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('error')
    // De-jargoned: the user-facing error no longer leaks "amuxd"; it surfaces
    // the i18n start-failure string with a retry hint.
    expect(s.error).toBe(i18n.t('settings.daemonOnboarding.startFailed'))
    expect(s.error).not.toMatch(/amuxd/)
    expect(h.invokeCalls.filter((c) => c === 'daemon_ensure_running')).toHaveLength(2)
  })

  it('matched-but-down → auto-retries once before surfacing error', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    // First ensureHealthy round exhausts all polls; second succeeds on first poll.
    h.probeQueue = [
      { ok: false, reason: 'not_running' },
      ...Array.from({ length: 13 }, () => ({ ok: false, reason: 'not_running' })),
      { ok: false, reason: 'not_running' },
      { ok: true, baseUrl: 'http://127.0.0.1:1' },
    ]
    vi.useFakeTimers()
    const p = useDaemonOnboardingStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(13 * 500 + 100)
    await p
    const s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('ready')
    expect(s.error).toBeNull()
    expect(h.invokeCalls.filter((c) => c === 'daemon_ensure_running')).toHaveLength(2)
  })

  it('recovery survives managed ensure throwing (falls through to polling)', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    h.installServiceShouldThrow = true
    h.probeQueue = [
      { ok: false, reason: 'not_running' },
      { ok: false, reason: 'not_running' },
      { ok: true, baseUrl: 'http://127.0.0.1:1' },
    ]
    vi.useFakeTimers()
    const p = useDaemonOnboardingStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(600)
    await p
    expect(useDaemonOnboardingStore.getState().status).toBe('ready')
    expect(h.invokeCalls).toContain('daemon_ensure_running')
    expect(h.invokeCalls).toContain('daemon_restart_managed')
  })
})
