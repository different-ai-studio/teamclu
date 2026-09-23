import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  invoke,
  listKnownDocuments,
  fetchDocuments,
  listKnowledgeAcl,
  loadLlmConfig,
  loadDeviceModelOptions,
  refreshExternalRoot,
  getMaintainerStatus,
  putMaintainerConfig,
  prepareCheckpoint,
  completeCheckpoint,
  downloadLatestCheckpoint,
  downloadCheckpoint,
  beginPublish,
  completePublish,
  recoverPublish,
  listen,
  progressListener,
} = vi.hoisted(() => ({
  invoke: vi.fn(),
  listKnownDocuments: vi.fn(),
  fetchDocuments: vi.fn(),
  listKnowledgeAcl: vi.fn(),
  loadLlmConfig: vi.fn(),
  loadDeviceModelOptions: vi.fn(),
  refreshExternalRoot: vi.fn(),
  getMaintainerStatus: vi.fn(),
  putMaintainerConfig: vi.fn(),
  prepareCheckpoint: vi.fn(),
  completeCheckpoint: vi.fn(),
  downloadLatestCheckpoint: vi.fn(),
  downloadCheckpoint: vi.fn(),
  beginPublish: vi.fn(),
  completePublish: vi.fn(),
  recoverPublish: vi.fn(),
  listen: vi.fn(),
  progressListener: { current: undefined as undefined | ((event: { payload: any }) => void) },
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
    wikiMaintainer: {
      getStatus: getMaintainerStatus,
      putConfig: putMaintainerConfig,
      prepareCheckpoint,
      completeCheckpoint,
      downloadLatestCheckpoint,
      downloadCheckpoint,
      beginPublish,
      completePublish,
      recoverPublish,
    },
  }),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen,
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
  adoptExistingWiki,
  loadWikiCompilerModels,
  loadWikiMaintenanceBootstrap,
  pickSavedCompilerModel,
  wikiSourceFolders,
  prepareWikiMaintenance,
  publishWikiMaintenance,
} from '../wiki-maintainer-client'

