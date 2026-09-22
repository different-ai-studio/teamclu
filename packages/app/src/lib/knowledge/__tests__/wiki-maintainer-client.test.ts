import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  invoke,
  listKnownDocuments,
  fetchDocuments,
  listKnowledgeAcl,
  loadLlmConfig,
  loadDeviceModelOptions,
  refreshExternalRoot,
} = vi.hoisted(() => ({
  invoke: vi.fn(),
  listKnownDocuments: vi.fn(),
  fetchDocuments: vi.fn(),
  listKnowledgeAcl: vi.fn(),
  loadLlmConfig: vi.fn(),
  loadDeviceModelOptions: vi.fn(),
  refreshExternalRoot: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/daemon/daemon-local-client', () => ({
  listKnownDocuments,
  fetchDocuments,
}))
vi.mock('@/lib/agent/device-default-models', () => ({
  loadDeviceModelOptions,
}))
vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({
    knowledgeAcl: { listKnowledgeAcl },
    teamWorkspaceConfig: { loadLlmConfig },
  }),
}))
vi.mock('@/stores/team-share-browser', () => ({
  useTeamShareBrowserStore: {
    getState: () => ({ syncRoot: '/team/shared/team-sync' }),
  },
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ refreshExternalRoot }),
  },
}))

import {
  loadWikiCompilerModels,
  pickSavedCompilerModel,
  prepareWikiMaintenance,
  publishWikiMaintenance,
} from '../wiki-maintainer-client'

describe('wiki-maintainer-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadDeviceModelOptions.mockResolvedValue({ options: [], reason: 'no-models', defaultBackend: null })
  })

  it('materializes only missing documents under selected folders before prepare', async () => {
    listKnowledgeAcl.mockResolvedValue([{ pathPrefix: 'documents/restricted/' }])
    listKnownDocuments.mockResolvedValue([
      { path: 'documents/handbook/a.pdf', version: 1, size: 10 },
      { path: 'documents/handbook/present.md', version: 1, size: 11 },
      { path: 'documents/handbook/deleted.md', version: 1, size: 12 },
      { path: 'documents/training/b.pdf', version: 1, size: 20 },
    ])
    invoke.mockImplementation(async (command: string) => {
      if (command === 'kb_maintainer_list_local_documents') {
        return ['documents/handbook/present.md']
      }
      if (command === 'kb_maintainer_imported_source_paths') {
        return ['documents/handbook/deleted.md']
      }
      return { runId: 'run-1' }
    })
    fetchDocuments.mockResolvedValue(1)

    await prepareWikiMaintenance('team-1', ['documents/handbook/'], 'glm-4.6')

    expect(invoke).toHaveBeenCalledWith('kb_maintainer_list_local_documents', {
      teamId: 'team-1',
      sourceDirectories: ['documents/handbook/'],
    })
    expect(invoke).toHaveBeenCalledWith('kb_maintainer_imported_source_paths', {
      teamId: 'team-1',
    })
    expect(fetchDocuments).toHaveBeenCalledWith('team-1', [
      'documents/handbook/a.pdf',
    ])
    expect(invoke).toHaveBeenCalledWith('kb_maintainer_prepare', {
      request: expect.objectContaining({
        compilerModel: 'glm-4.6',
        aclPrefixes: ['documents/restricted/'],
        known: [
          { path: 'documents/handbook/a.pdf', version: 1, size: 10 },
          { path: 'documents/handbook/present.md', version: 1, size: 11 },
          { path: 'documents/handbook/deleted.md', version: 1, size: 12 },
        ],
      }),
    })
  })

  it('stops when all selected lazy documents cannot be materialized', async () => {
    listKnowledgeAcl.mockResolvedValue([])
    listKnownDocuments.mockResolvedValue([
      { path: 'documents/handbook/a.pdf', version: 1, size: 10 },
      { path: 'documents/handbook/b.pdf', version: 1, size: 20 },
    ])
    invoke.mockImplementation(async (command: string) => {
      if (command === 'kb_maintainer_list_local_documents') return []
      if (command === 'kb_maintainer_imported_source_paths') return []
      return { runId: 'run-1' }
    })
    fetchDocuments.mockResolvedValue(1)

    await expect(
      prepareWikiMaintenance('team-1', ['documents/handbook/'], 'glm-4.6'),
    ).rejects.toThrow('download')
    expect(invoke).not.toHaveBeenCalledWith('kb_maintainer_prepare', expect.anything())
  })

  it('refreshes the visible team tree after publish', async () => {
    invoke.mockResolvedValue({ syncStatus: 'synced' })

    await expect(publishWikiMaintenance('run-1', false)).resolves.toEqual({
      syncStatus: 'synced',
    })

    expect(refreshExternalRoot).toHaveBeenCalledWith('/team/shared/team-sync')
  })

  it('loads device models and team gateway models for the compiler picker', async () => {
    loadDeviceModelOptions.mockResolvedValue({
      options: [
        {
          id: 'anthropic/claude-sonnet',
          displayName: 'Claude Sonnet',
          providerName: 'anthropic',
          backend: 'pi',
        },
      ],
      reason: 'ok',
      defaultBackend: 'pi',
    })
    loadLlmConfig.mockResolvedValue({
      enabled: true,
      baseUrl: 'https://gateway.example/v1',
      models: [
        { id: 'glm-4.6', name: '标准' },
        { id: 'glm-4-flash', name: '快速' },
      ],
    })
    await expect(loadWikiCompilerModels('team-1')).resolves.toEqual([
      { id: 'anthropic/claude-sonnet', name: 'Claude Sonnet', providerName: 'anthropic' },
      { id: 'team/glm-4.6', name: '标准', providerName: 'team' },
      { id: 'team/glm-4-flash', name: '快速', providerName: 'team' },
    ])
  })

  it('keeps a previously saved team model id that predates the provider prefix', () => {
    const models = [
      { id: 'anthropic/claude-sonnet', name: 'Claude Sonnet', providerName: 'anthropic' },
      { id: 'team/glm-4.6', name: '标准', providerName: 'team' },
    ]
    expect(pickSavedCompilerModel('glm-4.6', models)).toBe('team/glm-4.6')
    expect(pickSavedCompilerModel('anthropic/claude-sonnet', models)).toBe(
      'anthropic/claude-sonnet',
    )
    expect(pickSavedCompilerModel('', models)).toBe('anthropic/claude-sonnet')
  })
})
