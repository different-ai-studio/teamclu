import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SessionDetailDialog } from '../SessionDetailDialog'

const fetchSessionDetailSnapshot = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}))

vi.mock('@/lib/ui/date-format', () => ({
  formatRelativeTime: () => 'just now',
  formatDate: () => '2026-06-05',
}))

vi.mock('@/lib/session/session-detail', () => ({
  fetchSessionDetailSnapshot: (...args: unknown[]) => fetchSessionDetailSnapshot(...args),
}))

vi.mock('@/stores/runtime-state-store', () => ({
  useRuntimeStateStore: (selector: (state: { byRuntimeId: Record<string, never> }) => unknown) =>
    selector({ byRuntimeId: {} }),
}))

vi.mock('@/stores/acp-debug-store', () => ({
  isAcpDebugPanelVisible: () => false,
  useAcpDebugStore: (selector: (state: { lines: [] }) => unknown) => selector({ lines: [] }),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

describe('SessionDetailDialog', () => {
  beforeEach(() => {
    fetchSessionDetailSnapshot.mockReset()
    fetchSessionDetailSnapshot.mockResolvedValue({
      sessionId: 'session-1',
      teamId: 'team-1',
      title: 'b002-agent (15:14)',
      mode: 'collab',
      ideaId: null,
      primaryAgentId: 'agent-1',
      summary: null,
      createdByActorId: null,
      acpSessionId: null,
      binding: null,
      metadataJson: null,
      createdAt: '2026-06-05T00:00:00Z',
      updatedAt: '2026-06-05T01:00:00Z',
      lastMessageAt: '2026-06-05T01:00:00Z',
      lastMessagePreview: 'hello',
      runtimes: [{
        agentId: 'agent-1',
        agentName: 'b002-agent',
        runtimeId: 'rt123456',
        backendType: 'opencode',
        backendSessionId: 'bs-1',
        dbStatus: 'ready',
        dbModel: 'MiniMax-M2.5',
        liveState: 'active',
        liveStatus: 'ok',
        liveModel: 'MiniMax-M2.5',
        agentType: '1',
        lastSeenAt: '2026-06-05T01:00:00Z',
        workspacePath: '/tmp/workspace',
        workspaceId: null,
      }],
      workspaces: [],
      loadError: null,
    })
  })

  it('renders session overview and runtime sections', async () => {
    render(
      <SessionDetailDialog
        sessionId="session-1"
        teamId="team-1"
        hints={{ title: 'b002-agent (15:14)' }}
        participants={[
          {
            actorId: 'agent-1',
            displayName: 'b002-agent',
            avatarUrl: null,
            isAgent: true,
          },
        ]}
        activeSessionId="session-2"
        onOpenChange={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    )

    expect(screen.getByText('b002-agent (15:14)')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('Overview')).toBeInTheDocument()
      expect(screen.getByText('Runtime')).toBeInTheDocument()
      expect(screen.getByText('rt123456')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Open session/i })).toBeInTheDocument()
  })
})
