import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => {
  const providerState = {
    providers: [] as Array<{ id: string; name: string; configured: boolean }>,
    providersLoading: false,
    configuredProviders: [] as Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>,
    customProviderIds: [] as string[],
    authMethods: {} as Record<string, Array<{ type: 'oauth' | 'api'; label: string }>>,
    refreshAuthMethods: vi.fn(),
    refreshProviders: vi.fn(),
    refreshConfiguredProviders: vi.fn(),
    refreshCustomProviderIds: vi.fn(),
    connectProvider: vi.fn(),
    connectProviderOAuth: vi.fn(),
    completeOAuthCallback: vi.fn(),
    addCustomProvider: vi.fn(),
    updateCustomProvider: vi.fn(),
    getCustomProvider: vi.fn(),
    removeCustomProvider: vi.fn(),
    disconnectProvider: vi.fn(),
    initAll: vi.fn(),
  }
  const workspaceState = {
    workspacePath: '/test',
    openCodeReady: true,
    daemonHttpReady: true,
    setOpenCodeBootstrapped: vi.fn(),
    setWorkspace: vi.fn(),
  }
  const teamModeState = { teamModeType: null as string | null, teamModelConfig: null as null | { model: string; modelName: string; baseUrl: string }, devUnlocked: false, teamModelOptions: [] as Array<{ id: string; name: string }>, switchTeamModel: vi.fn() }
  const catalogState = {
    byWorkspacePath: {} as Record<
      string,
      { status: string; models: Array<{ id: string; displayName: string }>; recentModels: string[]; fetchedAt: number }
    >,
  }
  const ensureLocalDaemonCatalog = vi.fn()
  return {
    providerState,
    workspaceState,
    teamModeState,
    catalogState,
    ensureLocalDaemonCatalog,
    shellOpen: vi.fn(),
    dialogOpen: vi.fn(),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: string | { defaultValue?: string }) =>
      typeof d === 'string' ? d : d?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}))
vi.mock('@/stores/provider', () => ({
  useProviderStore: vi.fn((sel: (s: any) => any) => {
    return sel(mocks.providerState)
  }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => {
    return sel(mocks.workspaceState)
  }),
}))
vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: vi.fn((sel: (s: any) => any) => {
    return sel(mocks.teamModeState)
  }),
}))
vi.mock('@/stores/local-daemon-catalog-store', () => ({
  useLocalDaemonCatalogStore: vi.fn((sel: (s: any) => any) => sel(mocks.catalogState)),
  ensureLocalDaemonCatalog: mocks.ensureLocalDaemonCatalog,
}))
vi.mock('@/lib/team/team-permissions', () => ({
  useTeamPermissions: () => ({ role: 'owner', isOwner: true, canManageTeam: true, canEditFiles: true }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: mocks.shellOpen }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.dialogOpen }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' '), isTauri: () => false }))
vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}))

import { OpenCodeLLMSection as LLMSection } from '../LLMSection'

