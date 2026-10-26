import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MentionPopover } from '../MentionPopover'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'
import {
  useSessionParticipantStore,
  type SessionParticipantInfo,
} from '@/stores/session-participant-store'

const mockSelect = vi.fn()
const mockEnsureParticipants = vi.fn(async () => {})

const STRINGS: Record<string, string> = {
  'chat.mentionPopoverTitle': 'Mention people or agents',
  'chat.mentionGroupMembers': 'Members',
  'chat.mentionGroupAgents': 'Agents',
  'chat.mentionEmptyState': 'No one to mention in this session yet',
  'chat.mentionPopoverError': 'Failed to load participants',
  'chat.mentionPopoverNoMatch': 'No match for "{{query}}"',
  'chat.mentionAgentClearConfirm.title': 'Keep the engaged agent?',
  'chat.mentionAgentClearConfirm.backHint': 'Esc to go back · ↑↓ to choose · ↵ / Tab to confirm',
  'chat.mentionAgentClearConfirm.keepTitle': 'Keep {{agent}}, @{{name}}',
  'chat.mentionAgentClearConfirm.keepSubtitle': 'Message still routes to the agent; the member is also notified',
  'chat.mentionAgentClearConfirm.clearTitle': 'Clear {{agent}}, @{{name}}',
  'chat.mentionAgentClearConfirm.clearSubtitle': 'Remove the agent pill below; mention the human only',
  'common.loading': 'Loading...',
  'chat.sessionAgent.mentionAlready': '已提及',
}

vi.mock('@/stores/session-selection-store', () => ({
  useSessionSelectionStore: (sel: any) => sel({ currentSessionId: 'sess-1' }),
}))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: any) => sel({ currentMember: { id: 'm-self' } }),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (sel: any) => sel({ session: { user: { id: 'user-1' } } }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts
      let template = STRINGS[k] ?? k
      if (fallbackOrOpts && typeof fallbackOrOpts === 'object') {
        for (const [key, val] of Object.entries(fallbackOrOpts)) {
          template = template.replace(`{{${key}}}`, String(val))
        }
      }
      return template
    },
  }),
}))

const engagedAgent: AttachedAgent = { id: 'a-mac', displayName: 'MACPRO' }

function toStoreRows(
  rows: Array<{ id: string; actor_type: 'member' | 'agent'; display_name: string }>,
): SessionParticipantInfo[] {
  return rows.map((r) => ({
    actorId: r.id,
    displayName: r.display_name,
    avatarUrl: null,
    isAgent: r.actor_type === 'agent',
  }))
}

function seedParticipants(
  rows: SessionParticipantInfo[],
  opts?: { loading?: boolean; error?: string | null },
) {
  useSessionParticipantStore.setState({
    participantsBySession: { 'sess-1': rows },
    loadingBySession: { 'sess-1': opts?.loading ?? false },
    errorBySession: { 'sess-1': opts?.error ?? null },
    ensureParticipants: mockEnsureParticipants,
  })
}

beforeEach(() => {
  mockSelect.mockReset()
  mockEnsureParticipants.mockReset()
  useSessionParticipantStore.setState({
    participantsBySession: {},
    loadingBySession: {},
    errorBySession: {},
    ensureParticipants: mockEnsureParticipants,
  })
})

