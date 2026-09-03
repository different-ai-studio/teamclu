import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppControlPanel } from '../AppControlPanel'
import type { AppRow } from '@/lib/backend/types'

const backendMocks = vi.hoisted(() => ({
  listAppAccess: vi.fn(),
  // The data section lives in this panel now; without a stub it takes its own
  // error path and buries the panel's own failures in console noise.
  listAppDataTables: vi.fn(async () => ({ status: 'not_deployed' })),
  setAppAccess: vi.fn(),
  removeAppAccess: vi.fn(),
  updateAppAuthMode: vi.fn(),
  deleteApp: vi.fn(),
}))

const daemonMocks = vi.hoisted(() => ({
  daemonAppWorkdir: vi.fn(),
  moveDaemonAppWorkdir: vi.fn(),
}))

const storeMocks = vi.hoisted(() => ({
  deployingIds: [] as string[],
  reseed: vi.fn(),
  rename: vi.fn(),
  updateAuthMode: vi.fn(),
  deploy: vi.fn(),
  deleteApp: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    apps: {
      listAppAccess: backendMocks.listAppAccess,
      listAppDataTables: backendMocks.listAppDataTables,
      setAppAccess: backendMocks.setAppAccess,
      removeAppAccess: backendMocks.removeAppAccess,
      updateAppAuthMode: backendMocks.updateAppAuthMode,
      deleteApp: backendMocks.deleteApp,
    },
  }),
}))

vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  listTeamMembersForAccess: vi.fn(async () => [
    { id: 'member-1', displayName: 'Alice', role: 'member' },
    { id: 'member-2', displayName: 'Bob', role: 'member' },
  ]),
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  daemonAppWorkdir: (...args: unknown[]) => daemonMocks.daemonAppWorkdir(...args),
  moveDaemonAppWorkdir: (...args: unknown[]) => daemonMocks.moveDaemonAppWorkdir(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/stores/apps-store', () => ({
  useAppsStore: (sel: (s: typeof storeMocks) => unknown) =>
    sel(storeMocks as typeof storeMocks),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: Record<string, string>) => {
      let text = fallback ?? key
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          text = text.replace(`{{${k}}}`, v)
        }
      }
      return text
    },
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const baseApp: AppRow = {
  id: 'app-1',
  teamId: 'team-1',
  name: 'Demo App',
  slug: 'demo-app',
  type: 'static_web',
  visibility: 'team',
  workspaceId: null,
  gitRemoteUrl: 'https://gitea/tc-app-1',
  gitAuthKind: 'gitea_deploy_key',
  gitCommitSha: null,
  runtime: 'node',
  authMode: 'none',
  oauthClientId: null,
  provisionStatus: 'ready',
  fcStatus: 'live',
  fcEndpoint: 'https://demo.fcapp.run',
  fcFunctionName: null,
  fcRegion: null,
  publicUrl: 'https://demo.apps.example.com',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

describe('AppControlPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.deployingIds = []
    daemonMocks.daemonAppWorkdir.mockResolvedValue({
      workdir: '/Users/me/.amuxd/teams/team-1/apps/app-1',
      deviceName: 'Matt Mac',
    })
    daemonMocks.moveDaemonAppWorkdir.mockResolvedValue({
      outcome: 'moved',
      workdir: '/Users/me/Projects/demo-app',
      error: null,
    })
    backendMocks.listAppAccess.mockResolvedValue([
      {
        memberId: 'member-1',
        permissionLevel: 'prompt',
        grantedByMemberId: 'owner-1',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ])
    storeMocks.updateAuthMode.mockResolvedValue(undefined)
    storeMocks.deleteApp.mockResolvedValue(true)
  })

  it('renders status without deploy URL card', async () => {
    render(<AppControlPanel app={baseApp} />)
    expect(screen.getByText('Demo App')).toBeTruthy()
    expect(screen.queryByText('https://demo.apps.example.com')).toBeNull()
  })

  it('grants access to a member', async () => {
    backendMocks.setAppAccess.mockResolvedValue({
      memberId: 'member-2',
      permissionLevel: 'view',
      grantedByMemberId: 'owner-1',
      createdAt: '2026-01-02T00:00:00Z',
    })

    render(<AppControlPanel app={baseApp} />)
    await waitFor(() => expect(screen.getByText('Alice')).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '授权' }))

    await waitFor(() => {
      expect(backendMocks.setAppAccess).toHaveBeenCalledWith('app-1', 'member-2', 'prompt')
    })
  })

  it('shows read-only permissions when listAppAccess returns null', async () => {
    backendMocks.listAppAccess.mockReset()
    backendMocks.listAppAccess.mockResolvedValue(null)
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() => {
      expect(screen.getByTestId('app-control-permissions-readonly')).toBeTruthy()
    })
  })

  it('shows pending redeploy badge from the row, not from local state', async () => {
    // Server-derived (fc_status live + auth_mode <> deployed_auth_mode), so it
    // survives a reload and shows for a second admin too — the in-memory list
    // this replaced did neither, and the app looked protected while the live
    // site was still public.
    render(
      <AppControlPanel
        app={{ ...baseApp, authMode: 'platform', authModePendingRedeploy: true }}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('app-control-auth-pending-redeploy')).toBeTruthy()
      expect(screen.getByTestId('app-control-auth-live-warning')).toBeTruthy()
      expect(screen.getByTestId('app-control-redeploy-now')).toBeTruthy()
    })
  })

  it('disables save until auth mode changes', async () => {
    render(<AppControlPanel app={baseApp} />)
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  })

  it('shows local workdir and device name', async () => {
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() => {
      expect(screen.getByTestId('app-control-local-workdir').textContent).toContain(
        '/Users/me/.amuxd/teams/team-1/apps/app-1',
      )
      expect(screen.getByText('设备：Matt Mac')).toBeTruthy()
    })
  })

  it('opens delete confirmation and calls deleteApp', async () => {
    render(<AppControlPanel app={baseApp} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText('删除应用？')).toBeTruthy()
    await user.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)
    await waitFor(() => {
      expect(storeMocks.deleteApp).toHaveBeenCalledWith('app-1')
    })
  })
})
