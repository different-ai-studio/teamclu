import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppControlPanel } from '../AppControlPanel'
import type { AppRow } from '@/lib/backend/types'

const backendMocks = vi.hoisted(() => ({
  listAppAccess: vi.fn(),
  listAppDataTables: vi.fn(),
  listAppFiles: vi.fn(),
  getAppStorageUsage: vi.fn(),
  listAppCronJobs: vi.fn(),
  listAppEnv: vi.fn(),
  deleteApp: vi.fn(),
}))

const tabMocks = vi.hoisted(() => ({
  openAppAccess: vi.fn(),
  openAppAuth: vi.fn(),
  openAppCron: vi.fn(),
  openAppDataTable: vi.fn(),
  openAppEnv: vi.fn(),
  openAppFiles: vi.fn(),
  openAppLogs: vi.fn(),
}))

const daemonMocks = vi.hoisted(() => ({
  daemonAppWorkdir: vi.fn(),
  moveDaemonAppWorkdir: vi.fn(),
}))

const utilMocks = vi.hoisted(() => ({ copyToClipboard: vi.fn() }))

const storeMocks = vi.hoisted(() => ({
  deployingIds: [] as string[],
  reseed: vi.fn(),
  rename: vi.fn(),
  deploy: vi.fn(),
  deleteApp: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ apps: backendMocks }),
}))

vi.mock('@/lib/tabs/app-tabs', () => tabMocks)

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  daemonAppWorkdir: (...args: unknown[]) => daemonMocks.daemonAppWorkdir(...args),
  moveDaemonAppWorkdir: (...args: unknown[]) => daemonMocks.moveDaemonAppWorkdir(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  copyToClipboard: (...args: unknown[]) => utilMocks.copyToClipboard(...args),
}))

vi.mock('@/stores/apps-store', () => ({
  useAppsStore: (sel: (s: typeof storeMocks) => unknown) => sel(storeMocks),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: Record<string, string>) => {
      let text = fallback ?? key
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          text = text.replace(`{{${k}}}`, String(v))
        }
      }
      return text
    },
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
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
} as AppRow

