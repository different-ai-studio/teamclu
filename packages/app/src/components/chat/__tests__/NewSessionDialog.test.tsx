import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  closeNewSessionDialog: vi.fn(),
  switchToSession: vi.fn(),
  loadSessions: vi.fn(),
  upsertRows: vi.fn(),
  addHighlightedSession: vi.fn(),
  createSessionWithFirstMessage: vi.fn(),
  ensureSessionLiveSubscribed: vi.fn(),
  listActorDirectory: vi.fn(),
  requestComposerFocus: vi.fn(),
  getLocalDaemonActorId: vi.fn(),
  listDaemonWorkspaces: vi.fn(),
  setAgentDefaultWorkspace: vi.fn(),
  createDaemonWorkspace: vi.fn(),
  rememberDefaultWorkspaceId: vi.fn(),
  isTauri: vi.fn(() => false),
  team: { id: 'team-1' } as { id: string } | null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        newSessionDialogOpen: true,
        newSessionDialogInitialMessage: '',
        closeNewSessionDialog: mocks.closeNewSessionDialog,
        switchToSession: mocks.switchToSession,
      }),
    {
      getState: () => ({
        closeNewSessionDialog: mocks.closeNewSessionDialog,
        switchToSession: mocks.switchToSession,
        requestComposerFocus: mocks.requestComposerFocus,
      }),
    },
  ),
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        session: {
          user: { id: 'user-1' },
          access_token: 'token',
        },
      }),
    {
      getState: () => ({
        session: {
          user: { id: 'user-1' },
          access_token: 'token',
        },
      }),
    },
  ),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (state: unknown) => unknown) =>
    selector({
      team: mocks.team,
      currentMember: { id: 'member-1' },
    }),
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: {
    getState: () => ({
      load: mocks.loadSessions,
      upsertRows: mocks.upsertRows,
    }),
  },
}))

vi.mock('@/stores/session-store', () => ({
  useSessionStore: {
    getState: () => ({ addHighlightedSession: mocks.addHighlightedSession }),
  },
}))

vi.mock('@/stores/agent-default-workspace-store', () => ({
  rememberDefaultWorkspaceId: (...args: unknown[]) => mocks.rememberDefaultWorkspaceId(...args),
}))

vi.mock('@/lib/actor/current-actor', () => ({
  resolveCurrentMemberActorId: vi.fn().mockResolvedValue('member-1'),
}))

vi.mock('@/lib/cache/local-cache', () => ({
  loadActorsForTeam: vi.fn().mockResolvedValue([
    { id: 'agent-1', actorType: 'agent', displayName: 'MCA2' },
  ]),
  // Reached only once isTauri() is true — the actor directory writes its
  // reconcile back to libsql there.
  upsertActorsBatch: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/sync/actor-sync', () => ({
  syncActorsForTeam: vi.fn().mockResolvedValue(0),
}))

vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonActorId: (...args: unknown[]) => mocks.getLocalDaemonActorId(...args),
}))

vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  listDaemonWorkspaces: (...args: unknown[]) => mocks.listDaemonWorkspaces(...args),
  createDaemonWorkspace: (...args: unknown[]) => mocks.createDaemonWorkspace(...args),
  setAgentDefaultWorkspace: (...args: unknown[]) => mocks.setAgentDefaultWorkspace(...args),
}))

vi.mock('@/lib/session/session-viewer-workspace', () => ({
  invalidateViewerWorkspaceContext: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    actors: {
      listActorDirectory: mocks.listActorDirectory,
    },
  }),
}))

vi.mock('@/lib/actor/actor-color', () => ({
  actorAvatarColor: () => ({ bg: '#64748b', fg: '#fff' }),
}))

vi.mock('@/lib/session/session-create', () => ({
  createSessionWithFirstMessage: (...args: unknown[]) => mocks.createSessionWithFirstMessage(...args),
}))

vi.mock('@/lib/session/session-live-subscriptions', () => ({
  ensureSessionLiveSubscribed: (...args: unknown[]) => mocks.ensureSessionLiveSubscribed(...args),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
  isTauri: () => mocks.isTauri(),
}))

import { NewSessionDialog } from '../NewSessionDialog'

