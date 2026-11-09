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
vi.mock('@/lib/daemon/daemon-local-client', () => ({
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
    browserState.syncRoot = '/home/u/.amuxd/teams/t/shared/team-sync'
    loadSection.mockResolvedValue(undefined)
  })

  it('rebuilds the team folder, then reloads knowledge', async () => {
    const onRebuilt = vi.fn()
    render(<TeamDirInitPanel onRebuilt={onRebuilt} />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    await waitFor(() => expect(onRebuilt).toHaveBeenCalled())
    expect(linkDaemonTeamWorkspace).toHaveBeenCalledWith('/workspace', { strict: true })
    expect(workspaceState.refreshFileTree).not.toHaveBeenCalled()
    expect(loadSection).toHaveBeenCalledWith('knowledge', { force: true })
  })

  it('surfaces the daemon error instead of silently doing nothing', async () => {
    linkDaemonTeamWorkspace.mockRejectedValue(new Error('daemon HTTP port unavailable'))
    const onRebuilt = vi.fn()
    render(<TeamDirInitPanel onRebuilt={onRebuilt} />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    expect(await screen.findByText('daemon HTTP port unavailable')).toBeTruthy()
    expect(loadSection).not.toHaveBeenCalled()
    expect(onRebuilt).not.toHaveBeenCalled()
  })

  it('rebuilds with no workspace open, and sends no path', async () => {
    workspaceState.workspacePath = null
    const onRebuilt = vi.fn()
    render(<TeamDirInitPanel onRebuilt={onRebuilt} />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    await waitFor(() => expect(onRebuilt).toHaveBeenCalled())
    expect(linkDaemonTeamWorkspace).toHaveBeenCalledWith(null, { strict: true })
  })

  it('offers nothing outside the desktop app', () => {
    isTauriMock.mockReturnValue(false)
    render(<TeamDirInitPanel />)

    expect(screen.queryByRole('button', { name: 'Rebuild team folder' })).toBeNull()
    expect(screen.getByText('This can only be repaired from the desktop app.')).toBeTruthy()
  })

  it('reports a repair that succeeded without producing a team folder', async () => {
    browserState.syncRoot = null
    const onRebuilt = vi.fn()
    render(<TeamDirInitPanel onRebuilt={onRebuilt} />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    expect(
      await screen.findByText(
        'Rebuilt, but the team folder is still not here. The local daemon is probably out of date — restart or update it, then try again.',
      ),
    ).toBeTruthy()
    expect(onRebuilt).not.toHaveBeenCalled()
  })

  it('says nothing when the repair actually produced one', async () => {
    const onRebuilt = vi.fn()
    render(<TeamDirInitPanel onRebuilt={onRebuilt} />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    await waitFor(() => expect(onRebuilt).toHaveBeenCalled())
    expect(screen.queryByText(/still not here/)).toBeNull()
  })

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
