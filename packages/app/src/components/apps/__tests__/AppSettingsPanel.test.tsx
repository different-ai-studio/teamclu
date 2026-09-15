import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import {
  AppSettingsPanel,
  typeChangeNeedsConfirm,
  visibilityChangeNeedsConfirm,
} from '../AppSettingsPanel'
import type { AppRow } from '@/lib/backend/types'

const tabMocks = vi.hoisted(() => ({ openAppAuth: vi.fn() }))

const daemonMocks = vi.hoisted(() => ({
  daemonAppWorkdir: vi.fn(),
  moveDaemonAppWorkdir: vi.fn(),
}))

const utilMocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  openExternalUrl: vi.fn(),
}))

const storeMocks = vi.hoisted(() => ({
  deployingIds: [] as string[],
  reseed: vi.fn(),
  rename: vi.fn(),
  setVisibility: vi.fn(),
  setType: vi.fn(),
  deleteApp: vi.fn(),
  saveGitCredential: vi.fn(),
  clearGitCredential: vi.fn(),
}))

const actorMocks = vi.hoisted(() => ({
  actors: [{ id: 'actor-1', display_name: '海港' }] as Array<{ id: string; display_name: string }>,
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
  openExternalUrl: (...args: unknown[]) => utilMocks.openExternalUrl(...args),
}))

vi.mock('@/stores/apps-store', () => ({
  useAppsStore: (sel: (s: typeof storeMocks) => unknown) => sel(storeMocks),
}))

