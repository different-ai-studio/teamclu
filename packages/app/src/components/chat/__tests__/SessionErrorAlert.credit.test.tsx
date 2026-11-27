import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      const text = typeof fallback === 'string' ? fallback : key
      const vars = (typeof fallback === 'object' ? fallback : opts) ?? {}
      return text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''))
    },
  }),
}))

const perms = { isOwner: false }
vi.mock('@/lib/team/team-permissions', () => ({
  useTeamPermissions: () => ({ role: null, isOwner: perms.isOwner, canManageTeam: false, canEditFiles: true }),
}))

vi.mock('@/stores/actor-directory-store', () => ({
  useActorDirectory: () => ({
    actors: [
      { id: 'm1', actor_type: 'member', display_name: 'Ada', roles: [{ code: 'owner' }] },
      { id: 'm2', actor_type: 'member', display_name: 'Bob', roles: [{ code: 'admin' }] },
      { id: 'a1', actor_type: 'agent', display_name: 'Bot', roles: [] },
    ],
    loading: false,
    error: false,
    teamId: 't1',
    refetch: () => {},
  }),
}))

const openSettings = vi.fn()
vi.mock('@/stores/ui', () => ({
  useUIStore: (sel: (s: { openSettings: typeof openSettings }) => unknown) => sel({ openSettings }),
}))

import { SessionErrorAlert } from '../SessionErrorAlert'

const emptyWallet = {
  sessionId: 's1',
  error: {
    name: 'InsufficientCreditsError',
    data: { message: "The team's AI balance is used up, so this turn was not run." },
  },
}

describe('SessionErrorAlert — gateway credit refusal', () => {
  beforeEach(() => {
    perms.isOwner = false
    openSettings.mockReset()
  })
  afterEach(cleanup)

  it('tells a member which owner to ask, with no top-up button', () => {
    render(<SessionErrorAlert error={emptyWallet as never} />)
    expect(screen.getByTestId('credit-error-alert').dataset.reason).toBe('insufficient_credits')
    expect(screen.getByTestId('credit-error-contact').textContent).toContain('Ada')
    expect(screen.getByTestId('credit-error-contact').textContent).not.toContain('Bob')
    expect(screen.queryByTestId('credit-error-action')).toBeNull()
  })

  it('gives an owner the button straight to billing', () => {
    perms.isOwner = true
    render(<SessionErrorAlert error={emptyWallet as never} />)
    expect(screen.queryByTestId('credit-error-contact')).toBeNull()
    fireEvent.click(screen.getByTestId('credit-error-action'))
    expect(openSettings).toHaveBeenCalledWith('billing')
  })

  it('sends an owner to quotas for a member quota refusal', () => {
    perms.isOwner = true
    render(
      <SessionErrorAlert
        error={{ sessionId: 's1', error: { name: 'QuotaExceededError', data: { message: 'x' } } } as never}
      />,
    )
    fireEvent.click(screen.getByTestId('credit-error-action'))
    expect(openSettings).toHaveBeenCalledWith('tokenUsage')
  })

  it('recognises a raw 402 body that reached it unclassified', () => {
    render(
      <SessionErrorAlert
        error={{
          sessionId: 's1',
          error: {
            name: 'ProviderError',
            data: { message: 'model provider error: 402: {"code":"insufficient_credits"}' },
          },
        } as never}
      />,
    )
    expect(screen.getByTestId('credit-error-alert')).toBeTruthy()
    expect(screen.queryByText(/insufficient_credits/)).toBeNull()
  })
})
