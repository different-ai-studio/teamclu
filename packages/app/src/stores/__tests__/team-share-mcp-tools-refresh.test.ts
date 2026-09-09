import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/lib/workspace/effective-workspace', () => ({
  effectiveWorkspacePath: async () => '/Users/me/project',
}))
vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({
    teamMcp: { listTeamMcpServers: async () => [] },
    teamSkills: { listTeamSkills: async () => [] },
    actors: { createAgentManagementGrant: async () => ({ grant: 'g', nonce: 'n' }) },
  }),
}))
vi.mock('@/lib/daemon/teamclu-rpc', () => ({ manageAgentCapability: vi.fn(async () => ({})) }))
vi.mock('@/lib/agent/agent-device-reachability', () => ({
  resolveAgentDevicePresenceSync: () => 'online',
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))
vi.mock('@/lib/daemon/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => 'actor-1',
}))

import { useTeamShareBrowserStore } from '../team-share-browser'

const store = () => useTeamShareBrowserStore.getState()

describe('selecting an MCP subject agent', () => {
  beforeEach(() => {
    useTeamShareBrowserStore.setState({
      subjectActorId: null,
      mcp: { items: [], loading: false, loaded: false, error: null },
    })
  })

  test('reloads MCP with tool probes so the list is not stuck at 0 tools', async () => {
    const loadSection = vi.fn(async () => {})
    useTeamShareBrowserStore.setState({ loadSection })

    await store().setSubjectActor('actor-1')

    expect(store().subjectActorId).toBe('actor-1')
    expect(loadSection).toHaveBeenCalledWith('mcp', { force: true, withTools: true })
  })
})
