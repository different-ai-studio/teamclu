import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { create } from '@bufbuild/protobuf'
import { RuntimeInfoSchema, AgentStatus, AgentType, RuntimeLifecycle } from '@/lib/proto/amux_pb'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { SessionActorPanel } from '../SessionActorSheet'
import { clearSessionCreatedByCacheForTests } from '@/lib/session-created-by-cache'

const workspaceStoreState = vi.hoisted(() => ({
  workspacePath: '/Users/weigan.huang/copilot-ws-v2',
}))

const mockRuntimeStart = vi.fn().mockResolvedValue({ accepted: true, runtimeId: 'rt-new', sessionId: 'sess-1', rejectedReason: '' })
vi.mock('@/lib/teamclu-rpc', () => ({
  runtimeStart: (...args: unknown[]) => mockRuntimeStart(...args),
}))

const backendListParticipants = vi.fn()
const backendListCandidateActors = vi.fn()
const backendAddParticipant = vi.fn()
const backendRemoveParticipant = vi.fn()
const backendListAgentDefaults = vi.fn()
const backendListActorDirectoryByIds = vi.fn()
const backendListDaemonWorkspaces = vi.fn()
const backendGetSession = vi.fn()
const backendGetSessionDetail = vi.fn()
const backendResolveCurrentMemberActor = vi.fn()
const loadSessionParticipantsMock = vi.fn()
const loadSessionsForTeamMock = vi.fn()
const loadActorsForTeamMock = vi.fn()
const loadActorsByIdsMock = vi.fn()
const syncActorsForTeamMock = vi.fn().mockResolvedValue(undefined)
const syncParticipantsForSessionMock = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessionMembers: {
      listParticipants: backendListParticipants,
      listCandidateActors: backendListCandidateActors,
      addParticipant: backendAddParticipant,
      removeParticipant: backendRemoveParticipant,
    },
    runtime: {
      listAgentDefaults: backendListAgentDefaults,
    },
    actors: {
      listActorDirectoryByIds: backendListActorDirectoryByIds,
    },
    workspaces: {
      listDaemonWorkspaces: backendListDaemonWorkspaces,
    },
    auth: {
      getSession: backendGetSession,
    },
    sessions: {
      getSession: backendGetSessionDetail,
    },
    directory: {
      resolveCurrentMemberActor: backendResolveCurrentMemberActor,
    },
  }),
}))

vi.mock('@/lib/local-cache', () => ({
  loadSessionParticipants: (...args: unknown[]) => loadSessionParticipantsMock(...args),
  loadSessionsForTeam: (...args: unknown[]) => loadSessionsForTeamMock(...args),
  loadActorsForTeam: (...args: unknown[]) => loadActorsForTeamMock(...args),
  loadActorsByIds: (...args: unknown[]) => loadActorsByIdsMock(...args),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: typeof workspaceStoreState) => unknown) => selector(workspaceStoreState),
    {
      getState: () => workspaceStoreState,
    },
  ),
}))

vi.mock('@/lib/sync/actor-sync', () => ({
  syncActorsForTeam: (...args: unknown[]) => syncActorsForTeamMock(...args),
}))

vi.mock('@/lib/sync/session-participant-sync', () => ({
  syncParticipantsForSession: (...args: unknown[]) => syncParticipantsForSessionMock(...args),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, fallback: string, opts?: Record<string, unknown>) => {
      if (!opts) return fallback
      // Simple interpolation for test: replace {{key}} with value
      return fallback.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(opts[key] ?? ''))
    },
  }),
}))

