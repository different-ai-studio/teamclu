import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppDataSection } from '../AppDataSection'
import type { AppDataTable, AppRow } from '@/lib/backend/types'

const backend = vi.hoisted(() => ({
  listAppDataTables: vi.fn(),
}))

const openAppDataTable = vi.hoisted(() => vi.fn())

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ apps: backend }),
}))

vi.mock('@/lib/tabs/app-tabs', () => ({
  openAppDataTable: (...args: unknown[]) => openAppDataTable(...args),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: Record<string, unknown>) => {
      let text = fallback ?? key
      if (opts) {
        for (const [k, v] of Object.entries(opts)) text = text.replace(`{{${k}}}`, String(v))
      }
      return text
    },
  }),
}))

const APP = {
  id: 'app-1',
  teamId: 'team-1',
  name: 'Demo',
  slug: 'demo',
  type: 'fullstack_tanstack_postgres',
  visibility: 'team',
  workspaceId: null,
  gitRemoteUrl: null,
  gitAuthKind: null,
  gitCommitSha: null,
  runtime: 'node',
  authMode: 'none',
  authModePendingRedeploy: false,
  oauthClientId: null,
  provisionStatus: 'ready',
  fcStatus: 'live',
  fcEndpoint: 'https://x.fcapp.run',
  fcFunctionName: 'tc-app-1',
  fcRegion: 'cn-hangzhou',
  publicUrl: null,
  createdAt: '2026-08-27T00:00:00Z',
  updatedAt: '2026-08-27T00:00:00Z',
} as AppRow

const ITEMS: AppDataTable = {
  name: 'items',
  columns: [
    { name: 'id', dataType: 'integer', nullable: false },
    { name: 'title', dataType: 'text', nullable: false },
  ],
  primaryKey: ['id'],
  editable: true,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the three empty states are three different sentences', () => {
  it('says a static app has no database', async () => {
    backend.listAppDataTables.mockResolvedValue({ status: 'no_database' })
    render(<AppDataSection app={APP} canEdit />)
    await screen.findByTestId('app-data-state-no-database')
  })

  it('says an undeployed app gets one on first deploy', async () => {
    backend.listAppDataTables.mockResolvedValue({ status: 'not_deployed' })
    render(<AppDataSection app={APP} canEdit />)
    await screen.findByTestId('app-data-state-not-deployed')
  })

  it('says a deployed app with no tables is waiting for its first visit', async () => {
    backend.listAppDataTables.mockResolvedValue({ status: 'ok', tables: [] })
    render(<AppDataSection app={APP} canEdit />)
    const el = await screen.findByTestId('app-data-state-no-tables')
    expect(el.textContent).toMatch(/首次被访问时创建/)
  })
})

it('renders nothing at all when the caller cannot see the app', async () => {
  backend.listAppDataTables.mockResolvedValue(null)
  const { container } = render(<AppDataSection app={APP} canEdit={false} />)
  await waitFor(() => expect(backend.listAppDataTables).toHaveBeenCalled())
  await waitFor(() => expect(container.textContent).toBe(''))
})

it('opens the data browser on the first table', async () => {
  // One entry rather than a row per table: the browser it opens has its own
  // table switcher, so listing every name here only made the panel long.
  backend.listAppDataTables.mockResolvedValue({ status: 'ok', tables: [ITEMS] })
  render(<AppDataSection app={APP} canEdit />)
  await userEvent.click(await screen.findByTestId('app-data-open'))
  expect(openAppDataTable).toHaveBeenCalledWith(APP, 'items')
})

it('says how many tables there are without naming them', async () => {
  backend.listAppDataTables.mockResolvedValue({
    status: 'ok',
    tables: [ITEMS, { ...ITEMS, name: 'orders' }],
  })
  render(<AppDataSection app={APP} canEdit />)
  await screen.findByTestId('app-data-open')
  expect(screen.getByText(/2/)).toBeInTheDocument()
  expect(screen.queryByText('orders')).not.toBeInTheDocument()
})