describe('AppControlPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.deployingIds = []
    daemonMocks.daemonAppWorkdir.mockResolvedValue({
      workdir: '/Users/me/.amuxd/teams/team-1/apps/app-1',
      deviceName: 'Matt Mac',
    })
    backendMocks.listAppAccess.mockResolvedValue([
      { memberId: 'member-1', permissionLevel: 'prompt', grantedByMemberId: 'o', createdAt: 'x' },
      { memberId: 'member-2', permissionLevel: 'view', grantedByMemberId: 'o', createdAt: 'x' },
    ])
    backendMocks.listAppDataTables.mockResolvedValue({
      status: 'ok',
      tables: [{ name: 'orders' }, { name: 'users' }],
    })
    backendMocks.listAppFiles.mockResolvedValue({
      items: [{ path: 'a.csv', size: 10 }],
      canWrite: true,
    })
    backendMocks.getAppStorageUsage.mockResolvedValue({ bytes: 2048, quotaBytes: null })
    backendMocks.listAppCronJobs.mockResolvedValue([{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }])
    backendMocks.listAppEnv.mockResolvedValue({
      items: [
        { key: 'LOG_LEVEL', isSecret: false, value: 'debug', updatedAt: 'x' },
        { key: 'STRIPE_KEY', isSecret: true, value: null, updatedAt: 'x' },
      ],
      canWrite: true,
    })
    storeMocks.deleteApp.mockResolvedValue(true)
  })

  it('shows a count on every management row', async () => {
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() => {
      expect(screen.getByTestId('app-control-open-access').textContent).toContain('2 位成员')
      expect(screen.getByTestId('app-control-open-data').textContent).toContain('2 张表')
      expect(screen.getByTestId('app-control-open-files').textContent).toContain('1 个文件')
      expect(screen.getByTestId('app-control-open-cron').textContent).toContain('3 个任务')
      expect(screen.getByTestId('app-control-open-env').textContent).toContain('2 个变量')
    })
  })

  it('counts the secrets separately from the variables', async () => {
    // How much of an app's configuration is write-only is a different fact from
    // how much configuration there is.
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() =>
      expect(screen.getByTestId('app-control-open-env').textContent).toContain('1 个密钥'),
    )
  })

  it('leaves the secret clause off when there are none', async () => {
    backendMocks.listAppEnv.mockResolvedValue({
      items: [{ key: 'LOG_LEVEL', isSecret: false, value: 'debug', updatedAt: 'x' }],
      canWrite: true,
    })
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() =>
      expect(screen.getByTestId('app-control-open-env').textContent).toContain('1 个变量'),
    )
    // Not just "密钥" — the row's own label is 变量与密钥, so the assertion has to
    // be about the count clause rather than the word.
    expect(screen.getByTestId('app-control-open-env').textContent).not.toContain('个密钥')
  })

  it('says why there is nothing rather than showing a zero', async () => {
    // "0 tables" and "this app has no database" are different answers, and the
    // panel is the only place a reader sees them side by side.
    backendMocks.listAppDataTables.mockResolvedValue({ status: 'no_database' })
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() => {
      expect(screen.getByTestId('app-control-open-data').textContent).toContain('没有数据库')
    })
    expect(screen.getByTestId('app-control-open-data').textContent).not.toContain('0')
  })

  it('reports restricted access instead of zero members', async () => {
    // Null from listAppAccess is a 404: not visible, or not yours. Rendering
    // that as "0 members" would read as "nobody has access".
    backendMocks.listAppAccess.mockResolvedValue(null)
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() => {
      expect(screen.getByTestId('app-control-open-access').textContent).toContain('仅创建者可见')
    })
  })

  it('one unreachable surface does not blank the others', async () => {
    backendMocks.listAppFiles.mockRejectedValue(new Error('storage not configured'))
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() => {
      expect(screen.getByTestId('app-control-open-files').textContent).toContain('暂时读不到')
      expect(screen.getByTestId('app-control-open-cron').textContent).toContain('3 个任务')
      expect(screen.getByTestId('app-control-open-env').textContent).toContain('2 个变量')
    })
  })

  it('opens the data browser without asking the server twice', async () => {
    // The summary already knows which tables exist; re-fetching on click would
    // put a round-trip between the press and the tab.
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() =>
      expect(screen.getByTestId('app-control-open-data').textContent).toContain('2 张表'),
    )
    backendMocks.listAppDataTables.mockClear()
    await userEvent.setup().click(screen.getByTestId('app-control-open-data'))

    expect(tabMocks.openAppDataTable).toHaveBeenCalledWith(baseApp, 'orders')
    expect(backendMocks.listAppDataTables).not.toHaveBeenCalled()
  })

  it('opens the matching tab from each row', async () => {
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() => expect(backendMocks.listAppCronJobs).toHaveBeenCalled())
    const user = userEvent.setup()

    await user.click(screen.getByTestId('app-control-open-access'))
    expect(tabMocks.openAppAccess).toHaveBeenCalledWith(baseApp, '协作权限')

    await user.click(screen.getByTestId('app-control-open-auth'))
    expect(tabMocks.openAppAuth).toHaveBeenCalledWith(baseApp, '应用权限')

    await user.click(screen.getByTestId('app-control-open-files'))
    expect(tabMocks.openAppFiles).toHaveBeenCalledWith(baseApp, '应用附件')

    await user.click(screen.getByTestId('app-control-open-cron'))
    expect(tabMocks.openAppCron).toHaveBeenCalledWith(baseApp, '定时任务')

    await user.click(screen.getByTestId('app-control-open-env'))
    expect(tabMocks.openAppEnv).toHaveBeenCalledWith(baseApp, '变量与密钥')

    await user.click(screen.getByTestId('app-control-open-logs'))
    expect(tabMocks.openAppLogs).toHaveBeenCalledWith(baseApp, '日志')
  })

  it('does not open a logs tab for an app that was never deployed', async () => {
    render(<AppControlPanel app={{ ...baseApp, fcStatus: null } as AppRow} />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('app-control-open-logs'))
    expect(tabMocks.openAppLogs).not.toHaveBeenCalled()
    expect(screen.getByTestId('app-control-open-logs').textContent).toContain('未部署')
  })

  it('names the app permissions row by the wall that is actually up', async () => {
    const { rerender } = render(<AppControlPanel app={baseApp} />)
    expect(screen.getByTestId('app-control-open-auth').textContent).toContain('不需要登录')

    rerender(
      <AppControlPanel
        app={{
          ...baseApp,
          authMode: 'platform',
          authRules: [{ path: '/admin', auth: 'required' }],
        } as AppRow}
      />,
    )
    expect(screen.getByTestId('app-control-open-auth').textContent).toContain('1 条页面规则')
  })

  it('copies the local path', async () => {
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() => expect(screen.getByTestId('app-control-copy-path')).toBeTruthy())
    await userEvent.setup().click(screen.getByTestId('app-control-copy-path'))
    expect(utilMocks.copyToClipboard).toHaveBeenCalledWith(
      '/Users/me/.amuxd/teams/team-1/apps/app-1',
    )
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