describe('NewSessionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.team = { id: 'team-1' }
    mocks.isTauri.mockReturnValue(false)
    mocks.createSessionWithFirstMessage.mockResolvedValue({ sessionId: 'sess-1' })
    mocks.getLocalDaemonActorId.mockResolvedValue(null)
    mocks.listDaemonWorkspaces.mockResolvedValue([])
    // Candidates now flow through the shared actor-directory store, which reads
    // the network directory (listActorDirectory) — not the libsql cache — in the
    // jsdom test env (isTauri() === false).
    mocks.listActorDirectory.mockResolvedValue([
      { id: 'agent-1', actor_type: 'agent', display_name: 'MCA2' },
    ])
  })

  it('allows creating a daemon-agent session before the daemon has advertised models', async () => {
    render(<NewSessionDialog />)

    fireEvent.click(await screen.findByText('MCA2'))
    fireEvent.change(screen.getByPlaceholderText('想聊点什么？'), {
      target: { value: 'hello daemon' },
    })
    fireEvent.click(screen.getByRole('button', { name: /创建会话/ }))

    await waitFor(() => {
      expect(mocks.createSessionWithFirstMessage).toHaveBeenCalledWith({
        teamId: 'team-1',
        creatorActorId: 'member-1',
        additionalActorIds: ['agent-1'],
        agentActorIds: ['agent-1'],
        messageText: 'hello daemon',
        localWorkspace: null,
      })
    })
  })

  it('shows an empty state instead of the picker when there is no team', async () => {
    mocks.team = null
    render(<NewSessionDialog />)

    expect(screen.getByTestId('new-session-no-team')).toBeTruthy()
    expect(screen.queryByPlaceholderText('想聊点什么？')).toBeNull()
    expect(screen.getByRole('button', { name: /创建会话/ })).toBeDisabled()
  })

  describe('with a local daemon agent', () => {
    beforeEach(() => {
      mocks.isTauri.mockReturnValue(true)
      mocks.getLocalDaemonActorId.mockResolvedValue('agent-1')
      mocks.listActorDirectory.mockResolvedValue([
        {
          id: 'agent-1',
          actor_type: 'agent',
          display_name: 'MCA2',
          default_workspace_id: 'ws-default',
        },
        { id: 'agent-2', actor_type: 'agent', display_name: 'MCA2' },
      ])
      mocks.listDaemonWorkspaces.mockResolvedValue([
        { id: 'ws-other', name: 'other', path: '/tmp/other', archived: false },
        { id: 'ws-default', name: 'teamclu', path: '/tmp/teamclu', archived: false },
      ])
    })

    it('badges only the agent on this machine, which display names cannot distinguish', async () => {
      render(<NewSessionDialog />)

      await screen.findAllByText('MCA2')
      await waitFor(() => {
        expect(screen.getAllByTestId('candidate-local-badge')).toHaveLength(1)
      })
    })

    it('reveals the workspace picker only while the local agent is a participant', async () => {
      render(<NewSessionDialog />)

      const rows = await screen.findAllByText('MCA2')
      expect(screen.queryByTestId('new-session-workspace')).toBeNull()

      fireEvent.click(rows[0])
      await waitFor(() => {
        expect(screen.getByTestId('new-session-workspace')).toBeTruthy()
      })

      fireEvent.click(rows[0])
      await waitFor(() => {
        expect(screen.queryByTestId('new-session-workspace')).toBeNull()
      })
    })

    it("preselects the agent's default workspace and passes the choice to create", async () => {
      render(<NewSessionDialog />)

      const rows = await screen.findAllByText('MCA2')
      fireEvent.click(rows[0])
      await waitFor(() => {
        expect(mocks.listDaemonWorkspaces).toHaveBeenCalledWith('team-1', 'agent-1')
      })

      const select = await screen.findByLabelText('工作目录')
      await waitFor(() => expect((select as HTMLSelectElement).value).toBe('ws-default'))

      fireEvent.change(select, { target: { value: 'ws-other' } })
      fireEvent.change(screen.getByPlaceholderText('想聊点什么？'), {
        target: { value: 'run here' },
      })
      fireEvent.click(screen.getByRole('button', { name: /创建会话/ }))

      await waitFor(() => {
        expect(mocks.createSessionWithFirstMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            localWorkspace: {
              agentId: 'agent-1',
              workspaceId: 'ws-other',
              path: '/tmp/other',
            },
          }),
        )
      })
    })

    it('writes the agent default and refreshes the send-path cache', async () => {
      mocks.setAgentDefaultWorkspace.mockResolvedValue(undefined)
      render(<NewSessionDialog />)

      const rows = await screen.findAllByText('MCA2')
      fireEvent.click(rows[0])

      const select = await screen.findByLabelText('工作目录')
      await waitFor(() => expect((select as HTMLSelectElement).value).toBe('ws-default'))
      fireEvent.change(select, { target: { value: 'ws-other' } })

      fireEvent.click(await screen.findByRole('button', { name: /设为默认/ }))

      await waitFor(() => {
        expect(mocks.setAgentDefaultWorkspace).toHaveBeenCalledWith('agent-1', 'ws-other')
        expect(mocks.rememberDefaultWorkspaceId).toHaveBeenCalledWith(['agent-1'], 'ws-other')
      })
    })
  })
})