vi.mock('@/stores/actor-directory-store', () => ({
  useActorDirectory: () => ({ actors: actorMocks.actors }),
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

const SHA = 'b7e2d10aaaa0123456789abcdef0123456789abc'

const baseApp: AppRow = {
  id: 'app-1',
  teamId: 'team-1',
  name: 'Demo App',
  slug: 'demo-app',
  type: 'static_web',
  visibility: 'team',
  workspaceId: 'ws-1',
  createdByActorId: 'actor-1',
  gitRemoteUrl: 'ssh://git@gitea.example.com:2222/tc/app-1.git',
  gitAuthKind: 'gitea_deploy_key',
  gitCommitSha: SHA,
  runtime: 'node',
  startSpec: {
    port: 9000,
    command: ['node'],
    args: ['server.js'],
    fcRuntime: 'custom.debian10',
    healthCheckPath: '/healthz',
  },
  authMode: 'none',
  authAudience: 'org',
  authScope: 'all',
  authRules: [],
  authModePendingRedeploy: false,
  envPendingRedeploy: false,
  typePendingRedeploy: false,
  customDomain: null,
  customDomainVerifiedAt: null,
  oauthClientId: null,
  provisionStatus: 'ready',
  fcStatus: 'live',
  fcEndpoint: 'https://demo.fcapp.run',
  fcFunctionName: 'tc-app-1',
  fcRegion: 'cn-shenzhen',
  publicUrl: 'https://demo.apps.example.com',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
}

describe('AppSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.deployingIds = []
    actorMocks.actors = [{ id: 'actor-1', display_name: '海港' }]
    daemonMocks.daemonAppWorkdir.mockResolvedValue({
      workdir: '/Users/me/.amuxd/teams/team-1/apps/app-1',
      deviceName: 'Matt Mac',
    })
    storeMocks.deleteApp.mockResolvedValue(true)
    storeMocks.setVisibility.mockResolvedValue(true)
    storeMocks.rename.mockResolvedValue(undefined)
  })

  describe('code', () => {
    it('shows the repository address and copies it', async () => {
      render(<AppSettingsPanel app={baseApp} />)
      expect(screen.getByTestId('app-settings-git-remote').textContent).toBe(baseApp.gitRemoteUrl)
      expect(screen.getByText(/托管仓库/)).toBeTruthy()

      await userEvent.setup().click(screen.getByTestId('app-settings-git-remote-copy'))
      expect(utilMocks.copyToClipboard).toHaveBeenCalledWith(baseApp.gitRemoteUrl)
    })

    it('offers no "open" for an ssh remote, which has nowhere to open', () => {
      render(<AppSettingsPanel app={baseApp} />)
      expect(screen.queryByTestId('app-settings-git-remote-open')).toBeNull()
    })

    it('opens an https remote in the browser', async () => {
      const url = 'https://github.com/owner/repo.git'
      render(
        <AppSettingsPanel
          app={{ ...baseApp, gitAuthKind: null, gitRemoteUrl: url, gitCommitSha: null }}
        />,
      )
      expect(screen.getByText(/外部仓库/)).toBeTruthy()
      await userEvent.setup().click(screen.getByTestId('app-settings-git-remote-open'))
      expect(utilMocks.openExternalUrl).toHaveBeenCalledWith(url)
    })

    it('offers a credential for an https import, and saves one', async () => {
      storeMocks.saveGitCredential.mockResolvedValue(true)
      render(
        <AppSettingsPanel
          app={{
            ...baseApp,
            gitAuthKind: null,
            gitRemoteUrl: 'https://github.com/o/private.git',
            gitCommitSha: null,
          }}
        />,
      )
      const row = within(screen.getByTestId('app-settings-git-credential'))
      expect(row.getByTestId('app-settings-git-credential-status').textContent).toContain('未设置')

      const user = userEvent.setup()
      await user.click(row.getByRole('button', { name: '设置' }))
      await user.type(row.getByLabelText('访问令牌'), 'ghp_abc')
      await user.click(row.getByRole('button', { name: '保存' }))

      expect(storeMocks.saveGitCredential).toHaveBeenCalledWith('app-1', {
        username: '',
        token: 'ghp_abc',
      })
      await waitFor(() =>
        expect(screen.queryByTestId('app-settings-git-credential-form')).toBeNull(),
      )
      expect(toastMocks.success).toHaveBeenCalled()
    })

    it('clears a stored credential only on the second click', async () => {
      storeMocks.clearGitCredential.mockResolvedValue(true)
      render(
        <AppSettingsPanel
          app={{
            ...baseApp,
            gitAuthKind: 'https_token',
            gitRemoteUrl: 'https://github.com/o/private.git',
            gitCommitSha: null,
          }}
        />,
      )
      const row = within(screen.getByTestId('app-settings-git-credential'))
      expect(row.getByTestId('app-settings-git-credential-status').textContent).toContain('已保存')

      const user = userEvent.setup()
      await user.click(row.getByRole('button', { name: '清除' }))
      expect(storeMocks.clearGitCredential).not.toHaveBeenCalled()
      await user.click(row.getByRole('button', { name: '确认清除' }))
      expect(storeMocks.clearGitCredential).toHaveBeenCalledWith('app-1')
    })

    it('asks for no credential on a hosted repo or an ssh import', () => {
      const { unmount } = render(<AppSettingsPanel app={baseApp} />)
      expect(screen.queryByTestId('app-settings-git-credential')).toBeNull()
      unmount()
      render(
        <AppSettingsPanel
          app={{
            ...baseApp,
            gitAuthKind: null,
            gitRemoteUrl: 'git@github.com:o/r.git',
            gitCommitSha: null,
          }}
        />,
      )
      expect(screen.queryByTestId('app-settings-git-credential')).toBeNull()
    })

    it('says a local-only app has no remote rather than leaving the row blank', () => {
      render(
        <AppSettingsPanel
          app={{ ...baseApp, gitAuthKind: null, gitRemoteUrl: null, gitCommitSha: null }}
        />,
      )
      expect(screen.getByText('没有远端仓库')).toBeTruthy()
      expect(screen.getByText(/仅本机/)).toBeTruthy()
    })

    it('shows the deployed commit in full', () => {
      // A shortened SHA is fine to glance at and wrong to paste.
      render(<AppSettingsPanel app={baseApp} />)
      expect(screen.getByTestId('app-settings-commit').textContent).toBe(SHA)
      expect(screen.queryByText(/那次没有成功上线/)).toBeNull()
    })

    it('will not present an attempted commit as the one serving', () => {
      // git_commit_sha is stamped when a deploy STARTS.
      render(<AppSettingsPanel app={{ ...baseApp, fcStatus: 'deploy_error' }} />)
      expect(screen.getByText(/那次没有成功上线/)).toBeTruthy()
    })

    it('says an imported app deploys its folder, not a commit', () => {
      render(
        <AppSettingsPanel
          app={{
            ...baseApp,
            gitAuthKind: null,
            gitRemoteUrl: 'https://github.com/o/r.git',
            gitCommitSha: null,
          }}
        />,
      )
      expect(screen.getByText('部署的是本机目录，不对应某个提交')).toBeTruthy()
    })

    it('says a hosted app with no commit has never been deployed', () => {
      render(<AppSettingsPanel app={{ ...baseApp, gitCommitSha: null, fcStatus: null }} />)
      expect(screen.getByText('还没有部署过')).toBeTruthy()
    })

    it('copies the local path', async () => {
      render(<AppSettingsPanel app={baseApp} />)
      await waitFor(() => expect(screen.getByTestId('app-control-copy-path')).toBeTruthy())
      await userEvent.setup().click(screen.getByTestId('app-control-copy-path'))
      expect(utilMocks.copyToClipboard).toHaveBeenCalledWith(
        '/Users/me/.amuxd/teams/team-1/apps/app-1',
      )
    })

    it('shows local workdir and device name', async () => {
      render(<AppSettingsPanel app={baseApp} />)
      await waitFor(() => {
        expect(screen.getByTestId('app-control-local-workdir').textContent).toContain(
          '/Users/me/.amuxd/teams/team-1/apps/app-1',
        )
        expect(screen.getByText('设备：Matt Mac')).toBeTruthy()
      })
    })
  })

  describe('deployment', () => {
    it('shows where the app answers and what runs it', () => {
      render(<AppSettingsPanel app={baseApp} />)
      expect(screen.getByTestId('app-settings-address').textContent).toBe(baseApp.publicUrl)
      expect(screen.getByTestId('app-settings-endpoint').textContent).toBe(baseApp.fcEndpoint)

      const fn = screen.getByTestId('app-settings-function').textContent
      expect(fn).toContain('tc-app-1')
      expect(fn).toContain('cn-shenzhen')

      const start = screen.getByTestId('app-settings-start').textContent
      expect(start).toContain('node')
      expect(start).toContain('9000')
      expect(start).toContain('node server.js')
      expect(start).toContain('custom.debian10')
      expect(start).toContain('/healthz')
    })

    it('opens the live address', async () => {
      render(<AppSettingsPanel app={baseApp} />)
      await userEvent.setup().click(screen.getByTestId('app-settings-address-open'))
      expect(utilMocks.openExternalUrl).toHaveBeenCalledWith(baseApp.publicUrl)
    })

    it('does not repeat the endpoint when it is the only address', () => {
      render(<AppSettingsPanel app={{ ...baseApp, publicUrl: null }} />)
      expect(screen.getByTestId('app-settings-address').textContent).toBe(baseApp.fcEndpoint)
      expect(screen.queryByTestId('app-settings-endpoint')).toBeNull()
    })

    it('says the start config is unknown before a successful deploy', () => {
      // `runtime` defaults to node on the server; printing it before any deploy
      // declared one would state a guess as a fact.
      render(
        <AppSettingsPanel
          app={{
            ...baseApp,
            startSpec: null,
            fcStatus: null,
            fcEndpoint: null,
            publicUrl: null,
            fcFunctionName: null,
            fcRegion: null,
          }}
        />,
      )
      expect(screen.getByText('还没有成功部署过')).toBeTruthy()
      expect(screen.queryByTestId('app-settings-start')).toBeNull()
      expect(screen.queryByTestId('app-settings-function')).toBeNull()
    })

    it('says a settings change is waiting for a deploy only while it is', () => {
      const { rerender } = render(<AppSettingsPanel app={baseApp} />)
      expect(screen.queryByText(/这些变量还没有生效/)).toBeNull()
      expect(screen.queryByText(/登录设置已生效/)).toBeNull()

      rerender(
        <AppSettingsPanel
          app={{ ...baseApp, envPendingRedeploy: true, authModePendingRedeploy: true }}
        />,
      )
      expect(screen.getByText(/这些变量还没有生效/)).toBeTruthy()
      expect(screen.getByText(/登录设置已生效/)).toBeTruthy()
    })
  })

  describe('general', () => {
    it('names the creator and shows every identifier', () => {
      render(<AppSettingsPanel app={baseApp} />)
      expect(screen.getByTestId('app-settings-created').textContent).toContain('海港')
      const ids = screen.getByTestId('app-settings-identifiers').textContent
      expect(ids).toContain('app-1')
      expect(ids).toContain('demo-app')
      expect(ids).toContain('ws-1')
    })

    it('says the creator is unknown rather than showing an actor id', () => {
      actorMocks.actors = []
      render(<AppSettingsPanel app={baseApp} />)
      const created = screen.getByTestId('app-settings-created').textContent
      expect(created).toContain('未知成员')
      expect(created).not.toContain('actor-1')
    })

    it('renames on Enter and puts the name back on Escape', async () => {
      render(<AppSettingsPanel app={baseApp} />)
      const user = userEvent.setup()
      const input = screen.getByTestId('app-settings-name') as HTMLInputElement
      expect(screen.queryByTestId('app-settings-name-save')).toBeNull()

      await user.clear(input)
      await user.type(input, 'Draft{Escape}')
      expect(input.value).toBe(baseApp.name)
      expect(storeMocks.rename).not.toHaveBeenCalled()

      await user.clear(input)
      await user.type(input, 'New name')
      expect(screen.getByTestId('app-settings-name-save')).toBeTruthy()
      await user.type(input, '{Enter}')
      await waitFor(() => expect(storeMocks.rename).toHaveBeenCalledWith('app-1', 'New name'))
    })

    it("shows what the app's visibility currently means, not just its name", () => {
      // "Personal" does not tell anyone that the local daemon cannot see the app.
      const { rerender } = render(<AppSettingsPanel app={baseApp} />)
      expect(screen.getByTestId('app-control-visibility').textContent).toContain('全团队可见')
      expect(screen.getByText(/团队里每个人都能在应用列表里看到它/)).toBeTruthy()

      rerender(<AppSettingsPanel app={{ ...baseApp, visibility: 'personal' }} />)
      expect(screen.getByTestId('app-control-visibility').textContent).toContain(
        '仅自己和被授权的人',
      )
      expect(screen.getByText(/本机 daemon 也看不到它/)).toBeTruthy()
    })

    it('does not open a confirm before anything is asked for', () => {
      render(<AppSettingsPanel app={baseApp} />)
      expect(screen.queryByTestId('app-control-visibility-confirm')).toBeNull()
      expect(screen.queryByTestId('app-control-type-confirm')).toBeNull()
    })

    it('names the app type and says what that type is', () => {
      const { rerender } = render(<AppSettingsPanel app={baseApp} />)
      expect(screen.getByTestId('app-control-type').textContent).toContain('静态网页')
      expect(screen.getByTestId('app-control-type-hint').textContent).toContain('一个网站')

      rerender(<AppSettingsPanel app={{ ...baseApp, type: 'imported' }} />)
      expect(screen.getByTestId('app-control-type').textContent).toContain('导入的仓库')
    })

    it('reads a pre-split stored type as the data app it is', () => {
      // A raw value would match no option and leave the trigger blank for every
      // app created before types existed.
      render(<AppSettingsPanel app={{ ...baseApp, type: 'fullstack_tanstack_postgres' }} />)
      expect(screen.getByTestId('app-control-type').textContent).toContain('数据操作')
      expect(screen.getByTestId('app-control-type-hint').textContent).toContain('自带一个数据库')
    })

    it('says a type change waits for the next deploy only while it does', () => {
      const { rerender } = render(<AppSettingsPanel app={baseApp} />)
      expect(screen.queryByTestId('app-control-type-pending')).toBeNull()

      rerender(<AppSettingsPanel app={{ ...baseApp, typePendingRedeploy: true }} />)
      expect(screen.getByTestId('app-control-type-pending').textContent).toContain('下次部署')
    })

    it('treats a server that does not send the pending flag as nothing pending', () => {
      const { typePendingRedeploy: _omitted, ...olderRow } = baseApp
      render(<AppSettingsPanel app={olderRow as AppRow} />)
      expect(screen.queryByTestId('app-control-type-pending')).toBeNull()
    })
  })

  describe('live access', () => {
    it('says the site needs no login when it does not', () => {
      render(<AppSettingsPanel app={baseApp} />)
      const auth = screen.getByTestId('app-settings-auth').textContent
      expect(auth).toContain('无需登录（公开）')
      expect(auth).not.toContain('全站')
    })

    it('summarises the wall and the page rules', () => {
      render(
        <AppSettingsPanel
          app={{
            ...baseApp,
            authMode: 'platform',
            authRules: [{ path: '/admin', auth: 'required' }],
            oauthClientId: 'client-123',
          }}
        />,
      )
      const auth = screen.getByTestId('app-settings-auth').textContent
      expect(auth).toContain('TeamClu 账号登录')
      expect(auth).toContain('其余页面：需要登录 · 组织角色')
      expect(auth).toContain('1 条页面规则')
      expect(screen.getByTestId('app-settings-oauth-client').textContent).toBe('client-123')
    })

    it('reads a scope of paths as public everywhere else', () => {
      render(
        <AppSettingsPanel
          app={{
            ...baseApp,
            authMode: 'platform',
            authScope: 'paths',
            authAudience: 'any',
          }}
        />,
      )
      expect(screen.getByTestId('app-settings-auth').textContent).toContain('全站：不需要登录')
    })

    it('reads a missing audience as the strict one', () => {
      // An older server omits it; it must never make the wall look wider.
      const { authAudience: _omitted, ...olderRow } = { ...baseApp, authMode: 'platform' as const }
      render(<AppSettingsPanel app={olderRow as AppRow} />)
      expect(screen.getByTestId('app-settings-auth').textContent).toContain('组织角色')
    })

    it('edits the wall in its own tab', async () => {
      render(<AppSettingsPanel app={baseApp} />)
      await userEvent.setup().click(screen.getByTestId('app-settings-open-auth'))
      expect(tabMocks.openAppAuth).toHaveBeenCalledWith(baseApp, '应用权限')
    })
  })

  it('opens delete confirmation and calls deleteApp', async () => {
    render(<AppSettingsPanel app={baseApp} />)
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
})
