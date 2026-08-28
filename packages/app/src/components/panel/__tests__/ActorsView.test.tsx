import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ActorsView, compareMembersByRoleThenName, matchesActorTypeFilter, memberTeamRolePill } from '../ActorsView'
import type { ActorRow } from '@/stores/actor-directory-store'
import { useActorDetailStore } from '@/stores/actor-detail-store'
import { useUIStore } from '@/stores/ui'

const listActorDirectory = vi.fn()
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    actors: { listActorDirectory },
    auth: { getSession: vi.fn().mockResolvedValue({ user: { id: 'u-1' } }) },
    directory: { resolveFirstMemberActorForUser: vi.fn().mockResolvedValue({ team_id: 'team-1' }) },
  }),
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: Object.assign(
    (sel: any) => sel({ rows: [{ id: 's-1', team_id: 'team-1' }] }),
    {
      subscribe: vi.fn(() => () => {}),
      getState: vi.fn(() => ({ rows: [{ id: 's-1', team_id: 'team-1' }] })),
    },
  ),
}))

vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: 'expanded', sidebarState: 'expanded', open: true, setOpen: vi.fn(), openMobile: false, setOpenMobile: vi.fn(), isMobile: false, toggleSidebar: vi.fn() }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fallback: string) => fallback }),
}))

beforeEach(() => {
  listActorDirectory.mockReset()
  useActorDetailStore.setState({ actorId: null })
  useUIStore.setState({ draftPreselectedActor: null })
})

/** A gateway contact as the directory returns it: no role, no membership. */
function externalRow(id: string, name: string, source = 'wecom') {
  return {
    id,
    actor_type: 'external',
    display_name: name,
    member_status: null,
    agent_status: null,
    last_active_at: '2026-08-18T00:00:00Z',
    source,
    source_id: `${source}:${id}`,
  }
}

function mockActorsRows(rows: any[]) {
  listActorDirectory.mockResolvedValue(rows)
}

