import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  deviceId: 'device-1' as string | null,
  invokeThrows: false,
  agentId: null as string | null,
  displayName: null as string | null,
  findThrows: false,
  findCalls: 0,
  findWait: null as Promise<void> | null,
  teamDefault: null as string | null,
  teamDefaultThrows: false,
  directoryCalls: 0,
  directory: [] as Array<Record<string, unknown>>,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd !== 'read_stable_device_id') throw new Error(cmd)
    if (h.invokeThrows) throw new Error('invoke failed')
    return h.deviceId
  }),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    actors: {
      findAgentForDevice: vi.fn(async () => {
        h.findCalls += 1
        if (h.findWait) await h.findWait
        if (h.findThrows) throw new Error('for-device failed')
        return { agentId: h.agentId, displayName: h.displayName }
      }),
      getTeamDefaultAgent: vi.fn(async () => {
        if (h.teamDefaultThrows) throw new Error('default failed')
        return h.teamDefault
      }),
      listActorDirectory: vi.fn(async () => {
        h.directoryCalls += 1
        return h.directory
      }),
    },
  }),
}))

import {
  invalidateLocalAgentInstall,
  refreshAfterLocalAgentInstall,
  refreshDaemonUnlessSkipped,
  resetLocalAgentInstallForTests,
  resolveLocalAgentInstall,
  shouldSkipLocalAgentInstall,
} from '@/lib/daemon/local-agent-install'
import { useActorDirectoryStore } from '@/stores/actor-directory-store'
import { useAuthStore } from '@/stores/auth-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import {
  markLocalAgentInstallPending,
  useLocalAgentInstallStore,
} from '@/stores/local-agent-install'

function sessionFor(userId: string) {
  return { user: { id: userId }, accessToken: userId, refreshToken: userId, expiresAt: 1 }
}

