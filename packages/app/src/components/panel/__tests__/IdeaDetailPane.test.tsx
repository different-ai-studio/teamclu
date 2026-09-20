import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IdeasDetailColumn } from '../IdeaDetailPane'
import { useIdeaDetailStore } from '@/stores/idea-detail'

// One stable `t`, as in the app: a fresh function per render would re-run every
// effect that depends on it. Interpolates so event lines read as they ship.
const { t, updateIdeaMock, createIdeaActivityMock, recordIdeaStatusChangeMock } = vi.hoisted(() => ({
  t: (key: string, fallback?: string, opts?: Record<string, unknown>) =>
    (fallback ?? key).replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts?.[name] ?? '')),
  updateIdeaMock: vi.fn(),
  createIdeaActivityMock: vi.fn(),
  recordIdeaStatusChangeMock: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}))

vi.mock('@/lib/ui/date-format', () => ({
  formatRelativeTime: () => 'just now',
}))

vi.mock('@/lib/team/idea-mutations', () => ({
  createIdeaActivity: createIdeaActivityMock,
  recordIdeaStatusChange: recordIdeaStatusChangeMock,
  updateIdea: updateIdeaMock,
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
        // Newest first, as the API serves them.
        activities: [
          {
            id: 'activity-2',
            actor_id: 'actor-1',
            activity_type: 'status_change',
            content: 'Changed status from Open to In Progress',
            metadata: { from_status: 'open', to_status: 'in_progress' },
            created_at: '2026-05-12T00:00:00Z',
          },
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
  updateIdeaMock.mockReset()
  updateIdeaMock.mockResolvedValue(undefined)
  createIdeaActivityMock.mockReset()
  createIdeaActivityMock.mockResolvedValue(undefined)
  recordIdeaStatusChangeMock.mockReset()
  recordIdeaStatusChangeMock.mockResolvedValue(undefined)
})

function openLaunchBeta() {
  useIdeaDetailStore.getState().openEdit({
    id: 'idea-1',
    title: 'Launch beta',
    status: 'in_progress',
    created_by_actor_id: 'actor-1',
    sort_order: 1000,
    updated_at: '2026-05-11T00:00:00Z',
  })
}

describe('IdeasDetailColumn', () => {
  it('shows a hint when no idea is selected', () => {
    render(<IdeasDetailColumn />)
    expect(screen.getByText('Select an idea to view, or create a new one')).toBeInTheDocument()
  })

  it('renders the create surface without a discussion section', () => {
    useIdeaDetailStore.getState().openCreate('team-1')
    render(<IdeasDetailColumn />)

    expect(screen.getByText('Idea')).toBeInTheDocument()
    expect(screen.getByText('New idea')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Idea title')).toBeInTheDocument()
    expect(screen.queryByText('Discussion')).not.toBeInTheDocument()
  })

  it('renders the selected idea with its discussion, oldest first', async () => {
    openLaunchBeta()
    render(<IdeasDetailColumn />)

    await waitFor(() => expect(screen.getByDisplayValue('Launch beta')).toBeInTheDocument())
    expect(screen.getByText('Idea')).toBeInTheDocument()
    expect(screen.getByText('Discussion')).toBeInTheDocument()

    const comment = screen.getByText('Started.')
    const event = screen.getByText('Alice set status to In progress')
    expect(comment.compareDocumentPosition(event) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The header counts comments, not status changes.
    expect(screen.getByText('Alice · 1 comments · updated just now')).toBeInTheDocument()
  })

  it('autosaves an edit on blur without a save button', async () => {
    openLaunchBeta()
    render(<IdeasDetailColumn />)
    const title = await screen.findByDisplayValue('Launch beta')

    fireEvent.change(title, { target: { value: 'Launch beta in May' } })
    fireEvent.blur(title)

    await waitFor(() => expect(updateIdeaMock).toHaveBeenCalledWith('idea-1', {
      title: 'Launch beta in May',
      description: 'Ship the first version.',
      status: 'in_progress',
      workspaceId: null,
    }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(useIdeaDetailStore.getState().target).toMatchObject({ idea: { title: 'Launch beta in May' } })
  })

  it('autosaves after a pause in typing', async () => {
    openLaunchBeta()
    render(<IdeasDetailColumn />)
    const description = await screen.findByDisplayValue('Ship the first version.')

    fireEvent.change(description, { target: { value: 'Ship the first version to ten teams.' } })

    expect(updateIdeaMock).not.toHaveBeenCalled()
    await waitFor(
      () => expect(updateIdeaMock).toHaveBeenCalledWith('idea-1', expect.objectContaining({
        description: 'Ship the first version to ten teams.',
      })),
      { timeout: 3000 },
    )
  })

  it('never saves an emptied title', async () => {
    openLaunchBeta()
    render(<IdeasDetailColumn />)
    const title = await screen.findByDisplayValue('Launch beta')

    fireEvent.change(title, { target: { value: '   ' } })
    fireEvent.blur(title)

    await Promise.resolve()
    expect(updateIdeaMock).not.toHaveBeenCalled()
  })

  it('flushes a pending edit when the pane is left', async () => {
    openLaunchBeta()
    const { unmount } = render(<IdeasDetailColumn />)
    const title = await screen.findByDisplayValue('Launch beta')

    fireEvent.change(title, { target: { value: 'Launch beta, renamed' } })
    unmount()

    await waitFor(() => expect(updateIdeaMock).toHaveBeenCalledWith('idea-1', expect.objectContaining({
      title: 'Launch beta, renamed',
    })))
  })

  it('adopts a status set from the list instead of writing its own back', async () => {
    openLaunchBeta()
    render(<IdeasDetailColumn />)
    const title = await screen.findByDisplayValue('Launch beta')

    useIdeaDetailStore.getState().patchOpenIdea('idea-1', { status: 'done' })
    fireEvent.change(title, { target: { value: 'Launch beta shipped' } })
    fireEvent.blur(title)

    await waitFor(() => expect(updateIdeaMock).toHaveBeenCalledWith('idea-1', expect.objectContaining({
      title: 'Launch beta shipped',
      status: 'done',
    })))
    expect(recordIdeaStatusChangeMock).not.toHaveBeenCalled()
  })

  it('sends a comment on Enter, but not while an IME composition is confirming', async () => {
    openLaunchBeta()
    render(<IdeasDetailColumn />)
    await screen.findByDisplayValue('Launch beta')
    const composer = screen.getByPlaceholderText('Add a take, a constraint, or the next step...')

    fireEvent.change(composer, { target: { value: '我觉得可以' } })
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true })
    expect(createIdeaActivityMock).not.toHaveBeenCalled()

    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })
    expect(createIdeaActivityMock).not.toHaveBeenCalled()

    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(createIdeaActivityMock).toHaveBeenCalledWith('idea-1', {
      activityType: 'progress',
      content: '我觉得可以',
    }))
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(''))
  })
})
