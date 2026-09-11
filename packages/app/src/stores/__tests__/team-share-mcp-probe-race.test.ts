import { beforeEach, describe, expect, test, vi } from 'vitest'

const { getDaemonMcpTools, manageAgentCapability, listTeamMcpServers } = vi.hoisted(() => ({
  getDaemonMcpTools: vi.fn(),
  manageAgentCapability: vi.fn(),
  listTeamMcpServers: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/lib/workspace/effective-workspace', () => ({
  effectiveWorkspacePath: async () => '/Users/me/project',
}))
vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({
    teamMcp: { listTeamMcpServers },
    actors: { createAgentManagementGrant: async () => ({ grant: 'g', nonce: 'n' }) },
  }),
}))
vi.mock('@/lib/daemon/teamclu-rpc', () => ({ manageAgentCapability }))
vi.mock('@/lib/agent/agent-device-reachability', () => ({
  resolveAgentDevicePresenceSync: () => 'online',
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))
vi.mock('@/lib/daemon/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => 'actor-1',
}))
vi.mock('@/lib/daemon/daemon-local-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/daemon/daemon-local-client')>()
  return { ...actual, getDaemonMcpTools }
})

import { useTeamShareBrowserStore } from '../team-share-browser'
import { useCurrentTeamStore } from '../current-team'

const store = () => useTeamShareBrowserStore.getState()

/** One built-in server, the shape the daemon's `mcp:list` inventory returns. */
function inventory() {
  return {
    mcpServers: [
      {
        id: 'teamclu-introspect',
        name: 'teamclu-introspect',
        transport: 'stdio',
        source: 'builtin',
        configStatus: 'installed',
        commandOrUrl: '/Applications/TeamClu.app/Contents/MacOS/teamclu-introspect',
        configuredEnvKeys: [],
        configuredHeaderKeys: [],
      },
    ],
  }
}

describe('a slow MCP refresh that does not probe must not drop a probe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCurrentTeamStore.setState({ team: { id: 'team-1' } } as never)
    useTeamShareBrowserStore.setState({
      subjectActorId: 'actor-1',
      mcp: { items: [], loading: false, loaded: false, error: null },
    })
    manageAgentCapability.mockResolvedValue(inventory())
    getDaemonMcpTools.mockResolvedValue({
      'teamclu-introspect': {
        probe_status: 'ready',
        tools: ['get_my_capabilities', 'manage_mcp'],
        error: null,
        probed_at: '2026-09-11T00:00:00Z',
      },
    })
  })

  test('keeps the tools when a non-probing refresh resolves last', async () => {
    // The no-tools load (`loadCounts` on a team/workspace switch) starts first
    // and its catalog fetch is slow; the probing load that opens the pane
    // finishes first. Its late `set` used to restore the unprobed rows it
    // snapshotted at start — every server went back to "Idle · 0 tools".
    let calls = 0
    listTeamMcpServers.mockImplementation(async () => {
      calls += 1
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 50))
      return []
    })

    const slowNoTools = store().loadSection('mcp', { force: true })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const fastProbing = store().loadSection('mcp', { force: true, withTools: true })
    await Promise.all([slowNoTools, fastProbing])

    expect(store().mcp.items).toHaveLength(1)
    expect(store().mcp.items[0]).toMatchObject({
      id: 'teamclu-introspect',
      kind: 'builtin',
      probeStatus: 'ready',
      tools: ['get_my_capabilities', 'manage_mcp'],
    })
  })
})
