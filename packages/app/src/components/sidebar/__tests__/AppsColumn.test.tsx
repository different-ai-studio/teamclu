import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppsColumn } from '../AppsColumn'
import { useAppsStore } from '@/stores/apps-store'
import type { AppRow } from '@/lib/backend/types'

vi.mock('@/components/sidebar/AppListColumn', () => ({
  AppListColumn: () => <div data-testid="app-list" />,
}))
vi.mock('@/components/sidebar/AppSessionsColumn', () => ({
  AppSessionsColumn: ({ app }: { app: AppRow }) => (
    <div data-testid="app-sessions">{app.name}</div>
  ),
}))

const mkApp = (id: string, name: string): AppRow => ({
  id,
  teamId: 'team-1',
  name,
  slug: id,
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
})

describe('AppsColumn', () => {
  beforeEach(() => {
    useAppsStore.setState({
      items: [mkApp('app-1', 'Alpha')],
      selectedAppId: null,
      localAppIds: ['app-1'],
    })
  })

  it('shows the app list when nothing is selected', () => {
    render(<AppsColumn />)
    expect(screen.getByTestId('app-list')).toBeInTheDocument()
  })

  it('shows the selected app’s sessions', () => {
    useAppsStore.setState({ selectedAppId: 'app-1' })
    render(<AppsColumn />)
    expect(screen.getByTestId('app-sessions')).toHaveTextContent('Alpha')
  })

  it('will not open the sessions of an app that is not on this machine', () => {
    // They exist in the cloud, but nothing here can run in them — and the list
    // is where the download that fixes that lives.
    useAppsStore.setState({ selectedAppId: 'app-1', localAppIds: [] })
    render(<AppsColumn />)
    expect(screen.getByTestId('app-list')).toBeInTheDocument()
    expect(screen.queryByTestId('app-sessions')).not.toBeInTheDocument()
  })

  it('still opens them while the daemon has not answered', () => {
    // `null` is unknown, not "no": bouncing the user back to the list for the
    // second amuxd takes to start would break every launch.
    useAppsStore.setState({ selectedAppId: 'app-1', localAppIds: null })
    render(<AppsColumn />)
    expect(screen.getByTestId('app-sessions')).toHaveTextContent('Alpha')
  })

  it('falls back to the list when the selection no longer resolves', () => {
    // Deleted from another window, or a team switch replaced `items`. The old
    // column showed an empty "pick an app" pane here; the list is both more
    // useful and the only state the back button could have reached anyway.
    useAppsStore.setState({ selectedAppId: 'gone' })
    render(<AppsColumn />)
    expect(screen.getByTestId('app-list')).toBeInTheDocument()
  })
})