beforeEach(() => {
  clearSessionCreatedByCacheForTests()
  backendListParticipants.mockReset()
  backendListCandidateActors.mockReset()
  backendAddParticipant.mockReset()
  backendRemoveParticipant.mockReset()
  backendListAgentDefaults.mockReset()
  backendListActorDirectoryByIds.mockReset()
  backendListDaemonWorkspaces.mockReset()
  backendGetSession.mockReset()
  backendGetSessionDetail.mockReset()
  backendResolveCurrentMemberActor.mockReset()
  backendAddParticipant.mockResolvedValue(undefined)
  backendRemoveParticipant.mockResolvedValue(undefined)
  backendListAgentDefaults.mockResolvedValue([])
  backendListActorDirectoryByIds.mockResolvedValue([])
  backendListDaemonWorkspaces.mockResolvedValue([])
  backendListAgentDefaults.mockResolvedValue([])
  backendListActorDirectoryByIds.mockResolvedValue([])
  backendListDaemonWorkspaces.mockResolvedValue([])
  backendGetSession.mockResolvedValue({ user: { id: 'user-1' } })
  backendGetSessionDetail.mockResolvedValue({ id: 'sess-1', created_by_actor_id: 'm-1' })
  backendResolveCurrentMemberActor.mockResolvedValue({ id: 'm-1', team_id: 'team-1' })
  mockRuntimeStart.mockReset()
  loadSessionParticipantsMock.mockReset()
  loadSessionsForTeamMock.mockReset()
  loadSessionsForTeamMock.mockResolvedValue([])
  loadActorsForTeamMock.mockReset()
  loadActorsByIdsMock.mockReset()
  syncActorsForTeamMock.mockClear()
  syncParticipantsForSessionMock.mockClear()
  mockRuntimeStart.mockResolvedValue({ accepted: true, runtimeId: 'rt-new', sessionId: 'sess-1', rejectedReason: '' })
  useRuntimeStateStore.getState().clear()
  workspaceStoreState.workspacePath = '/Users/weigan.huang/copilot-ws-v2'
})

function mockJoinedRows(participantActorIds: string[], actorRows: unknown[]) {
  loadSessionParticipantsMock.mockResolvedValue(
    participantActorIds.map(id => ({ actorId: id })),
  )
  loadActorsForTeamMock.mockResolvedValue([])
  loadActorsByIdsMock.mockResolvedValue(
    actorRows.map((row: any) => ({
      id: row.id,
      actorType: row.actor_type,
      displayName: row.display_name,
      memberStatus: row.member_status ?? null,
      agentStatus: row.agent_status ?? null,
    })),
  )
  backendListParticipants.mockResolvedValue(actorRows)
  backendListCandidateActors.mockResolvedValue([])
  backendListAgentDefaults.mockResolvedValue([])
}

function mockSheetData(
  participantActorIds: string[],
  actorRows: unknown[],
  runtimeRows: unknown[],
  teamAgentRows: unknown[] = [],
  agentHistoryRows: unknown[] = [],
) {
  const actorCacheRows = actorRows.map((row: any) => ({
    id: row.id,
    actorType: row.actor_type,
    displayName: row.display_name,
    memberStatus: row.member_status ?? null,
    agentStatus: row.agent_status ?? null,
  }))
  const teamCacheRows = [...actorCacheRows]
  for (const row of teamAgentRows as Array<any>) {
    if (!teamCacheRows.some(existing => existing.id === row.id)) {
      teamCacheRows.push({
        id: row.id,
        actorType: row.actor_type,
        displayName: row.display_name,
        memberStatus: row.member_status ?? null,
        agentStatus: row.agent_status ?? null,
      })
    }
  }

  loadSessionParticipantsMock.mockResolvedValue(
    participantActorIds.map(id => ({ actorId: id })),
  )
  loadActorsForTeamMock.mockResolvedValue(teamCacheRows)
  loadActorsByIdsMock.mockResolvedValue(actorCacheRows)
  backendListParticipants.mockResolvedValue(actorRows)
  backendListCandidateActors.mockResolvedValue(
    (teamAgentRows as Array<any>).map((row) => ({ ...row, is_present: false })),
  )
  // Runtime hints ride the actor retain now, so seed the store instead of a
  // backend mock. Keyed (actor, session) — see attachmentsForSession.
  // First occurrence wins, and pre-seeded entries are left alone: a daemon
  // holds at most one attachment per session, so "duplicate rows for one agent"
  // is a shape the retain cannot produce.
  const seeded = new Set<string>()
  for (const row of [...(agentHistoryRows as Array<any>), ...(runtimeRows as Array<any>)]) {
    if (!row.agent_id) continue
    const key = `${row.agent_id}::sess-1`
    if (seeded.has(key) || useRuntimeStateStore.getState().byRuntimeId[key]) continue
    seeded.add(key)
    useRuntimeStateStore.getState().upsert(
      key,
      row.agent_id,
      create(RuntimeInfoSchema, {
        runtimeId: row.runtime_id ?? '',
        agentType: row.backend_type === 'opencode' ? AgentType.OPENCODE : AgentType.CLAUDE_CODE,
        currentModel: row.current_model ?? '',
        workspaceId: row.workspace_id ?? '',
      }),
    )
  }
  // The workspace a spawn starts in comes from the participant row for an agent
  // already in the session, and from the actor's default for one being added
  // (ADR-0005) — never from a runtime row, which no longer exists.
  const workspaceRows = [...(runtimeRows as Array<any>), ...(agentHistoryRows as Array<any>)]
  backendListActorDirectoryByIds.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({
      id,
      default_workspace_id: workspaceRows.find((r) => r.agent_id === id)?.workspace_id ?? null,
    })),
  )
  backendListAgentDefaults.mockResolvedValue(
    ([...(actorRows as Array<any>), ...(teamAgentRows as Array<any>)]).map((row) => ({
      id: row.id,
      agent_types: row.agent_types ?? [],
      default_agent_type: row.default_agent_type ?? null,
    })),
  )
}

