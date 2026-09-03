import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ActorDetailDialog } from '../ActorDetailDialog'

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

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return {
    ...actual,
    getBackend: () => ({
      actors: { getActorDirectoryEntry: mockGetActorDirectoryEntry },
    }),
  }
})

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

beforeEach(() => {
  mockGetActorDirectoryEntry.mockReset()
  mockGetActorDirectoryEntry.mockResolvedValue(null)
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
})
