import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const t = (k: string, d?: string, opts?: Record<string, unknown>) => {
  const base = typeof d === 'string' ? d : k
  return base.replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] ?? ''))
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))

const state = vi.hoisted(() => ({
  isOwner: true,
  packages: [] as unknown[],
  packagesThrows: false,
  opened: [] as string[],
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: unknown) => unknown) => sel({ team: { id: 'team-1' } }),
}))
vi.mock('@/lib/team-permissions', () => ({
  useTeamPermissions: () => ({ role: 'owner', isOwner: state.isOwner, canManageTeam: true, canEditFiles: true }),
}))
vi.mock('@/lib/utils', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  openExternalUrl: async (url: string) => { state.opened.push(url) },
}))

const createCheckout = vi.fn(async () => ({ sessionId: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }))
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    teams: {
      getTeamCredits: async () => ({
        teamId: 'team-1', balanceCredits: 50_000_000, usedCredits: 1_000_000,
        period: { range: 'month', startUtc: new Date(Date.now() - 86_400_000).toISOString(), endUtc: new Date().toISOString() },
      }),
      getCreditUsage: async () => ({
        range: 'month', startUtc: new Date(Date.now() - 86_400_000).toISOString(), endUtc: new Date().toISOString(),
        summary: { credits: 1_000_000, inputTokens: 10, outputTokens: 5, requests: 2 }, byModel: [], byActor: [],
      }),
      getCreditLedger: async () => ({ items: [] }),
      listCreditPackages: async () => {
        if (state.packagesThrows) throw new Error('nope')
        return { items: state.packages }
      },
      createCreditCheckoutSession: createCheckout,
    },
  }),
}))

const { BillingSection } = await import('../BillingSection')

const PKG = { priceId: 'price_a', credits: 100_000_000, unitAmount: 9900, currency: 'usd', name: 'Starter' }

beforeEach(() => {
  state.isOwner = true
  state.packages = [PKG]
  state.packagesThrows = false
  state.opened = []
  createCheckout.mockClear()
})

describe('BillingSection top-up', () => {
  it('buying opens hosted checkout in the SYSTEM browser, not this webview', async () => {
    render(<BillingSection />)
    await screen.findByText('Starter')
    // Credits are shown in points, and the price in its own currency.
    expect(screen.getByText('10,000 points')).toBeTruthy()
    expect(screen.getByText(/99\.00/)).toBeTruthy()

    fireEvent.click(screen.getByText('Buy'))
    await waitFor(() => expect(createCheckout).toHaveBeenCalledWith('team-1', { priceId: 'price_a' }))
    // The URL must leave the app: 3DS and wallets break in the embedded webview.
    await waitFor(() => expect(state.opened).toEqual(['https://checkout.stripe.com/c/pay/cs_1']))
    // And the UI must not pretend to wait for a payment happening elsewhere.
    await screen.findByText(/Payment continues in your browser/)
  })

  it('a non-owner sees the packages but cannot buy', async () => {
    state.isOwner = false
    render(<BillingSection />)
    await screen.findByText('Starter')
    expect((screen.getByText('Buy').closest('button') as HTMLButtonElement).disabled).toBe(true)
    // Two badges carry it — the top-up card and the ledger header.
    expect(screen.getAllByText('Owners only').length).toBeGreaterThan(0)
  })

  it('a deployment with no Stripe says so instead of erroring', async () => {
    state.packages = []
    render(<BillingSection />)
    await screen.findByText(/Online top-up is not available/)
    expect(screen.queryByText('Buy')).toBeNull()
  })

  it('a failing packages call degrades to "unavailable", never to a broken page', async () => {
    state.packagesThrows = true
    render(<BillingSection />)
    // The balance still renders — one dead endpoint must not take the page down.
    await screen.findByText(/Online top-up is not available/)
    expect(screen.getByText('Current balance')).toBeTruthy()
  })
})
