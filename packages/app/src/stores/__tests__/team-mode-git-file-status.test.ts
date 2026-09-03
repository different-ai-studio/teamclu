import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()
const cloud = vi.hoisted(() => ({
  loadLlmConfig: vi.fn(),
  currentTeamId: null as string | null,
}))
const providerStore = vi.hoisted(() => ({
  selectModel: vi.fn().mockResolvedValue(undefined),
  refreshConfiguredProviders: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  encodeWorkspaceId: (path: string) => path,
  deleteDaemonProviderAuth: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/agent/team-provider', () => ({
  TEAM_SHARED_PROVIDER_ID: 'team',
}))

vi.mock('@/stores/provider', () => ({
  useProviderStore: {
    getState: () => ({
      currentModelKey: null,
      selectModel: providerStore.selectModel,
      refreshConfiguredProviders: providerStore.refreshConfiguredProviders,
    }),
  },
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({}),
  },
}))

vi.mock('@/lib/config/build-config', () => ({
  appShortName: 'teamclu',
  appStoragePrefix: 'teamclu',
  TEAM_REPO_DIR: 'teamclu-team',
  buildConfig: { team: { lockLlmConfig: false } },
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    teamWorkspaceConfig: { loadLlmConfig: cloud.loadLlmConfig },
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: cloud.currentTeamId ? { id: cloud.currentTeamId } : null }),
  },
}))

vi.mock('@/stores/team-share', () => ({
  useTeamShareStore: { getState: () => ({ status: { mode: null } }) },
}))

beforeEach(() => {
  mockInvoke.mockReset()
  cloud.loadLlmConfig.mockReset()
  cloud.loadLlmConfig.mockResolvedValue(null)
  cloud.currentTeamId = null
  providerStore.selectModel.mockClear()
  providerStore.refreshConfiguredProviders.mockClear()
})

