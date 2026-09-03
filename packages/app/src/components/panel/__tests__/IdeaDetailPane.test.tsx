import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { IdeasDetailColumn } from '../IdeaDetailPane'
import { useIdeaDetailStore } from '@/stores/idea-detail'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}))

vi.mock('@/lib/ui/date-format', () => ({
  formatRelativeTime: () => 'just now',
}))

vi.mock('@/lib/team/idea-mutations', () => ({
  createIdeaActivity: vi.fn(),
  updateIdea: vi.fn(),
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

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    ideas: {
      createIdea: vi.fn(),
      getIdeaDetail: vi.fn().mockResolvedValue({
        id: 'idea-1',
        team_id: 'team-1',
        workspace_id: null,
        title: 'Launch beta',
        description: 'Ship the first version.',
        status: 'in_progress',
        created_by_actor_id: 'actor-1',
        created_at: '2026-05-10T00:00:00Z',
        updated_at: '2026-05-11T00:00:00Z',
        activities: [
          {
            id: 'activity-1',
            actor_id: 'actor-1',
            activity_type: 'progress',
            content: 'Started.',
            created_at: '2026-05-11T00:00:00Z',
          },
        ],
        actors: [{ id: 'actor-1', display_name: 'Alice', actor_type: 'member' }],
      }),
    },
  }),
}))

beforeEach(() => {
  useIdeaDetailStore.setState({ target: null, mutationTick: 0 })
})

describe('IdeasDetailColumn', () => {
  it('shows a hint when no idea is selected', () => {
    render(<IdeasDetailColumn />)
    expect(screen.getByText('Select an idea to view, or create a new one')).toBeInTheDocument()
  })

  it('renders the create surface without an activity section', () => {
    useIdeaDetailStore.getState().openCreate('team-1')
    render(<IdeasDetailColumn />)

    expect(screen.getByText('Idea')).toBeInTheDocument()
    expect(screen.getByText('New idea')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Idea title')).toBeInTheDocument()
    expect(screen.queryByText('Activity')).not.toBeInTheDocument()
  })

  it('renders the edit surface with activity for the selected idea', async () => {
    useIdeaDetailStore.getState().openEdit({
      id: 'idea-1',
      title: 'Launch beta',
      status: 'in_progress',
      created_by_actor_id: 'actor-1',
      sort_order: 1000,
      updated_at: '2026-05-11T00:00:00Z',
    })
    render(<IdeasDetailColumn />)

    await waitFor(() => expect(screen.getByDisplayValue('Launch beta')).toBeInTheDocument())
    expect(screen.getByText('Idea')).toBeInTheDocument()
    expect(screen.getByText('Activity')).toBeInTheDocument()
    expect(screen.getByText('Started.')).toBeInTheDocument()
  })
})
