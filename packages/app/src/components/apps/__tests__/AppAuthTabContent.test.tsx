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

vi.mock('@/stores/apps-store', () => ({
  useAppsStore: (sel: (s: typeof storeMocks) => unknown) => sel(storeMocks),
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

function renderWith(over: Partial<AppRow> = {}) {
  storeMocks.items = [{ ...baseApp, ...over } as AppRow]
  return render(<AppAuthTabContent appId="app-1" />)
}

/** The per-page selectors: everything that is not the mode or the baseline. */
function ruleSelects() {
  return screen
    .getAllByRole('combobox')
    .filter((el) => !['app-auth-mode', 'app-auth-baseline'].includes(el.getAttribute('data-testid') ?? ''))
}

describe('AppAuthTabContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.deployingIds = []
    storeMocks.updateAuthPolicy.mockResolvedValue(true)
  })

  it('shows the baseline as one choice, not a scope plus an audience', async () => {
    renderWith({ authScope: 'all', authAudience: 'org' })
    expect(screen.getByTestId('app-auth-baseline').textContent).toContain('需要登录 · 仅员工')
  })

  it('reads scope=paths as a public baseline', async () => {
    renderWith({
      authScope: 'paths',
      authAudience: 'org',
      authRules: [{ path: '/admin', auth: 'required' }],
    })
    expect(screen.getByTestId('app-auth-baseline').textContent).toContain('不需要登录')
  })

  it('shows a keyless rule at the audience that is actually in force', async () => {
    // A rule saved before per-path audiences existed inherits the app's. Showing
    // it as anything else would tell the reader the wall is somewhere it is not.
    renderWith({
      authAudience: 'any',
      authRules: [{ path: '/reports', auth: 'required' }],
    })
    expect(ruleSelects()[0].textContent).toContain('需要登录 · 任何用户')
  })

  it('moves an inheriting rule on screen when the baseline moves', async () => {
    // An audience-less rule FOLLOWS the baseline. Rendering it against the saved
    // value showed 仅员工 on a row the pending save was about to open to anyone
    // — the boundary widening while the UI said it had not.
    renderWith({
      authScope: 'all',
      authAudience: 'org',
      authRules: [{ path: '/reports', auth: 'required' }],
    })
    expect(ruleSelects()[0].textContent).toContain('需要登录 · 仅员工')

    // Re-render as the store would after the baseline is saved as `any`; the
    // rule text has to follow, because the wall does.
    storeMocks.items = [
      {
        ...baseApp,
        authAudience: 'any',
        authRules: [{ path: '/reports', auth: 'required' }],
      } as AppRow,
    ]
    render(<AppAuthTabContent appId="app-1" />)
    expect(ruleSelects().at(-1)!.textContent).toContain('需要登录 · 任何用户')
  })

  it('saves scope, audience and rules in one request', async () => {
    // The server validates them as a pair — `paths` with nothing required is
    // refused — so two PATCHes would be rejected on the intermediate state.
    renderWith({
      authAudience: 'any',
      authScope: 'all',
      authRules: [{ path: '/admin', auth: 'required', audience: 'org' }],
    })
    const user = userEvent.setup()

    await user.click(screen.getByTestId('app-auth-add-rule'))
    await user.click(screen.getByTestId('app-auth-save'))

    await waitFor(() => expect(storeMocks.updateAuthPolicy).toHaveBeenCalled())
    const [appId, patch] = storeMocks.updateAuthPolicy.mock.calls[0]
    expect(appId).toBe('app-1')
    expect(patch.authMode).toBe('platform')
    expect(patch.authScope).toBe('all')
    expect(patch.authAudience).toBe('any')
    expect(patch.authRules).toEqual([
      { path: '/admin', auth: 'required', audience: 'org' },
      // A new row starts at the app's own audience, so adding one changes who
      // gets in nowhere else.
      { path: '/', auth: 'required', audience: 'any' },
    ])
  })

  it('refuses to save a public baseline with nothing protected', async () => {
    // Deleting the only protected page leaves "every other page is public" with
    // nothing behind the wall — which the server rejects. Saying so here means
    // the user does not have to read a 400 to find out.
    renderWith({
      authScope: 'paths',
      authAudience: 'any',
      authRules: [{ path: '/admin', auth: 'required', audience: 'org' }],
    })
    expect(screen.queryByTestId('app-auth-nothing-protected')).toBeNull()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove' }))

    expect(screen.getByTestId('app-auth-nothing-protected')).toBeTruthy()
    expect(screen.getByTestId('app-auth-save')).toHaveProperty('disabled', true)
    expect(storeMocks.updateAuthPolicy).not.toHaveBeenCalled()
  })

  it('saves an untouched inherited rule exactly as it was read', async () => {
    // Opening this tab and pressing Save must not pin an audience nobody chose:
    // the row DISPLAYS the effective value, it does not write it.
    renderWith({
      authAudience: 'any',
      authRules: [{ path: '/reports', auth: 'required' }],
    })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('app-auth-add-rule'))
    await user.click(screen.getByTestId('app-auth-save'))

    await waitFor(() => expect(storeMocks.updateAuthPolicy).toHaveBeenCalled())
    const [, patch] = storeMocks.updateAuthPolicy.mock.calls[0]
    expect(patch.authRules[0]).toEqual({ path: '/reports', auth: 'required' })
  })

  it('leaves the page list out entirely when there is no wall', async () => {
    renderWith({ authMode: 'none' })
    expect(screen.queryByTestId('app-auth-add-rule')).toBeNull()
  })

  it('offers a redeploy only while the function env lags', async () => {
    const { rerender } = renderWith({ authModePendingRedeploy: false })
    expect(screen.queryByTestId('app-auth-redeploy-now')).toBeNull()

    storeMocks.items = [{ ...baseApp, authModePendingRedeploy: true } as AppRow]
    rerender(<AppAuthTabContent appId="app-1" />)
    expect(screen.getByTestId('app-auth-redeploy-now')).toBeTruthy()
  })

  it('says the app is gone rather than rendering an empty form', async () => {
    storeMocks.items = []
    render(<AppAuthTabContent appId="app-1" />)
    expect(screen.getByText(/找不到这个应用/)).toBeTruthy()
  })
})
