import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('@/lib/utils', () => ({
  isTauri: () => isTauriMock(),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const linkDaemonTeamWorkspace = vi.fn()
vi.mock('@/lib/daemon-local-client', () => ({
  linkDaemonTeamWorkspace: (...args: unknown[]) => linkDaemonTeamWorkspace(...args),
}))

const workspaceState = vi.hoisted(() => ({
  workspacePath: '/workspace' as string | null,
  refreshFileTree: vi.fn(),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: typeof workspaceState) => unknown) => sel(workspaceState),
}))

const loadSection = vi.fn()
vi.mock('@/stores/team-share-browser', () => ({
  useTeamShareBrowserStore: (sel: (s: { loadSection: typeof loadSection }) => unknown) =>
    sel({ loadSection }),
}))

import { TeamDirInitPanel } from '../TeamDirInitPanel'

describe('TeamDirInitPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isTauriMock.mockReturnValue(true)
    workspaceState.workspacePath = '/workspace'
    linkDaemonTeamWorkspace.mockResolvedValue({ ok: true })
  })

  it('rebuilds the team folder, then re-resolves the root without the workspace tree', async () => {
    render(<TeamDirInitPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    await waitFor(() => expect(loadSection).toHaveBeenCalled())
    // strict: a silent failure here would loop the user back to this panel with
    // no explanation, which is the bug the strict flag exists to prevent.
    expect(linkDaemonTeamWorkspace).toHaveBeenCalledWith('/workspace', { strict: true })
    // The column resolves its root from the daemon's directory, not from the
    // workspace file tree — refreshing that tree would be work for nobody.
    expect(workspaceState.refreshFileTree).not.toHaveBeenCalled()
    expect(loadSection).toHaveBeenCalledWith('knowledge', { force: true })
  })

  it('surfaces the daemon error instead of silently doing nothing', async () => {
    linkDaemonTeamWorkspace.mockRejectedValue(new Error('daemon HTTP port unavailable'))
    render(<TeamDirInitPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    expect(await screen.findByText('daemon HTTP port unavailable')).toBeTruthy()
    expect(loadSection).not.toHaveBeenCalled()
  })

  /**
   * The repair is "create the team's directory", which belongs to the team —
   * so it is offered with no folder open, and the call goes out without a path.
   * It used to be hidden behind "open a team workspace first", for an operation
   * that never needed one.
   */
  it('rebuilds with no workspace open, and sends no path', async () => {
    workspaceState.workspacePath = null
    render(<TeamDirInitPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    await waitFor(() => expect(loadSection).toHaveBeenCalled())
    expect(linkDaemonTeamWorkspace).toHaveBeenCalledWith(null, { strict: true })
  })

  it('offers nothing outside the desktop app', () => {
    isTauriMock.mockReturnValue(false)
    render(<TeamDirInitPanel />)

    expect(screen.queryByRole('button', { name: 'Rebuild team folder' })).toBeNull()
    expect(screen.getByText('This can only be repaired from the desktop app.')).toBeTruthy()
  })
})