describe('loadTeamGitFileSyncStatus', () => {
  it('maps untracked → new, modified/added/deleted/renamed/copied → modified, drops ignored', async () => {
    mockInvoke.mockResolvedValueOnce({
      branch: 'main',
      clean: false,
      files: [
        { path: 'a.md', status: 'untracked', staged: false },
        { path: 'b.md', status: 'modified', staged: false },
        { path: 'c.md', status: 'added', staged: true },
        { path: 'd.md', status: 'deleted', staged: false },
        { path: 'e.md', status: 'renamed', staged: true },
        { path: 'f.md', status: 'copied', staged: true },
        { path: 'g.md', status: 'ignored', staged: false },
        { path: 'h.md', status: 'unknown', staged: false },
      ],
    })

    const { useTeamModeStore } = await import('@/stores/team-mode')
    await useTeamModeStore.getState().loadTeamGitFileSyncStatus('/ws')

    expect(mockInvoke).toHaveBeenCalledWith('git_status', { path: '/ws/teamclu-team' })
    const map = useTeamModeStore.getState().teamGitFileSyncStatusMap
    expect(map).toEqual({
      'a.md': 'new',
      'b.md': 'modified',
      'c.md': 'modified',
      'd.md': 'modified',
      'e.md': 'modified',
      'f.md': 'modified',
    })
  })

  it('swallows errors and leaves map unchanged', async () => {
    const { useTeamModeStore } = await import('@/stores/team-mode')
    useTeamModeStore.setState({ teamGitFileSyncStatusMap: { 'x.md': 'modified' } })

    mockInvoke.mockRejectedValueOnce(new Error('no .git'))

    await expect(
      useTeamModeStore.getState().loadTeamGitFileSyncStatus('/ws')
    ).resolves.toBeUndefined()

    expect(useTeamModeStore.getState().teamGitFileSyncStatusMap).toEqual({ 'x.md': 'modified' })
  })

  it('clearTeamMode resets teamGitFileSyncStatusMap', async () => {
    const { useTeamModeStore } = await import('@/stores/team-mode')
    useTeamModeStore.setState({ teamGitFileSyncStatusMap: { 'x.md': 'modified' } })
    await useTeamModeStore.getState().clearTeamMode()
    expect(useTeamModeStore.getState().teamGitFileSyncStatusMap).toEqual({})
  })

  it('applyTeamModel refreshes teamModelConfig from the cloud team LLM', async () => {
    cloud.currentTeamId = 'team-1'
    cloud.loadLlmConfig.mockResolvedValueOnce({
      enabled: true,
      baseUrl: 'https://ai.ucar.cc',
      models: [
        { id: 'default', name: 'Default' },
        { id: 'pro', name: 'Pro' },
      ],
    })

    const { useTeamModeStore } = await import('@/stores/team-mode')
    useTeamModeStore.setState({
      teamModelConfig: {
        baseUrl: 'https://legacy.example.com',
        model: 'legacy',
        modelName: 'Legacy',
      },
      teamModelOptions: [],
    })

    await useTeamModeStore.getState().applyTeamModel('/ws')

    expect(cloud.loadLlmConfig).toHaveBeenCalledWith('team-1')
    expect(useTeamModeStore.getState().teamModelConfig).toEqual({
      baseUrl: 'https://ai.ucar.cc',
      model: 'default',
      modelName: 'Default',
    })
    expect(useTeamModeStore.getState().teamModelOptions).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'pro', name: 'Pro' },
    ])
  })

  // Regression: the applied-config fingerprint used to be `baseUrl|model`, so an
  // admin *adding* a model left the selection untouched and the change was
  // dropped by the early-return — the new model never reached the provider store.
  it('applyTeamModel propagates a team model-list change that leaves the selection unchanged', async () => {
    cloud.currentTeamId = 'team-1'
    const llmConfig = (models: Array<{ id: string; name: string }>) => ({
      enabled: true,
      baseUrl: 'https://ai.ucar.cc',
      models,
    })

    const { useTeamModeStore } = await import('@/stores/team-mode')
    // The store is a module singleton; clear the fingerprint so the first apply
    // below isn't swallowed by a key left over from another test.
    useTeamModeStore.setState({ _appliedConfigKey: null })

    cloud.loadLlmConfig.mockResolvedValueOnce(llmConfig([{ id: 'default', name: 'Default' }]))
    await useTeamModeStore.getState().applyTeamModel('/ws')
    expect(providerStore.refreshConfiguredProviders).toHaveBeenCalledTimes(1)

    // Same baseUrl, same selected model — only the list grew.
    cloud.loadLlmConfig.mockResolvedValueOnce(
      llmConfig([
        { id: 'default', name: 'Default' },
        { id: 'pro', name: 'Pro' },
      ]),
    )
    await useTeamModeStore.getState().applyTeamModel('/ws')

    expect(useTeamModeStore.getState().teamModelOptions).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'pro', name: 'Pro' },
    ])
    expect(providerStore.refreshConfiguredProviders).toHaveBeenCalledTimes(2)
  })

  it('applyTeamModel stays a no-op when nothing about the team LLM changed', async () => {
    cloud.currentTeamId = 'team-1'
    const llmConfig = {
      enabled: true,
      baseUrl: 'https://ai.ucar.cc',
      models: [{ id: 'default', name: 'Default' }],
    }

    const { useTeamModeStore } = await import('@/stores/team-mode')
    useTeamModeStore.setState({ _appliedConfigKey: null })

    cloud.loadLlmConfig.mockResolvedValueOnce(llmConfig)
    await useTeamModeStore.getState().applyTeamModel('/ws')
    cloud.loadLlmConfig.mockResolvedValueOnce(llmConfig)
    await useTeamModeStore.getState().applyTeamModel('/ws')

    expect(providerStore.refreshConfiguredProviders).toHaveBeenCalledTimes(1)
  })
})
