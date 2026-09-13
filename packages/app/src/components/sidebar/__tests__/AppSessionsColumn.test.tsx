import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AppSessionsColumn, sortAppSessionsForDisplay } from '../AppSessionsColumn'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import type { AppRow, AppSessionRow } from '@/lib/backend/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

// Sidebar UI primitives call useSidebar() which requires a SidebarProvider.
vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: 'expanded', open: true, setOpen: () => {}, toggleSidebar: () => {} }),
}))
vi.mock('@/components/app-sidebar', () => ({ SidebarCollapseToggle: () => null }))
vi.mock('@/components/ui/traffic-lights', () => ({ TrafficLights: () => null }))
vi.mock('@/components/apps/AppDeployFooter', () => ({ AppDeployFooter: () => null }))

const listAppSessions = vi.fn()
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ apps: { listAppSessions: (...a: unknown[]) => listAppSessions(...a) } }),
}))

const mocks = vi.hoisted(() => ({
  openAppSession: vi.fn(),
  createAppSessionShell: vi.fn(),
  switchToSession: vi.fn(),
  switchToSessionWorkspaceIfNeeded: vi.fn(),
}))

vi.mock('@/lib/apps/app-session', () => ({
  openAppSession: mocks.openAppSession,
  createAppSessionShell: mocks.createAppSessionShell,
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: { getState: () => ({ switchToSession: mocks.switchToSession }) },
}))

vi.mock('@/lib/session/session-by-workspace', () => ({
  switchToSessionWorkspaceIfNeeded: mocks.switchToSessionWorkspaceIfNeeded,
}))

function row(p: Partial<AppSessionRow>): AppSessionRow {
  return {
    id: 'id',
    teamId: 't',
    title: 'title',
    mode: 'collab',
    lastMessageAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...p,
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const app: AppRow = {
  id: 'app-1',
  teamId: 'team-1',
  name: 'Alpha',
  slug: 'app-1',
  type: 'static_web',
  visibility: 'personal',
  workspaceId: null,
  gitRemoteUrl: null,
  gitAuthKind: null,
  provisionStatus: 'ready',
  fcStatus: null,
  fcEndpoint: null,
  publicUrl: null,
  authMode: 'none',
  runtime: 'node',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as AppRow

describe('sortAppSessionsForDisplay', () => {
  it('orders by lastMessageAt then createdAt descending', () => {
    const sorted = sortAppSessionsForDisplay([
      row({ id: 'a', lastMessageAt: '2026-06-01T00:00:00.000Z' }),
      row({ id: 'b', lastMessageAt: '2026-06-10T00:00:00.000Z' }),
      row({ id: 'c', lastMessageAt: null, createdAt: '2026-06-08T00:00:00.000Z' }),
    ])
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('AppSessionsColumn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listAppSessions.mockResolvedValue([row({ id: 's1', title: 'First' })])
    useAppsStore.setState({ items: [app], selectedAppId: 'app-1' })
    useCurrentTeamStore.setState({ team: { id: 'team-1' } as never })
    useSessionSelectionStore.setState({ activeSessionId: null })
    mocks.openAppSession.mockResolvedValue(undefined)
    mocks.switchToSession.mockImplementation(async (id: string) => {
      useSessionSelectionStore.setState({ activeSessionId: id })
    })
    mocks.switchToSessionWorkspaceIfNeeded.mockResolvedValue(undefined)
  })

  it('names the app it is showing', async () => {
    render(<AppSessionsColumn app={app} />)
    expect(screen.getByText(/Alpha/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('First')).toBeInTheDocument())
  })

  it('closing returns to the app list by clearing the selection', () => {
    render(<AppSessionsColumn app={app} />)
    fireEvent.click(screen.getByRole('button', { name: '返回应用列表' }))
    expect(useAppsStore.getState().selectedAppId).toBe(null)
  })

  it('switches to the session without waiting for its setup', async () => {
    // The setup is daemon calls and Cloud API round trips on a first open;
    // awaiting it first is what made every click in this list feel stuck.
    const setup = deferred()
    mocks.openAppSession.mockReturnValue(setup.promise)
    render(<AppSessionsColumn app={app} />)

    fireEvent.click(await screen.findByText('First'))

    await waitFor(() =>
      expect(mocks.switchToSession).toHaveBeenCalledWith('s1', { keepSidebarFilter: true }),
    )
    expect(mocks.openAppSession).toHaveBeenCalledWith(app, 's1')
    expect(useAppsStore.getState().appIdBySessionId.s1).toBe('app-1')
    expect(mocks.switchToSessionWorkspaceIfNeeded).not.toHaveBeenCalled()

    setup.resolve()
  })

  it('resolves the workspace again once the binding has landed', async () => {
    // The switch looked the workspace up before the binding existed, so a
    // session opened for the first time on this machine found none.
    render(<AppSessionsColumn app={app} />)
    fireEvent.click(await screen.findByText('First'))

    await waitFor(() =>
      expect(mocks.switchToSessionWorkspaceIfNeeded).toHaveBeenCalledWith('team-1', 's1'),
    )
  })

  it('leaves the workspace alone when the user has already moved on', async () => {
    const setup = deferred()
    mocks.openAppSession.mockReturnValue(setup.promise)
    render(<AppSessionsColumn app={app} />)
    fireEvent.click(await screen.findByText('First'))
    await waitFor(() => expect(mocks.switchToSession).toHaveBeenCalled())

    useSessionSelectionStore.setState({ activeSessionId: 'somewhere-else' })
    setup.resolve()
    await setup.promise
    await new Promise((r) => setTimeout(r, 0))

    expect(mocks.switchToSessionWorkspaceIfNeeded).not.toHaveBeenCalled()
  })

  it('still switches when the setup fails', async () => {
    mocks.openAppSession.mockRejectedValue(new Error('daemon down'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<AppSessionsColumn app={app} />)
    fireEvent.click(await screen.findByText('First'))

    await waitFor(() => expect(mocks.switchToSession).toHaveBeenCalled())
    await waitFor(() => expect(error).toHaveBeenCalled())
    expect(mocks.switchToSessionWorkspaceIfNeeded).not.toHaveBeenCalled()
    error.mockRestore()
  })
})
