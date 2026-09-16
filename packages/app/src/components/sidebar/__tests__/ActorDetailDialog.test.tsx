import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ActorDetailDialog } from '../ActorDetailDialog'
import { useActorDirectoryStore } from '@/stores/actor-directory-store'
import { AvatarImageError } from '@/lib/actor/avatar-image'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      // Mirror i18next: when called as t(key, { when: '...' }) the 2nd arg is
      // options (no string fallback), so fall back to the key itself.
      const fb = typeof fallback === 'string' ? fallback : _k
      const vars = (typeof fallback === 'object' ? fallback : opts) as Record<string, unknown> | undefined
      if (vars) {
        return fb.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars[name] ?? ''))
      }
      return fb
    },
  }),
}))

vi.mock('@/lib/ui/date-format', () => ({
  formatRelativeTime: () => 'just now',
  formatDate: () => 'Jan 1, 2026',
}))

const mockGetActorDirectoryEntry = vi.fn()
const mockListOrgRoles = vi.fn()
const mockPutMemberRoles = vi.fn()
const mockRefetchDirectory = vi.fn()
const mockUploadCurrentActorAvatar = vi.fn()
const mockUpdateCurrentActorProfile = vi.fn()
const mockPrepareAvatarImage = vi.fn()
const mockToastSuccess = vi.fn()
const mockToastError = vi.fn()

// Who is signed in. Most tests look at someone else's profile; the profile-photo
// tests sign in as the actor they open.
const signedIn = vi.hoisted(() => ({
  currentMember: { id: 'me-1' } as { id: string; displayName?: string },
}))

const perms = vi.hoisted(() => ({
  canManageTeam: false,
  isOwner: false,
  role: 'member' as string | null,
}))

vi.mock('@/lib/team/team-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/team/team-permissions')>()
  return {
    ...actual,
    useTeamPermissions: () => ({
      role: perms.role,
      isOwner: perms.isOwner,
      canManageTeam: perms.canManageTeam,
      canEditFiles: true,
    }),
  }
})

vi.mock('@/stores/current-team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/current-team')>()
  return {
    ...actual,
    useCurrentTeamStore: Object.assign(
      (sel: (s: { currentMember: { id: string; displayName?: string }; team: { id: string } }) => unknown) =>
        sel({ currentMember: signedIn.currentMember, team: { id: 'team-abc' } }),
      {
        getState: () => ({ currentMember: signedIn.currentMember, team: { id: 'team-abc' } }),
        setState: actual.useCurrentTeamStore.setState,
        subscribe: actual.useCurrentTeamStore.subscribe,
      },
    ),
  }
})

vi.mock('@/stores/actor-directory-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/actor-directory-store')>()
  return {
    ...actual,
    useActorDirectory: () => ({
      actors: [],
      loading: false,
      error: false,
      teamId: 'team-abc',
      refetch: mockRefetchDirectory,
    }),
  }
})

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return {
    ...actual,
    getBackend: () => ({
      actors: {
        getActorDirectoryEntry: mockGetActorDirectoryEntry,
        uploadCurrentActorAvatar: mockUploadCurrentActorAvatar,
        updateCurrentActorProfile: mockUpdateCurrentActorProfile,
      },
      orgRoles: {
        list: mockListOrgRoles,
        putMemberRoles: mockPutMemberRoles,
      },
      teams: { removeTeamActor: vi.fn(), createTeamInvite: vi.fn() },
    }),
  }
})

// jsdom cannot decode or encode images; the crop itself is covered in
// lib/actor/__tests__/avatar-image.test.ts.
vi.mock('@/lib/actor/avatar-image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/actor/avatar-image')>()
  return { ...actual, prepareAvatarImage: (file: File) => mockPrepareAvatarImage(file) }
})

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DialogHeader: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DialogTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <h2 className={className}>{children}</h2>
  ),
}))

vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    disabled,
    onCheckedChange,
    id,
  }: {
    checked?: boolean
    disabled?: boolean
    onCheckedChange?: (v: boolean) => void
    id?: string
  }) => (
    <input
      type="checkbox"
      id={id}
      checked={!!checked}
      disabled={disabled}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}))

beforeEach(() => {
  mockGetActorDirectoryEntry.mockReset()
  mockGetActorDirectoryEntry.mockResolvedValue(null)
  mockListOrgRoles.mockReset()
  mockListOrgRoles.mockResolvedValue([
    { id: 'r-owner', code: 'owner', name: '拥有者', isSystem: true, status: 'active', sort: 1 },
    { id: 'r-admin', code: 'admin', name: '管理员', isSystem: true, status: 'active', sort: 2 },
    { id: 'r-member', code: 'member', name: '成员', isSystem: true, status: 'active', sort: 3 },
  ])
  mockPutMemberRoles.mockReset()
  mockPutMemberRoles.mockResolvedValue([{ id: 'r-admin', code: 'admin', name: '管理员' }])
  mockRefetchDirectory.mockReset()
  perms.canManageTeam = false
  perms.isOwner = false
  perms.role = 'member'
  mockUploadCurrentActorAvatar.mockReset()
  mockUpdateCurrentActorProfile.mockReset()
  mockPrepareAvatarImage.mockReset()
  mockToastSuccess.mockReset()
  mockToastError.mockReset()
  signedIn.currentMember = { id: 'me-1' }
  useActorDirectoryStore.setState({ byTeam: {} })
})

