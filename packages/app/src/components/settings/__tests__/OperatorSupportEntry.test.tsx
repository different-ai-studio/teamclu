import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}))

const h = vi.hoisted(() => ({
  enterSupportSession: vi.fn(),
  closeSettings: vi.fn(),
  busy: false,
}))

vi.mock('@/lib/admin/support-session', () => ({
  enterSupportSession: h.enterSupportSession,
  useSupportSessionStore: (sel: (s: { busy: boolean }) => unknown) => sel({ busy: h.busy }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (sel: (s: { closeSettings: () => void }) => unknown) => sel({ closeSettings: h.closeSettings }),
}))

const { OperatorSupportEntry } = await import('../OperatorSupportEntry')

const TEAM = { id: 'team-1', name: 'Core', slug: 'acme-core', orgId: 'org-1', orgName: 'Acme' }

beforeEach(() => {
  vi.clearAllMocks()
  h.enterSupportSession.mockResolvedValue(undefined)
})

describe('OperatorSupportEntry', () => {
  it('enters the team with a reason, then closes settings', async () => {
    render(<OperatorSupportEntry team={TEAM} />)
    fireEvent.click(screen.getByText('Enter as support'))
    const submit = screen.getByText('Enter').closest('button')!
    expect(submit.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Reason (recorded)'), { target: { value: ' ticket 7 ' } })
    fireEvent.click(submit)

    await waitFor(() => expect(h.closeSettings).toHaveBeenCalled())
    expect(h.enterSupportSession).toHaveBeenCalledWith({
      orgId: 'org-1',
      orgName: 'Acme',
      team: { id: 'team-1', name: 'Core', slug: 'acme-core' },
      reason: 'ticket 7',
    })
  })

  it('shows why entering failed and stays open', async () => {
    h.enterSupportSession.mockRejectedValue(new Error('the platform org is entered as yourself'))
    render(<OperatorSupportEntry team={TEAM} />)
    fireEvent.click(screen.getByText('Enter as support'))
    fireEvent.change(screen.getByLabelText('Reason (recorded)'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('Enter').closest('button')!)

    expect((await screen.findByRole('alert')).textContent).toContain('platform org')
    expect(h.closeSettings).not.toHaveBeenCalled()
  })

  it('is not offered for a team without an org', () => {
    const { container } = render(<OperatorSupportEntry team={{ ...TEAM, orgId: null }} />)
    expect(container.textContent).toBe('')
  })
})