describe('ActorsView', () => {
  it('renders the actor list surface with team and agent rows', async () => {
    mockActorsRows([
      {
        id: 'a-1',
        actor_type: 'member',
        display_name: 'Alice',
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
      {
        id: 'a-2',
        actor_type: 'agent',
        display_name: 'Reviewer',
        member_status: null,
        agent_status: 'online',
        last_active_at: null,
      },
    ])
    render(<ActorsView />)
    await waitFor(() => expect(screen.getByText('Contacts')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('Member')).toBeInTheDocument()
    expect(screen.getAllByText('Agent').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('online')).not.toBeInTheDocument()
    expect(screen.queryByText('offline')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Search')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter by type')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alice/ })).toHaveClass('hover:bg-selected')
  })

  it('shows owner and admin role pills for members', async () => {
    mockActorsRows([
      {
        id: 'a-1',
        actor_type: 'member',
        display_name: 'Owner User',
        team_role: 'owner',
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
      {
        id: 'a-2',
        actor_type: 'member',
        display_name: 'Admin User',
        team_role: 'admin',
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
    ])

    render(<ActorsView />)

    await waitFor(() => expect(screen.getByText('Owner User')).toBeInTheDocument())
    expect(screen.getByText('Owner')).toBeInTheDocument()
    expect(screen.getByText('Admin')).toBeInTheDocument()
  })

  it('sorts members with owner and admin before regular members', async () => {
    mockActorsRows([
      {
        id: 'm-1',
        actor_type: 'member',
        display_name: 'Zara',
        team_role: null,
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
      {
        id: 'm-2',
        actor_type: 'member',
        display_name: 'Admin Bob',
        team_role: 'admin',
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
      {
        id: 'm-3',
        actor_type: 'member',
        display_name: 'Owner Ana',
        team_role: 'owner',
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
      {
        id: 'm-4',
        actor_type: 'member',
        display_name: 'Alice',
        team_role: null,
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
    ])

    render(<ActorsView />)

    await waitFor(() => expect(screen.getByRole('button', { name: /Owner Ana/ })).toBeInTheDocument())
    const memberButtons = screen.getAllByRole('button').filter((button) =>
      ['Owner Ana', 'Admin Bob', 'Alice', 'Zara'].some((name) => button.textContent?.includes(name)),
    )

    expect(memberButtons.map((button) => button.textContent ?? '')).toEqual([
      expect.stringContaining('Owner Ana'),
      expect.stringContaining('Admin Bob'),
      expect.stringContaining('Alice'),
      expect.stringContaining('Zara'),
    ])
  })

  it('groups members before agents with section headers when unfiltered', async () => {
    mockActorsRows([
      {
        id: 'a-2',
        actor_type: 'agent',
        display_name: 'Zed',
        member_status: null,
        agent_status: 'online',
        last_active_at: null,
      },
      {
        id: 'a-1',
        actor_type: 'member',
        display_name: 'Alice',
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
      {
        id: 'a-3',
        actor_type: 'agent',
        display_name: 'Bob',
        member_status: null,
        agent_status: 'online',
        last_active_at: null,
      },
    ])

    render(<ActorsView />)

    await waitFor(() => expect(screen.getByRole('button', { name: /Alice/ })).toBeInTheDocument())
    const actorButtons = screen.getAllByRole('button').filter((button) =>
      ['Alice', 'Bob', 'Zed'].some((name) => button.textContent?.includes(name)),
    )

    expect(actorButtons.map((button) => button.textContent ?? '')).toEqual([
      expect.stringContaining('Alice'),
      expect.stringContaining('Bob'),
      expect.stringContaining('Zed'),
    ])
    expect(
      screen.getByText((_, el) => el?.textContent?.replace(/\s+/g, ' ').trim() === 'Team · 1'),
    ).toBeInTheDocument()
    expect(
      screen.getByText((_, el) => el?.textContent?.replace(/\s+/g, ' ').trim() === 'Agent · 2'),
    ).toBeInTheDocument()
  })

  it('renders empty state when no actors', async () => {
    mockActorsRows([])
    render(<ActorsView />)
    await waitFor(() => expect(screen.getByText(/no actors in this team yet/i)).toBeInTheDocument())
  })

  // A team that answers customers over WeCom gets one external actor per person
  // who ever wrote in. They used to be flattened into `member` and listed as
  // "Team", which buried the actual teammates.
  it('hides external gateway contacts from the unfiltered list', async () => {
    mockActorsRows([
      {
        id: 'a-1',
        actor_type: 'member',
        display_name: 'Alice',
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
      externalRow('x-1', 'wodi9vSQAAU8frf71'),
    ])

    render(<ActorsView />)

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(screen.queryByText('wodi9vSQAAU8frf71')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/Contacts\s*·\s*1/)
  })

  // Clicking a row used to jump straight into a new draft session addressed to
  // that actor. The list is where you look somebody up, so it now opens the
  // profile; "Start session" is an explicit button inside it.
  it('replaces the selected contact when opening another', async () => {
    mockActorsRows([
      {
        id: 'a-1',
        actor_type: 'member',
        display_name: 'Alice',
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
      {
        id: 'a-2',
        actor_type: 'member',
        display_name: 'Bob',
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
    ])

    render(<ActorsView />)

    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Bob/ }))

    expect(useActorDetailStore.getState().actorId).toBe('a-2')
  })

  it('opens a member in the main-column detail pane instead of a draft session', async () => {
    mockActorsRows([
      {
        id: 'a-1',
        actor_type: 'member',
        display_name: 'Alice',
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
    ])

    render(<ActorsView />)

    const row = await screen.findByRole('button', { name: /Alice/ })
    fireEvent.click(row)

    expect(useActorDetailStore.getState().actorId).toBe('a-1')
    expect(useUIStore.getState().draftPreselectedActor).toBeNull()
  })

  it('opens an external contact in the detail pane too', async () => {
    mockActorsRows([externalRow('x-9', 'Kefu Wang')])

    render(<ActorsView />)

    // The row is only reachable under the external filter.
    await waitFor(() => expect(screen.getByLabelText('Filter by type')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Filter by type'))
    await waitFor(() => expect(screen.getByText('External')).toBeInTheDocument())
    fireEvent.click(screen.getByText('External'))

    const row = await screen.findByRole('button', { name: /Kefu Wang/ })
    fireEvent.click(row)

    expect(useActorDetailStore.getState().actorId).toBe('x-9')
  })
})

describe('compareMembersByRoleThenName', () => {
  it('ranks owner before admin before member, then by name', () => {
    const owner = { display_name: 'Zed', team_role: 'owner' } as ActorRow
    const admin = { display_name: 'Amy', team_role: 'admin' } as ActorRow
    const memberA = { display_name: 'Alice', team_role: null } as ActorRow
    const memberZ = { display_name: 'Zara', team_role: 'member' } as ActorRow

    expect(compareMembersByRoleThenName(owner, admin)).toBeLessThan(0)
    expect(compareMembersByRoleThenName(admin, memberA)).toBeLessThan(0)
    expect(compareMembersByRoleThenName(memberA, memberZ)).toBeLessThan(0)
    expect(compareMembersByRoleThenName(admin, { display_name: 'Bob', team_role: 'admin' } as ActorRow)).toBeLessThan(0)
  })
})

describe('memberTeamRolePill', () => {
  it('returns owner and admin only', () => {
    expect(memberTeamRolePill('owner')).toBe('owner')
    expect(memberTeamRolePill('admin')).toBe('admin')
    expect(memberTeamRolePill('member')).toBeNull()
    expect(memberTeamRolePill(null)).toBeNull()
  })
})

describe('matchesActorTypeFilter', () => {
  it('excludes external contacts from "all"', () => {
    expect(matchesActorTypeFilter('member', 'all')).toBe(true)
    expect(matchesActorTypeFilter('agent', 'all')).toBe(true)
    expect(matchesActorTypeFilter('external', 'all')).toBe(false)
  })

  it('matches exactly for every explicit kind', () => {
    expect(matchesActorTypeFilter('external', 'external')).toBe(true)
    expect(matchesActorTypeFilter('member', 'external')).toBe(false)
    expect(matchesActorTypeFilter('agent', 'agent')).toBe(true)
    expect(matchesActorTypeFilter('external', 'agent')).toBe(false)
    expect(matchesActorTypeFilter('member', 'member')).toBe(true)
    expect(matchesActorTypeFilter('agent', 'member')).toBe(false)
  })
})
