import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDaemonProviders: vi.fn(),
  getDaemonDeviceProviderAuthMethods: vi.fn(),
  reloadDaemonRuntime: vi.fn(),
  workspacePath: '/workspace/demo',
  runtimeById: {} as Record<string, any>,
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/config/build-config', () => ({
  appShortName: 'teamclu',
  appStoragePrefix: 'teamclu',
}))

vi.mock('@/lib/config/storage', () => ({
  workspaceScopedKey: (base: string, workspacePath?: string | null) => `${base}:${workspacePath ?? ''}`,
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({
      workspacePath: mocks.workspacePath,
    }),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const daemonMocks = vi.hoisted(() => ({
  deleteDaemonProviderAuth: vi.fn(),
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  encodeWorkspaceId: (path: string) => path,
  getDaemonProviders: mocks.getDaemonProviders,
  getDaemonDeviceProviderAuthMethods: mocks.getDaemonDeviceProviderAuthMethods,
  reloadDaemonRuntime: mocks.reloadDaemonRuntime,
  putDaemonProviderAuth: vi.fn(),
  deleteDaemonProviderAuth: daemonMocks.deleteDaemonProviderAuth,
}))

vi.mock('@/stores/runtime-state-store', () => ({
  useRuntimeStateStore: {
    getState: () => ({
      byRuntimeId: mocks.runtimeById,
    }),
  },
}))

vi.mock('@/lib/opencode/config', () => ({
  providerApiKeyName: vi.fn((id: string) => `PROVIDER_${id.toUpperCase()}_API_KEY`),
}))

describe('provider store initAll', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    mocks.workspacePath = '/workspace/demo'
    mocks.runtimeById = {}
    mocks.getDaemonProviders.mockReset()
    mocks.getDaemonDeviceProviderAuthMethods.mockReset()
    mocks.reloadDaemonRuntime.mockReset()
    mocks.reloadDaemonRuntime.mockResolvedValue('applied_live')
    mocks.getDaemonProviders.mockResolvedValue(null)
    mocks.getDaemonDeviceProviderAuthMethods.mockResolvedValue({
      openai: [{ type: 'oauth', label: 'Browser login' }],
    })
    daemonMocks.deleteDaemonProviderAuth.mockReset()
    daemonMocks.deleteDaemonProviderAuth.mockResolvedValue('restart_required')
  })

  it('surfaces OpenCode runtime-advertised models in model settings', async () => {
    mocks.runtimeById = {
      'runtime-1': {
        info: {
          agentType: 2,
          availableModels: [
            { id: 'openai/gpt-4o', displayName: 'GPT-4o' },
            { id: 'opencode/qwen3.6-plus-free', displayName: 'OpenCode Zen/Qwen3.6 Plus Free' },
          ],
          currentModel: 'openai/gpt-4o',
        },
      },
    }

    const { useProviderStore } = await import('../provider')

    await useProviderStore.getState().initAll()

    const state = useProviderStore.getState()
    expect(state.providers).toEqual(
      expect.arrayContaining([
        { id: 'openai', name: 'OpenAI', configured: true },
        { id: 'opencode', name: 'OpenCode', configured: true },
      ]),
    )
    expect(state.models).toEqual(
      expect.arrayContaining([
        { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o' },
        { provider: 'opencode', id: 'qwen3.6-plus-free', name: 'OpenCode Zen/Qwen3.6 Plus Free' },
      ]),
    )
  })

  it('loads OAuth auth methods from daemon HTTP without a workspace', async () => {
    const { useProviderStore } = await import('../provider')
    await useProviderStore.getState().refreshAuthMethods()

    expect(mocks.getDaemonDeviceProviderAuthMethods).toHaveBeenCalledWith()
    expect(useProviderStore.getState().authMethods.openai).toEqual([
      { type: 'oauth', label: 'Browser login' },
    ])
  })

  it('falls back to built-in OAuth methods when daemon catalog is unavailable', async () => {
    mocks.getDaemonDeviceProviderAuthMethods.mockResolvedValue(null)

    const { useProviderStore } = await import('../provider')
    await useProviderStore.getState().refreshAuthMethods()

    expect(useProviderStore.getState().authMethods.openai).toEqual([
      { type: 'oauth', label: 'Browser login' },
    ])
  })

  it('disconnects via daemon without OpenCode sidecar', async () => {
    const { useProviderStore } = await import('../provider')
    useProviderStore.setState({
      providers: [{ id: 'openai', name: 'OpenAI', configured: true }],
      configuredProviders: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] }],
      models: [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }],
    })

    const ok = await useProviderStore.getState().disconnectProvider('openai')

    expect(ok).toBe(true)
    expect(daemonMocks.deleteDaemonProviderAuth).toHaveBeenCalledWith('/workspace/demo', 'openai')
    expect(useProviderStore.getState().providers).toEqual([
      { id: 'openai', name: 'OpenAI', configured: false },
    ])
  })

  it('shows OpenAI as a connectable provider when daemon providers are unavailable', async () => {
    const { useProviderStore } = await import('../provider')

    await useProviderStore.getState().initAll()

    const state = useProviderStore.getState()
    expect(state.models).toEqual([])
    expect(state.configuredProviders).toEqual([])
    expect(state.providers).toEqual([{ id: 'openai', name: 'OpenAI', configured: false }])
  })

  it('loads workspace custom models from daemon providers', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'custom-openai',
        display_name: 'Custom OpenAI',
        authenticated: true,
        models: ['my-model'],
      },
    ])

    const { useProviderStore } = await import('../provider')

    await useProviderStore.getState().initAll()

    const state = useProviderStore.getState()
    expect(state.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'custom-openai',
          id: 'my-model',
          name: 'my-model',
        }),
      ]),
    )
  })

  it('loads daemon providers once during initAll', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'custom-openai',
        display_name: 'Custom OpenAI',
        authenticated: true,
        models: ['my-model'],
      },
    ])

    const { useProviderStore } = await import('../provider')

    await useProviderStore.getState().initAll()

    expect(mocks.getDaemonProviders).toHaveBeenCalledTimes(1)
  })

  // NOTE: the tests that used to sit here all asserted on the store's
  // `currentModelKey` — a workspace-global "selected model" that no longer
  // exists. Model selection is per (session, agent) and lives in
  // `selectAgentModel`; see `runtime-state-resolve` and its tests. This store
  // is now only responsible for providers, credentials and the model catalog.

  // Regression: an admin changing the team model list left members pinned to the
  // old list. Runtime state arrives on a retained MQTT topic that replays the
  // models a runtime was spawned with, so unioning it in resurrected dropped
  // models and no refresh could clear them.
  it('drops team models the daemon no longer reports, even when retained runtime state still advertises them', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'team',
        display_name: 'Team',
        authenticated: true,
        models: ['model-b', 'model-c'],
      },
    ])
    mocks.runtimeById = {
      'runtime-1': {
        info: {
          agentType: 2,
          availableModels: [{ id: 'team/model-a', displayName: 'Model A' }],
          currentModel: 'team/model-a',
        },
      },
    }

    const { useProviderStore } = await import('../provider')
    await useProviderStore.getState().initAll()

    const teamModels = useProviderStore
      .getState()
      .models.filter((model) => model.provider === 'team')
      .map((model) => model.id)
    expect(teamModels).toEqual(['model-b', 'model-c'])
  })

  it('lets runtime state name team models without changing the daemon-reported list', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      { id: 'team', display_name: 'Team', authenticated: true, models: ['model-b'] },
    ])
    mocks.runtimeById = {
      'runtime-1': {
        info: {
          agentType: 2,
          availableModels: [
            { id: 'team/model-b', displayName: 'Model B' },
            { id: 'team/model-a', displayName: 'Model A' },
          ],
          currentModel: 'team/model-b',
        },
      },
    }

    const { useProviderStore } = await import('../provider')
    await useProviderStore.getState().initAll()

    expect(useProviderStore.getState().models.filter((model) => model.provider === 'team')).toEqual([
      { provider: 'team', id: 'model-b', name: 'Model B' },
    ])
  })

  // Without a daemon answer there is nothing authoritative to trust, so the
  // union still applies rather than blanking the picker.
  it('keeps runtime-advertised team models when the daemon snapshot is unavailable', async () => {
    mocks.getDaemonProviders.mockResolvedValue(null)
    mocks.runtimeById = {
      'runtime-1': {
        info: {
          agentType: 2,
          availableModels: [{ id: 'team/model-a', displayName: 'Model A' }],
          currentModel: 'team/model-a',
        },
      },
    }

    const { useProviderStore } = await import('../provider')
    await useProviderStore.getState().initAll()

    expect(useProviderStore.getState().models).toEqual(
      expect.arrayContaining([{ provider: 'team', id: 'model-a', name: 'Model A' }]),
    )
  })

  it('still unions runtime models into non-team providers', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      { id: 'openai', display_name: 'OpenAI', authenticated: true, models: ['gpt-4o'] },
    ])
    mocks.runtimeById = {
      'runtime-1': {
        info: {
          agentType: 2,
          availableModels: [{ id: 'openai/o3-mini', displayName: 'o3-mini' }],
          currentModel: 'openai/gpt-4o',
        },
      },
    }

    const { useProviderStore } = await import('../provider')
    await useProviderStore.getState().initAll()

    const openaiModels = useProviderStore
      .getState()
      .models.filter((model) => model.provider === 'openai')
      .map((model) => model.id)
    expect(openaiModels).toEqual(['gpt-4o', 'o3-mini'])
  })

})
