import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IdeasView } from '../IdeasView'
import { useIdeaDetailStore } from '@/stores/idea-detail'

const listIdeasMock = vi.fn()
const listActorDirectoryMock = vi.fn()
const updateIdeaMock = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    auth: { getSession: vi.fn().mockResolvedValue({ user: { id: 'u-1' } }) },
    directory: { resolveFirstMemberActorForUser: vi.fn().mockResolvedValue(null) },
    ideas: {
      listIdeas: listIdeasMock,
      updateIdea: updateIdeaMock,
    },
    actors: {
      listActorDirectory: listActorDirectoryMock,
    },
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

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: Object.assign(
    (sel: any) => sel({ team: { id: 'team-1', name: 'Team One', slug: 'team-one' } }),
    {
      subscribe: vi.fn(() => () => {}),
      getState: vi.fn(() => ({ team: { id: 'team-1', name: 'Team One', slug: 'team-one' } })),
    },
  ),
}))

vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: 'expanded', sidebarState: 'expanded', open: true, setOpen: vi.fn(), openMobile: false, setOpenMobile: vi.fn(), isMobile: false, toggleSidebar: vi.fn() }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fallback: string) => fallback }),
}))

vi.mock('@/lib/ui/date-format', () => ({
  formatRelativeTime: () => 'just now',
}))

beforeEach(() => {
  listIdeasMock.mockReset()
  listActorDirectoryMock.mockReset()
  updateIdeaMock.mockReset()
  updateIdeaMock.mockResolvedValue(undefined)
  useIdeaDetailStore.setState({ target: null, mutationTick: 0 })
  vi.useRealTimers()
})

function mockIdeasResponse(ideas: any[], actors: any[]) {
  listIdeasMock.mockResolvedValue(ideas)
  listActorDirectoryMock.mockResolvedValue(actors)
}

describe('IdeasView', () => {
  it('renders ideas with title and creator name', async () => {
    mockIdeasResponse(
      [
        { id: 'i-1', title: 'Launch beta', status: 'in_progress', created_by_actor_id: 'a-1', sort_order: 1000, updated_at: '2026-05-10T00:00:00Z' },
      ],
      [{ id: 'a-1', display_name: 'Alice' }],
    )
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText('Ideas')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('Launch beta')).toBeInTheDocument())
    expect(screen.getByText(/Alice/)).toBeInTheDocument()
    expect(screen.getByLabelText(/in progress/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Search')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter by status')).toBeInTheDocument()
    expect(screen.getByLabelText('Drag idea Launch beta')).toHaveClass('hover:bg-selected')
  })

  it('renders empty state when no ideas', async () => {
    mockIdeasResponse([], [])
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText(/no ideas yet/i)).toBeInTheDocument())
  })

  it('selects the idea for the main-column detail pane when a row is clicked', async () => {
    mockIdeasResponse(
      [
        { id: 'i-1', title: 'Launch beta', status: 'open', created_by_actor_id: 'a-1', sort_order: 1000, updated_at: '2026-05-10T00:00:00Z' },
      ],
      [{ id: 'a-1', display_name: 'Alice' }],
    )
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText('Launch beta')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Drag idea Launch beta'))

    const target = useIdeaDetailStore.getState().target
    expect(target).toMatchObject({ kind: 'edit', idea: { id: 'i-1', title: 'Launch beta' } })
    expect(screen.getByLabelText('Drag idea Launch beta').className).toContain('bg-selected')
  })

  it('opens the create surface in the main column from the + button', async () => {
    mockIdeasResponse([], [])
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText(/no ideas yet/i)).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Create idea'))

    expect(useIdeaDetailStore.getState().target).toEqual({ kind: 'create', teamId: 'team-1' })
  })

  it('paginates the list and pages through it', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `i-${i + 1}`,
      title: `Idea ${i + 1}`,
      status: 'open',
      created_by_actor_id: 'a-1',
      sort_order: (i + 1) * 1000,
      updated_at: '2026-05-10T00:00:00Z',
    }))
    mockIdeasResponse(many, [{ id: 'a-1', display_name: 'Alice' }])
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText('Idea 1')).toBeInTheDocument())

    expect(screen.getByText('Idea 20')).toBeInTheDocument()
    expect(screen.queryByText('Idea 21')).not.toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Next'))

    expect(screen.getByText('Idea 21')).toBeInTheDocument()
    expect(screen.getByText('Idea 25')).toBeInTheDocument()
    expect(screen.queryByText('Idea 1')).not.toBeInTheDocument()
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
  })

  it('long-press drag reorders ideas and persists sort order', async () => {
    mockIdeasResponse(
      [
        { id: 'i-1', title: 'First idea', status: 'open', created_by_actor_id: 'a-1', sort_order: 1000, updated_at: '2026-05-10T00:00:00Z' },
        { id: 'i-2', title: 'Second idea', status: 'open', created_by_actor_id: 'a-1', sort_order: 2000, updated_at: '2026-05-11T00:00:00Z' },
        { id: 'i-3', title: 'Third idea', status: 'open', created_by_actor_id: 'a-1', sort_order: 3000, updated_at: '2026-05-12T00:00:00Z' },
      ],
      [{ id: 'a-1', display_name: 'Alice' }],
    )

    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText('First idea')).toBeInTheDocument())

    fireEvent.pointerDown(screen.getByLabelText('Drag idea First idea'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    fireEvent.pointerEnter(screen.getByLabelText('Drag idea Third idea'))
    fireEvent.pointerUp(screen.getByLabelText('Drag idea Third idea'))

    await waitFor(() => {
      expect(updateIdeaMock).toHaveBeenCalledWith({ ideaId: 'i-1', sortOrder: 3000 })
    })
    expect(updateIdeaMock).toHaveBeenCalledWith({ ideaId: 'i-2', sortOrder: 1000 })
    expect(updateIdeaMock).toHaveBeenCalledWith({ ideaId: 'i-3', sortOrder: 2000 })
  })
})
