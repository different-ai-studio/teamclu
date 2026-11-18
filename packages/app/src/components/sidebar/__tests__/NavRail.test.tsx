import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { NavRail } from '../NavRail'
import { useUIStore } from '@/stores/ui'
import { useSessionStore } from '@/stores/session-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useCronStore } from '@/stores/cron'

const mkListRow = (id: string, title: string) => ({
  id,
  title,
  team_id: 't1',
  last_message_at: null,
  last_message_preview: null,
  mode: 'collab' as const,
  idea_id: null,
  has_unread: false,
  has_mention: false,
  created_at: '',
  updated_at: '',
})

vi.mock('@/components/sidebar/ContactsNavEntry', () => ({
  ContactsNavEntry: () => <div data-testid="contacts-nav-entry" />,
}))
vi.mock('@/components/sidebar/NewChatSplitButton', () => ({
  NewChatSplitButton: () => <div data-testid="new-chat-split" />,
}))
vi.mock('@/hooks/use-quick-chat-readiness', () => ({
  useQuickChatReadiness: () => ({
    kind: 'ready',
    target: { agentId: 'a1', displayName: 'Bot', source: 'local' },
  }),
}))
vi.mock('@/lib/config/remote-features', () => ({
  useFeatures: () => ({ apps: true }),
}))
vi.mock('@/components/sidebar/AppsNavSection', () => ({
  AppsNavSection: () => <div data-testid="apps-nav-section" />,
}))
vi.mock('sonner', () => ({
  toast: vi.fn(),
}))

describe('NavRail', () => {
  beforeEach(() => {
    useUIStore.setState({
      sidebarFilter: { kind: 'all' },
      embedMode: false,
      navGroupLast: {},
    })
    useSessionListStore.setState({
      rows: [mkListRow('s1', 'A'), mkListRow('s2', 'B')],
      pinnedSessionIds: [],
    })
    useCronStore.setState({
      cronSessionIds: new Set<string>(),
      showCronSessions: false,
    })
    useSessionStore.setState({ sessions: [] })
  })

  it('clicking Sessions sets filter to { kind: "all" }', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'pinned' } })
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /会话/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'all' })
  })

  it('clicking Sessions exits the clock-only session view', () => {
    useCronStore.setState({ showCronSessions: true })
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /会话/ }))
    expect(useCronStore.getState().showCronSessions).toBe(false)
  })

  it('does not show a session count badge on the Sessions row', () => {
    render(<NavRail />)
    const sessions = screen.getByRole('button', { name: /会话|Sessions/ })
    expect(sessions).toBeInTheDocument()
    expect(sessions.textContent).not.toMatch(/\d/)
  })

  it('shows six entries, with knowledge + ideas as 知识 and skills + MCP + secrets as 能力', () => {
    render(<NavRail />)
    expect(screen.getByRole('button', { name: /会话|Sessions/ })).toBeInTheDocument()
    expect(screen.getByTestId('contacts-nav-entry')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^知识$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^能力$/ })).toBeInTheDocument()
    expect(screen.getByTestId('apps-nav-section')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /快捷方式|Shortcuts/ })).toBeInTheDocument()

    // The members are column two's switch, not rail entries.
    expect(screen.queryByRole('button', { name: /知识库/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /想法/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /技能/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /MCP/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /密钥保险箱/ })).not.toBeInTheDocument()
    // No fold any more.
    expect(screen.queryByRole('button', { name: /^更多$/ })).not.toBeInTheDocument()
  })

  it('知识 opens the knowledge base first, then whichever member was last open', () => {
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /^知识$/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'teamShare', section: 'knowledge' })

    act(() => {
      useUIStore.getState().setSidebarFilter({ kind: 'ideas' })
      useUIStore.getState().setSidebarFilter({ kind: 'all' })
    })
    fireEvent.click(screen.getByRole('button', { name: /^知识$/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'ideas' })
  })

  it('能力 opens skills first, then whichever member was last open', () => {
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /^能力$/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'teamShare', section: 'skills' })

    act(() => {
      useUIStore.getState().setSidebarFilter({ kind: 'teamShare', section: 'env' })
      useUIStore.getState().setSidebarFilter({ kind: 'all' })
    })
    fireEvent.click(screen.getByRole('button', { name: /^能力$/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'teamShare', section: 'env' })
  })

  it('marks a group entry active while any of its members is open', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'teamShare', section: 'mcp' } })
    render(<NavRail />)
    expect(screen.getByRole('button', { name: /^能力$/ }).className).toMatch(/font-semibold/)
    expect(screen.getByRole('button', { name: /^知识$/ }).className).not.toMatch(/font-semibold/)
  })

  it('clicking Shortcuts sets filter to { kind: "shortcuts" }', () => {
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /快捷方式/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'shortcuts' })
  })

  it('in embed (plugin) mode hides Shortcuts and 知识 skips ideas', () => {
    useUIStore.setState({ embedMode: true, navGroupLast: { knowledge: 'ideas' } })
    render(<NavRail />)
    expect(screen.queryByRole('button', { name: /快捷方式|Shortcuts/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^知识$/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'teamShare', section: 'knowledge' })
  })
})
