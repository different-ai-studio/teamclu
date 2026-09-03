import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  getSessionTeamId: vi.fn(),
  listSessionDisplayRows: vi.fn(),
  upsertRows: vi.fn(),
  reloadAndSwitchTo: vi.fn(),
  setShowCronSessions: vi.fn(),
  currentTeam: { id: 'team-1' } as { id: string } | null,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: Array<string | false | null | undefined>) => args.filter(Boolean).join(' '),
  isTauri: () => false,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/test/workspace' }),
  },
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ switchToSession: vi.fn() }),
  },
}))

vi.mock('@/stores/cron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/cron')>()
  return {
    ...actual,
    useCronStore: {
      getState: () => ({
        setShowCronSessions: mocks.setShowCronSessions,
      }),
    },
  }
})

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessions: {
      getSessionTeamId: mocks.getSessionTeamId,
      listSessionDisplayRows: mocks.listSessionDisplayRows,
    },
  }),
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: {
    getState: () => ({
      rows: [],
      upsertRows: mocks.upsertRows,
    }),
  },
}))

vi.mock('@/lib/cron/cron-session-messages', () => ({
  hydrateCronSessionMessages: vi.fn().mockResolvedValue(1),
  ensureCronSessionVisible: async (sessionId: string) => {
    const teamId = await mocks.getSessionTeamId(sessionId)
    if (!teamId) throw new Error(`Session ${sessionId.slice(0, 8)} not found`)
    if (mocks.currentTeam?.id !== teamId) {
      await mocks.reloadAndSwitchTo(teamId)
    }
    const [displayRow] = await mocks.listSessionDisplayRows(teamId, [sessionId])
    mocks.upsertRows([
      {
        id: sessionId,
        title: displayRow?.title || 'Cron job',
        team_id: teamId,
        last_message_at: null,
        last_message_preview: null,
        mode: 'collab',
        idea_id: null,
        has_unread: false,
        created_at: null,
        updated_at: null,
      },
    ])
  },
}))

vi.mock('@/stores/session-message-store', () => ({
  useSessionMessageStore: {
    getState: () => ({ reloadActiveSessionMessages: vi.fn() }),
  },
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({
      team: mocks.currentTeam,
      reloadAndSwitchTo: mocks.reloadAndSwitchTo,
    }),
  },
}))

import { RunRecordCard, ensureCronSessionVisible } from '../CronHistoryDialog'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.currentTeam = { id: 'team-1' }
})

describe('RunRecordCard', () => {
  it('shows the last heartbeat for running runs', () => {
    render(
      <RunRecordCard
        run={{
          runId: 'run-1',
          jobId: 'job-1',
          startedAt: new Date(Date.now() - 120_000).toISOString(),
          lastHeartbeatAt: new Date(Date.now() - 30_000).toISOString(),
          status: 'running',
        }}
      />,
    )

    expect(screen.getByText(/Last heartbeat:/)).toBeTruthy()
  })

  it('shows the last heartbeat for stale runs', () => {
    render(
      <RunRecordCard
        run={{
          runId: 'run-1',
          jobId: 'job-1',
          startedAt: new Date(Date.now() - 120_000).toISOString(),
          finishedAt: new Date(Date.now() - 10_000).toISOString(),
          lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
          status: 'stale',
          error: 'Cron run was interrupted before completion.',
        }}
      />,
    )

    expect(screen.getByText(/Last heartbeat:/)).toBeTruthy()
  })

  it('switches to the cron session team before inserting the session row', async () => {
    mocks.currentTeam = { id: 'team-old' }
    mocks.reloadAndSwitchTo.mockResolvedValueOnce(undefined)
    mocks.getSessionTeamId.mockResolvedValueOnce('team-new')
    mocks.listSessionDisplayRows.mockResolvedValueOnce([{ id: 'session-2', title: 'Cron: Other Team' }])

    await ensureCronSessionVisible('session-2')

    expect(mocks.reloadAndSwitchTo).toHaveBeenCalledWith('team-new')
    expect(mocks.upsertRows).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'session-2',
        team_id: 'team-new',
      }),
    ])
  })
})

describe('ensureCronSessionVisible', () => {
  it('upserts a display row for cron sessions missing from the sidebar list', async () => {
    mocks.getSessionTeamId.mockResolvedValueOnce('team-1')
    mocks.listSessionDisplayRows.mockResolvedValueOnce([{ id: 'session-1', title: 'Cron: Daily' }])

    await ensureCronSessionVisible('session-1')

    expect(mocks.getSessionTeamId).toHaveBeenCalledWith('session-1')
    expect(mocks.listSessionDisplayRows).toHaveBeenCalledWith('team-1', ['session-1'])
    expect(mocks.upsertRows).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'session-1',
        team_id: 'team-1',
        title: 'Cron: Daily',
        mode: 'collab',
      }),
    ])
  })
})
