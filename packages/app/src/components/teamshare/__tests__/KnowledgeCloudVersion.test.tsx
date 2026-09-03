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

const { toastSuccess, toastError, invoke, loadConflicts } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  invoke: vi.fn(),
  loadConflicts: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

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
vi.mock('@/lib/team/team-skill-paths', () => ({
  teamSyncKeyForPath: (abs: string) => (abs.startsWith('/kb/') ? `knowledge/${abs.slice(4)}` : null),
}))

import { KnowledgeCloudVersion } from '../KnowledgeCloudVersion'

const DOC = '/kb/note.md'

/** The daemon's two reads, in the order the view makes them. */
function daemonAnswers(opts: {
  versions?: { ref: string; author: string | null; timestamp: string }[]
  content?: string | null
} = {}) {
  const versions = opts.versions ?? [
    { ref: 'hash-newest', author: '海港', timestamp: '2026-08-25T10:00:00Z' },
    { ref: 'hash-older', author: '海港', timestamp: '2026-08-24T10:00:00Z' },
  ]
  const content = opts.content === undefined ? '# 云端的内容\n' : opts.content
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'team_file_versions') return Promise.resolve({ versions })
    if (cmd === 'team_file_content') return Promise.resolve({ content })
    return Promise.resolve(undefined)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  daemonAnswers()
})

describe('KnowledgeCloudVersion', () => {
  it('shows what the cloud holds now, not an older version', async () => {
    render(<KnowledgeCloudVersion path={DOC} />)

    await waitFor(() => expect(screen.getByText(/云端的内容/)).toBeTruthy())
    // The list is newest-first; anything else would quietly show history as if
    // it were the current state.
    expect(invoke).toHaveBeenCalledWith('team_file_content', {
      teamId: 'team-1',
      path: 'knowledge/note.md',
      ref: 'hash-newest',
    })
  })

  it('says so when the cloud has never seen the document', async () => {
    daemonAnswers({ versions: [] })
    render(<KnowledgeCloudVersion path={DOC} />)

    await waitFor(() => expect(screen.getByText(/only exists here/)).toBeTruthy())
    expect(invoke).not.toHaveBeenCalledWith('team_file_content', expect.anything())
  })

  it('never shows one document under another document name', async () => {
    // Found on a real machine: this view used the shared version-history store,
    // so the second document opened read the FIRST one's `versions[0]` before
    // its own load finished. Blobs are content-addressed, so the daemon
    // returned that other document's text — under this document's name.
    const { unmount } = render(<KnowledgeCloudVersion path={DOC} />)
    await waitFor(() => expect(screen.getByText(/云端的内容/)).toBeTruthy())
    unmount()

    daemonAnswers({ versions: [] })
    render(<KnowledgeCloudVersion path="/kb/never-pushed.md" />)

    await waitFor(() => expect(screen.getByText(/only exists here/)).toBeTruthy())
    expect(screen.queryByText(/云端的内容/)).toBeNull()
  })

  it('explains an unreadable copy instead of rendering nothing', async () => {
    // A legacy encrypted blob this device has no key for comes back as null.
    daemonAnswers({ content: null })
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
      expect(invoke).toHaveBeenCalledWith('team_restore_file_version', {
        teamId: 'team-1',
        path: 'knowledge/note.md',
        ref: 'hash-newest',
      }),
    )
  })

  it('refuses to guess for a file outside the knowledge tree', () => {
    render(<KnowledgeCloudVersion path="/somewhere/else/note.md" />)
    expect(screen.getByText(/not part of the team knowledge base/)).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()
  })
})
