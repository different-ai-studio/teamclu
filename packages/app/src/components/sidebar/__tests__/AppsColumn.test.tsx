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
    useAppsStore.setState({ items: [mkApp('app-1', 'Alpha')], selectedAppId: null })
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

  it('falls back to the list when the selection no longer resolves', () => {
    // Deleted from another window, or a team switch replaced `items`. The old
    // column showed an empty "pick an app" pane here; the list is both more
    // useful and the only state the back button could have reached anyway.
    useAppsStore.setState({ selectedAppId: 'gone' })
    render(<AppsColumn />)
    expect(screen.getByTestId('app-list')).toBeInTheDocument()
  })
})
