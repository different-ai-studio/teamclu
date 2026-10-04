import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppAuthTabContent } from '../AppAuthTabContent'
import type { AppRow } from '@/lib/backend/types'

const storeMocks = vi.hoisted(() => ({
  items: [] as AppRow[],
  deployingIds: [] as string[],
  updateAuthPolicy: vi.fn(),
  deploy: vi.fn(),
}))

const getApp = vi.hoisted(() => vi.fn())
const getAppAuthInfo = vi.hoisted(() => vi.fn())

const orgRolesList = vi.hoisted(() =>
  vi.fn(async () => [
    { id: 'r-admin', orgId: 'o1', name: '管理员', code: 'admin', description: null, isSystem: true, status: 'active', sort: 1, parentRoleId: null },
    { id: 'r-finance', orgId: 'o1', name: '财务', code: 'finance', description: null, isSystem: true, status: 'active', sort: 2, parentRoleId: null },
    { id: 'r-member', orgId: 'o1', name: '成员', code: 'member', description: null, isSystem: true, status: 'active', sort: 3, parentRoleId: null },
  ]),
)

vi.mock('@/stores/apps-store', () => ({
  useAppsStore: (sel: (s: typeof storeMocks) => unknown) => sel(storeMocks),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    orgRoles: { list: orgRolesList },
    apps: { getAppAuthInfo, getApp },
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: Record<string, string>) => {
      let text = fallback ?? key
      if (opts) {
        for (const [k, v] of Object.entries(opts)) text = text.replace(`{{${k}}}`, String(v))
      }
      return text
    },
  }),
}))

const baseApp = {
  id: 'app-1',
  teamId: 'team-1',
  name: 'Demo App',
  slug: 'demo',
  authMode: 'platform',
  authAudience: 'any',
  authScope: 'all',
  authRules: [],
  authModePendingRedeploy: false,
  provisionStatus: 'ready',
} as unknown as AppRow

async function renderWith(over: Partial<AppRow> = {}) {
  storeMocks.items = [{ ...baseApp, ...over } as AppRow]
  const result = render(<AppAuthTabContent appId="app-1" />)
  await waitFor(() => expect(getAppAuthInfo).toHaveBeenCalled())
  await waitFor(() => expect(screen.queryByTestId('app-auth-loading')).toBeNull())
  if ((over.authMode ?? baseApp.authMode) === 'platform') {
    await waitFor(() => expect(screen.getByTestId('app-auth-baseline-login')).toBeTruthy())
  } else {
    await waitFor(() => expect(screen.getByTestId('app-auth-mode')).toBeTruthy())
  }
  return result
}

