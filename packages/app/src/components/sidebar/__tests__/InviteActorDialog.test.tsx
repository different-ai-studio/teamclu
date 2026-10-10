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

const perms = vi.hoisted(() => ({ canManageTeam: false }))
vi.mock('@/lib/team/team-permissions', () => ({
  useTeamPermissions: () => ({
    role: perms.canManageTeam ? 'admin' : 'member',
    isOwner: false,
    canManageTeam: perms.canManageTeam,
    canEditFiles: true,
  }),
}))

const { createTeamInvite, getTeamJoinLink, putTeamJoinLink, revokeTeamJoinLink } = vi.hoisted(() => ({
  createTeamInvite: vi.fn(async () => ({ token: 'tok', expiresAt: '2026-09-24T00:00:00Z' })),
  getTeamJoinLink: vi.fn(async () => {
    throw Object.assign(new Error('missing'), { status: 404 })
  }),
  putTeamJoinLink: vi.fn(),
  revokeTeamJoinLink: vi.fn(),
}))
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ teams: { createTeamInvite, getTeamJoinLink, putTeamJoinLink, revokeTeamJoinLink } }),
}))

const { InviteActorDialog } = await import('../InviteActorDialog')

describe('InviteActorDialog', () => {
  it('hides the section from a member', () => {
    perms.canManageTeam = false
    render(<InviteActorDialog open onOpenChange={() => {}} />)
    expect(screen.queryByRole('button', { name: '生成链接' })).toBeNull()
  })

  it('shows the join-link section to an admin', async () => {
    perms.canManageTeam = true
    render(<InviteActorDialog open onOpenChange={() => {}} />)
    expect(await screen.findByRole('button', { name: '生成链接' })).toBeInTheDocument()
  })

  it('offers no role choice and invites members as member', async () => {
    perms.canManageTeam = false

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
