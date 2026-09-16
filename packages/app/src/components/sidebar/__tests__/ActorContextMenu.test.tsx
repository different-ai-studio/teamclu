import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ActorContextMenu } from '../ActorContextMenu'
import { useCurrentTeamStore } from '@/stores/current-team'
import type { ActorRow } from '@/stores/actor-directory-store'

const setTeamMemberRole = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    teams: { setTeamMemberRole },
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string) => (typeof fallback === 'string' ? fallback : _k),
  }),
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu">{children}</div>
  ),
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode
    onSelect?: () => void
  }) => (
    <button type="button" onClick={() => onSelect?.()} data-testid="context-menu-item">
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
}))

function member(overrides: Partial<ActorRow> = {}): ActorRow {
  return {
    id: 'actor-b',
    actor_type: 'member',
    display_name: 'Bob',
    member_status: 'active',
    agent_status: null,
    last_active_at: null,
    team_role: 'member',
    ...overrides,
  }
}

function renderMenu(actor: ActorRow) {
  return render(
    <ActorContextMenu
      actor={actor}
      onViewDetail={vi.fn()}
      onCopyName={vi.fn()}
      onCopyId={vi.fn()}
      onRequestRemove={vi.fn()}
    >
      <span>row</span>
    </ActorContextMenu>,
  )
}

describe('ActorContextMenu admin role', () => {
  beforeEach(() => {
    setTeamMemberRole.mockReset()
    setTeamMemberRole.mockResolvedValue(undefined)
    useCurrentTeamStore.setState({
      team: { id: 'team-1', name: 'T', slug: 't' },
      currentMember: { id: 'me', displayName: 'Me', role: 'admin', joinedAt: null },
    })
  })

  it('lets an admin set a member as admin', async () => {
    renderMenu(member())
    fireEvent.click(screen.getByRole('button', { name: /Set as admin/i }))
    await waitFor(() => {
      expect(setTeamMemberRole).toHaveBeenCalledWith('team-1', 'actor-b', 'admin')
    })
  })

  it('lets an admin remove another admin', async () => {
    renderMenu(member({ team_role: 'admin' }))
    fireEvent.click(screen.getByRole('button', { name: /Remove admin/i }))
    await waitFor(() => {
      expect(setTeamMemberRole).toHaveBeenCalledWith('team-1', 'actor-b', 'member')
    })
  })

  it('hides the action for the team owner', () => {
    renderMenu(member({ team_role: 'owner', display_name: 'Owner' }))
    expect(screen.queryByRole('button', { name: /Set as admin|Remove admin/i })).toBeNull()
  })

  it('hides the action on yourself', () => {
    renderMenu(member({ id: 'me', team_role: 'member', display_name: 'Me' }))
    expect(screen.queryByRole('button', { name: /Set as admin|Remove admin/i })).toBeNull()
  })

  it('hides the action for a regular member', () => {
    useCurrentTeamStore.setState({
      currentMember: { id: 'me', displayName: 'Me', role: 'member', joinedAt: null },
    })
    renderMenu(member())
    expect(screen.queryByRole('button', { name: /Set as admin|Remove admin/i })).toBeNull()
  })
})
