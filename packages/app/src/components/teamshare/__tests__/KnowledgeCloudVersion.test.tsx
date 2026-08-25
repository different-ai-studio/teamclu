import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg?: unknown, vars?: Record<string, unknown>) => {
      const fallback = typeof arg === 'string' ? arg : key
      const values = (typeof arg === 'object' ? arg : vars) as Record<string, unknown> | undefined
      return fallback.replace(/\{\{(\w+)\}\}/g, (_m, n) => String(values?.[n] ?? ''))
    },
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const { toastSuccess, toastError, loadFileVersions, fetchVersionContent, restoreFileVersion, loadConflicts } =
  vi.hoisted(() => ({
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    loadFileVersions: vi.fn(),
    fetchVersionContent: vi.fn(),
    restoreFileVersion: vi.fn(),
    loadConflicts: vi.fn(),
  }))

vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: { team: { id: string } }) => unknown) => sel({ team: { id: 'team-1' } }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: { workspacePath: string | null }) => unknown) => sel({ workspacePath: null }),
}))
vi.mock('@/stores/team-conflicts', () => ({
  useTeamConflictsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ knowledgeDir: '/kb', load: loadConflicts }),
}))
vi.mock('@/lib/team-skill-paths', () => ({
  teamSyncKeyForPath: (abs: string) => (abs.startsWith('/kb/') ? `knowledge/${abs.slice(4)}` : null),
}))

const versionsState = vi.hoisted(() => ({ fileVersions: [] as { ref: string; author: string | null; timestamp: string }[] }))
vi.mock('@/stores/version-history', () => {
  const state = () => ({
    ...versionsState,
    loadFileVersions,
    fetchVersionContent,
    restoreFileVersion,
  })
  const store = (sel: (s: ReturnType<typeof state>) => unknown) => sel(state())
  store.getState = state
  return { useVersionHistoryStore: store }
})

import { KnowledgeCloudVersion } from '../KnowledgeCloudVersion'

const DOC = '/kb/note.md'

beforeEach(() => {
  vi.clearAllMocks()
  versionsState.fileVersions = [
    { ref: 'hash-newest', author: '海港', timestamp: '2026-08-25T10:00:00Z' },
    { ref: 'hash-older', author: '海港', timestamp: '2026-08-24T10:00:00Z' },
  ]
  fetchVersionContent.mockResolvedValue('# 云端的内容\n')
  restoreFileVersion.mockResolvedValue(undefined)
})

describe('KnowledgeCloudVersion', () => {
  it('shows what the cloud holds now, not an older version', async () => {
    render(<KnowledgeCloudVersion path={DOC} />)

    await waitFor(() => expect(screen.getByText(/云端的内容/)).toBeTruthy())
    // The list is newest-first; anything else would quietly show history as if
    // it were the current state.
    expect(fetchVersionContent).toHaveBeenCalledWith('team-1', 'knowledge/note.md', 'hash-newest')
  })

  it('says so when the cloud has never seen the document', async () => {
    versionsState.fileVersions = []
    render(<KnowledgeCloudVersion path={DOC} />)

    await waitFor(() => expect(screen.getByText(/only exists here/)).toBeTruthy())
    expect(fetchVersionContent).not.toHaveBeenCalled()
  })

  it('explains an unreadable copy instead of rendering nothing', async () => {
    // A legacy encrypted blob this device has no key for comes back as null.
    fetchVersionContent.mockResolvedValue(null)
    render(<KnowledgeCloudVersion path={DOC} />)

    await waitFor(() => expect(screen.getByText(/cannot be read here/)).toBeTruthy())
    // And with nothing readable there is nothing to copy over the local file.
    expect(screen.queryByRole('button', { name: 'Overwrite my copy with this' })).toBeNull()
  })

  it('overwrites the local document only after a confirmation', async () => {
    render(<KnowledgeCloudVersion path={DOC} />)
    await waitFor(() => expect(screen.getByText(/云端的内容/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite my copy with this' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Overwrite' }))

    await waitFor(() =>
      expect(restoreFileVersion).toHaveBeenCalledWith('team-1', 'knowledge/note.md', 'hash-newest'),
    )
  })

  it('refuses to guess for a file outside the knowledge tree', () => {
    render(<KnowledgeCloudVersion path="/somewhere/else/note.md" />)
    expect(screen.getByText(/not part of the team knowledge base/)).toBeTruthy()
    expect(loadFileVersions).not.toHaveBeenCalled()
  })
})
