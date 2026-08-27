import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

const mockSetActiveSession = vi.fn()
const mockClearSelection = vi.fn()
const mockSetFileModeRightTab = vi.fn()

// Mutable state refs for stores
let mockSessions: Array<{ id: string; title: string; updatedAt: string | Date; messageCount?: number; parentID?: string }> = []
let mockActiveSessionId: string | null = null
let mockIsLoading = false
let mockHighlightedSessionIds: string[] = []
let mockLayoutMode = 'task'
let mockPendingPermissions: Array<{
  permission: { id: string; sessionID?: string; permission: string; patterns?: string[] }
  childSessionId: string | null
  ownerSessionId?: string | null
}> = []
let mockPendingQuestions: Array<{ questionId: string; toolCallId: string; messageId: string; sessionId?: string; questions: unknown[] }> = []
let mockSessionStatus: { type: 'idle' | 'busy' | 'retry' } | null = null
let mockStreamingMessageId: string | null = null
let mockCronSessionIds = new Set<string>()
let mockShowCronSessions = false

// NOTE: @/stores/session and @/stores/ui are mocked further down with the
// full Object.assign(...) form that also provides static getState — vitest 4
// dedups duplicate vi.mock calls per-module non-deterministically across worker
// reuse, so we keep a single (complete) registration for each.

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ clearSelection: mockClearSelection }),
}))

// Mock date-format
vi.mock('@/lib/date-format', () => ({
  formatRelativeDate: () => 'just now',
}))

// Mock tanstack virtual
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 0,
    getVirtualItems: () => [],
  }),
}))

// Must be imported after mocks
import { SessionList } from '../SessionList'

// Need static getState for the handleSelectSession callback
vi.mock('@/stores/session', () => ({
  useSessionStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        sessions: mockSessions,
        activeSessionId: mockActiveSessionId,
        isLoading: mockIsLoading,
        highlightedSessionIds: mockHighlightedSessionIds,
        pendingPermissions: mockPendingPermissions,
        pendingQuestions: mockPendingQuestions,
        sessionStatus: mockSessionStatus,
        setActiveSession: mockSetActiveSession,
      }),
    {
      getState: () => ({
        activeSessionId: mockActiveSessionId,
        setActiveSession: mockSetActiveSession,
      }),
    },
  ),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ layoutMode: mockLayoutMode, setFileModeRightTab: mockSetFileModeRightTab }),
    {
      getState: () => ({
        layoutMode: mockLayoutMode,
        switchToSession: mockSetActiveSession,
      }),
    },
  ),
}))

vi.mock('@/stores/streaming', () => ({
  useStreamingStore: (selector: (s: unknown) => unknown) =>
    selector({ streamingMessageId: mockStreamingMessageId }),
}))

vi.mock('@/stores/cron', () => ({
  useCronStore: (selector: (s: unknown) => unknown) =>
    selector({
      cronSessionIds: mockCronSessionIds,
      showCronSessions: mockShowCronSessions,
    }),
}))

describe('SessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessions = []
    mockActiveSessionId = null
    mockIsLoading = false
    mockHighlightedSessionIds = []
    mockLayoutMode = 'task'
    mockPendingPermissions = []
    mockPendingQuestions = []
    mockSessionStatus = null
    mockStreamingMessageId = null
    mockCronSessionIds = new Set<string>()
    mockShowCronSessions = false
  })

  it('renders a list of sessions', () => {
    mockSessions = [
      { id: 'sess-1', title: 'First Session', updatedAt: new Date().toISOString() },
      { id: 'sess-2', title: 'Second Session', updatedAt: new Date().toISOString() },
    ]
    render(<SessionList />)
    expect(screen.getByText('First Session')).toBeTruthy()
    expect(screen.getByText('Second Session')).toBeTruthy()
  })

  it('clicking a session triggers setActiveSession', () => {
    mockSessions = [
      { id: 'sess-1', title: 'Click Me', updatedAt: new Date().toISOString() },
    ]
    render(<SessionList />)
    fireEvent.click(screen.getByText('Click Me'))
    expect(mockSetActiveSession).toHaveBeenCalledWith('sess-1')
  })

  it('shows empty state when there are no sessions', () => {
    mockSessions = []
    render(<SessionList />)
    expect(screen.getByText('No conversations yet')).toBeTruthy()
  })

  it('does not show active waiting badge for pending approval owned by another session', () => {
    mockSessions = [
      { id: 'sess-1', title: 'Waiting Session', updatedAt: new Date().toISOString() },
      { id: 'sess-2', title: 'Active Session', updatedAt: new Date().toISOString() },
    ]
    mockActiveSessionId = 'sess-2'
    mockPendingPermissions = [
      {
        permission: {
          id: 'perm-1',
          sessionID: 'sess-1',
          permission: 'bash',
          patterns: ['ls'],
        },
        childSessionId: null,
        ownerSessionId: 'sess-1',
      },
    ]

    render(<SessionList />)

    expect(screen.queryByText('Waiting')).toBeNull()
  })
})