describe('AppAuthTabContent', () => {
  it('blocks saving when the org role catalog could not be loaded', async () => {
    // An empty catalog is indistinguishable from "restricts nobody": it renders
    // a legacy `audience: org` app as "any signed-in user", and saving from
    // there writes `roles: []`, which the gateway admits everyone on. One
    // failed request would silently open a staff-only app.
    getAppAuthInfo.mockRejectedValueOnce(new Error('network'))
    storeMocks.items = [{ ...baseApp, authAudience: 'org' } as AppRow]
    render(<AppAuthTabContent appId="app-1" />)

    await waitFor(() => expect(screen.getByTestId('app-auth-roles-error')).toBeTruthy())
    expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled', true)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    Element.prototype.hasPointerCapture = () => false
    Element.prototype.setPointerCapture = () => {}
    Element.prototype.releasePointerCapture = () => {}
    Element.prototype.scrollIntoView = () => {}
    storeMocks.deployingIds = []
    storeMocks.updateAuthPolicy.mockResolvedValue(true)
    getApp.mockImplementation(async (id: string) => storeMocks.items.find(app => app.id === id))
    getAppAuthInfo.mockImplementation(async (id: string) => {
      const app = storeMocks.items.find(app => app.id === id)!
      return { ...app, appId: id, organization: { id: 'o1', name: 'Test Organization' }, organizationStatus: 'configured', roles: await orgRolesList(), effectivePolicies: [] }
    })
    orgRolesList.mockResolvedValue([
      { id: 'r-admin', orgId: 'o1', name: '管理员', code: 'admin', description: null, isSystem: true, status: 'active', sort: 1, parentRoleId: null },
      { id: 'r-finance', orgId: 'o1', name: '财务', code: 'finance', description: null, isSystem: true, status: 'active', sort: 2, parentRoleId: null },
      { id: 'r-member', orgId: 'o1', name: '成员', code: 'member', description: null, isSystem: true, status: 'active', sort: 3, parentRoleId: null },
    ])
  })

  it('loads nullable public and inherited rules without writes and preserves them on an unrelated edit', async () => {
    const authRules = [
      {path:'/public',auth:'public',roles:null,audience:null},
      {path:'/staff',auth:'required',roles:null,audience:null},
      {path:'/other',auth:'required',audience:'org'},
    ] as unknown as AppRow['authRules']
    await renderWith({authAudience:'org',authRules})
    expect(screen.getByTestId('app-auth-rule-roles-0')).toHaveProperty('disabled',true)
    expect(screen.getByTestId('app-auth-rule-roles-1').textContent).toContain('继承应用默认')
    expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled',true)
    expect(storeMocks.updateAuthPolicy).not.toHaveBeenCalled()
    await userEvent.setup().type(screen.getByTestId('app-auth-rule-path-2'),'/edit')
    await userEvent.setup().click(screen.getByTestId('app-auth-save'))
    await waitFor(() => expect(storeMocks.updateAuthPolicy).toHaveBeenCalled())
    expect(storeMocks.updateAuthPolicy.mock.calls[0][1].authRules).toEqual([
      authRules![0],authRules![1],{path:'/other/edit',auth:'required',audience:'org'},
    ])
  })

  it('shows three columns: path, login, and roles', async () => {
    await renderWith({ authScope: 'all', authAudience: 'any' })
    expect(screen.getByText('页面地址')).toBeTruthy()
    expect(screen.getByText('是否需要登录')).toBeTruthy()
    expect(screen.getByText('角色')).toBeTruthy()
    expect(screen.getByTestId('app-auth-baseline-login').textContent).toContain('需要登录')
    expect(screen.getByTestId('app-auth-baseline-roles').textContent).toContain('任意已登录用户')
  })

  it('reads scope=paths as a public baseline and disables roles', async () => {
    await renderWith({
      authScope: 'paths',
      authAudience: 'org',
      authRules: [{ path: '/admin', auth: 'required', roles: ['admin'] }],
    })
    expect(screen.getByTestId('app-auth-baseline-login').textContent).toContain('不需要登录')
    expect(screen.getByTestId('app-auth-baseline-roles')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('app-auth-rule-roles-0')).not.toHaveProperty('disabled', true)
  })

  it('shows dynamic and inherited org audiences without selecting the catalog', async () => {
    await renderWith({ authAudience: 'org', authRules: [{ path: '/reports', auth: 'required' }] })
    expect(screen.getByTestId('app-auth-baseline-roles').textContent).toContain('组织内任意有效角色')
    expect(screen.getByTestId('app-auth-rule-roles-0').textContent).toContain('继承应用默认')
    expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled', true)
    expect(storeMocks.updateAuthPolicy).not.toHaveBeenCalled()
  })

  it('retains failed save drafts and reports the failure', async () => {
    storeMocks.updateAuthPolicy.mockResolvedValue(false)
    await renderWith({ authRules: [{ path: '/staff', auth: 'required', audience: 'org' }] })
    await userEvent.setup().type(screen.getByTestId('app-auth-rule-path-0'), '/edit')
    await userEvent.setup().click(screen.getByTestId('app-auth-save'))
    await waitFor(() => expect(screen.getByTestId('app-auth-save-error')).toBeTruthy())
    expect(screen.getByTestId('app-auth-rule-path-0')).toHaveProperty('value', '/staff/edit')
    expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled', false)
  })

  it('distinguishes successful PATCH from failed confirmation read', async () => {
    await renderWith({ authRules: [{ path: '/staff', auth: 'required', audience: 'org' }] })
    getApp.mockRejectedValueOnce(new Error('network'))
    await userEvent.setup().type(screen.getByTestId('app-auth-rule-path-0'), '/edit')
    await userEvent.setup().click(screen.getByTestId('app-auth-save'))
    await waitFor(() => expect(screen.getByTestId('app-auth-readback-error')).toBeTruthy())
    expect(screen.getByTestId('app-auth-readback-error').textContent).toContain('保存已成功')
    expect(screen.getByTestId('app-auth-rule-path-0')).toHaveProperty('value', '/staff/edit')
  })

  it('keeps unknown role codes visible and preserves them on a failed submission', async () => {
    storeMocks.updateAuthPolicy.mockResolvedValue(false)
    await renderWith({ authRules: [{ path: '/staff', auth: 'required', roles: ['retired', 'missing'] }] })
    expect(screen.getByTestId('app-auth-rule-roles-0-codes').textContent).toContain('retired, missing')
    await userEvent.setup().type(screen.getByTestId('app-auth-rule-path-0'), '/edit')
    await userEvent.setup().click(screen.getByTestId('app-auth-save'))
    await waitFor(() => expect(screen.getByTestId('app-auth-save-error')).toBeTruthy())
    expect(storeMocks.updateAuthPolicy.mock.calls[0][1].authRules[0].roles).toEqual(['retired', 'missing'])
  })

  it('does not overwrite drafts when the store or catalog changes', async () => {
    const view = await renderWith({ authRules: [{ path: '/staff', auth: 'required', audience: 'org' }] })
    await userEvent.setup().type(screen.getByTestId('app-auth-rule-path-0'), '/draft')
    storeMocks.items = [{ ...storeMocks.items[0], authModePendingRedeploy: true }]
    orgRolesList.mockResolvedValue([])
    view.rerender(<AppAuthTabContent appId="app-1" />)
    expect(screen.getByTestId('app-auth-rule-path-0')).toHaveProperty('value', '/staff/draft')
  })

  it('discards a late auth-info result after switching apps', async () => {
    let resolveOld!: (value: unknown) => void
    getAppAuthInfo.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    storeMocks.items = [{ ...baseApp }, { ...baseApp, id: 'app-2', authAudience: 'org', authRules: [{ path: '/new', auth: 'required', audience: 'org' }] }]
    const view = render(<AppAuthTabContent appId="app-1" />)
    view.rerender(<AppAuthTabContent appId="app-2" />)
    await waitFor(() => expect(screen.queryByTestId('app-auth-loading')).toBeNull())
    await act(async () => resolveOld({ ...baseApp, organizationStatus: 'configured', organization: { id: 'old', name: 'Old Org' }, roles: [] }))
    expect(screen.getByTestId('app-auth-rule-path-0')).toHaveProperty('value', '/new')
    expect(screen.queryByText(/Old Org/)).toBeNull()
  })

  it('takes the successfully confirmed server policy as the new baseline', async () => {
    await renderWith({ authRules: [{ path: '/staff', auth: 'required', audience: 'org' }] })
    storeMocks.updateAuthPolicy.mockImplementationOnce(async (_id, patch) => {
      storeMocks.items = [{ ...storeMocks.items[0], ...patch, authRules: [{ path: '/server', auth: 'required', roles: ['reviewer'] }] }]
      return true
    })
    await userEvent.setup().type(screen.getByTestId('app-auth-rule-path-0'), '/edit')
    await userEvent.setup().click(screen.getByTestId('app-auth-save'))
    await waitFor(() => expect(screen.getByTestId('app-auth-rule-path-0')).toHaveProperty('value', '/server'))
    expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled', true)
  })

  it('supports a custom reviewer role without selecting the whole catalog', async () => {
    orgRolesList.mockResolvedValue([{ id: 'reviewer', code: 'reviewer', name: 'Reviewer', status: 'active' } as never])
    await renderWith({ authScope: 'paths', authRules: [{ path: '/staff', auth: 'required', audience: 'org' }] })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('app-auth-rule-roles-0'))
    await user.click(screen.getByRole('option', { name: '指定组织角色之一' }))
    expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled', true)
    await user.click(screen.getByTestId('app-auth-rule-roles-0-codes'))
    await user.click(screen.getByRole('checkbox'))
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('app-auth-save'))
    await waitFor(() => expect(storeMocks.updateAuthPolicy).toHaveBeenCalled())
    expect(storeMocks.updateAuthPolicy.mock.calls[0][1].authRules).toEqual([{ path: '/staff', auth: 'required', roles: ['reviewer'] }])
  })

  it('shows selected orphan codes even when the active catalog is empty', async () => {
    orgRolesList.mockResolvedValue([])
    await renderWith({ authRules: [{ path: '/staff', auth: 'required', roles: ['reviewer'] }] })
    await userEvent.setup().click(screen.getByTestId('app-auth-rule-roles-0-codes'))
    expect(screen.getByRole('checkbox').getAttribute('data-state')).toBe('checked')
    expect(screen.getByText(/已停用或缺失/)).toBeTruthy()
    expect(storeMocks.updateAuthPolicy).not.toHaveBeenCalled()
  })

  it('preserves an actually inactive catalog role and permits explicit removal', async () => {
    orgRolesList.mockResolvedValue([{ id: 'r-reviewer', code: 'reviewer', name: 'Reviewer', status: 'inactive' } as never])
    await renderWith({ authRules: [{ path: '/staff', auth: 'required', roles: ['reviewer'] }] })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('app-auth-rule-roles-0-codes'))
    expect(screen.getByText(/Reviewer.*已停用或缺失/)).toBeTruthy()
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox.getAttribute('data-state')).toBe('checked')
    expect(checkbox).not.toHaveProperty('disabled', true)
    await user.click(checkbox)
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled', true)
    expect(storeMocks.updateAuthPolicy).not.toHaveBeenCalled()
  })

  for (const phase of ['write', 'readback'] as const) {
    it(`ignores old-app ${phase} completion after an app switch`, async () => {
      let finish!: (value: any) => void
      const pending = new Promise(resolve => { finish = resolve })
      const view = await renderWith({ authRules: [{ path: '/old', auth: 'required', audience: 'org' }] })
      if (phase === 'write') storeMocks.updateAuthPolicy.mockReturnValueOnce(pending)
      else getAppAuthInfo.mockReturnValueOnce(pending)
      const user = userEvent.setup()
      await user.type(screen.getByTestId('app-auth-rule-path-0'), '/edit')
      await user.click(screen.getByTestId('app-auth-save'))
      if (phase === 'readback') await waitFor(() => expect(getAppAuthInfo).toHaveBeenCalledTimes(2))
      const next = { ...baseApp, id: 'app-2', authRules: [{ path: '/next', auth: 'required' as const, roles: [] }] }
      storeMocks.items = [next]
      view.rerender(<AppAuthTabContent appId="app-2" />)
      await waitFor(() => expect(screen.getByTestId('app-auth-rule-path-0')).toHaveProperty('value', '/next'))
      await act(async () => { finish(phase === 'write' ? false : { ...baseApp, roles: [], organization: null, organizationStatus: 'unconfigured', authRules: [{ path: '/stale', auth: 'required' }] }); await pending })
      expect(screen.getByTestId('app-auth-rule-path-0')).toHaveProperty('value', '/next')
      expect(screen.queryByTestId('app-auth-save-error')).toBeNull()
      expect(screen.queryByTestId('app-auth-readback-error')).toBeNull()
      expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled', true)
      expect(storeMocks.updateAuthPolicy).toHaveBeenCalledTimes(1)
    })
  }

  it('requires confirmation of an app-default change affecting inherited paths', async () => {
    await renderWith({ authAudience: 'org', authRules: [{ path: '/staff', auth: 'required' }] })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('app-auth-baseline-roles'))
    await user.click(screen.getByRole('option', { name: '任意已登录用户' }))
    expect(screen.getByTestId('app-auth-rule-roles-0').textContent).toContain('任意已登录用户')
    expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByTestId('app-auth-save'))
    await waitFor(() => expect(storeMocks.updateAuthPolicy).toHaveBeenCalled())
    expect(storeMocks.updateAuthPolicy.mock.calls[0][1].authRules).toEqual([{ path: '/staff', auth: 'required' }])
    expect(storeMocks.updateAuthPolicy.mock.calls[0][1].authAudience).toBe('any')
  })

  it('blocks organization audience configuration when no organization is configured', async () => {
    getAppAuthInfo.mockImplementationOnce(async () => ({ ...baseApp, organization: null, organizationStatus: 'unconfigured', roles: [], authAudience: 'org', authRules: [{ path: '/staff', auth: 'required', audience: 'org' }] }))
    await renderWith({ authAudience: 'org', authRules: [{ path: '/staff', auth: 'required', audience: 'org' }] })
    expect(screen.getByText('应用未配置组织，无法配置组织受众。')).toBeTruthy()
    await userEvent.setup().type(screen.getByTestId('app-auth-rule-path-0'), '/edit')
    expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled', true)
  })

  it('maps audience any to empty role codes', async () => {
    await renderWith({
      authAudience: 'any',
      authRules: [{ path: '/reports', auth: 'required' }],
    })
    expect(screen.getByTestId('app-auth-rule-roles-0').textContent).toContain('任意已登录用户')
  })

  it('saves another path without injecting a missing root rule', async () => {
    await renderWith({
      authAudience: 'any',
      authScope: 'all',
      authRules: [{ path: '/admin', auth: 'required', roles: ['admin'] }],
    })
    const user = userEvent.setup()

    await user.click(screen.getByTestId('app-auth-add-rule'))
    await user.type(screen.getByTestId('app-auth-rule-path-1'), '/reports')
    await user.click(screen.getByTestId('app-auth-save'))

    await waitFor(() => expect(storeMocks.updateAuthPolicy).toHaveBeenCalled())
    const [appId, patch] = storeMocks.updateAuthPolicy.mock.calls[0]
    expect(appId).toBe('app-1')
    expect(patch.authMode).toBe('platform')
    expect(patch.authScope).toBe('all')
    // 'org' because /admin restricts roles: auth_audience is the gateway's
    // last-resort answer for an unreadable path, and 'any' there would admit
    // every signed-in visitor to an app that names specific roles.
    expect(patch.authAudience).toBe('any')
    expect(patch.authRules).toEqual([
      { path: '/admin', auth: 'required', roles: ['admin'] },
      { path: '/reports', auth: 'required' },
    ])
  })

  it('refuses to save a public baseline with nothing protected', async () => {
    await renderWith({
      authScope: 'paths',
      authAudience: 'any',
      authRules: [{ path: '/admin', auth: 'required', roles: ['admin'] }],
    })
    expect(screen.queryByTestId('app-auth-nothing-protected')).toBeNull()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove' }))

    expect(screen.getByTestId('app-auth-nothing-protected')).toBeTruthy()
    expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled', true)
    expect(storeMocks.updateAuthPolicy).not.toHaveBeenCalled()
  })

  it('disables roles when a rule is public', async () => {
    await renderWith({
      authScope: 'paths',
      authRules: [{ path: '/health', auth: 'public' }],
    })
    expect(screen.getByTestId('app-auth-rule-login-0').textContent).toContain('不需要登录')
    expect(screen.getByTestId('app-auth-rule-roles-0')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('app-auth-rule-roles-0').textContent).toContain('任意已登录用户')
  })

  it('leaves the page list out entirely when there is no wall', async () => {
    await renderWith({ authMode: 'none' })
    expect(screen.queryByTestId('app-auth-add-rule')).toBeNull()
  })

  it('offers a redeploy only while the function env lags', async () => {
    const { rerender } = await renderWith({ authModePendingRedeploy: false })
    expect(screen.queryByTestId('app-auth-redeploy-now')).toBeNull()

    storeMocks.items = [{ ...baseApp, authModePendingRedeploy: true } as AppRow]
    rerender(<AppAuthTabContent appId="app-1" />)
    await waitFor(() => expect(screen.getByTestId('app-auth-redeploy-now')).toBeTruthy())
  })

  it('says the app is gone rather than rendering an empty form', async () => {
    storeMocks.items = []
    render(<AppAuthTabContent appId="app-1" />)
    expect(screen.getByText(/找不到这个应用/)).toBeTruthy()
  })
})