describe('wiki-maintainer-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    progressListener.current = undefined
    loadDeviceModelOptions.mockResolvedValue({ options: [], reason: 'no-models', defaultBackend: null })
    getMaintainerStatus.mockResolvedValue({
      config: null,
      generation: 0,
      stage: 'idle',
      checkpoint: null,
    })
    putMaintainerConfig.mockResolvedValue({ version: 1, config: {}, updatedAt: '' })
    prepareCheckpoint.mockResolvedValue({
      objectKey: 'wiki-maintainer/checkpoint.zip',
      requiresUpload: false,
      presignedPut: null,
    })
    completeCheckpoint.mockResolvedValue({
      generation: 1,
      stage: 'idle',
      checkpointId: 'checkpoint-1',
    })
    listen.mockImplementation(async (_name: string, handler: (event: { payload: any }) => void) => {
      progressListener.current = handler
      return vi.fn()
    })
  })

  it('uploads and CAS-completes each checkpoint before acknowledging the compiler', async () => {
    listKnowledgeAcl.mockResolvedValue([])
    listKnownDocuments.mockResolvedValue([])
    prepareCheckpoint.mockResolvedValue({
      objectKey: 'wiki-maintainer/checkpoint.zip',
      requiresUpload: true,
      presignedPut: 'https://objects.example/checkpoint',
    })
    completeCheckpoint.mockResolvedValue({
      generation: 1,
      stage: 'idle',
      checkpointId: 'checkpoint-1',
    })
    invoke.mockImplementation(async (command: string) => {
      if (command === 'kb_maintainer_list_local_documents') return []
      if (command === 'kb_maintainer_imported_source_paths') return []
      if (command === 'kb_maintainer_prepare') {
        progressListener.current?.({
          payload: {
            stage: 'checkpoint',
            expectedGeneration: 0,
            configVersion: 1,
            checkpointPath: '/safe/checkpoint.zip',
            sha256: 'a'.repeat(64),
            size: 10,
            manifest: { teamId: 'team-1', generation: 1 },
          },
        })
        return { runId: 'run-1' }
      }
      return null
    })

    await prepareWikiMaintenance('team-1', ['documents/handbook/'], 'glm-4.6')

    expect(prepareCheckpoint).toHaveBeenCalledWith(
      'team-1',
      expect.objectContaining({ expectedGeneration: 0, configVersion: 1 }),
    )
    expect(invoke).toHaveBeenCalledWith('kb_maintainer_upload_checkpoint', {
      request: expect.objectContaining({
        checkpointPath: '/safe/checkpoint.zip',
        url: 'https://objects.example/checkpoint',
      }),
    })
    expect(completeCheckpoint).toHaveBeenCalledWith(
      'team-1',
      expect.objectContaining({ objectKey: 'wiki-maintainer/checkpoint.zip' }),
    )
    expect(invoke).toHaveBeenCalledWith('kb_maintainer_ack_checkpoint', {
      teamId: 'team-1',
      generation: 1,
      accepted: true,
      manifest: expect.objectContaining({ generation: 1 }),
    })
  })

  it('stops and restores the winning checkpoint after a generation conflict', async () => {
    getMaintainerStatus
      .mockResolvedValueOnce({
        config: { version: 1, config: {
          schemaVersion: 1,
          sourceDirectories: ['documents/handbook/'],
          compilerModel: 'glm-4.6',
        }, updatedAt: '' },
        generation: 0,
        stage: 'idle',
        checkpoint: null,
      })
      .mockResolvedValueOnce({
        config: { version: 1, config: {}, updatedAt: '' },
        generation: 1,
        stage: 'idle',
        publishedCommit: 'c'.repeat(40),
        checkpoint: { generation: 1 },
      })
    prepareCheckpoint.mockResolvedValue({
      objectKey: 'wiki-maintainer/loser.zip',
      requiresUpload: false,
      presignedPut: null,
    })
    completeCheckpoint.mockRejectedValue({
      code: 'checkpoint_conflict',
      message: 'generation changed',
    })
    downloadLatestCheckpoint.mockResolvedValue({
      generation: 1,
      url: 'https://objects.example/winner',
      sha256: 'b'.repeat(64),
      size: 20,
    })
    listKnowledgeAcl.mockResolvedValue([])
    listKnownDocuments.mockResolvedValue([])
    invoke.mockImplementation(async (command: string) => {
      if (command === 'kb_maintainer_list_local_documents') return []
      if (command === 'kb_maintainer_imported_source_paths') return []
      if (command === 'kb_maintainer_local_checkpoint_status') return { generation: 0 }
      if (command === 'kb_maintainer_prepare') {
        progressListener.current?.({
          payload: {
            stage: 'checkpoint',
            expectedGeneration: 0,
            configVersion: 1,
            checkpointPath: '/safe/loser.zip',
            sha256: 'a'.repeat(64),
            size: 10,
            manifest: { teamId: 'team-1', generation: 1 },
          },
        })
        throw new Error('checkpoint generation conflict')
      }
      return null
    })

    await expect(
      prepareWikiMaintenance('team-1', ['documents/handbook/'], 'glm-4.6'),
    ).rejects.toMatchObject({ code: 'checkpoint_conflict' })

    expect(invoke).toHaveBeenCalledWith('kb_maintainer_restore_checkpoint', {
      request: expect.objectContaining({
        teamId: 'team-1',
        url: 'https://objects.example/winner',
        publishedCommit: 'c'.repeat(40),
      }),
    })
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
    getMaintainerStatus.mockResolvedValue({
      config: { version: 1, config: {}, updatedAt: '' },
      generation: 2,
      stage: 'ready_to_publish',
      checkpoint: {
        generation: 2,
        manifest: {
          nodeId: 'node-a',
          baseTreeHash: null,
          targetCommit: 'a'.repeat(40),
          targetTreeHash: 'b'.repeat(64),
        },
      },
    })
    beginPublish.mockResolvedValue({
      stage: 'publishing',
      publishToken: 'publish-token',
      publishing: {},
    })
    completePublish.mockResolvedValue({ stage: 'idle', generation: 2 })
    invoke.mockResolvedValue({ syncStatus: 'synced' })

    await expect(publishWikiMaintenance('team-1', {
      runId: 'run-1',
      sourceCount: 1,
      added: 1,
      updated: 0,
      deleted: 0,
      failed: 0,
      visionPages: 0,
      estimatedCost: null,
      currency: 'CNY',
      canPublish: true,
      blockers: [],
      nodeId: 'node-a',
      baseTreeHash: null,
      targetCommit: 'a'.repeat(40),
      targetTreeHash: 'b'.repeat(64),
    }, false)).resolves.toEqual({
      syncStatus: 'synced',
    })

    expect(beginPublish).toHaveBeenCalledWith('team-1', expect.objectContaining({
      generation: 2,
      configVersion: 1,
      targetCommit: 'a'.repeat(40),
    }))
    expect(completePublish).toHaveBeenCalledWith('team-1', {
      publishToken: 'publish-token',
      syncStatus: 'synced',
    })
    expect(refreshExternalRoot).toHaveBeenCalledWith('/team/shared/team-sync')
  })

  it('recovers an interrupted cloud publish instead of claiming it again', async () => {
    getMaintainerStatus.mockResolvedValue({
      config: { version: 1, config: {}, updatedAt: '' },
      generation: 2,
      stage: 'publishing',
      checkpoint: {
        generation: 2,
        manifest: {
          nodeId: 'node-a',
          baseTreeHash: null,
          targetCommit: 'a'.repeat(40),
          targetTreeHash: 'b'.repeat(64),
        },
      },
    })
    recoverPublish.mockResolvedValue({
      stage: 'publishing',
      publishToken: 'replacement-token',
      publishing: {},
    })
    completePublish.mockResolvedValue({ stage: 'idle', generation: 2 })
    invoke.mockResolvedValue({ syncStatus: 'synced' })
    const summary = {
      runId: 'run-recover',
      sourceCount: 1,
      added: 1,
      updated: 0,
      deleted: 0,
      failed: 0,
      visionPages: 0,
      estimatedCost: null,
      currency: 'CNY',
      canPublish: true,
      blockers: [],
      nodeId: 'node-a',
      baseTreeHash: null,
      targetCommit: 'a'.repeat(40),
      targetTreeHash: 'b'.repeat(64),
    }

    await publishWikiMaintenance('team-1', summary, false)

    expect(recoverPublish).toHaveBeenCalledWith('team-1')
    expect(beginPublish).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('kb_maintainer_publish', {
      teamId: 'team-1',
      runId: 'run-recover',
      acceptVisionCost: false,
      cloudPublishingRecovery: true,
      targetCommit: 'a'.repeat(40),
      targetTreeHash: 'b'.repeat(64),
      baseTreeHash: null,
    })
    expect(completePublish).toHaveBeenCalledWith('team-1', {
      publishToken: 'replacement-token',
      syncStatus: 'synced',
    })
  })

  it('rejects a stale summary when a newer checkpoint is current', async () => {
    getMaintainerStatus.mockResolvedValue({
      config: { version: 2, config: {}, updatedAt: '' },
      generation: 3,
      stage: 'ready_to_publish',
      checkpoint: {
        generation: 3,
        manifest: {
          nodeId: 'node-b',
          baseTreeHash: null,
          targetCommit: 'c'.repeat(40),
          targetTreeHash: 'd'.repeat(64),
        },
      },
    })
    await expect(
      publishWikiMaintenance(
        'team-1',
        {
          runId: 'stale-run',
          sourceCount: 1,
          added: 1,
          updated: 0,
          deleted: 0,
          failed: 0,
          visionPages: 0,
          estimatedCost: null,
          currency: 'CNY',
          canPublish: true,
          blockers: [],
          nodeId: 'node-a',
          baseTreeHash: null,
          targetCommit: 'a'.repeat(40),
          targetTreeHash: 'b'.repeat(64),
        },
        false,
      ),
    ).rejects.toThrow(/stale/)
    expect(beginPublish).not.toHaveBeenCalled()
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

  it('drops the Documents root saved by another computer', () => {
    expect(
      wikiSourceFolders([
        'documents/',
        'documents/features/',
        'documents/../secrets/',
        'knowledge/wiki/',
      ]),
    ).toEqual(['documents/features/'])
  })

  it('loads shared source and model preferences from the team config', async () => {
    getMaintainerStatus.mockResolvedValue({
      config: {
        version: 4,
        updatedAt: '',
        config: {
          schemaVersion: 1,
          sourceDirectories: ['documents/handbook/'],
          compilerModel: 'team/glm-4.6',
        },
      },
      generation: 3,
      stage: 'idle',
      checkpoint: { generation: 3 },
    })

    await expect(loadWikiMaintenanceBootstrap('team-1')).resolves.toEqual({
      sourceDirectories: ['documents/handbook/'],
      compilerModel: 'team/glm-4.6',
      checkpointModel: '',
      needsAdopt: false,
      recoveredSummary: null,
    })
  })

  it('retries a broken latest checkpoint and restores the parent generation', async () => {
    getMaintainerStatus.mockResolvedValue({
      config: { version: 2, config: { compilerModel: 'team/glm-4.6' }, updatedAt: '' },
      generation: 5,
      stage: 'ready_to_publish',
      publishedCommit: 'c'.repeat(40),
      checkpoint: {
        generation: 5,
        parentGeneration: 4,
        manifest: { compilerModel: 'team/glm-4.6', nodeId: 'node-a' },
      },
    })
    downloadLatestCheckpoint.mockRejectedValue(new Error('latest object missing'))
    downloadCheckpoint.mockImplementation(async (_teamId: string, generation: number) => {
      if (generation === 5) throw new Error('generation 5 missing')
      return {
        generation: 4,
        url: 'https://objects.example/parent',
        sha256: 'd'.repeat(64),
        size: 30,
      }
    })
    invoke.mockImplementation(async (command: string) => {
      if (command === 'kb_maintainer_local_checkpoint_status') return { generation: 0 }
      if (command === 'kb_maintainer_recovered_summary') return null
      return null
    })

    await loadWikiMaintenanceBootstrap('team-1')

    expect(downloadCheckpoint).toHaveBeenCalledWith('team-1', 5)
    expect(downloadCheckpoint).toHaveBeenCalledWith('team-1', 4)
    expect(invoke).toHaveBeenCalledWith('kb_maintainer_restore_checkpoint', {
      request: expect.objectContaining({
        teamId: 'team-1',
        url: 'https://objects.example/parent',
        publishedCommit: null,
      }),
    })
  })

  it('uploads a compressed baseline after publish and still succeeds if that upload fails', async () => {
    getMaintainerStatus.mockResolvedValue({
      config: { version: 1, config: { compilerModel: 'team/glm-4.6' }, updatedAt: '' },
      generation: 2,
      stage: 'ready_to_publish',
      checkpoint: {
        generation: 2,
        manifest: {
          nodeId: 'node-a',
          baseTreeHash: null,
          targetCommit: 'a'.repeat(40),
          targetTreeHash: 'b'.repeat(64),
        },
      },
    })
    beginPublish.mockResolvedValue({
      stage: 'publishing',
      publishToken: 'publish-token',
      publishing: {},
    })
    completePublish.mockResolvedValue({ stage: 'idle', generation: 2 })
    prepareCheckpoint.mockResolvedValue({
      objectKey: 'wiki-maintainer/baseline.zip',
      requiresUpload: true,
      presignedPut: 'https://objects.example/baseline',
    })
    const summary = {
      runId: 'run-1',
      sourceCount: 1,
      added: 1,
      updated: 0,
      deleted: 0,
      failed: 0,
      visionPages: 0,
      estimatedCost: null,
      currency: 'CNY',
      canPublish: true,
      blockers: [],
      nodeId: 'node-a',
      baseTreeHash: null,
      targetCommit: 'a'.repeat(40),
      targetTreeHash: 'b'.repeat(64),
    }
    invoke.mockImplementation(async (command: string) => {
      if (command === 'kb_maintainer_publish') return { syncStatus: 'synced' }
      if (command === 'kb_maintainer_create_baseline') {
        return {
          checkpointPath: '/safe/baseline.zip',
          expectedGeneration: 2,
          configVersion: 1,
          sha256: 'e'.repeat(64),
          size: 12,
          manifest: { generation: 3, baseline: true },
        }
      }
      return null
    })

    await expect(publishWikiMaintenance('team-1', summary, false)).resolves.toEqual({
      syncStatus: 'synced',
    })
    expect(prepareCheckpoint).toHaveBeenCalledWith(
      'team-1',
      expect.objectContaining({ expectedGeneration: 2, sha256: 'e'.repeat(64) }),
    )
    expect(completeCheckpoint).toHaveBeenCalled()

    prepareCheckpoint.mockRejectedValue(new Error('baseline upload failed'))
    await expect(publishWikiMaintenance('team-1', summary, false)).resolves.toEqual({
      syncStatus: 'synced',
    })
  })

  it('adopts an existing vault only before the first cloud checkpoint', async () => {
    getMaintainerStatus.mockResolvedValue({
      config: null,
      generation: 0,
      stage: 'idle',
      checkpoint: null,
    })
    prepareCheckpoint.mockResolvedValue({
      objectKey: 'wiki-maintainer/adopt.zip',
      requiresUpload: false,
      presignedPut: null,
    })
    invoke.mockResolvedValue({
      checkpointPath: '/safe/adopt.zip',
      expectedGeneration: 0,
      configVersion: 1,
      sha256: 'f'.repeat(64),
      size: 40,
      manifest: { generation: 1, baseline: true },
    })

    await adoptExistingWiki('team-1')

    expect(invoke).toHaveBeenCalledWith('kb_maintainer_adopt_wiki', { teamId: 'team-1' })
    expect(completeCheckpoint).toHaveBeenCalledWith(
      'team-1',
      expect.objectContaining({ objectKey: 'wiki-maintainer/adopt.zip' }),
    )

    getMaintainerStatus.mockResolvedValue({
      config: null,
      generation: 1,
      stage: 'idle',
      checkpoint: { generation: 1 },
    })
    await expect(adoptExistingWiki('team-1')).rejects.toThrow(/already has a cloud checkpoint/)
  })

  it('reports an existing vault that still needs adoption', async () => {
    getMaintainerStatus.mockResolvedValue({
      config: null,
      generation: 0,
      stage: 'idle',
      checkpoint: null,
    })
    invoke.mockImplementation(async (command: string) => {
      if (command === 'kb_maintainer_inspect_vault') return { needsAdopt: true }
      return null
    })

    await expect(loadWikiMaintenanceBootstrap('team-1')).resolves.toMatchObject({
      checkpointModel: '',
      needsAdopt: true,
      recoveredSummary: null,
    })
  })
})
