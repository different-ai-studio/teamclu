import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback: string) => fallback,
    i18n: { language: 'en' },
  }),
}))

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement('button', props, children),
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => React.createElement('input', props),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogDescription: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogFooter: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogHeader: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
}))

vi.mock('@/components/settings/shared', () => ({
  SettingCard: ({ children, className }: React.PropsWithChildren<{ className?: string }>) =>
    React.createElement('div', { 'data-testid': 'setting-card', className }, children),
  SectionHeader: ({ title }: { title: string }) =>
    React.createElement('div', { 'data-testid': 'section-header' }, title),
}))

const mockLoadEnvCatalog = vi.fn()

vi.mock('@/stores/env-vars', () => ({
  useEnvVarsStore: Object.assign(
    () => ({
      envVars: [],
      teamSecrets: [],
      isLoading: false,
      loadEnvCatalog: mockLoadEnvCatalog,
      setCatalogEntry: vi.fn(),
      deleteCatalogEntry: vi.fn(),
      getEnvVarValue: vi.fn(),
      hasChanges: false,
      setHasChanges: vi.fn(),
    }),
    {
      getState: () => ({ error: null }),
    },
  ),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ workspacePath: '/test' }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ team: { id: 'team-1' } }),
}))

vi.mock('@/stores/team-members', () => ({
  useTeamMembersStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      currentNodeId: null,
      loadCurrentNodeId: vi.fn(),
    }),
}))

vi.mock('@/lib/team/team-permissions', () => ({
  useTeamPermissions: () => ({
    role: null,
    isOwner: false,
    canManageTeam: false,
    canEditFiles: false,
  }),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'team_env_diagnostics') {
      return {
        linkExists: false,
        targetAccessible: false,
        linkPath: null,
        targetPath: null,
      }
    }
    return true
  })
})

describe('EnvVarsSection', () => {
  it('renders the section header', async () => {
    const { EnvVarsSection } = await import('@/components/settings/EnvVarsSection')
    render(React.createElement(EnvVarsSection))
    expect(screen.getByTestId('section-header')).toBeDefined()
    expect(screen.getByText('Environment Variables')).toBeDefined()
  })

  it('shows empty state when no env vars', async () => {
    const { EnvVarsSection } = await import('@/components/settings/EnvVarsSection')
    render(React.createElement(EnvVarsSection))
    expect(screen.getByText('No environment variables yet')).toBeDefined()
  })

  it('calls loadEnvCatalog on mount', async () => {
    const { EnvVarsSection } = await import('@/components/settings/EnvVarsSection')
    render(React.createElement(EnvVarsSection))
    expect(mockLoadEnvCatalog).toHaveBeenCalled()
  })

  it('warns when the daemon cannot decrypt team environment variables', async () => {
    mockInvoke.mockResolvedValue(false)
    const { EnvVarsSection } = await import('@/components/settings/EnvVarsSection')
    render(React.createElement(EnvVarsSection))

    expect(await screen.findByText('Team variables are not available to this agent')).toBeDefined()
  })
})
