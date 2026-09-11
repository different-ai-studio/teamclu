import { describe, test, expect, beforeEach, vi } from 'vitest'

// Regression test for https://github.com/different-ai-studio/teamclu/issues/1371
//
// Symptom: after opening the MCP panel (or switching the selected Agent), every
// server sits at "Idle"/"Unknown" with an empty tool list until the user manually
// clicks "Re-sync". Root cause: `setSubjectActor` reloads the mcp section with
// `loadSection('mcp', { force: true })` — no `withTools: true` — so the probe
// request (`getDaemonMcpTools`) never fires on the path that actually
// establishes which Agent is selected. `loadMcpTools` only runs later, when the
// user triggers a refresh by hand.

const { createAgentManagementGrant, manageAgentCapability, listTeamMcpServers, getDaemonMcpTools } =
  vi.hoisted(() => ({
    createAgentManagementGrant: vi.fn(async () => ({ grant: 'grant', nonce: 'nonce' })),
    manageAgentCapability: vi.fn(async () => ({ mcpServers: [] })),
    listTeamMcpServers: vi.fn(async () => []),
    getDaemonMcpTools: vi.fn(async () => ({})),
  }))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/lib/workspace/effective-workspace', () => ({
  effectiveWorkspacePath: async () => '/Users/me/project',
}))
vi.mock('@/lib/daemon/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => 'actor-1',
  noteLocalDaemonActorId: () => {},
}))
vi.mock('@/lib/daemon/daemon-local-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/daemon/daemon-local-client')>()
  return {
    ...actual,
    getDaemonMcpTools,
    encodeWorkspaceId: (p: string) => `ws:${p}`,
  }
})
vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({
    actors: { createAgentManagementGrant },
    teamMcp: { listTeamMcpServers },
  }),
}))
vi.mock('@/lib/daemon/teamclu-rpc', () => ({ manageAgentCapability }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))

import { useTeamShareBrowserStore } from '../team-share-browser'
import { useCurrentTeamStore } from '../current-team'

const store = () => useTeamShareBrowserStore.getState()

describe('setSubjectActor refreshes MCP tool probes', () => {
  beforeEach(() => {
    createAgentManagementGrant.mockClear()
    manageAgentCapability.mockClear()
    listTeamMcpServers.mockClear()
    getDaemonMcpTools.mockClear()
    useCurrentTeamStore.setState({ team: { id: 'team-1' } } as never)
    useTeamShareBrowserStore.setState({
      subjectActorId: null,
      mcp: { items: [], loading: false, loaded: false, error: null },
    })
  })

  test('selecting an Agent probes MCP tool status without a manual re-sync', async () => {
    await store().setSubjectActor('actor-1')

    expect(getDaemonMcpTools).toHaveBeenCalledTimes(1)
  })
})