describe('ActorDetailDialog', () => {
  it('uses the member detail pane surface', () => {
    render(
      <ActorDetailDialog
        actor={{
          id: 'actor-1',
          actor_type: 'member',
          display_name: 'Matt-iOS',
          member_status: 'iOS',
          agent_status: null,
          last_active_at: new Date().toISOString(),
        }}
        onOpenChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Matt-iOS')).toBeInTheDocument()
    expect(screen.getByText('Member details')).toBeInTheDocument()
    expect(screen.getByText('Details')).toBeInTheDocument()
    expect(screen.getByText('Role')).toBeInTheDocument()
    expect(screen.getByText('Last active')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copy ID/i })).toBeInTheDocument()
  })

  it('shows team ID when provided', () => {
    render(
      <ActorDetailDialog
        actor={{
          id: 'actor-1',
          actor_type: 'member',
          display_name: 'Matt-iOS',
          member_status: 'iOS',
          agent_status: null,
          last_active_at: new Date().toISOString(),
        }}
        teamId="team-abc"
        onOpenChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Team ID')).toBeInTheDocument()
    expect(screen.getByText('team-abc')).toBeInTheDocument()
  })

  it('renders the real avatar image when avatar_url is present', () => {
    render(
      <ActorDetailDialog
        actor={{
          id: 'actor-1',
          actor_type: 'member',
          display_name: 'Matt-iOS',
          member_status: 'iOS',
          agent_status: null,
          last_active_at: new Date().toISOString(),
          avatar_url: 'https://example.com/avatar.png',
        }}
        onOpenChange={vi.fn()}
      />,
    )

    const img = screen.getByRole('img', { name: 'Matt-iOS' }) as HTMLImageElement
    expect(img).toBeInTheDocument()
    expect(img.src).toBe('https://example.com/avatar.png')
  })

  it('falls back to initials when the avatar image fails to load', () => {
    render(
      <ActorDetailDialog
        actor={{
          id: 'actor-1',
          actor_type: 'member',
          display_name: 'Matt-iOS',
          member_status: 'iOS',
          agent_status: null,
          last_active_at: new Date().toISOString(),
          avatar_url: 'https://example.com/broken.png',
        }}
        onOpenChange={vi.fn()}
      />,
    )

    const img = screen.getByRole('img', { name: 'Matt-iOS' })
    fireEvent.error(img)
    expect(screen.queryByRole('img', { name: 'Matt-iOS' })).not.toBeInTheDocument()
    // The hero initial ("M") is shown instead.
    expect(screen.getByText('M')).toBeInTheDocument()
  })

  it('shows no avatar image when avatar_url is absent', () => {
    render(
      <ActorDetailDialog
        actor={{
          id: 'actor-1',
          actor_type: 'member',
          display_name: 'Matt-iOS',
          member_status: 'iOS',
          agent_status: null,
          last_active_at: new Date().toISOString(),
        }}
        onOpenChange={vi.fn()}
      />,
    )

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('renders the client versions section from the fetched actor detail', async () => {
    mockGetActorDirectoryEntry.mockResolvedValue({
      id: 'actor-1',
      team_id: 'team-abc',
      actor_type: 'member',
      display_name: 'Matt-iOS',
      client_versions: [
        {
          clientType: 'tauri',
          version: '1.2.3',
          deviceId: 'device-abcdef123456',
          build: '456',
          lastReportedAt: new Date().toISOString(),
        },
        {
          clientType: 'ios',
          version: '1.1.5',
          deviceId: 'device-zzz',
          build: null,
          lastReportedAt: new Date().toISOString(),
        },
      ],
    })

    render(
      <ActorDetailDialog
        actor={{
          id: 'actor-1',
          actor_type: 'member',
          display_name: 'Matt-iOS',
          member_status: 'iOS',
          agent_status: null,
          last_active_at: new Date().toISOString(),
        }}
        teamId="team-abc"
        onOpenChange={vi.fn()}
      />,
    )

    expect(await screen.findByText('Client versions')).toBeInTheDocument()
    expect(screen.getByText('tauri')).toBeInTheDocument()
    expect(screen.getByText(/1\.2\.3/)).toBeInTheDocument()
    expect(screen.getByText('ios')).toBeInTheDocument()
    expect(screen.getByText(/1\.1\.5/)).toBeInTheDocument()
    expect(mockGetActorDirectoryEntry).toHaveBeenCalledWith('actor-1')
  })

  // Member re-invite was removed in 20260811110000: the server rejects a member
  // invite that names a target actor, so the dialog offers nothing here for a
  // member — registered or anonymous.
  it.each([
    ['a registered member', 'matt@example.com'],
    ['an anonymous member', undefined],
  ])('shows no re-invite section for %s', (_label, email) => {
    render(
      <ActorDetailDialog
        actor={{
          id: 'actor-1',
          actor_type: 'member',
          display_name: 'Matt-iOS',
          member_status: 'iOS',
          agent_status: null,
          last_active_at: new Date().toISOString(),
          ...(email ? { email } : {}),
        }}
        teamId="team-abc"
        onOpenChange={vi.fn()}
      />,
    )

    expect(screen.queryByText('Re-invite')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /re-invite link/i })).not.toBeInTheDocument()
  })

  it('still shows the re-invite button for an agent regardless of contact', () => {
    render(
      <ActorDetailDialog
        actor={{
          id: 'agent-1',
          actor_type: 'agent',
          display_name: 'amuxd',
          member_status: null,
          agent_status: 'online',
          last_active_at: new Date().toISOString(),
        }}
        teamId="team-abc"
        onOpenChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /Regenerate invite link/i })).toBeInTheDocument()
  })

  it('omits the client versions section when none are reported', async () => {
    mockGetActorDirectoryEntry.mockResolvedValue({
      id: 'actor-1',
      team_id: 'team-abc',
      actor_type: 'member',
      display_name: 'Matt-iOS',
      client_versions: [],
    })

    render(
      <ActorDetailDialog
        actor={{
          id: 'actor-1',
          actor_type: 'member',
          display_name: 'Matt-iOS',
          member_status: 'iOS',
          agent_status: null,
          last_active_at: new Date().toISOString(),
        }}
        teamId="team-abc"
        onOpenChange={vi.fn()}
      />,
    )

    // Let the fetch resolve.
    await screen.findByText('Details')
    expect(screen.queryByText('Client versions')).not.toBeInTheDocument()
  })

  it('renders role chips from roles[]', () => {
    render(
      <ActorDetailDialog
        actor={{
          id: 'actor-1',
          actor_type: 'member',
          display_name: 'Alice',
          member_status: 'active',
          agent_status: null,
          last_active_at: new Date().toISOString(),
          roles: [
            { id: 'r-admin', code: 'admin', name: '管理员' },
            { id: 'r-finance', code: 'finance', name: '财务' },
          ],
          team_role: 'admin',
        }}
        teamId="team-abc"
        onOpenChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('member-role-chips')).toHaveTextContent('管理员')
    expect(screen.getByTestId('member-role-chips')).toHaveTextContent('财务')
  })

  it('falls back to a Member chip when roles[] is empty', () => {
    render(
      <ActorDetailDialog
        actor={{
          id: 'actor-1',
          actor_type: 'member',
          display_name: 'Alice',
          member_status: 'active',
          agent_status: null,
          last_active_at: new Date().toISOString(),
          roles: [],
        }}
        teamId="team-abc"
        onOpenChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('member-role-chips')).toHaveTextContent('Member')
  })

  it('lets owner/admin edit roles and calls putMemberRoles on save', async () => {
    perms.canManageTeam = true
    perms.isOwner = true
    perms.role = 'owner'

    render(
      <ActorDetailDialog
        actor={{
          id: 'actor-1',
          actor_type: 'member',
          display_name: 'Alice',
          member_status: 'active',
          agent_status: null,
          last_active_at: new Date().toISOString(),
          roles: [{ id: 'r-member', code: 'member', name: '成员' }],
          team_role: 'member',
        }}
        teamId="team-abc"
        onOpenChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Edit roles|编辑角色/i }))
    await screen.findByText('管理员')

    fireEvent.click(screen.getByLabelText(/管理员/))
    fireEvent.click(screen.getByRole('button', { name: /Save|保存/i }))

    await waitFor(() => {
      expect(mockPutMemberRoles).toHaveBeenCalledWith(
        'team-abc',
        'actor-1',
        expect.arrayContaining(['r-admin', 'r-member']),
      )
    })
  })

  describe('profile photo', () => {
    const self = {
      id: 'actor-1',
      actor_type: 'member' as const,
      display_name: 'Matt-iOS',
      member_status: 'iOS',
      agent_status: null,
      last_active_at: new Date().toISOString(),
    }

    function signInAs(id: string, displayName = 'Matt-iOS') {
      signedIn.currentMember = { id, displayName }
    }

    function pickFile(file: File) {
      fireEvent.change(screen.getByTestId('actor-avatar-file-input'), { target: { files: [file] } })
    }

    it('offers no upload on someone else\'s profile', () => {
      signInAs('someone-else')
      render(<ActorDetailDialog actor={self} teamId="team-abc" onOpenChange={vi.fn()} />)

      expect(screen.queryByRole('button', { name: /Upload photo|Change photo/ })).not.toBeInTheDocument()
      expect(screen.queryByTestId('actor-avatar-file-input')).not.toBeInTheDocument()
    })

    it('offers no upload on an agent, even one with the current member\'s id', () => {
      signInAs('agent-1')
      render(
        <ActorDetailDialog
          actor={{ ...self, id: 'agent-1', actor_type: 'agent', display_name: 'amuxd' }}
          teamId="team-abc"
          onOpenChange={vi.fn()}
        />,
      )

      expect(screen.queryByTestId('actor-avatar-file-input')).not.toBeInTheDocument()
    })

    it('labels the action by whether a photo is already set', () => {
      signInAs('actor-1')
      const { rerender } = render(<ActorDetailDialog actor={self} teamId="team-abc" onOpenChange={vi.fn()} />)
      expect(screen.getAllByRole('button', { name: 'Upload photo' }).length).toBeGreaterThan(0)

      rerender(
        <ActorDetailDialog
          actor={{ ...self, avatar_url: 'https://example.com/old.png' }}
          teamId="team-abc"
          onOpenChange={vi.fn()}
        />,
      )
      expect(screen.getAllByRole('button', { name: 'Change photo' }).length).toBeGreaterThan(0)
    })

    it('uploads the picked photo, saves it on the profile and shows it', async () => {
      signInAs('actor-1', 'Matt (renamed)')
      useActorDirectoryStore.setState({
        byTeam: { 'team-abc': { actors: [self], loading: false, error: false, started: true } },
      })
      const prepared = new Blob(['jpeg'], { type: 'image/jpeg' })
      mockPrepareAvatarImage.mockResolvedValue(prepared)
      mockUploadCurrentActorAvatar.mockResolvedValue('https://cdn.example.test/avatars/actor-1/avatar-1.jpg')
      mockUpdateCurrentActorProfile.mockResolvedValue({
        id: 'actor-1',
        display_name: 'Matt (renamed)',
        avatar_url: 'https://cdn.example.test/avatars/actor-1/avatar-1.jpg',
      })

      render(<ActorDetailDialog actor={self} teamId="team-abc" onOpenChange={vi.fn()} />)
      const picked = new File(['png'], 'me.png', { type: 'image/png' })
      pickFile(picked)

      const img = (await screen.findByRole('img', { name: 'Matt-iOS' })) as HTMLImageElement
      expect(img.src).toBe('https://cdn.example.test/avatars/actor-1/avatar-1.jpg')
      expect(mockPrepareAvatarImage).toHaveBeenCalledWith(picked)
      expect(mockUploadCurrentActorAvatar).toHaveBeenCalledWith({ actorId: 'actor-1', image: prepared })
      // The profile RPC rewrites the name too, so it gets the current one.
      expect(mockUpdateCurrentActorProfile).toHaveBeenCalledWith({
        actorId: 'actor-1',
        displayName: 'Matt (renamed)',
        avatarUrl: 'https://cdn.example.test/avatars/actor-1/avatar-1.jpg',
      })
      expect(mockToastSuccess).toHaveBeenCalledWith('Profile photo updated')
      expect(useActorDirectoryStore.getState().byTeam['team-abc'].actors[0].avatar_url).toBe(
        'https://cdn.example.test/avatars/actor-1/avatar-1.jpg',
      )
      expect(screen.getAllByRole('button', { name: 'Change photo' }).length).toBeGreaterThan(0)
    })

    it('explains a rejected file and uploads nothing', async () => {
      signInAs('actor-1')
      mockPrepareAvatarImage.mockRejectedValue(new AvatarImageError('unsupported_type'))

      render(<ActorDetailDialog actor={self} teamId="team-abc" onOpenChange={vi.fn()} />)
      pickFile(new File(['gif'], 'anim.gif', { type: 'image/gif' }))

      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Choose a JPG, PNG or WebP image'))
      expect(mockUploadCurrentActorAvatar).not.toHaveBeenCalled()
      expect(mockUpdateCurrentActorProfile).not.toHaveBeenCalled()
    })

    it('reports a failed save and keeps the old picture', async () => {
      signInAs('actor-1')
      mockPrepareAvatarImage.mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }))
      mockUploadCurrentActorAvatar.mockResolvedValue('https://cdn.example.test/avatars/actor-1/avatar-2.jpg')
      mockUpdateCurrentActorProfile.mockRejectedValue(new Error('actor profile update is not allowed'))

      render(
        <ActorDetailDialog
          actor={{ ...self, avatar_url: 'https://example.com/old.png' }}
          teamId="team-abc"
          onOpenChange={vi.fn()}
        />,
      )
      pickFile(new File(['png'], 'me.png', { type: 'image/png' }))

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          'Failed to update profile photo: actor profile update is not allowed',
        ),
      )
      const img = screen.getByRole('img', { name: 'Matt-iOS' }) as HTMLImageElement
      expect(img.src).toBe('https://example.com/old.png')
      expect(mockToastSuccess).not.toHaveBeenCalled()
    })
  })
})