describe('LLMSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
    mocks.providerState.providers = []
    mocks.providerState.providersLoading = false
    mocks.providerState.configuredProviders = []
    mocks.providerState.customProviderIds = []
    mocks.providerState.authMethods = {}
    mocks.catalogState.byWorkspacePath = {}
    mocks.ensureLocalDaemonCatalog.mockReset()
    mocks.workspaceState.workspacePath = '/test'
    mocks.workspaceState.openCodeReady = true
    mocks.workspaceState.daemonHttpReady = true
    mocks.workspaceState.setWorkspace.mockReset()
    mocks.teamModeState.teamModeType = null
    mocks.teamModeState.teamModelConfig = null
    mocks.teamModeState.devUnlocked = false
    mocks.teamModeState.teamModelOptions = []
  })

  it('renders the LLM Model title', () => {
    render(<LLMSection />)
    expect(screen.getByText('LLM Model')).toBeTruthy()
  })

  it('no longer offers a workspace switcher', () => {
    // Providers are per-workspace, so the section still reads workspacePath —
    // but switching from here was a second, competing way to change the
    // workspace and is gone. Daemon → Workspaces owns that now.
    render(<LLMSection />)
    expect(screen.queryByText('Workspace Path')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Switch Workspace' })).toBeNull()
  })

  it('refreshes provider data from the daemon workspace-control plane on mount', async () => {
    render(<LLMSection />)

    await waitFor(() => {
      expect(mocks.providerState.refreshProviders).toHaveBeenCalled()
      expect(mocks.providerState.refreshConfiguredProviders).toHaveBeenCalled()
      expect(mocks.providerState.refreshAuthMethods).toHaveBeenCalled()
    })
  })

  it('seeds the local model-catalog on mount for the current workspace', async () => {
    render(<LLMSection />)
    await waitFor(() => {
      expect(mocks.ensureLocalDaemonCatalog).toHaveBeenCalledWith('/test', 'opencode')
    })
  })

  it('force-refetches model-catalog when the refresh control is used', async () => {
    mocks.providerState.providers = [{ id: 'openai', name: 'OpenAI', configured: true }]
    render(<LLMSection />)
    mocks.ensureLocalDaemonCatalog.mockClear()

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => {
      expect(mocks.ensureLocalDaemonCatalog).toHaveBeenCalledWith('/test', 'opencode', {
        force: true,
      })
    })
  })

  it('force-refetches model-catalog after connecting a provider', async () => {
    mocks.providerState.providers = [{ id: 'openai', name: 'OpenAI', configured: false }]
    mocks.providerState.connectProvider.mockResolvedValueOnce(true)
    render(<LLMSection />)
    mocks.ensureLocalDaemonCatalog.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' }).at(-1)!)

    await waitFor(() => {
      expect(mocks.ensureLocalDaemonCatalog).toHaveBeenCalledWith('/test', 'opencode', {
        force: true,
      })
    })
  })

  it('force-refetches model-catalog after disconnecting a provider', async () => {
    mocks.providerState.providers = [{ id: 'openai', name: 'OpenAI', configured: true }]
    mocks.providerState.disconnectProvider.mockResolvedValueOnce(true)
    render(<LLMSection />)
    mocks.ensureLocalDaemonCatalog.mockClear()

    fireEvent.click(screen.getByTitle('Disconnect provider'))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))

    await waitFor(() => {
      expect(mocks.ensureLocalDaemonCatalog).toHaveBeenCalledWith('/test', 'opencode', {
        force: true,
      })
    })
  })

  it('force-refetches model-catalog after adding a custom provider', async () => {
    mocks.providerState.addCustomProvider.mockResolvedValueOnce('custom-openai')
    render(<LLMSection />)
    mocks.ensureLocalDaemonCatalog.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Add Custom' }))
    fireEvent.change(screen.getByPlaceholderText('e.g. My OpenAI Proxy'), {
      target: { value: 'Custom OpenAI' },
    })
    fireEvent.change(screen.getByPlaceholderText('e.g. https://api.openai.com/v1'), {
      target: { value: 'https://api.example.test/v1' },
    })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), {
      target: { value: 'sk-test' },
    })
    fireEvent.change(screen.getByPlaceholderText('e.g. gpt-4o'), {
      target: { value: 'custom-model' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }))

    await waitFor(() => {
      expect(mocks.ensureLocalDaemonCatalog).toHaveBeenCalledWith('/test', 'opencode', {
        force: true,
      })
    })
  })

  it('force-refetches model-catalog after updating a custom provider', async () => {
    mocks.providerState.providers = [{ id: 'custom-openai', name: 'Custom OpenAI', configured: true }]
    mocks.providerState.customProviderIds = ['custom-openai']
    mocks.providerState.getCustomProvider.mockResolvedValueOnce({
      name: 'Custom OpenAI',
      baseURL: 'https://api.example.test/v1',
      models: [{ modelId: 'custom-model', modelName: 'Custom Model' }],
    })
    mocks.providerState.updateCustomProvider.mockResolvedValueOnce(true)
    render(<LLMSection />)
    mocks.ensureLocalDaemonCatalog.mockClear()

    fireEvent.click(screen.getByTitle('Edit custom provider'))
    expect(await screen.findByDisplayValue('Custom OpenAI')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update Provider' }))

    await waitFor(() => {
      expect(mocks.ensureLocalDaemonCatalog).toHaveBeenCalledWith('/test', 'opencode', {
        force: true,
      })
    })
  })

  it('force-refetches model-catalog after removing a custom provider', async () => {
    mocks.providerState.providers = [{ id: 'custom-openai', name: 'Custom OpenAI', configured: true }]
    mocks.providerState.customProviderIds = ['custom-openai']
    mocks.providerState.removeCustomProvider.mockResolvedValueOnce(true)
    render(<LLMSection />)
    mocks.ensureLocalDaemonCatalog.mockClear()

    fireEvent.click(screen.getByTitle('Remove custom provider'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(mocks.ensureLocalDaemonCatalog).toHaveBeenCalledWith('/test', 'opencode', {
        force: true,
      })
    })
  })

  it('lists catalog models for an unconnected provider and allows expand', async () => {
    mocks.providerState.providers = [{ id: 'opencode', name: 'OpenCode', configured: false }]
    mocks.catalogState.byWorkspacePath['/test'] = {
      status: 'ready',
      models: [
        { id: 'opencode/qwen3.6-plus-free', displayName: 'OpenCode Zen/Qwen3.6 Plus Free' },
      ],
      recentModels: [],
      fetchedAt: Date.now(),
    }

    render(<LLMSection />)

    expect(screen.getByText(/1 model/i)).toBeTruthy()
    fireEvent.click(screen.getByText('OpenCode'))
    expect(await screen.findByText('OpenCode Zen/Qwen3.6 Plus Free')).toBeTruthy()
    expect(screen.getByText('opencode/qwen3.6-plus-free')).toBeTruthy()
  })

  it('uses catalog display names for a connected provider (not configuredProviders bare ids)', async () => {
    mocks.providerState.providers = [{ id: 'anthropic', name: 'Anthropic', configured: true }]
    mocks.providerState.configuredProviders = [
      { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-4', name: 'claude-sonnet-4' }] },
    ]
    mocks.catalogState.byWorkspacePath['/test'] = {
      status: 'ready',
      models: [
        { id: 'anthropic/claude-sonnet-4', displayName: 'Claude Sonnet 4' },
      ],
      recentModels: [],
      fetchedAt: Date.now(),
    }

    render(<LLMSection />)
    fireEvent.click(screen.getByText('Anthropic'))
    expect(await screen.findByText('Claude Sonnet 4')).toBeTruthy()
    expect(screen.getByText('anthropic/claude-sonnet-4')).toBeTruthy()
    expect(screen.queryByText('claude-sonnet-4')).toBeNull()
  })

  it.each([
    ['pending', 0],
    ['ready', 0],
  ])('shows a loading subtitle for an unsettled %s catalog', (status, fetchedAt) => {
    mocks.providerState.providers = [{ id: 'openai', name: 'OpenAI', configured: true }]
    mocks.catalogState.byWorkspacePath['/test'] = {
      status,
      models: [],
      recentModels: [],
      fetchedAt,
    }

    const { container } = render(<LLMSection />)

    expect(screen.getByText('Loading models...')).toBeTruthy()
    expect(screen.queryByText(/0 models available/i)).toBeNull()
    expect(container.querySelector('svg.lucide-chevron-right')).toBeNull()
  })

  it.each(['error', 'unknown'])(
    'shows an unavailable hint and no expansion control for a %s catalog',
    (status) => {
      mocks.providerState.providers = [{ id: 'openai', name: 'OpenAI', configured: true }]
      mocks.catalogState.byWorkspacePath['/test'] = {
        status,
        models: [],
        recentModels: [],
        fetchedAt: Date.now(),
      }

      const { container } = render(<LLMSection />)

      expect(screen.getByText('Models could not be loaded')).toBeTruthy()
      expect(screen.queryByText(/0 models available/i)).toBeNull()
      expect(container.querySelector('svg.lucide-chevron-right')).toBeNull()

      fireEvent.click(screen.getByText('OpenAI'))
      expect(screen.queryByText('Connect OpenAI')).toBeNull()
    },
  )

  it('merges catalog-only providers into the list when /providers omitted them', async () => {
    mocks.providerState.providers = []
    mocks.catalogState.byWorkspacePath['/test'] = {
      status: 'ready',
      models: [{ id: 'opencode/gpt-5-nano', displayName: 'GPT-5 Nano' }],
      recentModels: [],
      fetchedAt: Date.now(),
    }

    render(<LLMSection />)
    expect(screen.getByText('opencode')).toBeTruthy()
    expect(screen.queryByText('No providers available')).toBeNull()
  })

  it('shows no providers message when empty', () => {
    render(<LLMSection />)
    expect(screen.getByText('No providers available')).toBeTruthy()
  })

  it('waits for an authorization code before completing code-based OAuth providers', async () => {
    mocks.providerState.providers = [{ id: 'openai', name: 'OpenAI', configured: false }]
    mocks.providerState.authMethods = {
      openai: [{ type: 'oauth', label: 'Browser login' }],
    }
    mocks.providerState.connectProviderOAuth.mockResolvedValueOnce({
      status: 'pending',
      url: 'https://auth.example.test/openai',
      instructions: 'Paste the authorization code from the browser.',
      methodType: 'code',
    })
    mocks.providerState.completeOAuthCallback.mockResolvedValueOnce(true)

    render(<LLMSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Login with browser' }))

    await waitFor(() => {
      expect(mocks.shellOpen).toHaveBeenCalledWith('https://auth.example.test/openai')
    })
    expect(mocks.providerState.completeOAuthCallback).not.toHaveBeenCalled()

    const codeInput = await screen.findByPlaceholderText('Paste authorization code')
    fireEvent.change(codeInput, { target: { value: 'oa-code-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Complete authorization' }))

    await waitFor(() => {
      expect(mocks.providerState.completeOAuthCallback).toHaveBeenCalledWith('openai', 0, 'oa-code-123')
    })
  })

  it('validates an OpenAI-compatible custom provider and fills returned models', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gpt-4o' },
          { id: 'gpt-4.1', name: 'GPT-4.1' },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<LLMSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Add Custom' }))
    fireEvent.change(screen.getByPlaceholderText('e.g. My OpenAI Proxy'), {
      target: { value: 'OpenAI' },
    })
    fireEvent.change(screen.getByPlaceholderText('e.g. https://api.openai.com/v1'), {
      target: { value: 'https://api.openai.com/v1/' },
    })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), {
      target: { value: 'sk-test' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Validate & fetch models' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test',
          }),
        }),
      )
    })

    await waitFor(() => {
      expect(screen.getByDisplayValue('gpt-4o')).toBeTruthy()
      expect(screen.getByDisplayValue('gpt-4.1')).toBeTruthy()
    })
  })
})