describe('SessionActorSheet', () => {
  it('lists members and agents from session_participants × actor_directory', async () => {
    mockJoinedRows(
      ['m-1', 'a-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Alice', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
        { id: 'a-1', actor_type: 'agent', display_name: 'Reviewer', member_status: null, agent_status: 'idle', agent_kind: 'claude', last_active_at: null },
      ],
    )
    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('团队')).toBeInTheDocument()
    expect(screen.getByText('AGENT')).toBeInTheDocument()
  })

  it('shows empty state when session has no participants', async () => {
    mockJoinedRows([], [])
    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)
    await waitFor(() => expect(screen.getByText(/no participants in this session/i)).toBeInTheDocument())
  })

  it('does not fetch when sessionId is null', async () => {
    render(<SessionActorPanel sessionId={null} teamId={null} />)
    // Brief wait to ensure no fetch fires
    await new Promise(r => setTimeout(r, 50))
    expect(backendListParticipants).not.toHaveBeenCalled()
  })

  it('shows breathing dot and model name for an active agent', async () => {
    // Prime the runtime-state-store with a live ACTIVE/ACTIVE runtime
    const info = create(RuntimeInfoSchema, {
      runtimeId: '05532480',
      agentType: AgentType.CLAUDE_CODE,
      state: RuntimeLifecycle.ACTIVE,
      status: AgentStatus.ACTIVE,
      currentModel: 'claude-opus-4-7',
    })
    useRuntimeStateStore.getState().upsert('a-1::sess-1', 'a-1', info)

    mockSheetData(
      ['a-1'],
      [
        {
          id: 'a-1',
          actor_type: 'agent',
          display_name: 'Reviewer',
          member_status: null,
          agent_status: 'idle',
          agent_kind: 'claude',
          last_active_at: null,
        },
      ],
      [{ agent_id: 'a-1', runtime_id: '05532480', status: 'running', current_model: 'claude-opus-4-7' }],
    )

    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)
    await waitFor(() => expect(screen.getByText('Reviewer')).toBeInTheDocument())

    // Model name appears in subline
    expect(screen.getByText('claude-opus-4-7')).toBeInTheDocument()

    // Status dot has animate-pulse (breathing) class
    const dot = document.querySelector('.animate-pulse.rounded-full')
    expect(dot).toBeTruthy()
  })

  it('shows the single attachment a session has, not a merge of stale rows', async () => {
    // Replaces "keeps the newest runtime row when duplicate rows arrive
    // newest-first". `agent_runtimes` could hold several rows per (agent,
    // session) and the client had to pick; the retain holds exactly one
    // (`coalesce_session_runtimes` enforces it), so there is nothing to pick.
    useRuntimeStateStore.getState().upsert('rt-new', 'dev-a', create(RuntimeInfoSchema, {
      runtimeId: 'rt-new',
      agentType: AgentType.CLAUDE_CODE,
      state: RuntimeLifecycle.ACTIVE,
      status: AgentStatus.IDLE,
      currentModel: 'new-model',
    }))
    useRuntimeStateStore.getState().upsert('rt-old', 'dev-a', create(RuntimeInfoSchema, {
      runtimeId: 'rt-old',
      agentType: AgentType.CLAUDE_CODE,
      state: RuntimeLifecycle.ACTIVE,
      status: AgentStatus.IDLE,
      currentModel: 'old-model',
    }))

    mockSheetData(
      ['a-1'],
      [
        {
          id: 'a-1',
          actor_type: 'agent',
          display_name: 'Reviewer',
          member_status: null,
          agent_status: 'idle',
          agent_types: ['claude'],
          default_agent_type: 'claude',
          last_active_at: null,
        },
      ],
      [
        { agent_id: 'a-1', runtime_id: 'rt-new', status: 'running', current_model: 'new-model' },
        { agent_id: 'a-1', runtime_id: 'rt-old', status: 'running', current_model: 'old-model' },
      ],
    )

    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)

    await waitFor(() => expect(screen.getByText('Reviewer')).toBeInTheDocument())
    expect(screen.getByText(/new-model/)).toBeInTheDocument()
    expect(screen.queryByText(/old-model/)).not.toBeInTheDocument()
  })

  it('keeps participant rows visible when runtime enrichment fails', async () => {
    mockSheetData(
      ['m-1', 'a-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Me', member_status: 'active', agent_status: null, last_active_at: null },
        { id: 'a-1', actor_type: 'agent', display_name: 'Reviewer', member_status: null, agent_status: 'idle', last_active_at: null },
      ],
      [],
    )
    // Runtime enrichment is a retain read now — it cannot fail. The remaining
    // enrichment call that can is the actor directory, so that is what this
    // asserts degrades gracefully.
    backendListAgentDefaults.mockRejectedValueOnce(new Error('agent defaults unavailable'))

    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)

    await waitFor(() => expect(backendListAgentDefaults).toHaveBeenCalled())
    expect(screen.getByText('Me')).toBeInTheDocument()
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.queryByText(/failed to load actors/i)).not.toBeInTheDocument()
  })

  it.each([
    ['auth session load fails', () => backendGetSession.mockRejectedValueOnce(new Error('auth unavailable'))],
    ['current member actor resolution fails', () => backendResolveCurrentMemberActor.mockRejectedValueOnce(new Error('directory unavailable'))],
  ])('keeps participants and candidates visible when %s', async (_name, failEnrichment) => {
    failEnrichment()
    mockSheetData(
      ['m-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Me', member_status: 'active', agent_status: null, last_active_at: null },
      ],
      [],
      [
        { id: 'a-1', actor_type: 'agent', display_name: 'Candidate Bot', member_status: null, agent_status: 'idle', last_active_at: null },
      ],
    )

    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)

    await waitFor(() => expect(screen.getByText('Me')).toBeInTheDocument())
    expect(screen.getByText('Candidate Bot')).toBeInTheDocument()
    expect(screen.getByText('邀请加入')).toBeInTheDocument()
    expect(screen.queryByText(/failed to load actors/i)).not.toBeInTheDocument()
  })

  it('keeps participants and candidates visible when agent metadata enrichment fails', async () => {
    mockSheetData(
      ['m-1', 'a-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Me', member_status: 'active', agent_status: null, last_active_at: null },
        { id: 'a-1', actor_type: 'agent', display_name: 'Reviewer', member_status: null, agent_status: 'idle', last_active_at: null },
      ],
      [],
      [
        { id: 'a-2', actor_type: 'agent', display_name: 'Candidate Bot', member_status: null, agent_status: 'idle', last_active_at: null },
      ],
    )
    backendListAgentDefaults.mockRejectedValueOnce(new Error('agent defaults unavailable'))

    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)

    await waitFor(() => expect(backendListAgentDefaults).toHaveBeenCalled())
    expect(screen.getByText('Me')).toBeInTheDocument()
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('Candidate Bot')).toBeInTheDocument()
    expect(screen.getByText('邀请加入')).toBeInTheDocument()
    expect(screen.queryByText(/failed to load actors/i)).not.toBeInTheDocument()
  })

  it('shows owner label on session creator instead of always on self', async () => {
    mockSheetData(
      ['m-1', 'm-2', 'a-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Me', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
        { id: 'm-2', actor_type: 'member', display_name: 'Other', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
        { id: 'a-1', actor_type: 'agent', display_name: 'Bot', member_status: null, agent_status: 'idle', agent_kind: 'claude', last_active_at: null },
      ],
      [],
    )
    backendGetSessionDetail.mockResolvedValue({ id: 'sess-1', created_by_actor_id: 'm-2' })

    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)
    await waitFor(() => expect(screen.getAllByText('所有者')).toHaveLength(1))

    expect(backendGetSessionDetail).toHaveBeenCalledWith('sess-1', 'team-1')

    const otherRow = screen.getByText('Other').closest('.group')
    const meRow = screen.getByText('Me').closest('.group')
    expect(otherRow).toHaveTextContent('所有者')
    expect(meRow).not.toHaveTextContent('所有者')
  })

  it('starts added agents with opencode runtimeStart requests when runtime history says opencode', async () => {
    const user = userEvent.setup()
    mockSheetData(
      ['m-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Me', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
      ],
      [],
      [
        { id: 'a-2', actor_type: 'agent', display_name: 'Builder', member_status: null, agent_status: 'idle', agent_kind: 'daemon', last_active_at: null },
      ],
      [
        { workspace_id: 'ws-open', agent_id: 'a-2', current_model: 'openai/gpt-5', status: 'idle', backend_type: 'opencode', updated_at: '2026-05-18T00:00:00.000Z' },
      ],
    )

    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)
    await waitFor(() => expect(screen.getByText('Me')).toBeInTheDocument())

    const addAgentButton = screen.getByRole('button', { name: /\+ 加入/ })
    await user.click(addAgentButton)

    await waitFor(() => {
        expect(mockRuntimeStart).toHaveBeenCalledWith(
          expect.objectContaining({
            targetActorId: 'a-2',
            workspaceId: 'ws-open',
            worktree: '',
            agentType: AgentType.OPENCODE,
          }),
        )
      })
  })

  it('does not open remove confirm dialog while session kick is disabled', async () => {
    mockSheetData(
      ['m-1', 'm-2'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Me', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
        { id: 'm-2', actor_type: 'member', display_name: 'Other', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
      ],
      [],
    )

    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)
    await waitFor(() => expect(screen.getByText('Other')).toBeInTheDocument())

    expect(screen.queryAllByRole('button', { name: /remove/i })).toHaveLength(0)
    expect(screen.queryByText(/remove from session\?/i)).not.toBeInTheDocument()
  })

  it('shows + button when team has candidate agents and hides when no candidates', async () => {
    // Session has only a member (m-1), team has agent a-1 not yet in session
    mockSheetData(
      ['m-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Me', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
      ],
      [],
      [{ id: 'a-1', display_name: 'Bot', actor_type: 'agent' }],
    )

    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)
    await waitFor(() => expect(screen.getByText('Me')).toBeInTheDocument())

    // The invite heading and + button should appear since there's a candidate
    expect(screen.getByText('邀请加入')).toBeInTheDocument()
    const addBtn = screen.getByRole('button', { name: /\+ 加入/ })
    expect(addBtn).toBeInTheDocument()
  })

  it('renders the editorial participants panel with invite candidates', async () => {
    mockSheetData(
      ['m-1', 'a-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'You', member_status: '你', agent_status: null, agent_kind: null, last_active_at: null },
        { id: 'a-1', actor_type: 'agent', display_name: 'ClawBot', member_status: null, agent_status: '默认助手', agent_kind: 'claude', last_active_at: null },
      ],
      [],
      [
        { id: 'a-2', display_name: 'ShipReview', actor_type: 'agent', agent_status: '代码评审', agent_types: ['claude'], default_agent_type: 'claude' },
        { id: 'm-2', display_name: 'Jinliang', actor_type: 'member', member_status: '产品' },
      ],
    )

    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)
    // '参与者' is the static panel header — it renders immediately, before the
    // async participant/candidate load resolves, so waiting on it races the
    // data sections (flaky under CI load). Anchor on data-dependent markers
    // from both the participant-derived list (AGENT) and the candidate list
    // (ShipReview) so the wait only resolves once the loaded content is in.
    await waitFor(() => {
      expect(screen.getByText('AGENT')).toBeInTheDocument()
      expect(screen.getByText('ShipReview')).toBeInTheDocument()
    })

    expect(screen.getByText('团队')).toBeInTheDocument()
    expect(screen.getByText('邀请加入')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('搜索成员或 Agent...')).toBeInTheDocument()
    expect(screen.getByText('ShipReview')).toBeInTheDocument()
    expect(screen.getByText('Jinliang')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /\+ 加入/ })).toHaveLength(2)
    expect(screen.getByText('加入后将看到完整历史')).toBeInTheDocument()
  })

  it('clicking + button calls runtimeStart and adds agent row', async () => {
    const user = userEvent.setup()

    // Session has only m-1; team has candidate agent a-1
    mockSheetData(
      ['m-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Me', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
      ],
      [],
      [{ id: 'a-1', display_name: 'Bot', actor_type: 'agent' }],
    )

    render(<SessionActorPanel sessionId="sess-1" teamId="team-1" />)
    await waitFor(() => expect(screen.getByRole('button', { name: /\+ 加入/ })).toBeInTheDocument())

    const addBtn = screen.getByRole('button', { name: /\+ 加入/ })
    await user.click(addBtn)

    // After click, the agent row should appear optimistically
    await waitFor(() => expect(screen.getByText('Bot')).toBeInTheDocument())

    // runtimeStart should have been called
    await waitFor(() => expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        worktree: '',
      }),
    ))
  })
})