describe('local agent install classification', () => {
  beforeEach(() => {
    h.deviceId = 'device-1'
    h.invokeThrows = false
    h.agentId = null
    h.displayName = null
    h.findThrows = false
    h.findCalls = 0
    h.findWait = null
    h.teamDefault = null
    h.teamDefaultThrows = false
    h.directoryCalls = 0
    h.directory = []
    useAuthStore.setState({ session: null })
    resetLocalAgentInstallForTests()
    useLocalAgentInstallStore.setState({ byTeam: {}, wizardOpen: false, gateSkippedTeamId: null })
    ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {}
    useCurrentTeamStore.setState({
      team: { id: 'team-1', name: 'Team', slug: 'team' },
    })
  })

  it('treats an empty for-device row as absent', async () => {
    const record = await resolveLocalAgentInstall('team-1')
    expect(record.status).toBe('absent')
    expect(useLocalAgentInstallStore.getState().byTeam['team-1']?.status).toBe('absent')
  })

  it('treats a returned agent as installed', async () => {
    h.agentId = 'agent-local'
    h.displayName = 'This machine'
    const record = await resolveLocalAgentInstall('team-1')
    expect(record).toEqual({
      status: 'installed',
      agentId: 'agent-local',
      displayName: 'This machine',
    })
  })

  it('is unknown when the device id cannot be resolved', async () => {
    h.deviceId = null
    const record = await resolveLocalAgentInstall('team-1')
    expect(record.status).toBe('unknown')
    expect(h.findCalls).toBe(0)
  })

  it('is unknown when the device id command throws', async () => {
    h.invokeThrows = true
    expect((await resolveLocalAgentInstall('team-1')).status).toBe('unknown')
    expect(h.findCalls).toBe(0)
  })

  it('is unknown when for-device fails', async () => {
    h.findThrows = true
    expect((await resolveLocalAgentInstall('team-1')).status).toBe('unknown')
  })

  it('shares one lookup between concurrent callers', async () => {
    h.agentId = 'agent-local'
    const [a, b] = await Promise.all([
      resolveLocalAgentInstall('team-1'),
      resolveLocalAgentInstall('team-1'),
    ])
    expect(a.status).toBe('installed')
    expect(b.status).toBe('installed')
    expect(h.findCalls).toBe(1)
  })

  it('skips only when absent and the team has a default agent', async () => {
    h.teamDefault = 'agent-team'
    expect(await shouldSkipLocalAgentInstall('team-1')).toBe(true)

    invalidateLocalAgentInstall('team-1')
    h.teamDefault = null
    expect(await shouldSkipLocalAgentInstall('team-1')).toBe(false)

    invalidateLocalAgentInstall('team-1')
    h.agentId = 'agent-local'
    h.teamDefault = 'agent-team'
    expect(await shouldSkipLocalAgentInstall('team-1')).toBe(false)

    invalidateLocalAgentInstall('team-1')
    h.agentId = null
    h.teamDefaultThrows = true
    expect(await shouldSkipLocalAgentInstall('team-1')).toBe(false)
  })

  it('does not refresh the daemon when the install gate is skipped', async () => {
    h.teamDefault = 'agent-team'
    const refresh = vi.fn(async () => {})
    useDaemonOnboardingStore.setState({ refresh })
    await refreshDaemonUnlessSkipped()
    expect(refresh).not.toHaveBeenCalled()
    expect(useDaemonOnboardingStore.getState().loaded).toBe(true)
    expect(useDaemonOnboardingStore.getState().status).toBe('unknown')
    expect(useLocalAgentInstallStore.getState().gateSkippedTeamId).toBe('team-1')
  })

  it('reloads the actor directory after install before marking the agent installed', async () => {
    h.agentId = 'agent-local'
    h.displayName = 'HGBOTPRO'
    h.directory = [{
      id: 'agent-local',
      actor_type: 'agent',
      display_name: 'HGBOTPRO',
      agent_status: 'active',
    }]
    await refreshAfterLocalAgentInstall('team-1')
    expect(h.directoryCalls).toBe(1)
    expect(useActorDirectoryStore.getState().byTeam['team-1']?.actors).toEqual([
      expect.objectContaining({ id: 'agent-local', display_name: 'HGBOTPRO' }),
    ])
    expect(useLocalAgentInstallStore.getState().byTeam['team-1']?.status).toBe('installed')
  })

  it('refreshes the daemon when a local agent is already installed', async () => {
    h.agentId = 'agent-local'
    const refresh = vi.fn(async () => {})
    useDaemonOnboardingStore.setState({ refresh })
    await refreshDaemonUnlessSkipped({ forceIdentityRebind: true })
    expect(refresh).toHaveBeenCalledWith({ forceIdentityRebind: true })
  })

  it('reuses the settled classification for the same signed-in user', async () => {
    useAuthStore.setState({ session: sessionFor('user-a') })
    h.agentId = 'agent-a'
    h.displayName = 'A'
    await resolveLocalAgentInstall('team-1')
    useAuthStore.setState({
      session: { ...sessionFor('user-a'), accessToken: 'refreshed-token' },
    })
    const again = await resolveLocalAgentInstall('team-1')
    expect(h.findCalls).toBe(1)
    expect(again).toEqual({ status: 'installed', agentId: 'agent-a', displayName: 'A' })
    expect(useLocalAgentInstallStore.getState().byTeam['team-1']?.agentId).toBe('agent-a')
  })

  it('does not let a second pending mark wipe a finished classification for the same user', async () => {
    useAuthStore.setState({ session: sessionFor('user-a') })
    h.agentId = 'agent-a'
    h.displayName = 'A'
    await resolveLocalAgentInstall('team-1')
    markLocalAgentInstallPending('team-1')
    expect(useLocalAgentInstallStore.getState().byTeam['team-1']).toEqual({
      status: 'installed',
      agentId: 'agent-a',
      displayName: 'A',
    })
  })

  it('drops the previous user classification on sign-out before the next render', async () => {
    useAuthStore.setState({ session: sessionFor('user-a') })
    h.teamDefault = 'agent-team'
    await refreshDaemonUnlessSkipped()
    expect(useLocalAgentInstallStore.getState().gateSkippedTeamId).toBe('team-1')
    useLocalAgentInstallStore.getState().openWizard()
    expect(useLocalAgentInstallStore.getState().wizardOpen).toBe(true)

    useAuthStore.setState({ session: null })

    expect(useLocalAgentInstallStore.getState().gateSkippedTeamId).toBeNull()
    expect(useLocalAgentInstallStore.getState().byTeam).toEqual({})
    expect(useLocalAgentInstallStore.getState().wizardOpen).toBe(false)
  })

  it('classifies the new account instead of reusing the previous one', async () => {
    useAuthStore.setState({ session: sessionFor('user-a') })
    h.agentId = 'agent-a'
    h.displayName = 'A'
    await resolveLocalAgentInstall('team-1')

    useAuthStore.setState({ session: sessionFor('user-b') })
    expect(useLocalAgentInstallStore.getState().byTeam).toEqual({})
    h.agentId = 'agent-b'
    h.displayName = 'B'
    const record = await resolveLocalAgentInstall('team-1')

    expect(h.findCalls).toBe(2)
    expect(record).toEqual({ status: 'installed', agentId: 'agent-b', displayName: 'B' })
    expect(useLocalAgentInstallStore.getState().byTeam['team-1']?.agentId).toBe('agent-b')
  })

  it('lets a pending mark start again after the account changes', async () => {
    useAuthStore.setState({ session: sessionFor('user-a') })
    await resolveLocalAgentInstall('team-1')
    expect(useLocalAgentInstallStore.getState().byTeam['team-1']?.status).toBe('absent')

    useAuthStore.setState({ session: sessionFor('user-b') })
    markLocalAgentInstallPending('team-1')
    expect(useLocalAgentInstallStore.getState().byTeam['team-1']?.status).toBe('pending')
  })

  it('rebinds the daemon when the new account has a local agent and the old one did not', async () => {
    useAuthStore.setState({ session: sessionFor('user-a') })
    h.teamDefault = 'agent-team'
    const refresh = vi.fn(async () => {})
    useDaemonOnboardingStore.setState({ refresh })
    await refreshDaemonUnlessSkipped()
    expect(refresh).not.toHaveBeenCalled()

    useAuthStore.setState({ session: sessionFor('user-b') })
    h.agentId = 'agent-b'
    h.displayName = 'B'
    await refreshDaemonUnlessSkipped({ forceIdentityRebind: true })
    expect(refresh).toHaveBeenCalledWith({ forceIdentityRebind: true })
    expect(useLocalAgentInstallStore.getState().gateSkippedTeamId).toBeNull()
  })

  it('does not publish an in-flight classification after the account changes', async () => {
    let release: () => void = () => {}
    h.findWait = new Promise<void>((resolve) => {
      release = resolve
    })
    useAuthStore.setState({ session: sessionFor('user-a') })
    h.agentId = 'agent-a'
    h.displayName = 'A'
    const pending = resolveLocalAgentInstall('team-1')
    await vi.waitFor(() => expect(h.findCalls).toBe(1))

    useAuthStore.setState({ session: sessionFor('user-b') })
    release()
    const stale = await pending

    expect(stale.agentId).toBe('agent-a')
    expect(useLocalAgentInstallStore.getState().byTeam['team-1']).toBeUndefined()
  })
})
