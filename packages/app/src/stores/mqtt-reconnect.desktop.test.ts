import { beforeEach, describe, expect, it, vi } from 'vitest'
import { publishLocalAgentInstall, useLocalAgentInstallStore } from './local-agent-install'
import { useCurrentTeamStore } from './current-team'
import { useDaemonOnboardingStore } from './daemon-onboarding'
import {
  ensureIssuedMqttBroker,
  reconnectDesktopMqttWhenLocalAgentAbsent,
  useMqttReconnectStore,
  __resetMqttReconnectForTests,
} from './mqtt-reconnect'

const daemonSnapshot = vi.hoisted(() => vi.fn())
const desktopMqttStatus = vi.hoisted(() => vi.fn())
const getEffectiveServerConfig = vi.hoisted(() => vi.fn())
const fetchAndApplyBootstrap = vi.hoisted(() => vi.fn())

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>()
  return { ...actual, isTauri: () => true }
})

vi.mock('@/lib/mqtt/mqtt-bridge', () => ({
  mqttStatus: desktopMqttStatus,
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  getDaemonMqttSnapshot: daemonSnapshot,
  recoverDaemonMqtt: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/config/server-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config/server-config')>()
  return { ...actual, getEffectiveServerConfig }
})

vi.mock('@/lib/config/bootstrap', () => ({
  fetchAndApplyBootstrap,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

const TEAM_ID = 'team-desktop-mqtt'

function classify(status: 'installed' | 'absent') {
  useCurrentTeamStore.setState({
    team: { id: TEAM_ID, name: 'Team', slug: 'team' },
  })
  publishLocalAgentInstall(TEAM_ID, {
    status,
    agentId: status === 'installed' ? 'agent-1' : null,
    displayName: status === 'installed' ? 'Local' : null,
  })
}

async function wireAndSettle(): Promise<void> {
  useMqttReconnectStore.setState({ _wired: false })
  useMqttReconnectStore.getState().ensureWired()
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (useMqttReconnectStore.getState().connected !== null) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('desktop mqtt probe did not settle')
}

describe('desktop mqtt probe vs local agent', () => {
  beforeEach(() => {
    __resetMqttReconnectForTests()
    daemonSnapshot.mockReset()
    desktopMqttStatus.mockReset()
    daemonSnapshot.mockResolvedValue({
      connected: false,
      phase: 'Recovering',
    })
    desktopMqttStatus.mockResolvedValue({ connected: true, subscribedTopics: [] })
    getEffectiveServerConfig.mockReset()
    fetchAndApplyBootstrap.mockReset()
    getEffectiveServerConfig.mockResolvedValue({ mqttHost: 'mqtt.example.com' })
    fetchAndApplyBootstrap.mockResolvedValue('applied')
    useDaemonOnboardingStore.setState({ enabled: null })
  })

  it('keeps a connected daemon snapshot when a local agent is installed', async () => {
    daemonSnapshot.mockResolvedValue({ connected: true, phase: 'Ready' })
    classify('installed')
    await wireAndSettle()
    expect(useMqttReconnectStore.getState().connected).toBe(true)
    expect(daemonSnapshot).toHaveBeenCalled()
    expect(desktopMqttStatus).not.toHaveBeenCalled()
  })

  it('reconnects the desktop client after the broker address arrives only when no local agent is installed', async () => {
    useCurrentTeamStore.setState({
      team: { id: TEAM_ID, name: 'Team', slug: 'team' },
    })
    useLocalAgentInstallStore.setState({
      byTeam: {
        [TEAM_ID]: { status: 'absent', agentId: null, displayName: null },
      },
    })
    useMqttReconnectStore.setState({ connected: false, nonce: 0 })
    await reconnectDesktopMqttWhenLocalAgentAbsent()
    expect(useMqttReconnectStore.getState().nonce).toBe(1)

    useMqttReconnectStore.setState({ connected: true, nonce: 0 })
    await reconnectDesktopMqttWhenLocalAgentAbsent()
    expect(useMqttReconnectStore.getState().nonce).toBe(0)

    useLocalAgentInstallStore.setState({
      byTeam: {
        [TEAM_ID]: { status: 'installed', agentId: 'agent-1', displayName: 'Local' },
      },
    })
    useMqttReconnectStore.setState({ connected: false, nonce: 0 })
    await reconnectDesktopMqttWhenLocalAgentAbsent()
    expect(useMqttReconnectStore.getState().nonce).toBe(0)
  })

  it('asks the server for the issued address only when no local agent is installed and none is cached', async () => {
    useCurrentTeamStore.setState({
      team: { id: TEAM_ID, name: 'Team', slug: 'team' },
    })
    useLocalAgentInstallStore.setState({
      byTeam: {
        [TEAM_ID]: { status: 'absent', agentId: null, displayName: null },
      },
    })
    getEffectiveServerConfig
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ mqttHost: 'mqtt.teamclu-dev.ucar.cc', mqttPort: 1883 })
    fetchAndApplyBootstrap.mockResolvedValue('applied')

    await expect(ensureIssuedMqttBroker('token')).resolves.toBe('ready')
    expect(fetchAndApplyBootstrap).toHaveBeenCalledWith({ accessToken: 'token' })

    fetchAndApplyBootstrap.mockClear()
    getEffectiveServerConfig.mockResolvedValue({ mqttHost: 'mqtt.teamclu-dev.ucar.cc' })
    await expect(ensureIssuedMqttBroker('token')).resolves.toBe('ready')
    expect(fetchAndApplyBootstrap).not.toHaveBeenCalled()

    useLocalAgentInstallStore.setState({
      byTeam: {
        [TEAM_ID]: { status: 'installed', agentId: 'agent-1', displayName: 'Local' },
      },
    })
    getEffectiveServerConfig.mockResolvedValue({})
    await expect(ensureIssuedMqttBroker('token')).resolves.toBe('skipped')
    expect(fetchAndApplyBootstrap).not.toHaveBeenCalled()

    useDaemonOnboardingStore.setState({ enabled: false })
    getEffectiveServerConfig
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ mqttHost: 'mqtt.teamclu-dev.ucar.cc' })
    await expect(ensureIssuedMqttBroker('token')).resolves.toBe('ready')
    expect(fetchAndApplyBootstrap).toHaveBeenCalledWith({ accessToken: 'token' })
  })

  it('uses the desktop client when no local agent is installed, even if the daemon snapshot is down', async () => {
    classify('absent')
    await wireAndSettle()
    expect(useMqttReconnectStore.getState().connected).toBe(true)
    expect(daemonSnapshot).not.toHaveBeenCalled()
    expect(desktopMqttStatus).toHaveBeenCalled()
  })
})
