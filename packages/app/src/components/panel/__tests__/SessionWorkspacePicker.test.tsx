import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'

const mocks = vi.hoisted(() => ({
  listDaemonWorkspaces: vi.fn(),
  bindSessionAgentWorkspace: vi.fn(),
  ensureAgentWorkspaceForPath: vi.fn(),
  openDialog: vi.fn(),
  toastError: vi.fn(),
  windowPath: '/Users/me/project' as string | null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.openDialog }))

vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  listDaemonWorkspaces: mocks.listDaemonWorkspaces,
}))

vi.mock('@/lib/session/session-agent-workspace', () => ({
  bindSessionAgentWorkspace: mocks.bindSessionAgentWorkspace,
  ensureAgentWorkspaceForPath: mocks.ensureAgentWorkspaceForPath,
}))

vi.mock('@/stores/session-selection-store', () => ({
  useSessionSelectionStore: (selector: (s: unknown) => unknown) =>
    selector({ currentSessionId: 'sess-1' }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({ team: { id: 'team-1' }, currentMember: { id: 'member-1' } }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ workspacePath: mocks.windowPath }),
}))

import { SessionWorkspacePicker } from '../SessionWorkspacePicker'

function workspaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    teamId: 'team-1',
    agentId: 'agent-local',
    createdByMemberId: 'member-1',
    name: 'project',
    path: '/Users/me/project',
    archived: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

describe('SessionWorkspacePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.windowPath = '/Users/me/project'
    mocks.bindSessionAgentWorkspace.mockResolvedValue(undefined)
    mocks.listDaemonWorkspaces.mockResolvedValue([
      workspaceRow({ id: 'ws-old', name: 'old', path: '/Users/me/old', updatedAt: '2026-08-01T00:00:00Z' }),
      workspaceRow({ id: 'ws-archived', name: 'gone', archived: true }),
      workspaceRow({ id: 'ws-pathless', name: 'app-shell', path: null }),
      workspaceRow(),
    ])
  })

  it('lists the local agent\'s live workspaces, most recent first, marking the window\'s', async () => {
    render(<SessionWorkspacePicker agentId="agent-local" />)
    const list = await screen.findByTestId('files-workspace-options')
    const rows = list.querySelectorAll('button')
    expect(mocks.listDaemonWorkspaces).toHaveBeenCalledWith('team-1', 'agent-local')
    expect([...rows].map((r) => r.getAttribute('title'))).toEqual(['/Users/me/project', '/Users/me/old'])
    expect(rows[0].textContent).toContain('当前窗口')
    expect(rows[1].textContent).not.toContain('当前窗口')
  })

  it('binds a listed workspace to the agent\'s seat', async () => {
    render(<SessionWorkspacePicker agentId="agent-local" />)
    fireEvent.click(await screen.findByTitle('/Users/me/old'))
    await waitFor(() =>
      expect(mocks.bindSessionAgentWorkspace).toHaveBeenCalledWith({
        teamId: 'team-1',
        sessionId: 'sess-1',
        agentId: 'agent-local',
        viewerMemberId: 'member-1',
        workspace: { id: 'ws-old', path: '/Users/me/old' },
      }),
    )
    expect(mocks.ensureAgentWorkspaceForPath).not.toHaveBeenCalled()
  })

  it('binds once when a row is clicked twice before the pane re-renders', async () => {
    let release: () => void = () => {}
    mocks.bindSessionAgentWorkspace.mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve }),
    )
    render(<SessionWorkspacePicker agentId="agent-local" />)
    const oldRow = await screen.findByTitle('/Users/me/old')
    const projectRow = screen.getByTitle('/Users/me/project')
    // One batch: no render between the clicks, as with a fast double click.
    act(() => {
      oldRow.click()
      projectRow.click()
    })
    await waitFor(() => expect(mocks.bindSessionAgentWorkspace).toHaveBeenCalledTimes(1))
    release()
    await waitFor(() => expect((oldRow as HTMLButtonElement).disabled).toBe(false))
    expect(mocks.bindSessionAgentWorkspace).toHaveBeenCalledTimes(1)
  })

  it('registers a browsed folder and binds it', async () => {
    mocks.openDialog.mockResolvedValue('/Users/me/new-thing')
    mocks.ensureAgentWorkspaceForPath.mockResolvedValue({ id: 'ws-new', path: '/Users/me/new-thing' })
    render(<SessionWorkspacePicker agentId="agent-local" />)
    await screen.findByTestId('files-workspace-options')
    fireEvent.click(screen.getByText('浏览其他目录…'))

    await waitFor(() =>
      expect(mocks.bindSessionAgentWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ workspace: { id: 'ws-new', path: '/Users/me/new-thing' } }),
      ),
    )
    expect(mocks.ensureAgentWorkspaceForPath).toHaveBeenCalledWith({
      teamId: 'team-1',
      agentId: 'agent-local',
      memberId: 'member-1',
      path: '/Users/me/new-thing',
    })
  })

  it('does nothing when the directory dialog is cancelled', async () => {
    mocks.openDialog.mockResolvedValue(null)
    render(<SessionWorkspacePicker agentId="agent-local" />)
    await screen.findByTestId('files-workspace-options')
    fireEvent.click(screen.getByText('浏览其他目录…'))
    await waitFor(() => expect(mocks.openDialog).toHaveBeenCalled())
    expect(mocks.ensureAgentWorkspaceForPath).not.toHaveBeenCalled()
    expect(mocks.bindSessionAgentWorkspace).not.toHaveBeenCalled()
  })

  it('still offers to browse when the agent has no workspaces', async () => {
    mocks.listDaemonWorkspaces.mockResolvedValue([])
    render(<SessionWorkspacePicker agentId="agent-local" />)
    expect(await screen.findByText('本机还没有工作目录')).toBeDefined()
    expect(screen.getByText('浏览其他目录…').closest('button')?.disabled).toBe(false)
  })

  it('reports a seat that could not be moved, and lets the user try again', async () => {
    mocks.bindSessionAgentWorkspace.mockRejectedValueOnce(new Error('403 forbidden'))
    render(<SessionWorkspacePicker agentId="agent-local" />)
    const row = await screen.findByTitle('/Users/me/old')
    fireEvent.click(row)
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('设置工作目录失败：{{msg}}'))
    await waitFor(() => expect((row as HTMLButtonElement).disabled).toBe(false))
  })
})
