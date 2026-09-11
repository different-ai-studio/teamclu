import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import {
  AppControlPanel,
  describeCodeVersion,
  typeChangeNeedsConfirm,
  visibilityChangeNeedsConfirm,
} from '../AppControlPanel'
import type { AppRow } from '@/lib/backend/types'

const backendMocks = vi.hoisted(() => ({
  listAppAccess: vi.fn(),
  listAppDataTables: vi.fn(),
  listAppFiles: vi.fn(),
  getAppStorageUsage: vi.fn(),
  listAppCronJobs: vi.fn(),
  listAppEnv: vi.fn(),
  getGitHead: vi.fn(),
  deleteApp: vi.fn(),
}))

const tabMocks = vi.hoisted(() => ({
  openAppSettings: vi.fn(),
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
  setVisibility: vi.fn(),
  setType: vi.fn(),
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
  // Real behaviour, not a stub: the code-version line branches on it, and a
  // stub returning true would hide the imported-app case entirely.
  isGiteaManaged: (a: { gitAuthKind?: string | null }) => a.gitAuthKind === 'gitea_deploy_key',
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

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMocks }))

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
  typePendingRedeploy: false,
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
      {
        memberId: 'member-1',
        permissionLevel: 'prompt',
        grantedByMemberId: 'o',
        createdAt: 'x',
      },
      {
        memberId: 'member-2',
        permissionLevel: 'view',
        grantedByMemberId: 'o',
        createdAt: 'x',
      },
    ])
    backendMocks.listAppDataTables.mockResolvedValue({
      status: 'ok',
      tables: [{ name: 'orders' }, { name: 'users' }],
    })
    backendMocks.listAppFiles.mockResolvedValue({
      items: [{ path: 'a.csv', size: 10 }],
      nextCursor: null,
      canWrite: true,
    })
    backendMocks.getAppStorageUsage.mockResolvedValue({
      bytes: 2048,
      quotaBytes: null,
    })
    backendMocks.listAppCronJobs.mockResolvedValue([{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }])
    backendMocks.listAppEnv.mockResolvedValue({
      items: [
        { key: 'LOG_LEVEL', isSecret: false, value: 'debug', updatedAt: 'x' },
        { key: 'STRIPE_KEY', isSecret: true, value: null, updatedAt: 'x' },
      ],
      canWrite: true,
    })
    storeMocks.deleteApp.mockResolvedValue(true)
    storeMocks.setVisibility.mockResolvedValue(true)
    backendMocks.getGitHead.mockResolvedValue({
      sha: 'a3f91c2ffff',
      branch: 'main',
      deployedSha: 'b7e2d10aaaa',
      undeployedCommits: 3,
    })
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

  it('does not claim the data is unreadable while it is still loading', async () => {
    // The row shows a spinner during the load; clicking it used to fire the
    // not-yet-decided reason text as a toast — a statement about a request that
    // had not come back.
    let release: (v: unknown) => void = () => {}
    backendMocks.listAppDataTables.mockReturnValue(
      new Promise((r) => {
        release = r
      }),
    )
    render(<AppControlPanel app={baseApp} />)

    await userEvent.setup().click(screen.getByTestId('app-control-open-data'))
    expect(toastMocks.info).not.toHaveBeenCalled()
    expect(tabMocks.openAppDataTable).not.toHaveBeenCalled()

    release({ status: 'ok', tables: [{ name: 'orders' }] })
    await waitFor(() =>
      expect(screen.getByTestId('app-control-open-data').textContent).toContain('1 张表'),
    )
  })

  it('opens the matching tab from each row', async () => {
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() => expect(backendMocks.listAppCronJobs).toHaveBeenCalled())
    const user = userEvent.setup()

    expect(screen.queryByTestId('app-control-type')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(screen.getByTestId('app-control-open-settings'))
    expect(tabMocks.openAppSettings).toHaveBeenCalledWith(baseApp, '应用设置')

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
    expect((screen.getByTestId('app-control-open-logs') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renames on Enter and discards the draft on Escape', async () => {
    render(<AppControlPanel app={baseApp} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '重命名' }))
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), 'New name{Escape}')
    expect(storeMocks.rename).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '重命名' }))
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(baseApp.name)
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), 'New name{Enter}')
    await waitFor(() => expect(storeMocks.rename).toHaveBeenCalledWith(baseApp.id, 'New name'))
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('names the app permissions row by the wall that is actually up', async () => {
    const { rerender } = render(<AppControlPanel app={baseApp} />)
    expect(screen.getByTestId('app-control-open-auth').textContent).toContain('不需要登录')

    rerender(
      <AppControlPanel
        app={
          {
            ...baseApp,
            authMode: 'platform',
            authRules: [{ path: '/admin', auth: 'required' }],
          } as AppRow
        }
      />,
    )
    expect(screen.getByTestId('app-control-open-auth').textContent).toContain('1 条页面规则')
  })

  it("shows what the app's visibility currently means, not just its name", async () => {
    // "Personal" does not tell anyone that the local daemon cannot see the app.
    const { rerender } = render(<AppControlPanel settings app={baseApp} />)
    expect(screen.getByTestId('app-control-visibility').textContent).toContain('全团队可见')
    expect(screen.getByText(/团队里每个人都能在应用列表里看到它/)).toBeTruthy()

    rerender(<AppControlPanel settings app={{ ...baseApp, visibility: 'personal' } as AppRow} />)
    expect(screen.getByTestId('app-control-visibility').textContent).toContain('仅自己和被授权的人')
    expect(screen.getByText(/本机 daemon 也看不到它/)).toBeTruthy()
  })

  it('does not open a confirm before anything is asked for', async () => {
    render(<AppControlPanel app={baseApp} />)
    expect(screen.queryByTestId('app-control-visibility-confirm')).toBeNull()
    expect(screen.queryByTestId('app-control-type-confirm')).toBeNull()
  })

  it('names the app type and says what that type is', async () => {
    const { rerender } = render(<AppControlPanel settings app={baseApp} />)
    expect(screen.getByTestId('app-control-type').textContent).toContain('静态网页')
    expect(screen.getByTestId('app-control-type-hint').textContent).toContain('一个网站')

    rerender(<AppControlPanel settings app={{ ...baseApp, type: 'imported' } as AppRow} />)
    expect(screen.getByTestId('app-control-type').textContent).toContain('导入的仓库')
  })

  it('reads a pre-split stored type as the data app it is', async () => {
    // A raw value would match no option and leave the trigger blank for every
    // app created before types existed.
    render(
      <AppControlPanel
        settings
        app={{ ...baseApp, type: 'fullstack_tanstack_postgres' } as AppRow}
      />,
    )
    expect(screen.getByTestId('app-control-type').textContent).toContain('数据操作')
    expect(screen.getByTestId('app-control-type-hint').textContent).toContain('自带一个数据库')
  })

  it('says a type change waits for the next deploy only while it does', async () => {
    const { rerender } = render(<AppControlPanel settings app={baseApp} />)
    expect(screen.queryByTestId('app-control-type-pending')).toBeNull()

    rerender(<AppControlPanel settings app={{ ...baseApp, typePendingRedeploy: true } as AppRow} />)
    expect(screen.getByTestId('app-control-type-pending').textContent).toContain('下次部署')
  })

  it('treats a server that does not send the pending flag as nothing pending', async () => {
    const { typePendingRedeploy: _omitted, ...olderRow } = baseApp
    render(<AppControlPanel settings app={olderRow as AppRow} />)
    expect(screen.queryByTestId('app-control-type-pending')).toBeNull()
  })

  it('says how far behind the deployed commit is', async () => {
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() => {
      const line = screen.getByTestId('app-control-code-version').textContent!
      expect(line).toContain('b7e2d10') // deployed, short
      expect(line).toContain('main')
      expect(line).toContain('3')
    })
    expect(backendMocks.getGitHead).toHaveBeenCalledWith('app-1', {
      compare: true,
    })
  })

  it('does not ask the forge about an app whose repo is not ours', async () => {
    render(<AppControlPanel app={{ ...baseApp, gitAuthKind: null } as AppRow} />)
    await waitFor(() =>
      expect(screen.getByTestId('app-control-code-version').textContent).toContain('外部仓库'),
    )
    expect(backendMocks.getGitHead).not.toHaveBeenCalled()
  })

  it('marks the file count as a floor when there is another page', async () => {
    backendMocks.listAppFiles.mockResolvedValue({
      items: Array.from({ length: 100 }, (_, i) => ({
        path: `f${i}`,
        size: 1,
      })),
      nextCursor: 'more',
      canWrite: true,
    })
    render(<AppControlPanel app={baseApp} />)
    await waitFor(() =>
      expect(screen.getByTestId('app-control-open-files').textContent).toContain('100+'),
    )
  })

  it('copies the local path', async () => {
    render(<AppControlPanel settings app={baseApp} />)
    await waitFor(() => expect(screen.getByTestId('app-control-copy-path')).toBeTruthy())
    await userEvent.setup().click(screen.getByTestId('app-control-copy-path'))
    expect(utilMocks.copyToClipboard).toHaveBeenCalledWith(
      '/Users/me/.amuxd/teams/team-1/apps/app-1',
    )
  })

  it('shows local workdir and device name', async () => {
    render(<AppControlPanel settings app={baseApp} />)
    await waitFor(() => {
      expect(screen.getByTestId('app-control-local-workdir').textContent).toContain(
        '/Users/me/.amuxd/teams/team-1/apps/app-1',
      )
      expect(screen.getByText('设备：Matt Mac')).toBeTruthy()
    })
  })

  it('opens delete confirmation and calls deleteApp', async () => {
    render(<AppControlPanel settings app={baseApp} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText('删除应用？')).toBeTruthy()
    await user.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)
    await waitFor(() => {
      expect(storeMocks.deleteApp).toHaveBeenCalledWith('app-1')
    })
  })

  describe('visibilityChangeNeedsConfirm', () => {
    it("confirms only when the change takes the app off other people's lists", () => {
      // Widening adds people and can surprise nobody; narrowing removes the app
      // from every teammate's list, which "personal" does not say on its own.
      expect(visibilityChangeNeedsConfirm('team', 'personal')).toBe(true)
      expect(visibilityChangeNeedsConfirm('personal', 'team')).toBe(false)
    })

    it('never confirms a change that changes nothing', () => {
      expect(visibilityChangeNeedsConfirm('team', 'team')).toBe(false)
      expect(visibilityChangeNeedsConfirm('personal', 'personal')).toBe(false)
    })
  })

  describe('typeChangeNeedsConfirm', () => {
    it('confirms leaving the data app for any type without a database', () => {
      // The next deploy drops DATABASE_URL, and nothing about "slides" says so.
      expect(typeChangeNeedsConfirm('data_app', 'static_web')).toBe(true)
      expect(typeChangeNeedsConfirm('data_app', 'slides')).toBe(true)
      expect(typeChangeNeedsConfirm('data_app', 'imported')).toBe(true)
    })

    it('treats a legacy stored type as the data app it is', () => {
      expect(typeChangeNeedsConfirm('fullstack_tanstack_postgres', 'static_web')).toBe(true)
      expect(typeChangeNeedsConfirm('fullstack_tanstack_postgres', 'data_app')).toBe(false)
    })

    it('does not confirm gaining a database', () => {
      expect(typeChangeNeedsConfirm('static_web', 'data_app')).toBe(false)
      expect(typeChangeNeedsConfirm('imported', 'data_app')).toBe(false)
    })

    it('does not confirm moving between types that never had a database', () => {
      expect(typeChangeNeedsConfirm('static_web', 'slides')).toBe(false)
      expect(typeChangeNeedsConfirm('slides', 'imported')).toBe(false)
    })

    it('never confirms a change that changes nothing', () => {
      expect(typeChangeNeedsConfirm('data_app', 'data_app')).toBe(false)
      expect(typeChangeNeedsConfirm('static_web', 'static_web')).toBe(false)
    })
  })

  describe('describeCodeVersion', () => {
    const gitea = {
      gitAuthKind: 'gitea_deploy_key',
      gitCommitSha: null,
      fcStatus: 'live',
    } as any
    const head = (over: Record<string, unknown> = {}) =>
      ({
        sha: 'a3f91c2ffff',
        branch: 'main',
        deployedSha: 'b7e2d10aaaa',
        undeployedCommits: 3,
        ...over,
      }) as any

    it('counts the commits when the forge could compare them', () => {
      const out = describeCodeVersion(gitea, head())
      expect(out.vars).toEqual({ sha: 'b7e2d10', branch: 'main', count: 3 })
    })

    it('says up to date when the deployed commit is the head', () => {
      const out = describeCodeVersion(gitea, head({ undeployedCommits: 0 }))
      expect(out.key).toBe('apps.controlPanel.codeVersionUpToDate')
    })

    it('treats an identical sha as up to date even without a count', () => {
      // A server that did not compare still leaves the two shas comparable, and
      // "we did not count" must not read as "there are changes".
      const out = describeCodeVersion(
        gitea,
        head({ deployedSha: 'a3f91c2ffff', undeployedCommits: null }),
      )
      expect(out.key).toBe('apps.controlPanel.codeVersionUpToDate')
    })

    it('admits it cannot count rather than guessing', () => {
      // A force-push past the deployed commit makes /compare 404. Saying
      // "up to date" there would be wrong in the direction that matters.
      const out = describeCodeVersion(gitea, head({ undeployedCommits: null }))
      expect(out.key).toBe('apps.controlPanel.codeVersionBehindUnknown')
    })

    it('distinguishes never-deployed from up-to-date', () => {
      const out = describeCodeVersion(gitea, head({ deployedSha: null }))
      expect(out.key).toBe('apps.controlPanel.codeVersionNeverDeployed')
      expect(out.vars).toEqual({ branch: 'main', head: 'a3f91c2' })
    })

    it("says the repo is somebody else's before it says anything else", () => {
      const out = describeCodeVersion(
        { gitAuthKind: null, gitCommitSha: null, fcStatus: 'live' } as any,
        head(),
      )
      expect(out.key).toBe('apps.controlPanel.codeVersionExternalRepo')
    })

    it('will not call an attempted commit "live" when the deploy did not land', () => {
      // apps.git_commit_sha is stamped when a deploy STARTS. On a failed build
      // the row names the commit that was attempted, not the one serving.
      const out = describeCodeVersion({ ...gitea, fcStatus: 'deploy_error' }, head())
      expect(out.key).toBe('apps.controlPanel.codeVersionNotLive')
      expect(out.vars).toEqual({
        sha: 'b7e2d10',
        branch: 'main',
        head: 'a3f91c2',
      })
    })

    it('says it cannot read the repo when the head never arrived', () => {
      const out = describeCodeVersion(gitea, null)
      expect(out.key).toBe('apps.controlPanel.codeVersionUnavailable')
    })
  })
})
