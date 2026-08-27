import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NavRail } from '../NavRail'
import { useUIStore } from '@/stores/ui'
import { useSessionStore } from '@/stores/session'
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
vi.mock('@/lib/remote-features', () => ({
  useFeatures: () => ({ apps: true }),
}))
vi.mock('@/components/sidebar/AppsNavSection', () => ({
  AppsNavSection: () => <div data-testid="apps-nav-section" />,
}))
vi.mock('sonner', () => ({
  toast: vi.fn(),
}))

function expandMore() {
  fireEvent.click(screen.getByRole('button', { name: /更多|More/ }))
}

describe('NavRail', () => {
  beforeEach(() => {
    useUIStore.setState({
      sidebarFilter: { kind: 'all' },
      embedMode: false,
      moreNavExpanded: false,
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

  it('shows session count badge in Sessions row', () => {
    render(<NavRail />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('keeps session count when legacy session store is empty', () => {
    useSessionStore.setState({ sessions: [] })
    useSessionListStore.setState({
      rows: [mkListRow('s1', 'A'), mkListRow('s2', 'B'), mkListRow('s3', 'C')],
    })
    render(<NavRail />)
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('shows only Sessions, Contacts, Skills and Knowledge by default', () => {
    render(<NavRail />)
    expect(screen.getByRole('button', { name: /会话|Sessions/ })).toBeInTheDocument()
    expect(screen.getByTestId('contacts-nav-entry')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /技能|Skills/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /知识库|Knowledge/ })).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: /Ideas|想法/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /快捷方式|Shortcuts/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /MCP/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /环境变量|Team Env/ })).not.toBeInTheDocument()
  })

  it('reveals Ideas, Shortcuts, MCP and Team Env once 更多 is expanded', () => {
    render(<NavRail />)
    expandMore()
    expect(screen.getByRole('button', { name: /Ideas|想法/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /快捷方式|Shortcuts/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /MCP/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /环境变量|Team Env/ })).toBeInTheDocument()
  })

  it('clicking Shortcuts inside 更多 sets filter to { kind: "shortcuts" }', () => {
    render(<NavRail />)
    expandMore()
    fireEvent.click(screen.getByRole('button', { name: /快捷方式/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'shortcuts' })
  })

  it('auto-expands 更多 when one of its destinations is already selected', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'shortcuts' } })
    render(<NavRail />)
    expect(screen.getByRole('button', { name: /快捷方式|Shortcuts/ })).toBeInTheDocument()
    expect(useUIStore.getState().moreNavExpanded).toBe(true)
  })

  it('hides Ideas and Shortcuts in embed (plugin) mode', () => {
    useUIStore.setState({ embedMode: true })
    render(<NavRail />)
    expandMore()
    expect(screen.queryByRole('button', { name: /Ideas|想法/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /快捷方式|Shortcuts/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /会话|Sessions/ })).toBeInTheDocument()
  })

  it('renders AppsNavSection inside 更多 when apps feature is on', () => {
    render(<NavRail />)
    expandMore()
    expect(screen.getByTestId('apps-nav-section')).toBeInTheDocument()
  })

  it('auto-expands 更多 when apps filter is active', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'apps' } })
    render(<NavRail />)
    expect(screen.getByTestId('apps-nav-section')).toBeInTheDocument()
    expect(useUIStore.getState().moreNavExpanded).toBe(true)
  })
})
