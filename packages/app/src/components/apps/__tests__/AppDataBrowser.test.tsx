import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppDataBrowser } from '../AppDataBrowser'
import type { AppDataRowsPage, AppDataTable, AppRow } from '@/lib/backend/types'

const backend = vi.hoisted(() => ({
  readAppDataRows: vi.fn(),
  updateAppDataRow: vi.fn(),
  deleteAppDataRow: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ apps: backend }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
    { name: 'updated_at', dataType: 'timestamp with time zone', nullable: false },
  ],
  primaryKey: ['id'],
  editable: true,
}

const AUDIT: AppDataTable = {
  name: 'audit_log',
  columns: [{ name: 'what', dataType: 'text', nullable: true }],
  primaryKey: [],
  editable: false,
}

function page(over: Partial<AppDataRowsPage> = {}): AppDataRowsPage {
  return {
    table: 'items',
    columns: ITEMS.columns,
    primaryKey: ['id'],
    editable: true,
    rows: [
      { id: 1, title: 'first', updated_at: '2026-08-27T01:00:00.000Z' },
      { id: 2, title: 'second', updated_at: '2026-08-27T02:00:00.000Z' },
    ],
    nextCursor: null,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  backend.readAppDataRows.mockResolvedValue(page())
})

it('loads rows for the initial table', async () => {
  render(<AppDataBrowser app={APP} tables={[ITEMS]} canEdit initialTable="items" />)
  await waitFor(() => expect(backend.readAppDataRows).toHaveBeenCalledWith('app-1', 'items'))
  expect(await screen.findByText('first')).toBeTruthy()
})

it('renders a timestamp locally and keeps the stored value in the title', async () => {
  render(<AppDataBrowser app={APP} tables={[ITEMS]} canEdit initialTable="items" />)
  const cell = await screen.findByTitle('2026-08-27T01:00:00.000Z')
  expect(cell.textContent).not.toBe('2026-08-27T01:00:00.000Z')
})

it('sends only the columns that actually changed, and shows what came back', async () => {
  backend.updateAppDataRow.mockResolvedValue({
    id: 1,
    title: 'renamed',
    updated_at: '2030-01-01T00:00:00.000Z',
  })
  render(<AppDataBrowser app={APP} tables={[ITEMS]} canEdit initialTable="items" />)
  await screen.findByText('first')

  const rowKey = Buffer.from('[1]').toString('base64url')
  await userEvent.click(await screen.findByTestId(`app-data-edit-${rowKey}`))
  const titleInput = screen.getAllByRole('textbox')[0]
  await userEvent.clear(titleInput)
  await userEvent.type(titleInput, 'renamed')
  await userEvent.click(screen.getByText('Save'))

  await waitFor(() =>
    expect(backend.updateAppDataRow).toHaveBeenCalledWith('app-1', 'items', rowKey, {
      title: 'renamed',
    }),
  )
  expect(await screen.findByTitle('2030-01-01T00:00:00.000Z')).toBeTruthy()
})

it('disables row actions on a table with no primary key, and says why', async () => {
  backend.readAppDataRows.mockResolvedValue(
    page({ table: 'audit_log', columns: AUDIT.columns, primaryKey: [], editable: false, rows: [{ what: 'x' }] }),
  )
  render(<AppDataBrowser app={APP} tables={[AUDIT]} canEdit initialTable="audit_log" />)
  const rowKey = Buffer.from('[]').toString('base64url')
  const editButton = await screen.findByTestId(`app-data-edit-${rowKey}`)
  expect((editButton as HTMLButtonElement).disabled).toBe(true)
  expect(editButton.getAttribute('title')).toMatch(/没有主键/)
})

it('disables row actions for a prompt-tier member, with a different reason', async () => {
  render(<AppDataBrowser app={APP} tables={[ITEMS]} canEdit={false} initialTable="items" />)
  await screen.findByText('first')
  const rowKey = Buffer.from('[1]').toString('base64url')
  const editButton = await screen.findByTestId(`app-data-edit-${rowKey}`)
  expect((editButton as HTMLButtonElement).disabled).toBe(true)
  expect(editButton.getAttribute('title')).toMatch(/admin/)
})

it('appends the next page instead of replacing it', async () => {
  backend.readAppDataRows
    .mockResolvedValueOnce(page({ nextCursor: 'CURSOR' }))
    .mockResolvedValueOnce(page({ rows: [{ id: 3, title: 'third', updated_at: '2026-08-27T03:00:00.000Z' }], nextCursor: null }))
  render(<AppDataBrowser app={APP} tables={[ITEMS]} canEdit initialTable="items" />)
  await userEvent.click(await screen.findByTestId('app-data-load-more'))

  await waitFor(() =>
    expect(backend.readAppDataRows).toHaveBeenLastCalledWith('app-1', 'items', { after: 'CURSOR' }),
  )
  expect(await screen.findByText('third')).toBeTruthy()
  expect(screen.getByText('first')).toBeTruthy()
})

it('confirms before deleting a row', async () => {
  backend.deleteAppDataRow.mockResolvedValue(undefined)
  render(<AppDataBrowser app={APP} tables={[ITEMS]} canEdit initialTable="items" />)
  await screen.findByText('first')

  const rowKey = Buffer.from('[1]').toString('base64url')
  await userEvent.click(await screen.findByTestId(`app-data-delete-${rowKey}`))
  expect(backend.deleteAppDataRow).not.toHaveBeenCalled()

  const dialog = await screen.findByRole('alertdialog')
  await userEvent.click(within(dialog).getByText('Delete'))
  await waitFor(() => expect(backend.deleteAppDataRow).toHaveBeenCalledWith('app-1', 'items', rowKey))
  await waitFor(() => expect(screen.queryByText('first')).toBeNull())
})
