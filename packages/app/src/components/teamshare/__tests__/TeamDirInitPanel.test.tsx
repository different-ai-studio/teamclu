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

const scaffoldKnowledgeVault = vi.fn()
vi.mock('@/lib/knowledge/scaffold-client', () => ({
  scaffoldKnowledgeVault: (...args: unknown[]) => scaffoldKnowledgeVault(...args),
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

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: { team: { name: string } | null }) => unknown) =>
    sel({ team: { name: '增长组' } }),
}))

import { TeamDirInitPanel } from '../TeamDirInitPanel'

describe('TeamDirInitPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isTauriMock.mockReturnValue(true)
    workspaceState.workspacePath = '/workspace'
    linkDaemonTeamWorkspace.mockResolvedValue({ ok: true })
    scaffoldKnowledgeVault.mockResolvedValue({
      knowledgeRoot: '/k',
      dirsCreated: [],
      filesCreated: ['00-home.md'],
      filesSkipped: [],
    })
    browserState.syncRoot = '/home/u/.amuxd/teams/t/shared/team-sync'
    loadSection.mockResolvedValue(undefined)
  })

  it('rebuilds the team folder, scaffolds, then reloads knowledge', async () => {
    render(<TeamDirInitPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    await waitFor(() => expect(scaffoldKnowledgeVault).toHaveBeenCalled())
    expect(linkDaemonTeamWorkspace).toHaveBeenCalledWith('/workspace', { strict: true })
    expect(workspaceState.refreshFileTree).not.toHaveBeenCalled()
    expect(loadSection).toHaveBeenCalledWith('knowledge', { force: true })
    expect(scaffoldKnowledgeVault).toHaveBeenCalledWith({ teamName: '增长组' })
  })

  it('scaffolds only when the vault is already present but empty', async () => {
    const onScaffolded = vi.fn()
    render(<TeamDirInitPanel mode="empty-vault" onScaffolded={onScaffolded} />)

    fireEvent.click(screen.getByRole('button', { name: '初始化知识库' }))

    await waitFor(() => expect(scaffoldKnowledgeVault).toHaveBeenCalled())
    expect(linkDaemonTeamWorkspace).not.toHaveBeenCalled()
    expect(scaffoldKnowledgeVault).toHaveBeenCalledWith({ teamName: '增长组' })
    expect(onScaffolded).toHaveBeenCalled()
  })

  it('surfaces the daemon error instead of silently doing nothing', async () => {
    linkDaemonTeamWorkspace.mockRejectedValue(new Error('daemon HTTP port unavailable'))
    render(<TeamDirInitPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    expect(await screen.findByText('daemon HTTP port unavailable')).toBeTruthy()
    expect(loadSection).not.toHaveBeenCalled()
    expect(scaffoldKnowledgeVault).not.toHaveBeenCalled()
  })

  it('rebuilds with no workspace open, and sends no path', async () => {
    workspaceState.workspacePath = null
    render(<TeamDirInitPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    await waitFor(() => expect(scaffoldKnowledgeVault).toHaveBeenCalled())
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
    render(<TeamDirInitPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    expect(
      await screen.findByText(
        'Rebuilt, but the team folder is still not here. The local daemon is probably out of date — restart or update it, then try again.',
      ),
    ).toBeTruthy()
    expect(scaffoldKnowledgeVault).not.toHaveBeenCalled()
  })

  it('says nothing when the repair actually produced one', async () => {
    render(<TeamDirInitPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild team folder' }))

    await waitFor(() => expect(scaffoldKnowledgeVault).toHaveBeenCalled())
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