describe('MentionPopover', () => {
  it('renders member and agent groups with icons from session-participant-store', async () => {
    seedParticipants(toStoreRows([
      { id: 'm-self', actor_type: 'member', display_name: 'Haigang Ye' },
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
      { id: 'a-1', actor_type: 'agent', display_name: 'Reviewer Bot' },
    ]))
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        onSelectMember={mockSelect}
        onSelectAgent={vi.fn()}
      />,
    )
    expect(screen.queryByText('Haigang Ye')).not.toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Reviewer Bot')).toBeInTheDocument()
    expect(screen.getByText('Members')).toBeInTheDocument()
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(mockEnsureParticipants).toHaveBeenCalledWith(['sess-1'])
  })

  it('marks an agent that is already a pill', () => {
    seedParticipants(toStoreRows([
      { id: 'a-1', actor_type: 'agent', display_name: 'Reviewer Bot' },
      { id: 'a-2', actor_type: 'agent', display_name: 'Other Bot' },
    ]))
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        engagedAgentIds={['a-1']}
        onSelectMember={vi.fn()}
        onSelectAgent={vi.fn()}
      />,
    )
    expect(screen.getByText('Mentioned')).toBeInTheDocument()
    expect(screen.getAllByText('Mentioned')).toHaveLength(1)
  })

  it('reflects store updates without reopening the popover', async () => {
    seedParticipants(toStoreRows([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
    ]))
    const { rerender } = render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        onSelectMember={vi.fn()}
        onSelectAgent={vi.fn()}
      />,
    )
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.queryByText('My Agent')).not.toBeInTheDocument()

    seedParticipants(toStoreRows([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
      { id: 'a-new', actor_type: 'agent', display_name: 'My Agent' },
    ]))
    rerender(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        onSelectMember={vi.fn()}
        onSelectAgent={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText('My Agent')).toBeInTheDocument())
  })

  it('filters participants using inline searchQuery from the composer', async () => {
    seedParticipants(toStoreRows([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
      { id: 'm-2', actor_type: 'member', display_name: 'Bob' },
      { id: 'a-1', actor_type: 'agent', display_name: 'Reviewer Bot' },
    ]))
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery="bob"
        onSelectMember={vi.fn()}
        onSelectAgent={vi.fn()}
      />,
    )
    expect(screen.getByText('Bob')).toBeInTheDocument()
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()
    expect(screen.queryByText('Reviewer Bot')).not.toBeInTheDocument()
  })

  it('calls onSelectMember when a member is clicked without an engaged agent', async () => {
    const onSelectMember = vi.fn()
    const onSelectAgent = vi.fn()
    seedParticipants(toStoreRows([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
      { id: 'a-1', actor_type: 'agent', display_name: 'Reviewer Bot' },
    ]))
    const user = userEvent.setup()
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        onSelectMember={onSelectMember}
        onSelectAgent={onSelectAgent}
      />,
    )
    await user.click(screen.getByText('Alice'))
    expect(onSelectMember).toHaveBeenCalledWith({ id: 'm-1', name: 'Alice' })
    await user.click(screen.getByText('Reviewer Bot'))
    expect(onSelectAgent).toHaveBeenCalledWith({ id: 'a-1', displayName: 'Reviewer Bot' })
  })

  it('shows E2 confirm step when @-mentioning a human with an engaged agent', async () => {
    const onSelectMember = vi.fn()
    seedParticipants(toStoreRows([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
    ]))
    const user = userEvent.setup()
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        engagedAgent={engagedAgent}
        onSelectMember={onSelectMember}
        onSelectAgent={vi.fn()}
      />,
    )
    await user.click(screen.getByText('Alice'))
    expect(onSelectMember).not.toHaveBeenCalled()
    expect(screen.getByText('Keep the engaged agent?')).toBeInTheDocument()
    expect(screen.getByText('Keep MACPRO, @Alice')).toBeInTheDocument()
    expect(screen.getByText('Clear MACPRO, @Alice')).toBeInTheDocument()
  })

  it('confirms keep-agent via keyboard in E2 step', async () => {
    const onSelectMember = vi.fn()
    const onOpenChange = vi.fn()
    seedParticipants(toStoreRows([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
    ]))
    render(
      <MentionPopover
        open={true}
        onOpenChange={onOpenChange}
        searchQuery=""
        engagedAgent={engagedAgent}
        onSelectMember={onSelectMember}
        onSelectAgent={vi.fn()}
      />,
    )
    fireEvent.keyDown(document, { key: 'Enter', bubbles: true })
    await waitFor(() => screen.getByText('Keep MACPRO, @Alice'))
    fireEvent.keyDown(document, { key: 'Enter', bubbles: true })
    expect(onSelectMember).toHaveBeenCalledWith(
      { id: 'm-1', name: 'Alice' },
      { clearEngagedAgent: false },
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('confirms clear-agent via keyboard in E2 step', async () => {
    const onSelectMember = vi.fn()
    seedParticipants(toStoreRows([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
    ]))
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        engagedAgent={engagedAgent}
        onSelectMember={onSelectMember}
        onSelectAgent={vi.fn()}
      />,
    )
    fireEvent.keyDown(document, { key: 'Enter', bubbles: true })
    await waitFor(() => screen.getByText('Clear MACPRO, @Alice'))
    fireEvent.keyDown(document, { key: 'ArrowDown', bubbles: true })
    fireEvent.keyDown(document, { key: 'Enter', bubbles: true })
    expect(onSelectMember).toHaveBeenCalledWith(
      { id: 'm-1', name: 'Alice' },
      { clearEngagedAgent: true },
    )
  })

  it('returns to browse list on Escape in E2 confirm step', async () => {
    seedParticipants(toStoreRows([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
    ]))
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        engagedAgent={engagedAgent}
        onSelectMember={vi.fn()}
        onSelectAgent={vi.fn()}
      />,
    )
    fireEvent.keyDown(document, { key: 'Enter', bubbles: true })
    await waitFor(() => screen.getByText('Keep the engaged agent?'))
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true })
    expect(screen.getByText('Members')).toBeInTheDocument()
    expect(screen.queryByText('Keep the engaged agent?')).not.toBeInTheDocument()
  })

  it('confirms clear-agent via mouse in E2 step', async () => {
    const onSelectMember = vi.fn()
    seedParticipants(toStoreRows([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
    ]))
    const user = userEvent.setup()
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        engagedAgent={engagedAgent}
        onSelectMember={onSelectMember}
        onSelectAgent={vi.fn()}
      />,
    )
    await user.click(screen.getByText('Alice'))
    await user.click(screen.getByText('Clear MACPRO, @Alice'))
    expect(onSelectMember).toHaveBeenCalledWith(
      { id: 'm-1', name: 'Alice' },
      { clearEngagedAgent: true },
    )
  })

  it('selects agent directly without E2 confirm when engaged agent exists', async () => {
    const onSelectAgent = vi.fn()
    const onSelectMember = vi.fn()
    seedParticipants(toStoreRows([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
      { id: 'a-1', actor_type: 'agent', display_name: 'Reviewer Bot' },
    ]))
    const user = userEvent.setup()
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        engagedAgent={engagedAgent}
        onSelectMember={onSelectMember}
        onSelectAgent={onSelectAgent}
      />,
    )
    await user.click(screen.getByText('Reviewer Bot'))
    expect(onSelectAgent).toHaveBeenCalledWith({
      id: 'a-1',
      displayName: 'Reviewer Bot',
    })
    expect(onSelectMember).not.toHaveBeenCalled()
    expect(screen.queryByText('Keep the engaged agent?')).not.toBeInTheDocument()
  })

  it('shows empty state when participants list is empty', async () => {
    seedParticipants([])
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        onSelectMember={vi.fn()}
        onSelectAgent={vi.fn()}
      />,
    )
    expect(screen.getByText(/no one to mention/i)).toBeInTheDocument()
  })

  it('shows error state when store reports a load error', async () => {
    seedParticipants([], { error: 'rls denied' })
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        onSelectMember={vi.fn()}
        onSelectAgent={vi.fn()}
      />,
    )
    expect(screen.getByText(/failed to load participants/i)).toBeInTheDocument()
  })
})
