import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CommandPopover } from '../CommandPopover'
import { SKILLS_CHANGED_EVENT } from '@/hooks/useAppInit'
import { useWorkspaceRuntimeRefreshStore } from '@/stores/workspace-runtime-refresh'

const mocks = vi.hoisted(() => ({
  runtimeRows: [] as Array<{ runtime_id: string | null; backend_type: string | null; current_model: string | null }>,
  runtimeStates: {} as Record<string, unknown>,
  loadRolesSkillsWorkspaceState: vi.fn(),
  loadAllRoles: vi.fn(),
  getDaemonPermissions: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg1?: string | { count?: number }, arg2?: { count?: number }) => {
      if (typeof arg1 === 'string') return arg1
      const count = typeof arg1 === 'object' ? arg1?.count : arg2?.count
      if (typeof count === 'number') return `${key}:${count}`
      return key
    },
  }),
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return {
    ...actual,
    isTauri: () => true,
  }
})

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: { workspacePath: string | null }) => unknown) =>
    selector({ workspacePath: '/workspace/demo' }),
}))

vi.mock('@/stores/runtime-state-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/runtime-state-store')>()
  const store = (selector: (s: { byRuntimeId: Record<string, unknown> }) => unknown) =>
    selector({ byRuntimeId: mocks.runtimeStates })
  store.getState = () => ({ byRuntimeId: mocks.runtimeStates })
  return { ...actual, useRuntimeStateStore: store }
})

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({}),
}))

vi.mock('@/lib/daemon-local-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/daemon-local-client')>()
  return {
    ...actual,
    getDaemonPermissions: (...args: unknown[]) => mocks.getDaemonPermissions(...args),
  }
})

vi.mock('@/lib/roles/loader', () => ({
  loadRolesSkillsWorkspaceState: (...args: unknown[]) => mocks.loadRolesSkillsWorkspaceState(...args),
  loadAllRoles: (...args: unknown[]) => mocks.loadAllRoles(...args),
}))

vi.mock('@/lib/teamclu-config', () => ({
  resolveSkillPermission: () => ({ permission: 'allow', isExact: false }),
}))

