import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Task 13 regression: adding a workspace must go through createDaemonWorkspace
// (POST /v1/workspaces) as the sole writer of workspace path/UUID. It must NOT
// also call the daemon `addWorkspace` RPC for the same user action — that RPC
// no longer writes a local store (Task 11) and would be a redundant duplicate
// write of the same (teamId, path) row.

const createDaemonWorkspace = vi.hoisted(() => vi.fn(async (input: { teamId: string; agentId: string; name: string; path: string }) => ({
  id: 'ws-new',
  teamId: input.teamId,
  agentId: input.agentId,
  createdByMemberId: null,
  name: input.name,
  path: input.path,
  archived: false,
  createdAt: '',
  updatedAt: '',
})))
const listDaemonWorkspaces = vi.hoisted(() => vi.fn(async () => []))
const getCurrentDaemonWorkspaceAgent = vi.hoisted(() =>
  vi.fn(async () => ({
    id: 'agent-1',
    displayName: 'Local Agent',
    agentTypes: [],
    defaultAgentType: null,
    defaultWorkspaceId: 'ws-new',
    status: null,
    lastActiveAt: null,
  })),
)
const setAgentDefaultWorkspace = vi.hoisted(() => vi.fn(async () => {}))
const updateDaemonWorkspace = vi.hoisted(() => vi.fn(async () => ({})))

// Spy that stands in for the daemon RPC module. If any code path still imports
// and calls `addWorkspace` from teamclu-rpc during the create flow, this spy
// will be invoked and the regression assertion below will fail.
const rpcAddWorkspace = vi.hoisted(() => vi.fn(async () => ({ accepted: true })))

const dialogOpen = vi.fn()
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...a: unknown[]) => dialogOpen(...a) }))

vi.mock('@/lib/daemon/teamclu-rpc', () => ({
  addWorkspace: rpcAddWorkspace,
}))

vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  createDaemonWorkspace,
  listDaemonWorkspaces,
  getCurrentDaemonWorkspaceAgent,
  setAgentDefaultWorkspace,
  updateDaemonWorkspace,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOptions === 'string') return fallbackOrOptions
      return key
    },
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ team: { id: 'team-1' }, currentMember: { id: 'member-1' } }),
}))

const setWorkspace = vi.hoisted(() => vi.fn(async () => {}))
const workspaceState = vi.hoisted(() => ({ workspacePath: null as string | null }))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel(workspaceState),
    { getState: () => ({ setWorkspace }) },
  ),
}))

vi.mock('@/stores/session-utils', () => ({
  workspacePathsMatch: (a: string, b: string) => a === b,
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

vi.mock('../shared', () => ({
  SectionHeader: () => <div />,
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))
vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}))
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked, onCheckedChange, id }: any) => (
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={(e) => onCheckedChange(e.currentTarget.checked)}
    />
  ),
}))

import { DaemonWorkspacesSection } from '../DaemonWorkspacesSection'

describe('DaemonWorkspacesSection', () => {
  beforeEach(() => {
    // mockClear alone leaves queued mockResolvedValueOnce values from a prior
    // test, so a cancelled-picker case could hand its `null` to the next one.
    dialogOpen.mockReset()
    createDaemonWorkspace.mockClear()
    rpcAddWorkspace.mockClear()
    setAgentDefaultWorkspace.mockClear()
    setWorkspace.mockClear()
    listDaemonWorkspaces.mockResolvedValue([])
    workspaceState.workspacePath = null
  })

  it('adding a workspace picks a directory, then calls createDaemonWorkspace only', async () => {
    dialogOpen.mockResolvedValueOnce('/Users/me/my-project')
    render(<DaemonWorkspacesSection />)

    const addButton = await screen.findByRole('button', { name: /Add Workspace/i })
    fireEvent.click(addButton)

    await waitFor(() => expect(createDaemonWorkspace).toHaveBeenCalledTimes(1))
    expect(createDaemonWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1', agentId: 'agent-1', path: '/Users/me/my-project' }),
    )
    // Name comes from the path — there is no field left to type it into.
    expect(createDaemonWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-project' }),
    )

    // The regression under test: no daemon RPC round-trip for the same action.
    expect(rpcAddWorkspace).not.toHaveBeenCalled()
  })

  it('cancelling the directory picker registers nothing', async () => {
    dialogOpen.mockResolvedValueOnce(null)
    render(<DaemonWorkspacesSection />)

    fireEvent.click(await screen.findByRole('button', { name: /Add Workspace/i }))

    await waitFor(() => expect(dialogOpen).toHaveBeenCalled())
    expect(createDaemonWorkspace).not.toHaveBeenCalled()
  })

  // The sidebar's workspace list used to be the only way to point the desktop
  // at a folder by hand. It is gone, so this is the replacement — without it a
  // session whose workspace binding cannot be resolved leaves the file tree
  // stuck on "agent has not started" with no way to correct it.
  it('opening a workspace points the desktop workspace store at its path', async () => {
    listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-a',
        teamId: 'team-1',
        agentId: 'agent-1',
        createdByMemberId: null,
        name: 'other',
        path: '/Users/me/other',
        archived: false,
        createdAt: '',
        updatedAt: '',
      },
    ] as never)

    render(<DaemonWorkspacesSection />)

    const open = await screen.findByRole('button', { name: 'Open' })
    fireEvent.click(open)

    await waitFor(() => {
      expect(setWorkspace).toHaveBeenCalledWith('/Users/me/other')
    })
  })

  it('offers no open action for the workspace already open', async () => {
    workspaceState.workspacePath = '/Users/me/other'
    listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-a',
        teamId: 'team-1',
        agentId: 'agent-1',
        createdByMemberId: null,
        name: 'other',
        path: '/Users/me/other',
        archived: false,
        createdAt: '',
        updatedAt: '',
      },
    ] as never)

    render(<DaemonWorkspacesSection />)

    await screen.findByText('other')
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
  })
})
