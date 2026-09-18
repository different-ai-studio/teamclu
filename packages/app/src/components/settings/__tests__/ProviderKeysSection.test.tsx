import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CloudApiError } from '@/lib/backend/cloud-api/http'
import { resetPlatformOperatorCacheForTests } from '@/lib/admin/platform-operator'
import type { ProviderPool } from '@/lib/backend/types'

const t = (k: string, d?: string, opts?: Record<string, unknown>) => {
  const base = typeof d === 'string' ? d : k
  return base.replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] ?? ''))
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'zh-CN', changeLanguage: vi.fn() } }),
}))

const api = vi.hoisted(() => ({
  whoami: vi.fn(),
  getProviderPools: vi.fn(),
  resetProviderPool: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  hasBackendConfig: () => true,
  getBackend: () => ({ admin: api }),
}))

const { ProviderKeysSection } = await import('../ProviderKeysSection')

/** Two keys on one provider: the first out of balance, the second serving. */
const POOLS: ProviderPool[] = [
  {
    providerId: 'deepseek',
    keys: [
      {
        id: '1a2b3c4d',
        hint: '…aaaa',
        position: 0,
        ok: 12,
        failed: 3,
        lastUsedAt: '2026-09-18T01:00:00.000Z',
        cooldowns: [
          {
            model: null,
            class: 'exhausted',
            active: true,
            until: new Date(Date.now() + 125_000).toISOString(),
            strikes: 2,
            status: 402,
            error: 'Insufficient Balance',
            at: '2026-09-18T01:00:00.000Z',
          },
        ],
      },
      {
        id: '5e6f7a8b',
        hint: '…bbbb',
        position: 1,
        ok: 4,
        failed: 0,
        lastUsedAt: '2026-09-18T01:02:00.000Z',
        cooldowns: [],
      },
    ],
  },
]

beforeEach(() => {
  resetPlatformOperatorCacheForTests()
  api.whoami.mockReset()
  api.getProviderPools.mockReset()
  api.resetProviderPool.mockReset()
  api.whoami.mockResolvedValue({ userId: 'op-1', operator: true })
  api.getProviderPools.mockResolvedValue(POOLS)
  api.resetProviderPool.mockResolvedValue({ cleared: 1 })
})

describe('ProviderKeysSection', () => {
  it('shows which key is serving and which is benched, and why', async () => {
    render(<ProviderKeysSection />)

    await screen.findByTestId('provider-pool-deepseek')
    expect(screen.getByText('…aaaa')).toBeTruthy()
    expect(screen.getByText('…bbbb')).toBeTruthy()
    // The serving key says so; the benched one carries the reason, the scope,
    // the upstream status and how long it sits out.
    expect(screen.getByText('Serving')).toBeTruthy()
    const cooldown = screen.getByTestId('provider-key-cooldown-1a2b3c4d').textContent ?? ''
    expect(cooldown).toContain('out of balance or quota')
    expect(cooldown).toContain('whole key')
    expect(cooldown).toContain('402')
    expect(cooldown).toContain('Insufficient Balance')
    expect(cooldown).toMatch(/resumes in 2m0\ds/)
    expect(cooldown).toContain('2 in a row')
  })

  it('shows the message out of a JSON error body, not the punctuation', async () => {
    // Providers answer with JSON and the gateway stores it verbatim; printed
    // raw it is mostly braces and quotes.
    api.getProviderPools.mockResolvedValue([
      {
        providerId: 'mx5',
        keys: [
          {
            ...POOLS[0].keys[0],
            cooldowns: [
              {
                ...POOLS[0].keys[0].cooldowns[0],
                status: 429,
                error: '{"type":"error","error":{"type":"GoUsageLimitError","message":"weekly usage limit reached"}}',
              },
            ],
          },
        ],
      },
    ])
    render(<ProviderKeysSection />)

    const row = await screen.findByTestId('provider-key-cooldown-1a2b3c4d')
    expect(row.textContent).toContain('weekly usage limit reached')
    expect(row.textContent).not.toContain('{"type"')
  })

  it('offers to resume only the key that is benched', async () => {
    render(<ProviderKeysSection />)
    await screen.findByTestId('provider-pool-deepseek')

    const buttons = screen.getAllByRole('button', { name: 'Resume this key' })
    expect(buttons).toHaveLength(1)

    fireEvent.click(buttons[0])
    await waitFor(() => expect(api.resetProviderPool).toHaveBeenCalledWith('deepseek', '1a2b3c4d'))
    // Reloaded, so the row reflects the reset rather than the stale snapshot.
    await waitFor(() => expect(api.getProviderPools).toHaveBeenCalledTimes(2))
  })

  it('resumes a whole provider without naming a key', async () => {
    render(<ProviderKeysSection />)
    await screen.findByTestId('provider-pool-deepseek')

    fireEvent.click(screen.getByRole('button', { name: /Resume all/ }))
    await waitFor(() => expect(api.resetProviderPool).toHaveBeenCalledWith('deepseek', undefined))
  })

  it('reloads on demand', async () => {
    render(<ProviderKeysSection />)
    await screen.findByTestId('provider-pool-deepseek')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.getProviderPools).toHaveBeenCalledTimes(2))
  })

  it('tells a non-operator their own user id instead of asking the gateway', async () => {
    api.whoami.mockResolvedValue({ userId: 'user-9', operator: false })
    render(<ProviderKeysSection />)

    await screen.findByTestId('provider-keys-not-operator')
    expect(screen.getByText('user-9')).toBeTruthy()
    expect(api.getProviderPools).not.toHaveBeenCalled()
  })

  it('explains a deployment with no AI gateway rather than reporting an error', async () => {
    api.getProviderPools.mockRejectedValue(
      new CloudApiError(503, 'ai_gateway_unavailable', 'AI gateway is not configured', null),
    )
    render(<ProviderKeysSection />)

    await screen.findByTestId('provider-keys-no-gateway')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('surfaces any other failure as an error', async () => {
    api.getProviderPools.mockRejectedValue(new Error('boom'))
    render(<ProviderKeysSection />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('boom')
  })
})
