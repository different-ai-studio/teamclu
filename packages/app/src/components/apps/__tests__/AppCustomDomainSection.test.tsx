import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { AppCustomDomainSection } from '../AppCustomDomainSection'
import type { AppCustomDomain, AppRow } from '@/lib/backend/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const mocks = vi.hoisted(() => ({
  getAppCustomDomain: vi.fn(),
  bind: vi.fn(),
  verify: vi.fn(),
  unbind: vi.fn(),
}))
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ apps: { getAppCustomDomain: mocks.getAppCustomDomain } }),
}))
vi.mock('@/stores/apps-store', () => ({
  useAppsStore: (sel: (s: unknown) => unknown) =>
    sel({ bindCustomDomain: mocks.bind, verifyCustomDomain: mocks.verify, unbindCustomDomain: mocks.unbind }),
}))

const app = (over: Partial<AppRow> = {}) =>
  ({ id: 'app-1', customDomain: 'shop.example.org', customDomainVerifiedAt: null, ...over }) as AppRow

const view = (over: Partial<AppCustomDomain> = {}): AppCustomDomain =>
  ({
    domain: 'shop.example.org',
    verified: false,
    verifiedAt: null,
    dns: [
      { type: 'CNAME', name: 'shop.example.org', value: 'shop-app1.apps.example.com' },
      { type: 'TXT', name: '_teamclu-challenge.shop.example.org', value: 'teamclu-verify=tok-1' },
    ],
    ...over,
  }) as AppCustomDomain

beforeEach(() => vi.clearAllMocks())

describe('AppCustomDomainSection', () => {
  it('shows a bound domain read off the row, with its records after a reload', async () => {
    mocks.getAppCustomDomain.mockResolvedValue(view())
    render(<AppCustomDomainSection app={app()} />)
    expect(screen.getByTestId('app-control-domain-input')).toHaveValue('shop.example.org')
    expect(await screen.findByText('teamclu-verify=tok-1')).toBeInTheDocument()
    expect(mocks.getAppCustomDomain).toHaveBeenCalledWith('app-1')
    // Reading the records must not re-bind (which would need write access).
    expect(mocks.bind).not.toHaveBeenCalled()
  })

  it('shows a member without admin the domain and its state, not the controls', async () => {
    mocks.getAppCustomDomain.mockResolvedValue(null)
    render(<AppCustomDomainSection app={app()} />)
    await waitFor(() => expect(screen.getByTestId('app-control-domain-input')).toBeDisabled())
    expect(screen.getByTestId('app-control-domain-status')).toHaveTextContent('待校验')
    expect(screen.queryByTestId('app-control-domain-verify')).toBeNull()
    expect(screen.queryByText('解绑')).toBeNull()
  })

  it('does not show records for a verified domain', async () => {
    mocks.getAppCustomDomain.mockResolvedValue(view({ verified: true, verifiedAt: '2026-11-01T00:00:00.000Z' }))
    render(<AppCustomDomainSection app={app({ customDomainVerifiedAt: '2026-11-01T00:00:00.000Z' })} />)
    await waitFor(() => expect(mocks.getAppCustomDomain).toHaveBeenCalled())
    expect(screen.getByTestId('app-control-domain-status')).toHaveTextContent('已生效')
    expect(screen.queryByText('teamclu-verify=tok-1')).toBeNull()
  })

  it('asks nothing for an app with no domain', () => {
    render(<AppCustomDomainSection app={app({ customDomain: null })} />)
    expect(mocks.getAppCustomDomain).not.toHaveBeenCalled()
  })
})
