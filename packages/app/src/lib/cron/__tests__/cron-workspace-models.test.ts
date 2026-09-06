import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  listDaemonWorkspaces: vi.fn(),
  getCurrentDaemonWorkspaceAgent: vi.fn(),
  isDaemonHttpAvailable: vi.fn(),
  getDaemonModelCatalog: vi.fn(),
  isTauri: vi.fn(),
}))

vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  getCurrentDaemonWorkspaceAgent: mocks.getCurrentDaemonWorkspaceAgent,
  listDaemonWorkspaces: mocks.listDaemonWorkspaces,
}))

vi.mock('@/lib/daemon/daemon-local-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/daemon/daemon-local-client')>()
  return {
    ...actual,
    isDaemonHttpAvailable: mocks.isDaemonHttpAvailable,
    getDaemonModelCatalog: mocks.getDaemonModelCatalog,
  }
})

vi.mock('@/lib/utils', () => ({
  isTauri: mocks.isTauri,
}))

import { AgentType } from '@/lib/proto/amux_pb'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import {
  resolveDaemonWorkspacePath,
  loadCronDialogModels,
  modelsFromLiveRuntime,
  findRuntimeForWorkspace,
} from '@/lib/cron/cron-workspace-models'

describe('resolveDaemonWorkspacePath', () => {
  beforeEach(() => {
    mocks.listDaemonWorkspaces.mockReset()
  })

  it('returns canonical daemon path when local path matches by suffix', async () => {
    mocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-1',
        path: '/Users/me/projects/MyApp',
        teamId: 't1',
        agentId: null,
        createdByMemberId: null,
        name: 'MyApp',
        archived: false,
        createdAt: '',
        updatedAt: '',
      },
    ])

    const resolved = await resolveDaemonWorkspacePath(
      'team-1',
      '~/projects/MyApp',
    )
    expect(resolved).toBe('/Users/me/projects/MyApp')
  })
})

describe('modelsFromLiveRuntime', () => {
  beforeEach(() => {
    useRuntimeStateStore.setState({ byRuntimeId: {} })
  })

  it('returns ACP models for the newest runtime on the workspace', () => {
    useRuntimeStateStore.getState().upsert('rt-old', 'agent-1', {
      runtimeId: 'rt-old',
      agentType: AgentType.OPENCODE,
      worktree: '/Users/me/ws',
      availableModels: [{ id: 'team/old', displayName: 'Old' }],
      currentModel: 'team/old',
    } as never)
    useRuntimeStateStore.getState().upsert('rt-new', 'agent-1', {
      runtimeId: 'rt-new',
      agentType: AgentType.OPENCODE,
      worktree: '/Users/me/ws',
      availableModels: [
        { id: 'team/default', displayName: 'Default' },
        { id: 'team/pro', displayName: 'Pro' },
      ],
      currentModel: 'team/default',
    } as never)

    const groups = modelsFromLiveRuntime('/Users/me/ws')
    expect(groups).toHaveLength(1)
    expect(groups[0].backend).toBe('pi')
    expect(groups[0].models.map((m) => m.ref)).toEqual(['team/default', 'team/pro'])
    expect(findRuntimeForWorkspace('/Users/me/ws')?.info.runtimeId).toBe('rt-new')
  })
})

