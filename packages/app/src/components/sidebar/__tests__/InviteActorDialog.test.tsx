import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => (typeof d === 'string' ? d : k) }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: unknown) => unknown) => sel({ team: { id: 'team-1' } }),
}))

vi.mock('@/components/auth/UpgradeToOrgDialog', () => ({ UpgradeToOrgDialog: () => null }))

vi.mock('@/lib/config/server-config', () => ({
  getEffectiveServerConfigSync: () => ({ cloudApiUrl: 'https://api.example.test' }),
}))

const createTeamInvite = vi.fn(async () => ({ token: 'tok', expiresAt: '2026-09-24T00:00:00Z' }))
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ teams: { createTeamInvite } }),
}))

const { InviteActorDialog } = await import('../InviteActorDialog')

describe('InviteActorDialog', () => {
  it('offers no role choice and invites members as member', async () => {
    render(<InviteActorDialog open onOpenChange={() => {}} />)

    expect(screen.queryByText('Role')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('Display name'), { target: { value: 'Alice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))

    await waitFor(() => expect(createTeamInvite).toHaveBeenCalledTimes(1))
    expect(createTeamInvite).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1', kind: 'member', teamRole: 'member' }),
    )
  })
})