describe('CommandPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWorkspaceRuntimeRefreshStore.setState({
      workspacePath: null,
      refresh: null,
      dismissedAt: null,
    })
    mocks.runtimeRows = []
    mocks.runtimeStates = {}
    mocks.loadRolesSkillsWorkspaceState.mockResolvedValue({
      roles: [],
      skills: [],
      roleUsageBySkill: {},
      skillNamesByRole: {},
      metrics: { rolesCount: 0, skillsCount: 0, linkedSkillsCount: 0, unlinkedSkillsCount: 0 },
    })
    mocks.loadAllRoles.mockResolvedValue([])
    mocks.getDaemonPermissions.mockResolvedValue({})
  })

  it('shows daemon-advertised skills for the active session', async () => {
    mocks.runtimeStates = {
      // Keyed (actor, session): that is how the retain is filed.
      'agent-1::session-1': {
        daemonActorId: 'agent-1',
        lastUpdated: Date.now(),
        info: {
          availableCommands: [
            {
              name: 'superpowers/brainstorming',
              description: 'Explore intent before coding',
              inputHint: '',
            },
          ],
        },
      },
    }

    render(
      <CommandPopover
        open={true}
        activeSessionId="session-1"
        onOpenChange={vi.fn()}
        searchQuery=""
        onSelect={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('superpowers/brainstorming')).toBeInTheDocument()
    })
  })

  it('selects a daemon-advertised skill using skill token semantics when it matches a known skill', async () => {
    mocks.runtimeStates = {
      // Keyed (actor, session): that is how the retain is filed.
      'agent-1::session-1': {
        daemonActorId: 'agent-1',
        lastUpdated: Date.now(),
        info: {
          availableCommands: [
            {
              name: 'superpowers/brainstorming',
              description: 'Explore intent before coding',
              inputHint: '',
            },
          ],
        },
      },
    }
    mocks.loadRolesSkillsWorkspaceState.mockResolvedValue({
      roles: [],
      skills: [
        {
          filename: 'brainstorming',
          name: 'Brainstorming',
          invocationName: 'superpowers/brainstorming',
          description: 'Explore intent before coding',
          content: '---\ndescription: Explore intent before coding\n---\n# Brainstorming\n',
          source: 'global-agent',
          dirPath: '/Users/test/.agents/skills/superpowers',
          linkedRoles: [],
          isRoleSkill: false,
        },
      ],
      roleUsageBySkill: {},
      skillNamesByRole: {},
      metrics: { rolesCount: 0, skillsCount: 1, linkedSkillsCount: 0, unlinkedSkillsCount: 1 },
    })

    const onSelect = vi.fn()

    render(
      <CommandPopover
        open={true}
        activeSessionId="session-1"
        onOpenChange={vi.fn()}
        searchQuery=""
        onSelect={onSelect}
      />,
    )

    const item = await screen.findByText('superpowers/brainstorming')
    fireEvent.click(item)

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'superpowers/brainstorming',
        _type: 'skill',
      }),
    )
  })

  it('treats daemon-advertised namespaced skills as skill tokens even when local skill scan is empty', async () => {
    mocks.runtimeStates = {
      // Keyed (actor, session): that is how the retain is filed.
      'agent-1::session-1': {
        daemonActorId: 'agent-1',
        lastUpdated: Date.now(),
        info: {
          availableCommands: [
            {
              name: 'superpowers/brainstorming',
              description: 'Explore intent before coding',
              inputHint: '',
            },
          ],
        },
      },
    }

    const onSelect = vi.fn()

    render(
      <CommandPopover
        open={true}
        activeSessionId="session-1"
        onOpenChange={vi.fn()}
        searchQuery=""
        onSelect={onSelect}
      />,
    )

    const item = await screen.findByText('superpowers/brainstorming')
    fireEvent.click(item)

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'superpowers/brainstorming',
        _type: 'skill',
      }),
    )
  })

  it('dedupes duplicate scanned skills that share the same invocation name', async () => {
    mocks.loadRolesSkillsWorkspaceState.mockResolvedValue({
      roles: [],
      skills: [
        {
          filename: 'accounting-error-investigator',
          name: 'accounting-error-investigator',
          invocationName: 'accounting-error-investigator',
          description: 'Investigate accounting errors',
          content: '---\nname: accounting-error-investigator\n---\n',
          source: 'team',
          dirPath: '/workspace/demo/teamclu-team/skills',
          linkedRoles: [],
          isRoleSkill: false,
        },
        {
          filename: 'accounting-error-investigator',
          name: 'accounting-error-investigator',
          invocationName: 'accounting-error-investigator',
          description: 'Investigate accounting errors',
          content: '---\nname: accounting-error-investigator\n---\n',
          source: 'claude',
          dirPath: '/workspace/demo/.claude/skills',
          linkedRoles: [],
          isRoleSkill: false,
        },
      ],
      roleUsageBySkill: {},
      skillNamesByRole: {},
      metrics: { rolesCount: 0, skillsCount: 2, linkedSkillsCount: 0, unlinkedSkillsCount: 2 },
    })

    render(
      <CommandPopover
        open={true}
        activeSessionId={null}
        onOpenChange={vi.fn()}
        searchQuery=""
        onSelect={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('chat.commandPopover.skills:1')).toBeInTheDocument()
    })
    expect(screen.getAllByText('accounting-error-investigator')).toHaveLength(1)
  })

  it('reloads skills once when daemon refresh timestamp changes without noteLocalRefresh', async () => {
    const noteLocalRefresh = vi.spyOn(
      useWorkspaceRuntimeRefreshStore.getState(),
      'noteLocalRefresh',
    )

    render(
      <CommandPopover
        open={true}
        activeSessionId={null}
        onOpenChange={vi.fn()}
        searchQuery=""
        onSelect={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(mocks.loadRolesSkillsWorkspaceState).toHaveBeenCalledTimes(1)
    })

    useWorkspaceRuntimeRefreshStore.setState({
      refresh: {
        status: 'pending',
        change_kinds: ['skills'],
        recommended_action: 'none',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: '2026-08-28T07:00:00Z',
        last_error: null,
      },
    })

    await waitFor(() => {
      expect(mocks.loadRolesSkillsWorkspaceState).toHaveBeenCalledTimes(2)
    })
    expect(noteLocalRefresh).not.toHaveBeenCalled()
  })

  it('reloads skills when SKILLS_CHANGED_EVENT fires from the filesystem path', async () => {
    render(
      <CommandPopover
        open={true}
        activeSessionId={null}
        onOpenChange={vi.fn()}
        searchQuery=""
        onSelect={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(mocks.loadRolesSkillsWorkspaceState).toHaveBeenCalledTimes(1)
    })

    window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT))
    await waitFor(() => {
      expect(mocks.loadRolesSkillsWorkspaceState).toHaveBeenCalledTimes(2)
    })
  })
})
