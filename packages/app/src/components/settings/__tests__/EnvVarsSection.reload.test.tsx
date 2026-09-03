import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'

const mockReloadDaemonRuntime = vi.fn()
const mockNotifyDaemonRuntimePendingChanges = vi.fn()
const mockSetCatalogEntry = vi.fn()
const mockEncodeWorkspaceId = vi.fn((path: string) => path)
const mockInvoke = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOptions === 'string') return fallbackOrOptions
      if (fallbackOrOptions && typeof fallbackOrOptions === 'object') {
        const { defaultValue, ...vars } = fallbackOrOptions
        let text = String(defaultValue ?? key)
        for (const [name, value] of Object.entries(vars)) {
          text = text.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), String(value))
        }
        return text
      }
      return key
    },
    i18n: { language: 'en' },
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  reloadDaemonRuntime: (...args: unknown[]) => mockReloadDaemonRuntime(...args),
  notifyDaemonRuntimePendingChanges: (...args: unknown[]) =>
    mockNotifyDaemonRuntimePendingChanges(...args),
  encodeWorkspaceId: (path: string) => mockEncodeWorkspaceId(path),
  getDaemonEnvActivationDiagnostics: vi.fn(),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ workspacePath: '/workspace/demo' }),
    {
      getState: () => ({ workspacePath: '/workspace/demo' }),
    },
  ),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement('button', props, children),
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => React.createElement('input', props),
}))

vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: (props: Record<string, unknown>) =>
    React.createElement('input', { type: 'checkbox', ...props }),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogDescription: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  DialogFooter: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogHeader: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
}))

vi.mock('@/components/settings/shared', () => ({
  SettingCard: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', { 'data-testid': 'setting-card' }, children),
  SectionHeader: ({ title }: { title: string }) =>
    React.createElement('div', { 'data-testid': 'section-header' }, title),
}))

vi.mock('@/stores/env-vars', () => ({
  useEnvVarsStore: Object.assign(
    () => ({
      envVars: [],
      teamSecrets: [],
      isLoading: false,
      loadEnvCatalog: vi.fn(),
      setCatalogEntry: (...args: unknown[]) => mockSetCatalogEntry(...args),
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

vi.mock('@/stores/team-members', () => ({
  useTeamMembersStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      currentNodeId: 'node-1',
      loadCurrentNodeId: vi.fn(),
    }),
}))

vi.mock('@/lib/team/team-permissions', () => ({
  useTeamPermissions: () => ({ role: 'owner', isOwner: true }),
}))

import { EnvVarsSection } from '../EnvVarsSection'

describe('EnvVarsSection save notifies pending reload', () => {
  beforeEach(() => {
    mockReloadDaemonRuntime.mockReset()
    mockNotifyDaemonRuntimePendingChanges.mockReset()
    mockSetCatalogEntry.mockReset()
    mockInvoke.mockReset()
    mockNotifyDaemonRuntimePendingChanges.mockResolvedValue(true)
    mockSetCatalogEntry.mockResolvedValue(undefined)
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'team_env_diagnostics') {
        return {
          teamIdPresent: false,
          teamLinkPath: '/tmp/link',
          linkExists: false,
          linkIsSymlink: false,
          linkTarget: null,
          targetAccessible: false,
          secretsDirExists: false,
          secretFileCount: 0,
          secretConfigured: false,
        }
      }
      return true
    })
  })

  it('does not render personal activation diagnostics or manual reload', async () => {
    render(<EnvVarsSection />)
    expect(screen.queryByText('个人变量生效诊断')).toBeNull()
    expect(screen.queryByText('Personal env activation')).toBeNull()
    expect(screen.queryByRole('button', { name: '重载 Agent 运行时' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reload agent runtime' })).toBeNull()
  })

  it('notifies daemon of pending env_vars after saving a personal env var', async () => {
    const { toast } = await import('sonner')
    const user = userEvent.setup()
    render(<EnvVarsSection />)

    await user.click(screen.getByRole('button', { name: 'Add Variable' }))
    await user.type(screen.getByPlaceholderText('MY_API_KEY'), 'MY_TOKEN')
    await user.type(screen.getByPlaceholderText('sk-...'), 'secret-value')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockSetCatalogEntry).toHaveBeenCalledWith(
        'personal',
        'MY_TOKEN',
        'secret-value',
        { description: undefined },
      )
      expect(mockNotifyDaemonRuntimePendingChanges).toHaveBeenCalledWith('/workspace/demo', [
        'env_vars',
      ])
      expect(mockReloadDaemonRuntime).not.toHaveBeenCalled()
    })
    expect(toast.success).toHaveBeenCalled()
  })

  it('warns when pending-change notify fails', async () => {
    const { toast } = await import('sonner')
    mockNotifyDaemonRuntimePendingChanges.mockResolvedValue(false)
    const user = userEvent.setup()
    render(<EnvVarsSection />)

    await user.click(screen.getByRole('button', { name: 'Add Variable' }))
    await user.type(screen.getByPlaceholderText('MY_API_KEY'), 'MY_TOKEN')
    await user.type(screen.getByPlaceholderText('sk-...'), 'secret-value')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalled()
    })
    expect(mockReloadDaemonRuntime).not.toHaveBeenCalled()
  })

})