describe('loadCronDialogModels', () => {
  beforeEach(() => {
    mocks.getCurrentDaemonWorkspaceAgent.mockReset()
    mocks.listDaemonWorkspaces.mockReset()
    mocks.listDaemonWorkspaces.mockResolvedValue([])
    mocks.isDaemonHttpAvailable.mockReset()
    mocks.getDaemonModelCatalog.mockReset()
    mocks.isTauri.mockReturnValue(true)
    mocks.isDaemonHttpAvailable.mockResolvedValue(true)
    useRuntimeStateStore.setState({ byRuntimeId: {} })
  })

  const messages = {
    workspaceNoPath: 'no path',
    globalNoTeam: 'no team',
    globalNoDefault: 'no default',
    globalNoDefaultPath: 'no default path',
    daemonUnavailable: 'daemon down',
    noConfiguredModels: 'no models',
    loadFailed: 'load failed',
  }

  it('prefers live runtime models over the daemon catalog', async () => {
    useRuntimeStateStore.getState().upsert('rt-1', 'agent-1', {
      runtimeId: 'rt-1',
      agentType: AgentType.OPENCODE,
      worktree: '/ws',
      availableModels: [{ id: 'team/default', displayName: 'Default' }],
      currentModel: 'team/default',
    } as never)

    const result = await loadCronDialogModels({
      activeScope: 'workspace',
      teamId: 'team-1',
      selectedWorkspacePath: '/ws',
      messages,
    })

    expect(result.hint).toBeNull()
    expect(result.groups[0].models[0].ref).toBe('team/default')
    expect(mocks.getDaemonModelCatalog).not.toHaveBeenCalled()
  })

  it('falls back to the default backend catalog slice when no runtime is live', async () => {
    mocks.getDaemonModelCatalog.mockResolvedValue({
      automation_default_backend: 'opencode',
      backends: [
        {
          backend: 'opencode',
          label: 'OpenCode',
          models: [
            {
              ref: 'team/default',
              model_id: 'default',
              display_name: 'Default',
            },
          ],
        },
        {
          backend: 'claude',
          label: 'Claude Code',
          models: [
            {
              ref: 'claude-code/claude-sonnet-4-6',
              model_id: 'claude-sonnet-4-6',
              display_name: 'Claude Sonnet 4.6',
            },
          ],
        },
      ],
    })

    const result = await loadCronDialogModels({
      activeScope: 'workspace',
      teamId: 'team-1',
      selectedWorkspacePath: '/ws',
      messages,
    })

    expect(result.hint).toBeNull()
    expect(result.automationDefaultBackend).toBe('opencode')
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].backend).toBe('opencode')
    expect(result.groups[0].models.map((m) => m.ref)).toEqual(['team/default'])
  })

  it('falls back to cloud daemon default when local registry has no default flag', async () => {
    mocks.getCurrentDaemonWorkspaceAgent.mockResolvedValue({
      id: 'agent-1',
      defaultWorkspaceId: 'cloud-ws-2',
    })
    mocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'cloud-ws-2',
        path: '/Users/me/copilot-ws-v2',
        archived: false,
      },
    ])
    mocks.getDaemonModelCatalog.mockResolvedValue({
      automation_default_backend: 'opencode',
      backends: [
        {
          backend: 'opencode',
          label: 'OpenCode',
          models: [
            {
              ref: 'scnet/MiniMax-M2.5',
              model_id: 'MiniMax-M2.5',
              display_name: 'MiniMax-M2.5',
            },
          ],
        },
      ],
    })

    const result = await loadCronDialogModels({
      activeScope: 'global',
      teamId: 'team-1',
      selectedWorkspacePath: null,
      localWorkspaces: [
        {
          workspaceId: 'local-1',
          remoteWorkspaceId: 'cloud-ws-2',
          path: '/Users/me/copilot-ws-v2',
          displayName: 'copilot-ws-v2',
          teamId: 'team-1',
          isDefault: false,
        },
      ],
      messages,
    })

    expect(result.hint).toBeNull()
    expect(result.automationDefaultBackend).toBe('opencode')
    expect(result.groups[0].models[0].ref).toBe('scnet/MiniMax-M2.5')
    expect(mocks.getDaemonModelCatalog).toHaveBeenCalled()
  })

  it('reports daemon unavailable when HTTP probe never succeeds', async () => {
    vi.useFakeTimers()
    mocks.isDaemonHttpAvailable.mockResolvedValue(false)

    const promise = loadCronDialogModels({
      activeScope: 'global',
      teamId: null,
      selectedWorkspacePath: null,
      localWorkspaces: [
        {
          workspaceId: 'local-1',
          remoteWorkspaceId: 'r1',
          path: '/Users/me/copilot-ws-v2',
          displayName: 'copilot-ws-v2',
          teamId: null,
          isDefault: true,
        },
      ],
      messages,
    })

    await vi.advanceTimersByTimeAsync(9000)
    const result = await promise
    vi.useRealTimers()

    expect(result.groups).toEqual([])
    expect(result.hint).toBe('daemon down')
  })
})
