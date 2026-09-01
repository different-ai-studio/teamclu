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
  TEAM_LINK_LEGACY_DAEMON: 'team_link_legacy_daemon',
}))

const workspaceState = vi.hoisted(() => ({
  workspacePath: '/workspace' as string | null,
  refreshFileTree: vi.fn(),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: typeof workspaceState) => unknown) => sel(workspaceState),
}))

const loadSection = vi.fn()
const browserState = vi.hoisted(() => ({ syncRoot: null as string | null }))
vi.mock('@/stores/team-share-browser', () => {
  const store = (sel: (s: { loadSection: typeof loadSection }) => unknown) => sel({ loadSection })
  store.getState = () => ({ loadSection, syncRoot: browserState.syncRoot })
  return { useTeamShareBrowserStore: store }
})

import { TeamDirInitPanel } from '../TeamDirInitPanel'

describe('TeamDirInitPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isTauriMock.mockReturnValue(true)
    workspaceState.workspacePath = '/workspace'
    linkDaemonTeamWorkspace.mockResolvedValue({ ok: true })
    // The repair worked unless a test says otherwise.
    browserState.syncRoot = '/home/u/.amuxd/teams/t/shared/team-sync'
    loadSection.mockResolvedValue(undefined)
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

  /**
   * A daemon older than the knowledge relocation materializes the previous
   * layout and answers 200: the call succeeded, nothing this column reads
   * changed, and the panel re-rendered itself unchanged. Four clicks, four
   * 200s, no feedback — which is what a dead button looks like.
   */
  it('reports a repair that succeeded without producing a team folder', async () => {
    browserState.syncRoot = null
    render(<TeamDirInitPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    expect(
      await screen.findByText(
        'Rebuilt, but the team folder is still not here. The local daemon is probably out of date — restart or update it, then try again.',
      ),
    ).toBeTruthy()
  })

  it('says nothing when the repair actually produced one', async () => {
    render(<TeamDirInitPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    await waitFor(() => expect(loadSection).toHaveBeenCalled())
    expect(screen.queryByText(/still not here/)).toBeNull()
  })

  /**
   * An older daemon requires `path` and answers 422 to the pathless call. Its
   * raw complaint is a serde deserialization message — recognised here so the
   * user is told what to do about it instead.
   */
  it('translates an out-of-date daemon into an actionable message', async () => {
    workspaceState.workspacePath = null
    linkDaemonTeamWorkspace.mockRejectedValue(new Error('team_link_legacy_daemon'))
    render(<TeamDirInitPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    expect(
      await screen.findByText(
        'The local daemon is too old to create the team folder on its own. Restart or update it, then try again.',
      ),
    ).toBeTruthy()
  })
})
