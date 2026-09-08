import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AppSessionsColumn, sortAppSessionsForDisplay } from '../AppSessionsColumn'
import { useAppsStore } from '@/stores/apps-store'
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
}

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
})
