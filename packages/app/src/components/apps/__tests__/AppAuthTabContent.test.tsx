import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
  await waitFor(() => expect(orgRolesList).toHaveBeenCalled())
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
    orgRolesList.mockRejectedValueOnce(new Error('network'))
    storeMocks.items = [{ ...baseApp, authAudience: 'org' } as AppRow]
    render(<AppAuthTabContent appId="app-1" />)

    await waitFor(() => expect(screen.getByTestId('app-auth-roles-error')).toBeTruthy())
    expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled', true)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.deployingIds = []
    storeMocks.updateAuthPolicy.mockResolvedValue(true)
    orgRolesList.mockResolvedValue([
      { id: 'r-admin', orgId: 'o1', name: '管理员', code: 'admin', description: null, isSystem: true, status: 'active', sort: 1, parentRoleId: null },
      { id: 'r-finance', orgId: 'o1', name: '财务', code: 'finance', description: null, isSystem: true, status: 'active', sort: 2, parentRoleId: null },
      { id: 'r-member', orgId: 'o1', name: '成员', code: 'member', description: null, isSystem: true, status: 'active', sort: 3, parentRoleId: null },
    ])
  })

  it('shows three columns: path, login, and roles', async () => {
    await renderWith({ authScope: 'all', authAudience: 'any' })
    expect(screen.getByText('页面地址')).toBeTruthy()
    expect(screen.getByText('是否需要登录')).toBeTruthy()
    expect(screen.getByText('角色')).toBeTruthy()
    expect(screen.getByTestId('app-auth-baseline-login').textContent).toContain('需要登录')
    expect(screen.getByTestId('app-auth-baseline-roles').textContent).toContain('任意用户')
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

  it('prefills all org role codes for legacy audience org', async () => {
    await renderWith({
      authScope: 'all',
      authAudience: 'org',
      authRules: [{ path: '/reports', auth: 'required' }],
    })
    expect(screen.getByTestId('app-auth-baseline-roles').textContent).toContain('admin')
    expect(screen.getByTestId('app-auth-baseline-roles').textContent).toContain('finance')
    expect(screen.getByTestId('app-auth-baseline-roles').textContent).toContain('member')
    expect(screen.getByTestId('app-auth-rule-roles-0').textContent).toContain('admin')
  })

  it('maps audience any to empty role codes', async () => {
    await renderWith({
      authAudience: 'any',
      authRules: [{ path: '/reports', auth: 'required' }],
    })
    expect(screen.getByTestId('app-auth-rule-roles-0').textContent).toContain('任意用户')
  })

  it('saves path rules with roles and injects a / baseline rule', async () => {
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
    expect(patch.authAudience).toBe('org')
    expect(patch.authRules).toEqual([
      { path: '/', auth: 'required', roles: [] },
      { path: '/admin', auth: 'required', roles: ['admin'] },
      { path: '/reports', auth: 'required', roles: [] },
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
    expect(screen.getByTestId('app-auth-rule-roles-0').textContent).toContain('任意用户')
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
